import fs from 'node:fs'
import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import { config } from './config.js'
import { ComixClient } from './comix.js'
import { hasTranslationOutput, Store } from './db.js'
import { TranslationQueue } from './queue.js'
import { MangaTranslator } from './translator.js'
import type { TranslationMode } from './types.js'

const app = express()
const store = new Store(config.dataDir)
const comix = new ComixClient()
const mediaComix = new ComixClient()
const translator = new MangaTranslator()
const queue = new TranslationQueue(store, comix, translator)

app.disable('x-powered-by')
app.use(express.json({ limit: '128kb' }))

app.get('/transcomic/api/health', (_request, response) => {
  response.json({ ok: true, service: 'transcomic' })
})

app.use((request, response, next) => {
  if (config.authMode === 'off') return next()
  const value = request.headers[config.trustedHeader]
  if (value === config.trustedValue) return next()
  response.status(401).json({ error: '需要最高管理員權限' })
})

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => handler(request, response).catch(next)
}

function parseId(raw: unknown): number {
  const value = Number.parseInt(String(raw), 10)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('識別碼無效')
  return value
}

async function ensurePages(chapterId: number): Promise<void> {
  const chapter = store.getChapter(chapterId)
  if (!chapter) throw new Error('找不到章節')
  const storedPages = store.listPages(chapterId)
  if (storedPages.length > 0 && storedPages.every((page) => page.scramble === 0 || page.scramble === 1)) return
  const pages = await comix.getChapterPages({ id: chapter.id, url: chapter.source_url })
  if (pages.length === 0) throw new Error('章節未有可用圖片')
  store.upsertPages(chapterId, pages)
}

app.get('/transcomic/api/search', asyncRoute(async (request, response) => {
  const query = String(request.query.q ?? '').trim().slice(0, 100)
  const searchPage = Math.max(1, Math.min(100, Number.parseInt(String(request.query.page ?? '1'), 10) || 1))
  if (query.length < 2) {
    response.json({ items: [] })
    return
  }
  const result = await comix.search(query, searchPage)
  response.json({ items: result.items ?? [], meta: result.meta ?? {} })
}))

app.get('/transcomic/api/library', (_request, response) => {
  response.json({ items: store.listSeries() })
})

app.post('/transcomic/api/library/:hid', asyncRoute(async (request, response) => {
  const hid = String(request.params.hid)
  if (!/^[a-z0-9-]{2,32}$/i.test(hid)) {
    response.status(400).json({ error: '漫畫識別碼無效' })
    return
  }
  const [series, chapters] = await Promise.all([comix.getSeries(hid), comix.getAllChapters(hid)])
  store.upsertSeries(series)
  store.upsertChapters(hid, chapters)
  response.status(201).json({ series: store.getSeries(hid), chapters: store.listChapters(hid) })
}))

app.get('/transcomic/api/library/:hid', (request, response) => {
  const hid = String(request.params.hid)
  const series = store.getSeries(hid)
  if (!series) {
    response.status(404).json({ error: '書庫未有呢套漫畫' })
    return
  }
  response.json({ series, chapters: store.listChapters(hid) })
})

app.get('/transcomic/api/chapters/:id/pages', asyncRoute(async (request, response) => {
  const chapterId = parseId(request.params.id)
  await ensurePages(chapterId)
  const chapter = store.getChapter(chapterId)
  if (!chapter) {
    response.status(404).json({ error: '找不到章節' })
    return
  }
  const pages = store.listPages(chapterId).map((page) => ({
    position: page.position,
    width: page.width,
    height: page.height,
    status: page.status,
    originalUrl: page.original_path
      ? `/transcomic/api/media/original/${chapterId}/${page.position}`
      : `/transcomic/api/source-image?chapterId=${chapterId}&position=${page.position}`,
    translatedUrl: hasTranslationOutput(page)
      ? `/transcomic/api/media/translated/${chapterId}/${page.position}`
      : null,
    needsRetranslation: page.status === 'needs_retranslation',
  }))
  response.json({ chapter, series: store.getSeries(chapter.series_hid), pages })
}))

