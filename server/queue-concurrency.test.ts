import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import type { ComixClient } from './comix.js'
import { config } from './config.js'
import { Store } from './db.js'
import { TranslationQueue } from './queue.js'
import { TranslationCompletenessError, type MangaTranslator } from './translator.js'
import type { SourcePage, TranslationResult } from './types.js'

interface HeldRequest {
  chapterId: number
  release: () => void
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await tick()
  }
}

function createStore(chapterIds: number[]): { folder: string; store: Store } {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'transcomic-queue-pool-'))
  const store = new Store(folder)
  store.upsertSeries({
    hid: `queue-pool-${chapterIds[0]}`,
    title: '並行測試',
    altTitles: [],
    type: 'manga',
    status: 'releasing',
    originalLanguage: 'en',
    poster: {},
    latestChapter: chapterIds.length,
    synopsis: '',
    url: '/title/queue-pool',
  })
  store.upsertChapters(`queue-pool-${chapterIds[0]}`, chapterIds.map((id, index) => ({
    id,
    mangaId: 1,
    number: index + 1,
    volume: 1,
    name: '',
    language: 'en',
    url: `/title/queue-pool/chapter-${index + 1}`,
  })))
  return { folder, store }
}

function heldComix(requests: HeldRequest[]): ComixClient {
  return {
    getChapterPages: ({ id }: { id: number }) => new Promise((resolve) => {
      requests.push({ chapterId: id, release: () => resolve([]) })
    }),
  } as unknown as ComixClient
}

const unusedTranslator = {} as MangaTranslator

