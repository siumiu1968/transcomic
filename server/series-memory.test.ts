import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import sharp from 'sharp'
import type { ComixClient } from './comix.js'
import { config } from './config.js'
import { canonicalSourceKey, Store } from './db.js'
import type { OcrDetection } from './ocr.js'
import { TranslationQueue } from './queue.js'
import { buildTranslationPrompt, mergeTranslationResults, parseTranslationOutput, type MangaTranslator, type TranslationContext } from './translator.js'
import type { SeriesMemoryEntry, SourcePage, TranslationMemoryDelta } from './types.js'

const successfulEmptyOcr = async (): Promise<OcrDetection> => ({
  words: [],
  successfulEngines: ['tesseract'],
  failedEngines: [],
})

function seedStore(folder: string, id: number, pageCount = 1): Store {
  const store = new Store(folder)
  store.upsertSeries({
    hid: `memory-${id}`,
    title: '記憶測試',
    altTitles: [],
    type: 'manga',
    status: 'releasing',
    originalLanguage: 'en',
    poster: {},
    latestChapter: 1,
    synopsis: 'Alice visits Moon Base.',
    url: '/title/memory',
  })
  store.upsertChapters(`memory-${id}`, [{
    id,
    mangaId: 1,
    number: 1,
    volume: 1,
    name: '',
    language: 'en',
    url: `/title/memory/${id}`,
  }])
  store.upsertPages(id, Array.from({ length: pageCount }, (_, index) => ({
    url: `https://static.comix.to/memory-${id}-${index + 1}.webp`,
    width: 120,
    height: 180,
  })))
  return store
}

