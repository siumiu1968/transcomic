import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { findResidualSourceText, renderTranslationDetailed } from './renderer.js'
import type { OcrWord } from './ocr.js'
import type { TranslationRegion } from './types.js'

const dialogue: TranslationRegion = {
  id: 7,
  bubble: { x: 100, y: 100, width: 500, height: 300 },
  safe: { x: 150, y: 150, width: 400, height: 200 },
  lines: [{ x: 180, y: 190, width: 330, height: 45 }],
  source: 'Hello brave world',
  translation: '你好，勇敢嘅世界。',
  kind: 'speech',
}

function word(text: string, x: number, y: number, confidence = 96): OcrWord {
  return { text, x, y, width: text.length * 10, height: 20, confidence, line: '1:1:1:1' }
}

test('residual QA reports source text seen at the same region position after rendering', () => {
  const original = [word('Hello', 120, 170), word('brave', 180, 170), word('world', 240, 170)]
  const rendered = [word('Hello', 122, 171), word('brave', 181, 170), word('世界', 242, 170)]
  assert.deepEqual(findResidualSourceText(original, rendered, [dialogue], {
    imageWidth: 800,
    imageHeight: 1000,
  }), [{
    regionId: 7,
    source: 'Hello brave world',
    residualText: 'hello brave',
    matchedWords: ['hello', 'brave'],
    sourceCoverage: 10 / 15,
    bounds: { x: 122, y: 170, width: 109, height: 21 },
  }])
})

test('residual QA accepts line-level OCR returned by RapidOCR', () => {
  const line = { ...word('Hello brave world', 120, 170), width: 220, engine: 'rapidocr' as const }
  const residual = findResidualSourceText([line], [{ ...line, x: 121 }], [dialogue], {
    imageWidth: 800,
    imageHeight: 1000,
  })
  assert.equal(residual.length, 1)
  assert.equal(residual[0]?.regionId, 7)
})

test('residual QA permits Latin names deliberately retained in the translation', () => {
  const bilingual = { ...dialogue, source: 'Hello world', translation: 'Hello，世界。' }
  const hello = word('Hello', 120, 170)
  assert.deepEqual(findResidualSourceText([hello], [{ ...hello, x: 121 }], [bilingual], {
    imageWidth: 800,
    imageHeight: 1000,
  }), [])
})

test('residual QA ignores moved text, credits, watermarks and SFX', () => {
  const original = [word('Hello', 120, 170), word('world', 240, 170)]
  const moved = [word('Hello', 600, 800), word('world', 680, 800)]
  const excluded: TranslationRegion[] = [
    { ...dialogue, id: 8, source: 'Typeset by Example Team', kind: 'narration' },
    { ...dialogue, id: 9, source: 'BANG', kind: 'sfx' },
    { ...dialogue, id: 10, source: 'www.example.com', kind: 'narration' },
  ]
  assert.deepEqual(findResidualSourceText(original, moved, [dialogue, ...excluded], {
    imageWidth: 800,
    imageHeight: 1000,
  }), [])
})

test('aggressive cleanup expands only a verified text-line mask', async () => {
  const source = Buffer.from('<svg width="300" height="300" xmlns="http://www.w3.org/2000/svg"><rect width="300" height="300" fill="#fff"/><rect x="100" y="100" width="50" height="20" fill="#111"/><rect x="157" y="108" width="2" height="2" fill="#111"/></svg>')
  const result = { regions: [{
    id: 1,
    bubble: { x: 200, y: 200, width: 600, height: 400 },
    safe: { x: 300, y: 300, width: 400, height: 200 },
    lines: [{ x: 333, y: 333, width: 167, height: 67 }],
    source: 'HELLO',
    translation: '好',
    kind: 'speech' as const,
  }] }
  const ocr = [word('HELLO', 100, 100)]
  const normal = await renderTranslationDetailed(source, result, ocr)
  const aggressive = await renderTranslationDetailed(source, result, {
    ocrWordsOverride: ocr,
    aggressiveRegionIds: [1],
  })
  assert.equal(aggressive.renderedRegions, 1)
  const normalResidual = await sharp(normal.image).extract({ left: 157, top: 108, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
  const aggressiveCleaned = await sharp(aggressive.image).extract({ left: 157, top: 108, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
  assert.ok(normalResidual[0] < 100)
  assert.ok(aggressiveCleaned[0] > 220)
})

test('aggressive cleanup fails closed when source-linked OCR is incomplete', async () => {
  const source = Buffer.from('<svg width="300" height="300" xmlns="http://www.w3.org/2000/svg"><rect width="300" height="300" fill="#fff"/><circle cx="125" cy="110" r="8" fill="#111"/></svg>')
  const rendered = await renderTranslationDetailed(source, { regions: [{
    id: 2,
    bubble: { x: 200, y: 200, width: 600, height: 400 },
    safe: { x: 300, y: 300, width: 400, height: 200 },
    lines: [{ x: 333, y: 333, width: 167, height: 67 }],
    source: 'HELLO WORLD',
    translation: '你好',
    kind: 'speech',
  }] }, {
    ocrWordsOverride: [word('HELLO', 100, 100)],
    aggressiveRegionIds: [2],
  })
  assert.equal(rendered.renderedRegions, 0)
  const artwork = await sharp(rendered.image).extract({ left: 125, top: 110, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
  assert.ok(artwork[0] < 80)
})
