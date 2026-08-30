import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { isAllowedSourceUrl } from './comix.js'
import { hasTranslationOutput, Store } from './db.js'
import { completionStatus } from './queue.js'
import { balanceTranslationLines, matchOcrLines, normalizeDisplayText, renderTranslation, renderTranslationDetailed } from './renderer.js'
import { codexTimeoutForEffort, mergeTranslationResults, parseTranslationOutput, withAuditFallback } from './translator.js'

test('source image allowlist blocks SSRF targets', () => {
  assert.equal(isAllowedSourceUrl('https://static.comix.to/poster.webp'), true)
  assert.equal(isAllowedSourceUrl('https://j24n.wowpic2.store/page'), true)
  assert.equal(isAllowedSourceUrl('http://static.comix.to/page'), false)
  assert.equal(isAllowedSourceUrl('https://127.0.0.1/page'), false)
  assert.equal(isAllowedSourceUrl('https://comix.to.example.com/page'), false)
})

test('renderer preserves page dimensions and emits webp', async () => {
  const source = Buffer.from('<svg width="600" height="900" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="900" fill="#ddd7c8"/><ellipse cx="300" cy="360" rx="210" ry="160" fill="#fff" stroke="#111" stroke-width="5"/><circle cx="180" cy="280" r="8" fill="#111"/></svg>')
  const output = await renderTranslation(source, {
    regions: [{
      id: 1,
      bubble: { x: 150, y: 220, width: 700, height: 360 },
      safe: { x: 230, y: 270, width: 540, height: 200 },
      lines: [{ x: 286, y: 302, width: 28, height: 20 }],
      source: 'There are many stories left in this world.',
      translation: '呢個世界，仲有好多故事。',
      kind: 'speech',
    }],
  })
  const metadata = await sharp(output).metadata()
  assert.equal(metadata.width, 600)
  assert.equal(metadata.height, 900)
  assert.equal(metadata.format, 'webp')
  const unverifiedInk = await sharp(output).extract({ left: 180, top: 280, width: 1, height: 1 }).raw().toBuffer()
  assert.ok(unverifiedInk[0] < 50)
})

test('renderer translates an edge-clipped bubble without painting a panel-sized rectangle', async () => {
  const source = Buffer.from('<svg width="600" height="900" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="900" fill="#d7d0c6"/><ellipse cx="530" cy="705" rx="150" ry="190" fill="#fff" stroke="#111" stroke-width="5"/><rect x="458" y="648" width="65" height="26" fill="#111"/><rect x="435" y="600" width="8" height="10" fill="#111"/></svg>')
  const sourcePixel = await sharp(source).extract({ left: 465, top: 655, width: 1, height: 1 }).raw().toBuffer()
  assert.ok(sourcePixel[0] < 30)
  const output = await renderTranslation(source, {
    regions: [{
      id: 1,
      bubble: { x: 620, y: 570, width: 430, height: 430 },
      safe: { x: 740, y: 680, width: 170, height: 220 },
      lines: [{ x: 760, y: 715, width: 120, height: 40 }],
      source: 'My presence will endanger him.',
      translation: '我會連累佢。',
      kind: 'speech',
    }],
  })
  const cleanedPixel = await sharp(output).extract({ left: 465, top: 655, width: 1, height: 1 }).raw().toBuffer()
  const expandedPixel = await sharp(output).extract({ left: 438, top: 605, width: 1, height: 1 }).raw().toBuffer()
  const outsidePixel = await sharp(output).extract({ left: 300, top: 650, width: 1, height: 1 }).raw().toBuffer()
  assert.ok(cleanedPixel[0] > 200)
  assert.ok(expandedPixel[0] < 50)
  assert.ok(outsidePixel[0] < 230)
})

test('renderer skips an unverified fallback instead of covering artwork', async () => {
  const source = Buffer.from('<svg width="600" height="900" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="900" fill="#fff"/><rect x="250" y="365" width="100" height="10" fill="#111"/></svg>')
  const rendered = await renderTranslationDetailed(source, {
    regions: [{
      id: 1,
      bubble: { x: 250, y: 300, width: 500, height: 260 },
      safe: { x: 400, y: 400, width: 200, height: 100 },
      lines: [{ x: 417, y: 406, width: 166, height: 20 }],
      source: 'Hey old man',
      translation: '喂，老伯！',
      kind: 'speech',
    }],
  })
  assert.equal(rendered.expectedRegions, 1)
  assert.equal(rendered.renderedRegions, 0)
  const unverifiedInk = await sharp(rendered.image).extract({ left: 270, top: 368, width: 1, height: 1 }).raw().toBuffer()
  assert.ok(unverifiedInk[0] < 50)
})

