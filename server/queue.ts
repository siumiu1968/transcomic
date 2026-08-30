import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { config } from './config.js'
import { hasTranslationOutput, type Store } from './db.js'
import type { ComixClient } from './comix.js'
import { parseTranslationOutput, type MangaTranslator, type TranslationContext } from './translator.js'
import type { JobRow, TranslationMode } from './types.js'
import { renderTranslationDetailed } from './renderer.js'

async function atomicWrite(target: string, content: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, content)
  await fs.rename(temporary, target)
}

function translationContext(values: string[], seriesTitle: string, synopsis: string): TranslationContext {
  const previousRegions = values.flatMap((value) => {
    try {
      return parseTranslationOutput(value).regions.map(({ source, translation }) => ({ source, translation }))
    } catch {
      return []
    }
  })
  return { seriesTitle, synopsis, previousRegions }
}

export function completionStatus(needsRetranslation: boolean): Pick<JobRow, 'status' | 'error'> {
  return needsRetranslation
    ? { status: 'failed', error: '部分頁面未能安全完成嵌字' }
    : { status: 'completed', error: '' }
}

export class TranslationQueue {
  private readonly pending: string[] = []
  private readonly scheduled = new Set<string>()
  private running = false
  private stopping = false
  private drainTask?: Promise<void>
  private stopTask?: Promise<void>

  constructor(
    private readonly store: Store,
    private readonly comix: ComixClient,
    private readonly translator: MangaTranslator,
  ) {}

  start(): void {
    for (const job of this.store.queuedJobs()) this.schedule(job.id)
  }

  stop(): Promise<void> {
    this.stopTask ??= (async () => {
      this.stopping = true
      await this.drainTask
    })()
    return this.stopTask
  }