test('series memory migration is safe for a pre-memory database', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'transcomic-memory-migration-'))
  try {
    const legacy = new DatabaseSync(path.join(folder, 'transcomic.sqlite'))
    legacy.exec(`
      CREATE TABLE series (
        hid TEXT PRIMARY KEY, title TEXT NOT NULL, alt_titles TEXT NOT NULL DEFAULT '[]',
        poster_url TEXT NOT NULL DEFAULT '', source_language TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '', synopsis TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    legacy.close()

    const store = new Store(folder)
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='series_memory'").all()
    assert.equal(tables.length, 1)
    store.db.close()
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('canonical keys and first successful write keep confirmed names stable', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'transcomic-memory-stable-'))
  const chapterId = 9_100_000_000 + process.pid
  try {
    assert.equal(canonicalSourceKey(' Ａlice・Smith! '), canonicalSourceKey('alice smith'))
    const store = seedStore(folder, chapterId)
    const first: TranslationMemoryDelta[] = [
      { category: 'character', source: 'Alice Smith', translation: '愛麗絲・史密夫', note: '' },
      { category: 'voice', source: 'Alice Smith', translation: '', note: '說話冷靜、句子短。' },
    ]
    assert.equal(store.completePageTranslation(chapterId, 1, 'first.webp', '{}', first), 2)
    assert.equal(store.completePageTranslation(chapterId, 1, 'second.webp', '{}', [
      { category: 'character', source: 'ＡLICE—SMITH!!', translation: '隨機新譯名', note: '' },
    ]), 0)

    const memory = store.seriesMemory(`memory-${chapterId}`, 'Alice Smith', 10)
    assert.equal(memory.find(({ category }) => category === 'character')?.translation, '愛麗絲・史密夫')
    assert.equal(memory.find(({ category }) => category === 'voice')?.note, '說話冷靜、句子短。')
    assert.equal(store.listPages(chapterId)[0]?.translated_path, 'second.webp')
    store.db.close()
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('page completion and memory merge roll back together', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'transcomic-memory-atomic-'))
  const chapterId = 9_200_000_000 + process.pid
  try {
    const store = seedStore(folder, chapterId)
    store.db.exec(`
      CREATE TRIGGER reject_memory BEFORE INSERT ON series_memory
      WHEN NEW.source_key='explode'
      BEGIN SELECT RAISE(ABORT, 'test rollback'); END
    `)
    assert.throws(() => store.completePageTranslation(chapterId, 1, 'translated.webp', '{}', [
      { category: 'term', source: 'explode', translation: '爆炸', note: '' },
    ]), /test rollback/u)
    assert.equal(store.listPages(chapterId)[0]?.status, 'pending')
    assert.equal(store.seriesMemory(`memory-${chapterId}`).length, 0)
    store.db.close()
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('audit merge preserves primary memory delta and legacy JSON still parses', () => {
  assert.deepEqual(parseTranslationOutput('{"regions":[]}'), { regions: [], memory_delta: [] })
  const merged = mergeTranslationResults(
    { regions: [], memory_delta: [{ category: 'place', source: 'Moon Base', translation: '月球基地', note: '' }] },
    { regions: [], memory_delta: [
      { category: 'place', source: 'ＭＯＯＮ　ＢＡＳＥ!', translation: '月面基地', note: '' },
      { category: 'address', source: 'Captain', translation: '隊長', note: '' },
    ] },
  )
  assert.deepEqual(merged.memory_delta, [
    { category: 'place', source: 'Moon Base', translation: '月球基地', note: '' },
    { category: 'address', source: 'Captain', translation: '隊長', note: '' },
  ])
})

test('translation prompt keeps previous dialogue and bounds injected series memory', () => {
  const memory: SeriesMemoryEntry[] = Array.from({ length: 30 }, (_, index) => ({
    series_hid: 'prompt',
    category: 'term',
    source_key: `term${index}`,
    source: `TERM-${index}`,
    translation: `術語${index}`,
    note: '',
    created_at: '2026-08-31 00:00:00',
  }))
  const context: TranslationContext = {
    seriesTitle: 'Prompt Test',
    synopsis: '',
    previousRegions: [{ source: 'Earlier words', translation: '較早對白' }],
    seriesMemory: memory,
  }
  const prompt = buildTranslationPrompt(context, [{
    text: 'Alice visits Moon Base',
    box: { x: 100, y: 100, width: 300, height: 80 },
    confidence: 94,
    engines: ['rapidocr', 'tesseract'],
  }])
  assert.match(prompt, /Earlier words/u)
  assert.match(prompt, /TERM-23/u)
  assert.doesNotMatch(prompt, /TERM-24/u)
  assert.match(prompt, /OCR CHECKLIST/u)
  assert.match(prompt, /Alice visits Moon Base/u)
})

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('queue memory test timed out')
    await tick()
  }
}

test('a successful page atomically feeds bounded series memory into the next page', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'transcomic-memory-queue-'))
  const chapterId = 9_300_000_000 + process.pid
  const mediaFolder = path.join(config.dataDir, 'media', String(chapterId))
  const pages: SourcePage[] = [1, 2].map((position) => ({
    url: `https://static.comix.to/queue-memory-${position}.webp`,
    width: 120,
    height: 180,
  }))
  try {
    const store = seedStore(folder, chapterId, 2)
    const original = await sharp({ create: { width: 120, height: 180, channels: 3, background: '#fff' } }).webp().toBuffer()
    for (const position of [1, 2]) {
      const relative = path.join('media', String(chapterId), 'original', `${String(position).padStart(3, '0')}.webp`)
      const absolute = path.join(config.dataDir, relative)
      fs.mkdirSync(path.dirname(absolute), { recursive: true })
      fs.writeFileSync(absolute, original)
      store.updatePage(chapterId, position, { original_path: relative })
    }
    const contexts: TranslationContext[] = []
    const translator = {
      translate: async (_image: Buffer, _model: string, _effort: string, context: TranslationContext) => {
        contexts.push(context)
        return contexts.length === 1
          ? { regions: [], memory_delta: [{ category: 'character', source: 'Alice', translation: '愛麗絲', note: '' }] }
          : { regions: [], memory_delta: [] }
      },
    } as unknown as MangaTranslator
    const comix = { getChapterPages: async () => pages } as unknown as ComixClient
    const jobId = `memory-queue-${process.pid}`
    store.createJob({ id: jobId, chapter_id: chapterId, model: 'gpt-5.6-luna', reasoning_effort: 'max' })
    const queue = new TranslationQueue(store, comix, translator, 1, successfulEmptyOcr)
    queue.start()
    await waitFor(() => store.getJob(jobId)?.status === 'completed')
    await queue.stop()

    assert.equal(contexts.length, 2)
    assert.equal(contexts[1]?.seriesMemory.find(({ source }) => source === 'Alice')?.translation, '愛麗絲')
    assert.equal(store.seriesMemory(`memory-${chapterId}`).length, 1)
    assert.equal(store.listPages(chapterId).every(({ status }) => status === 'completed'), true)
    store.db.close()
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
    fs.rmSync(mediaFolder, { recursive: true, force: true })
  }
})