app.get('/transcomic/api/source-image', asyncRoute(async (request, response) => {
  const chapterId = Number.parseInt(String(request.query.chapterId ?? ''), 10)
  const position = Number.parseInt(String(request.query.position ?? ''), 10)
  const page = Number.isSafeInteger(chapterId) && Number.isSafeInteger(position)
    ? store.listPages(chapterId).find((item) => item.position === position)
    : undefined
  const chapter = page ? store.getChapter(chapterId) : undefined
  const sourceUrl = String(request.query.url ?? '')
  if (!page || !chapter) {
    if (!sourceUrl) {
      response.status(404).json({ error: '找不到來源頁面' })
      return
    }
    const image = await mediaComix.downloadSource(sourceUrl)
    response.setHeader('Content-Type', image.contentType)
    response.setHeader('Cache-Control', 'private, max-age=3600')
    response.send(image.body)
    return
  }
  if (!page.source_url) {
    response.status(404).json({ error: '找不到來源頁面' })
    return
  }
  const image = await mediaComix.downloadSource(page.source_url, {
    chapterUrl: chapter.source_url,
    pagePosition: page.position,
    scramble: page.scramble === 1,
  })
  response.setHeader('Content-Type', image.contentType)
  response.setHeader('Cache-Control', 'private, max-age=3600')
  response.send(image.body)
}))

app.get('/transcomic/api/media/:kind/:chapterId/:position', (request, response) => {
  const chapterId = parseId(request.params.chapterId)
  const position = parseId(request.params.position)
  const page = store.listPages(chapterId).find((item) => item.position === position)
  const stored = request.params.kind === 'translated'
    ? page && hasTranslationOutput(page) ? page.translated_path : ''
    : request.params.kind === 'original' ? page?.original_path : ''
  if (!stored) {
    response.status(404).end()
    return
  }
  const target = path.resolve(config.dataDir, stored)
  const root = `${path.resolve(config.dataDir)}${path.sep}`
  if (!target.startsWith(root) || !fs.existsSync(target)) {
    response.status(404).end()
    return
  }
  response.setHeader('Cache-Control', request.params.kind === 'translated'
    ? 'private, max-age=0, must-revalidate'
    : 'private, max-age=31536000, immutable')
  response.sendFile(stored, { root: config.dataDir, dotfiles: 'deny' })
})

app.post('/transcomic/api/translate', (request, response) => {
  const rawIds = Array.isArray(request.body?.chapterIds) ? request.body.chapterIds : []
  const chapterIds = [...new Set<number>(rawIds.map((value: unknown) => Number(value)).filter((value: number) => Number.isSafeInteger(value) && value > 0))].slice(0, 5000)
  const forceIds: unknown[] = Array.isArray(request.body?.forceChapterIds) ? request.body.forceChapterIds : []
  const forceChapterIds = new Set<number>(forceIds.flatMap((value) => {
    const id = Number(value)
    return Number.isSafeInteger(id) && chapterIds.includes(id) ? [id] : []
  }))
  const mode: TranslationMode = request.body?.mode === 'fast' || request.body?.mode === 'quality' ? request.body.mode : 'balanced'
  if (chapterIds.length === 0) {
    response.status(400).json({ error: '請先選擇章節' })
    return
  }
  const jobs = queue.enqueue(chapterIds, mode, forceChapterIds)
  response.status(202).json({ jobs })
})

app.get('/transcomic/api/jobs', (_request, response) => {
  response.json({ items: store.listJobs() })
})

app.post('/transcomic/api/jobs/:id/cancel', (request, response) => {
  if (!queue.cancel(String(request.params.id))) {
    response.status(409).json({ error: '工作已經完結或不存在' })
    return
  }
  response.json({ ok: true })
})

const staticRoot = path.resolve('dist')
app.use('/transcomic', express.static(staticRoot, { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0 }))
app.get(/^\/transcomic(?:\/.*)?$/, (_request, response) => response.sendFile(path.join(staticRoot, 'index.html')))

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : '伺服器發生錯誤'
  console.error('[transcomic]', message)
  response.status(message.includes('找不到') ? 404 : 500).json({ error: message })
})

const server = app.listen(config.port, config.host, () => {
  console.log(`TransComic listening on http://${config.host}:${config.port}/transcomic/`)
  queue.start()
})

let shutdownTask: Promise<void> | undefined

function shutdown(): Promise<void> {
  shutdownTask ??= (async () => {
    const closeServer = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await Promise.all([closeServer, queue.stop()])
    await Promise.all([comix.close(), mediaComix.close()])
    store.db.close()
  })()
  return shutdownTask
}

function requestShutdown(): void {
  void shutdown().catch((error: unknown) => {
    console.error('[transcomic] 關閉失敗', error)
    process.exitCode = 1
  })
}

process.once('SIGINT', requestShutdown)
process.once('SIGTERM', requestShutdown)