  enqueue(chapterIds: number[], mode: TranslationMode, forceChapterIds: ReadonlySet<number> = new Set()): JobRow[] {
    const profile = this.translator.profileFor(mode)
    const jobs: JobRow[] = []
    for (const chapterId of chapterIds) {
      if (!this.store.getChapter(chapterId)) continue
      const active = this.store.activeJobForChapter(chapterId)
      if (active) {
        jobs.push(active)
        continue
      }
      if (forceChapterIds.has(chapterId)) this.store.resetChapterTranslation(chapterId)
      const id = crypto.randomUUID()
      this.store.createJob({ id, chapter_id: chapterId, model: profile.model, reasoning_effort: profile.effort })
      const job = this.store.getJob(id)
      if (job) jobs.push(job)
      this.schedule(id, forceChapterIds.has(chapterId))
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

  private schedule(id: string, priority = false): void {
    if (this.stopping) return
    if (this.scheduled.has(id)) return
    this.scheduled.add(id)
    if (priority) this.pending.unshift(id)
    else this.pending.push(id)
    this.drainTask ??= this.drain().finally(() => {
      this.drainTask = undefined
    })
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (!this.stopping && this.pending.length > 0) {
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
    let needsRetranslation = false
    this.store.updateJob(job.id, { status: 'running', started_at: new Date().toISOString(), error: '' })
    this.store.setChapterStatus(chapter.id, 'translating')
    try {
      const sourcePages = await this.comix.getChapterPages({ id: chapter.id, url: chapter.source_url })
      if (sourcePages.length === 0) throw new Error('章節未有可用圖片')
      this.store.upsertPages(chapter.id, sourcePages)
      this.store.updateJob(job.id, { total_pages: sourcePages.length })
      const pages = this.store.listPages(chapter.id)
      const series = this.store.getSeries(chapter.series_hid)
      const priorChapterContext = this.store.recentSeriesTranslationJson(chapter.series_hid, chapter.number, 2)
      const currentChapterContext: string[] = []
      for (const page of pages) {
        activePosition = page.position
        if (this.stopping) {
          this.requeueAfterShutdown(job, chapter.id, activePosition)
          return
        }
        if (this.store.getJob(job.id)?.status === 'cancelled') return
        if (hasTranslationOutput(page)) {
          try {
            await fs.access(path.join(config.dataDir, page.translated_path))
            if (this.stopping) {
              this.requeueAfterShutdown(job, chapter.id, activePosition)
              return
            }
            if (this.store.getJob(job.id)?.status === 'cancelled') return
            currentChapterContext.push(page.translation_json)
            this.store.updateJob(job.id, { current_page: page.position })
            continue
          } catch {
            if (this.stopping) {
              this.requeueAfterShutdown(job, chapter.id, activePosition)
              return
            }
            this.store.updatePage(chapter.id, page.position, { translated_path: '', status: 'pending', error: '' })
          }
        }
        this.store.updatePage(chapter.id, page.position, { status: 'translating', error: '' })
        const folder = path.join('media', String(chapter.id))
        const originalRelative = path.join(folder, 'original', `${String(page.position).padStart(3, '0')}.webp`)
        const translatedRelative = path.join(folder, 'translated', `${String(page.position).padStart(3, '0')}.webp`)
        const originalPath = path.join(config.dataDir, originalRelative)
        let original: Buffer
        if (page.original_path) {
          try {
            original = await fs.readFile(originalPath)
          } catch {
            const download = await this.comix.downloadSource(page.source_url, {
              chapterUrl: chapter.source_url,
              pagePosition: page.position,
              scramble: page.scramble === 1,
            })
            original = await sharp(download.body).rotate().webp({ quality: 92 }).toBuffer()
            await atomicWrite(originalPath, original)
          }
        } else {
          const download = await this.comix.downloadSource(page.source_url, {
            chapterUrl: chapter.source_url,
            pagePosition: page.position,
            scramble: page.scramble === 1,
          })
          original = await sharp(download.body).rotate().webp({ quality: 92 }).toBuffer()
          await atomicWrite(originalPath, original)
        }
        const metadata = await sharp(original).metadata()
        this.store.updatePage(chapter.id, page.position, {
          original_path: originalRelative,
          width: metadata.width ?? page.width,
          height: metadata.height ?? page.height,
        })
        if (this.stopping) {
          this.requeueAfterShutdown(job, chapter.id, activePosition)
          return
        }
        const context = translationContext(
          [...priorChapterContext, ...currentChapterContext.slice(-2)],
          series?.title ?? job.series_title,
          series?.synopsis ?? '',
        )
        const translation = await this.translator.translate(original, job.model, job.reasoning_effort, context)
        const translationJson = JSON.stringify(translation)
        const rendered = await renderTranslationDetailed(original, translation)
        if (this.stopping) {
          this.requeueAfterShutdown(job, chapter.id, activePosition)
          return
        }
        if (this.store.getJob(job.id)?.status === 'cancelled') {
          this.store.updatePage(chapter.id, page.position, { status: 'pending', error: '' })
          return
        }
        if (rendered.renderedRegions !== rendered.expectedRegions) {
          needsRetranslation = true
          this.store.updatePage(chapter.id, page.position, {
            translated_path: '',
            translation_json: translationJson,
            status: 'needs_retranslation',
            error: `有 ${rendered.expectedRegions - rendered.renderedRegions} 個對白未能安全嵌字，請重譯`,
          })
          currentChapterContext.push(translationJson)
          this.store.updateJob(job.id, { current_page: page.position })
          continue
        }
        await atomicWrite(path.join(config.dataDir, translatedRelative), rendered.image)
        if (this.stopping) {
          this.requeueAfterShutdown(job, chapter.id, activePosition)
          return
        }
        if (this.store.getJob(job.id)?.status === 'cancelled') {
          this.store.updatePage(chapter.id, page.position, { status: 'pending', error: '' })
          return
        }
        this.store.updatePage(chapter.id, page.position, {
          translated_path: translatedRelative,
          translation_json: translationJson,
          status: 'completed',
          error: '',
        })
        currentChapterContext.push(translationJson)
        this.store.updateJob(job.id, { current_page: page.position })
      }
      if (this.stopping) {
        this.requeueAfterShutdown(job, chapter.id, activePosition)
        return
      }
      if (this.store.getJob(job.id)?.status === 'cancelled') return
      this.store.updateJob(job.id, {
        ...completionStatus(needsRetranslation),
        current_page: sourcePages.length,
        finished_at: new Date().toISOString(),
      })
      this.store.setChapterStatus(chapter.id, needsRetranslation ? 'needs_retranslation' : 'completed')
    } catch (error) {
      if (this.stopping) {
        this.requeueAfterShutdown(job, chapter.id, activePosition)
        return
      }
      const message = error instanceof Error ? error.message : '翻譯工作失敗'
      if (this.store.getJob(job.id)?.status !== 'cancelled') {
        if (activePosition > 0) this.store.updatePage(chapter.id, activePosition, { status: 'failed', error: message.slice(0, 500) })
        this.store.updateJob(job.id, { status: 'failed', error: message.slice(0, 500), finished_at: new Date().toISOString() })
        this.store.setChapterStatus(chapter.id, 'failed')
      }
    }
  }

  private requeueAfterShutdown(job: JobRow, chapterId: number, activePosition: number): void {
    const current = this.store.getJob(job.id)
    if (!current || current.status === 'cancelled') return
    if (activePosition > 0) {
      const page = this.store.listPages(chapterId).find((item) => item.position === activePosition)
      if (page?.status === 'translating' || page?.status === 'failed') {
        this.store.updatePage(chapterId, activePosition, { status: 'pending', error: '' })
      }
    }
    this.store.updateJob(job.id, { status: 'queued', started_at: '', error: '' })
    this.store.setChapterStatus(chapterId, 'queued')
  }
}