test('translation queue runs two different chapters in parallel and then starts the next', async () => {
  const base = 8_100_000_000 + process.pid * 10
  const chapterIds = [base + 1, base + 2, base + 3]
  const { folder, store } = createStore(chapterIds)
  const requests: HeldRequest[] = []
  try {
    chapterIds.forEach((chapterId, index) => {
      store.createJob({ id: `parallel-${process.pid}-${index}`, chapter_id: chapterId, model: 'gpt-5.6-luna', reasoning_effort: 'max' })
    })
    const queue = new TranslationQueue(store, heldComix(requests), unusedTranslator, 2)
    queue.start()

    await waitFor(() => requests.length === 2, '兩個章節未有同時開始')
    await tick()
    assert.equal(requests.length, 2)
    assert.equal(new Set(requests.map(({ chapterId }) => chapterId)).size, 2)

    requests[0]?.release()
    await waitFor(() => requests.length === 3, '第一個 worker 完成後未有接續下一章')
    requests.slice(1).forEach(({ release }) => release())
    await waitFor(
      () => chapterIds.every((_, index) => store.getJob(`parallel-${process.pid}-${index}`)?.status === 'failed'),
      '並行測試工作未有結束',
    )
    await queue.stop()
  } finally {
    store.db.close()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('translation queue never runs two jobs for the same chapter together', async () => {
  const chapterId = 8_200_000_000 + process.pid
  const { folder, store } = createStore([chapterId])
  const requests: HeldRequest[] = []
  try {
    store.createJob({ id: `same-a-${process.pid}`, chapter_id: chapterId, model: 'gpt-5.6-luna', reasoning_effort: 'max' })
    store.createJob({ id: `same-b-${process.pid}`, chapter_id: chapterId, model: 'gpt-5.6-luna', reasoning_effort: 'max' })
    const queue = new TranslationQueue(store, heldComix(requests), unusedTranslator, 2)
    queue.start()

    await waitFor(() => requests.length === 1, '同章第一個工作未有開始')
    await tick()
    assert.equal(requests.length, 1)
    requests[0]?.release()
    await waitFor(() => requests.length === 2, '同章第二個工作未有在首個結束後開始')
    assert.equal(requests[0]?.chapterId, requests[1]?.chapterId)
    requests[1]?.release()
    await waitFor(
      () => store.getJob(`same-b-${process.pid}`)?.status === 'failed',
      '同章第二個工作未有結束',
    )
    await queue.stop()
  } finally {
    store.db.close()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('cancelling one running chapter does not interrupt its parallel peer', async () => {
  const base = 8_250_000_000 + process.pid * 10
  const chapterIds = [base + 1, base + 2]
  const { folder, store } = createStore(chapterIds)
  const requests: HeldRequest[] = []
  const jobIds = [`cancel-${process.pid}`, `peer-${process.pid}`]
  try {
    chapterIds.forEach((chapterId, index) => {
      store.createJob({ id: jobIds[index] ?? '', chapter_id: chapterId, model: 'gpt-5.6-luna', reasoning_effort: 'max' })
    })
    const queue = new TranslationQueue(store, heldComix(requests), unusedTranslator, 2)
    queue.start()
    await waitFor(() => requests.length === 2, '取消測試未有兩個運行中工作')

    assert.equal(queue.cancel(jobIds[0] ?? ''), true)
    requests.forEach(({ release }) => release())
    await waitFor(() => store.getJob(jobIds[1] ?? '')?.status === 'failed', '並行工作受到取消操作阻塞')
    await queue.stop()

    assert.equal(store.getJob(jobIds[0] ?? '')?.status, 'cancelled')
    assert.equal(store.getChapter(chapterIds[0] ?? 0)?.status, 'ready')
    assert.equal(store.getJob(jobIds[1] ?? '')?.status, 'failed')
  } finally {
    store.db.close()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('an incomplete page fails closed while the queue continues the rest of the chapter', async () => {
  const chapterId = 8_275_000_000 + process.pid
  const { folder, store } = createStore([chapterId])
  const mediaFolder = path.join(config.dataDir, 'media', String(chapterId))
  const pages: SourcePage[] = [1, 2].map((position) => ({
    url: `https://static.comix.to/completeness-${position}.webp`,
    width: 120,
    height: 180,
    scramble: false,
  }))
  const partialResult: TranslationResult = { regions: [{
    id: 1,
    bubble: { x: 100, y: 100, width: 300, height: 250 },
    safe: { x: 140, y: 140, width: 220, height: 150 },
    lines: [{ x: 160, y: 160, width: 180, height: 50 }],
    source: 'Already translated',
    translation: '已經翻譯',
    kind: 'speech',
  }] }
  try {
    store.upsertPages(chapterId, pages)
    const original = await sharp({ create: { width: 120, height: 180, channels: 3, background: '#fff' } }).webp().toBuffer()
    for (const position of [1, 2]) {
      const relative = path.join('media', String(chapterId), 'original', `${String(position).padStart(3, '0')}.webp`)
      const absolute = path.join(config.dataDir, relative)
      fs.mkdirSync(path.dirname(absolute), { recursive: true })
      fs.writeFileSync(absolute, original)
      store.updatePage(chapterId, position, { original_path: relative })
    }
    const jobId = `incomplete-${process.pid}`
    store.createJob({ id: jobId, chapter_id: chapterId, model: 'gpt-5.6-luna', reasoning_effort: 'max' })
    let translations = 0
    const translator = {
      translate: async () => {
        translations += 1
        if (translations === 1) {
          throw new TranslationCompletenessError(partialResult, [
            { text: 'Still missed one', box: { x: 500, y: 100, width: 200, height: 80 }, confidence: 95 },
            { text: 'Still missed two', box: { x: 500, y: 220, width: 200, height: 80 }, confidence: 92 },
          ])
        }
        return { regions: [] }
      },
    } as unknown as MangaTranslator
    const comix = {
      getChapterPages: async () => pages,
    } as unknown as ComixClient
    const queue = new TranslationQueue(store, comix, translator, 1)
    queue.start()
    await waitFor(() => store.getJob(jobId)?.status === 'failed', '完整度失敗後章節工作未有正常收結')
    await queue.stop()

    const storedPages = store.listPages(chapterId)
    assert.equal(translations, 2)
    assert.equal(storedPages[0]?.status, 'needs_retranslation')
    assert.equal(storedPages[0]?.translated_path, '')
    assert.deepEqual(JSON.parse(storedPages[0]?.translation_json ?? ''), partialResult)
    assert.match(storedPages[0]?.error ?? '', /尚有 2 個高信心英文區域未翻譯/u)
    assert.equal(fs.existsSync(path.join(mediaFolder, 'translated', '001.webp')), false)
    assert.equal(storedPages[1]?.status, 'completed')
    assert.ok(storedPages[1]?.translated_path)
    assert.equal(store.getJob(jobId)?.current_page, 2)
    assert.deepEqual(
      { status: store.getJob(jobId)?.status, error: store.getJob(jobId)?.error },
      { status: 'failed', error: '部分頁面未能安全完成嵌字' },
    )
    assert.equal(store.getChapter(chapterId)?.status, 'needs_retranslation')
  } finally {
    store.db.close()
    fs.rmSync(folder, { recursive: true, force: true })
    fs.rmSync(mediaFolder, { recursive: true, force: true })
  }
})

test('stopping a parallel queue waits for active chapters, requeues them, and leaves pending work untouched', async () => {
  const base = 8_300_000_000 + process.pid * 10
  const chapterIds = [base + 1, base + 2, base + 3]
  const { folder, store } = createStore(chapterIds)
  const requests: HeldRequest[] = []
  try {
    chapterIds.forEach((chapterId, index) => {
      store.createJob({ id: `stop-${process.pid}-${index}`, chapter_id: chapterId, model: 'gpt-5.6-luna', reasoning_effort: 'max' })
    })
    const queue = new TranslationQueue(store, heldComix(requests), unusedTranslator, 2)
    queue.start()
    await waitFor(() => requests.length === 2, '停止測試未有兩個運行中工作')

    let stopped = false
    const stopTask = queue.stop().then(() => { stopped = true })
    await tick()
    assert.equal(stopped, false)
    requests.forEach(({ release }) => release())
    await stopTask

    assert.equal(requests.length, 2)
    chapterIds.forEach((chapterId, index) => {
      assert.equal(store.getJob(`stop-${process.pid}-${index}`)?.status, 'queued')
      assert.equal(store.getChapter(chapterId)?.status, 'queued')
    })
  } finally {
    store.db.close()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
