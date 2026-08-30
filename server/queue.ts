import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { config } from './config.js'
import type { Store } from './db.js'
import type { ComixClient } from './comix.js'
import type { MangaTranslator } from './translator.js'
import type { JobRow, TranslationMode } from './types.js'
import { renderTranslation } from './renderer.js'

async function atomicWrite(target: string, content: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, content)
  await fs.rename(temporary, target)
}

export class TranslationQueue {
  private readonly pending: string[] = []
  private readonly scheduled = new Set<string>()
  private running = false

  constructor(
    private readonly store: Store,
    private readonly comix: ComixClient,
    private readonly translator: MangaTranslator,
  ) {}

  start(): void {
    for (const job of this.store.queuedJobs()) this.schedule(job.id)
  }

  enqueue(chapterIds: number[], mode: TranslationMode): JobRow[] {
    const model = this.translator.modelFor(mode)
    const jobs: JobRow[] = []
    for (const chapterId of chapterIds) {
      if (!this.store.getChapter(chapterId)) continue
      const active = this.store.activeJobForChapter(chapterId)
      if (active) {
        jobs.push(active)
        continue
      }
      const id = crypto.randomUUID()
      this.store.createJob({ id, chapter_id: chapterId, model })
      const job = this.store.getJob(id)
      if (job) jobs.push(job)
      this.schedule(id)
    }
    return jobs
  }

  cancel(id: string): boolean {
    const job = this.store.getJob(id)
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return false
    this.store.updateJob(id, { status: 'cancelled', finished_at: new Date().toISOString() })
    this.store.setChapterStatus(job.chapter_id, 'ready')
    return true
  }

  private schedule(id: string): void {
    if (this.scheduled.has(id)) return
    this.scheduled.add(id)
    this.pending.push(id)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.pending.length > 0) {
        const id = this.pending.shift()
        if (!id) continue
        this.scheduled.delete(id)
        const job = this.store.getJob(id)
        if (job?.status === 'queued') await this.process(job)
      }
    } finally {
      this.running = false
    }
  }

  private async process(job: JobRow): Promise<void> {
    const chapter = this.store.getChapter(job.chapter_id)
    if (!chapter) return
    let activePosition = 0
    this.store.updateJob(job.id, { status: 'running', started_at: new Date().toISOString(), error: '' })
    this.store.setChapterStatus(chapter.id, 'translating')
    try {
      const sourcePages = await this.comix.getChapterPages({ id: chapter.id, url: chapter.source_url })
      if (sourcePages.length === 0) throw new Error('章節未有可用圖片')
      this.store.upsertPages(chapter.id, sourcePages)
      this.store.updateJob(job.id, { total_pages: sourcePages.length })
      const pages = this.store.listPages(chapter.id)
      for (const page of pages) {
        activePosition = page.position
        if (this.store.getJob(job.id)?.status === 'cancelled') return
        if (page.status === 'completed' && page.translated_path) {
          this.store.updateJob(job.id, { current_page: page.position })
          continue
        }
        this.store.updatePage(chapter.id, page.position, { status: 'translating', error: '' })
        const folder = path.join('media', String(chapter.id))
        const originalRelative = path.join(folder, 'original', `${String(page.position).padStart(3, '0')}.webp`)
        const translatedRelative = path.join(folder, 'translated', `${String(page.position).padStart(3, '0')}.webp`)
        const originalPath = path.join(config.dataDir, originalRelative)
        let original: Buffer
        try {
          original = await fs.readFile(originalPath)
        } catch {
          const download = await this.comix.downloadSource(page.source_url)
          original = await sharp(download.body).rotate().webp({ quality: 92 }).toBuffer()
          await atomicWrite(originalPath, original)
        }
        const metadata = await sharp(original).metadata()
        this.store.updatePage(chapter.id, page.position, {
          original_path: originalRelative,
          width: metadata.width ?? page.width,
          height: metadata.height ?? page.height,
        })
        const translation = await this.translator.translate(original, job.model)
        const rendered = await renderTranslation(original, translation)
        await atomicWrite(path.join(config.dataDir, translatedRelative), rendered)
        this.store.updatePage(chapter.id, page.position, {
          translated_path: translatedRelative,
          status: 'completed',
          error: '',
        })
        this.store.updateJob(job.id, { current_page: page.position })
      }
      this.store.updateJob(job.id, { status: 'completed', current_page: sourcePages.length, finished_at: new Date().toISOString() })
      this.store.setChapterStatus(chapter.id, 'completed')
    } catch (error) {
      const message = error instanceof Error ? error.message : '翻譯工作失敗'
      if (this.store.getJob(job.id)?.status !== 'cancelled') {
        if (activePosition > 0) this.store.updatePage(chapter.id, activePosition, { status: 'failed', error: message.slice(0, 500) })
        this.store.updateJob(job.id, { status: 'failed', error: message.slice(0, 500), finished_at: new Date().toISOString() })
        this.store.setChapterStatus(chapter.id, 'failed')
      }
    }
  }
}