test('OCR line matching returns only confident words from the model source', () => {
  const lines = matchOcrLines([
    { x: 130, y: 140, width: 52, height: 20, confidence: 96, line: '1:1:1:1', text: 'Hello' },
    { x: 190, y: 140, width: 55, height: 20, confidence: 96, line: '1:1:1:1', text: 'world' },
    { x: 520, y: 300, width: 48, height: 20, confidence: 99, line: '1:1:1:2', text: 'Hello' },
  ], {
    x: 100,
    y: 100,
    width: 320,
    height: 180,
    source: 'Hello world',
  })
  assert.deepEqual(lines, [{ x: 130, y: 140, width: 115, height: 20 }])
})

test('OCR line matching joins split words and ignores duplicate noise', () => {
  const lines = matchOcrLines([
    { x: 120, y: 140, width: 42, height: 20, confidence: 94, line: '1:1:1:1', text: 'PRE-' },
    { x: 168, y: 140, width: 58, height: 20, confidence: 91, line: '1:1:1:1', text: 'PARED' },
    { x: 125, y: 220, width: 44, height: 20, confidence: 92, line: '1:1:1:2', text: 'PRE-' },
  ], {
    x: 100,
    y: 100,
    width: 200,
    height: 180,
    source: 'PREPARED',
  })
  assert.deepEqual(lines, [{ x: 120, y: 140, width: 106, height: 20 }])
})

test('typesetter compacts Chinese punctuation and keeps closing punctuation off new lines', () => {
  assert.equal(normalizeDisplayText('事情會變得 ... 很糟糕。 呼、呼 !!'), '事情會變得……很糟糕。呼、呼！！')
  const lines = balanceTranslationLines('如果我離開呢個形態……我仲活着嗎？！', 108, 24)
  assert.equal(lines.some((line) => /^[，。！？、：；）》」』】]/u.test(line)), false)
})

