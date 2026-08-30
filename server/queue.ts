import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { config } from './config.js'
import { hasTranslationOutput, type Store } from './db.js'
import type { ComixClient } from './comix.js'
import { isTranslationCompletenessError, parseTranslationOutput, type MangaTranslator, type TranslationContext } from './translator.js'
import type { JobRow, TranslationMode, TranslationResult } from './types.js'
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
  private readonly activeTasks = new Set<Promise<void>>()
  private readonly activeChapterIds = new Set<number>()
  private readonly workerLimit: number
  private stopping = false
  private drainTask?: Promise<void>
  private stopTask?: Promise<void>
  private wakeDrain?: () => void

  constructor(
    private readonly store: Store,
    private readonly comix: ComixClient,
    private readonly translator: MangaTranslator,
    concurrency = config.translationChapterConcurrency,
  ) {
    this.workerLimit = Number.isSafeInteger(concurrency) && concurrency > 0 ? Math.min(concurrency, 4) : 1
  }

  start(): void {
    for (const job of this.store.queuedJobs()) this.schedule(job.id)
  }

  stop(): Promise<void> {
    this.stopTask ??= (async () => {
      this.stopping = true
      this.wakeDrain?.()
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
    this.ensureDrain()
    this.wakeDrain?.()
  }

  private ensureDrain(): void {
    if (this.stopping || this.drainTask) return
    // Start on the next microtask so a batch enqueue can fill all workers at once.
    this.drainTask = Promise.resolve().then(() => this.drain()).finally(() => {
      this.drainTask = undefined
      // A request can enqueue work while the previous drain promise is settling.
      if (!this.stopping && this.pending.length > 0) this.ensureDrain()
    })
  }

  private async drain(): Promise<void> {
    while (true) {
      if (this.stopping) {
        await Promise.allSettled([...this.activeTasks])
        return
      }

      while (this.activeTasks.size < this.workerLimit) {
        const job = this.takeNextEligibleJob()
        if (!job) break
        this.startJob(job)
      }

      if (this.activeTasks.size === 0) return
      await this.waitForWorkerOrSchedule()
    }
  }

  private async waitForWorkerOrSchedule(): Promise<void> {
    let wake = () => {}
    const scheduled = new Promise<void>((resolve) => { wake = resolve })
    this.wakeDrain = wake
    try {
      await Promise.race([
        scheduled,
        ...[...this.activeTasks].map((task) => task.catch(() => undefined)),
      ])
    } finally {
      if (this.wakeDrain === wake) this.wakeDrain = undefined
    }
  }

  private takeNextEligibleJob(): JobRow | undefined {
    for (let index = 0; index < this.pending.length;) {
      const id = this.pending[index]
      const job = id ? this.store.getJob(id) : undefined
      if (!job || job.status !== 'queued') {
        this.pending.splice(index, 1)
        if (id) this.scheduled.delete(id)
        continue
      }
      if (this.activeChapterIds.has(job.chapter_id)) {
        index += 1
        continue
      }
      this.pending.splice(index, 1)
      this.scheduled.delete(job.id)
      return job
    }
    return undefined
  }

  private startJob(job: JobRow): void {
    this.activeChapterIds.add(job.chapter_id)
    const task = this.process(job).finally(() => {
      this.activeTasks.delete(task)
      this.activeChapterIds.delete(job.chapter_id)
    })
    this.activeTasks.add(task)
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
        let translation: TranslationResult
        try {
          translation = await this.translator.translate(original, job.model, job.reasoning_effort, context)
        } catch (error) {
          if (!isTranslationCompletenessError(error)) throw error
          if (this.stopping) {
            this.requeueAfterShutdown(job, chapter.id, activePosition)
            return
          }
          if (this.store.getJob(job.id)?.status === 'cancelled') {
            this.store.updatePage(chapter.id, page.position, { status: 'pending', error: '' })
            return
          }
          const partialJson = JSON.stringify(error.partialResult)
          needsRetranslation = true
          this.store.updatePage(chapter.id, page.position, {
            translated_path: '',
            translation_json: partialJson,
            status: 'needs_retranslation',
            error: `尚有 ${error.unresolvedHints.length} 個高信心英文區域未翻譯，請重譯`,
          })
          currentChapterContext.push(partialJson)
          this.store.updateJob(job.id, { current_page: page.position })
          continue
        }
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