test('translation output parser accepts strict and fenced JSON', () => {
  const expected = { regions: [{
    id: 1,
    bubble: { x: 10, y: 20, width: 100, height: 120 },
    safe: { x: 20, y: 30, width: 70, height: 80 },
    lines: [],
    source: 'Hello',
    translation: '你好',
    kind: 'speech' as const,
  }] }
  assert.deepEqual(parseTranslationOutput(JSON.stringify(expected)), expected)
  assert.deepEqual(parseTranslationOutput(`\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``), expected)
  assert.deepEqual(parseTranslationOutput(JSON.stringify({ regions: [{ bubble: {}, safe: {}, translation: '錯誤框', kind: 'speech' }] })), { regions: [] })
})

test('audit merge adds only a distinct missed bubble in reading order', () => {
  const primary = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 4, bubble: { x: 600, y: 200, width: 160, height: 160 }, safe: { x: 625, y: 225, width: 110, height: 100 },
    source: 'Hello', translation: '你好', kind: 'speech',
  }] }))
  const audit = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 1, bubble: { x: 300, y: 160, width: 170, height: 160 }, safe: { x: 325, y: 185, width: 120, height: 100 },
    source: 'Wait for me.', translation: '等埋我。', kind: 'speech',
  }] }))
  const merged = mergeTranslationResults(primary, audit)
  assert.deepEqual(merged.regions.map(({ id, source, translation }) => ({ id, source, translation })), [
    { id: 1, source: 'Wait for me.', translation: '等埋我。' },
    { id: 2, source: 'Hello', translation: '你好' },
  ])
})

test('audit merge keeps primary wording and already-valid geometry', () => {
  const primary = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 1, bubble: { x: 100, y: 100, width: 200, height: 200 }, safe: { x: 130, y: 130, width: 120, height: 100 },
    source: 'Hello!', translation: '你好！', kind: 'speech',
  }] }))
  const audit = parseTranslationOutput(JSON.stringify({ regions: [
    { id: 1, bubble: { x: 110, y: 110, width: 190, height: 190 }, safe: { x: 140, y: 140, width: 110, height: 100 }, source: ' hello ', translation: '重覆翻譯', kind: 'speech' },
    { id: 2, bubble: { x: 115, y: 115, width: 185, height: 185 }, safe: { x: 145, y: 145, width: 110, height: 100 }, source: 'Different OCR', translation: '重覆位置', kind: 'speech' },
  ] }))
  const merged = mergeTranslationResults(primary, audit)
  assert.deepEqual(merged.regions.map((region) => region.translation), ['你好！'])
  assert.deepEqual(merged.regions[0]?.safe, { x: 130, y: 130, width: 120, height: 100 })
})

test('audit failure preserves the completed primary result', async () => {
  const primary = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 1, bubble: { x: 100, y: 100, width: 200, height: 200 }, safe: { x: 130, y: 130, width: 120, height: 100 },
    source: 'Hello', translation: '你好', kind: 'speech',
  }] }))
  const merged = await withAuditFallback(primary, async () => { throw new Error('audit unavailable') })
  assert.deepEqual(merged, primary)
})

test('Max reasoning has enough time for dense manga pages', () => {
  assert.ok(codexTimeoutForEffort('max') >= 15 * 60_000)
  assert.ok(codexTimeoutForEffort('xhigh') >= 10 * 60_000)
})

test('a partially rendered chapter is not reported as a completed job', () => {
  assert.deepEqual(completionStatus(false), { status: 'completed', error: '' })
  assert.deepEqual(completionStatus(true), { status: 'failed', error: '部分頁面未能安全完成嵌字' })
})

test('store imports a series and chapters without duplicating them', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'transcomic-test-'))
  try {
    const store = new Store(folder)
    store.upsertSeries({
      hid: 'demo', title: '測試漫畫', altTitles: [], type: 'manga', status: 'releasing',
      originalLanguage: 'ja', poster: {}, latestChapter: 2, synopsis: '', url: '/title/demo',
    })
    const chapters = [
      { id: 101, mangaId: 1, number: 1, volume: 1, name: '', language: 'ja', url: '/title/demo/101-chapter-1' },
      { id: 102, mangaId: 1, number: 2, volume: 1, name: '', language: 'ja', url: '/title/demo/102-chapter-2' },
    ]
    store.upsertChapters('demo', chapters)
    store.upsertChapters('demo', chapters)
    assert.equal(store.listSeries()[0]?.chapter_count, 2)
    assert.deepEqual(store.listChapters('demo').map((chapter) => chapter.id), [102, 101])
    store.upsertChapters('demo', [chapters[1]])
    assert.deepEqual(store.listChapters('demo').map((chapter) => chapter.id), [102])
    store.upsertPages(102, [{ url: 'https://static.comix.to/page.webp', width: 600, height: 900 }])
    store.updatePage(102, 1, { translated_path: 'media/102/translated/001.webp', translation_json: JSON.stringify({ regions: [] }), status: 'completed' })
    store.resetChapterTranslation(102)
    assert.equal(store.listPages(102)[0]?.translated_path, '')
    assert.equal(store.listPages(102)[0]?.translation_json, '')
    assert.equal(store.listPages(102)[0]?.status, 'pending')
    store.createJob({ id: 'job-1', chapter_id: 102, model: 'gpt-5.6-luna', reasoning_effort: 'max' })
    assert.equal(store.getJob('job-1')?.reasoning_effort, 'max')
    store.db.close()
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('legacy translated files without translation data are retained but marked for manual retry', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'transcomic-legacy-test-'))
  try {
    const store = new Store(folder)
    store.upsertSeries({
      hid: 'legacy', title: '舊測試漫畫', altTitles: [], type: 'manga', status: 'releasing',
      originalLanguage: 'ja', poster: {}, latestChapter: 1, synopsis: '', url: '/title/legacy',
    })
    store.upsertChapters('legacy', [{ id: 201, mangaId: 1, number: 1, volume: 1, name: '', language: 'ja', url: '/title/legacy/201' }])
    store.upsertPages(201, [{ url: 'https://static.comix.to/page.webp', width: 600, height: 900 }])
    store.updatePage(201, 1, { translated_path: 'media/201/translated/001.webp', status: 'completed' })
    store.setChapterStatus(201, 'completed')
    store.db.close()

    const reopened = new Store(folder)
    const page = reopened.listPages(201)[0]!
    assert.equal(page.translated_path, 'media/201/translated/001.webp')
    assert.equal(page.status, 'needs_retranslation')
    assert.equal(hasTranslationOutput(page), false)
    assert.equal(reopened.getChapter(201)?.status, 'needs_retranslation')
    reopened.db.close()
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
