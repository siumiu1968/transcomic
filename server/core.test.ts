import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { isAllowedSourceUrl } from './comix.js'
import { config } from './config.js'
import { hasTranslationOutput, Store } from './db.js'
import { completionStatus, TranslationQueue } from './queue.js'
import { balanceTranslationLines, detectVisualTextLines, filterUsableOcrLines, matchEdgeClippedOcrLines, matchOcrLines, modelBackedVisualLinesAreTight, normalizeDisplayText, planNarrationCaption, renderTranslation, renderTranslationDetailed } from './renderer.js'
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

test('visual fallback accepts tall colored lettering only when model geometry backs it', async () => {
  const source = Buffer.from('<svg width="600" height="900" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="900" fill="#fff"/><rect x="240" y="365" width="20" height="38" fill="#985f38"/><rect x="270" y="365" width="24" height="38" fill="#985f38"/><rect x="330" y="388" width="8" height="8" fill="#985f38"/><rect x="343" y="388" width="8" height="8" fill="#985f38"/></svg>')
  const region = {
    x: 150,
    y: 270,
    width: 300,
    height: 270,
    safe: { x: 228, y: 351, width: 150, height: 81 },
    lines: [{ x: 234, y: 360, width: 132, height: 54 }],
    source: 'SO',
    text: '所以……',
    kind: 'speech' as const,
  }
  const visual = await detectVisualTextLines(source, region)
  assert.equal(visual.length, 1)
  assert.ok(visual[0].height >= 38)
})

test('model-backed visual full erase rejects a large CV box with one-way overlap only', () => {
  assert.equal(modelBackedVisualLinesAreTight(
    [{ x: 306, y: 753, width: 89, height: 51 }],
    [{ x: 314, y: 761, width: 74, height: 41 }],
  ), true)
  assert.equal(modelBackedVisualLinesAreTight(
    [{ x: 50, y: 80, width: 300, height: 80 }],
    [{ x: 100, y: 100, width: 100, height: 40 }],
  ), false)
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

test('OCR line matching keeps a high-confidence stutter initial beside matched dialogue', () => {
  const lines = matchOcrLines([
    { x: 100, y: 140, width: 18, height: 20, confidence: 94, line: '1:9:1:1', text: 'B,' },
    { x: 126, y: 140, width: 40, height: 20, confidence: 96, line: '1:1:1:1', text: 'BUT' },
    { x: 174, y: 140, width: 30, height: 20, confidence: 95, line: '1:1:1:1', text: 'HE' },
  ], {
    x: 80,
    y: 100,
    width: 180,
    height: 100,
    source: 'B, BUT HE',
  })
  assert.deepEqual(lines, [{ x: 100, y: 140, width: 104, height: 20 }])
})

test('model line height admits a verified outlined OCR row in a short safe box', () => {
  const outlined = { x: 799, y: 564, width: 143, height: 38 }
  assert.deepEqual(filterUsableOcrLines([outlined], {
    safe: { x: 797, y: 576, width: 148, height: 42 },
    lines: [{ x: 800, y: 579, width: 143, height: 37 }],
  }), [outlined])
  assert.deepEqual(filterUsableOcrLines([outlined], {
    safe: { x: 797, y: 576, width: 148, height: 42 },
    lines: [],
  }), [])
})

test('narration caption fallback requires complete OCR aligned to every model row', () => {
  const narration = {
    x: 80,
    y: 100,
    width: 300,
    height: 200,
    safe: { x: 100, y: 120, width: 260, height: 120 },
    lines: [
      { x: 116, y: 136, width: 136, height: 28 },
      { x: 140, y: 172, width: 140, height: 28 },
    ],
    source: 'THE NIGHT REMEMBERS',
    text: '黑夜仍然記得。',
    kind: 'narration' as const,
  }
  const ocr = [
    { x: 120, y: 140, width: 42, height: 20, confidence: 96, line: '1:1:1:1', text: 'THE' },
    { x: 170, y: 140, width: 78, height: 20, confidence: 94, line: '1:1:1:1', text: 'NIGHT' },
    { x: 145, y: 176, width: 130, height: 20, confidence: 92, line: '1:1:1:2', text: 'REMEMBERS' },
  ]

  assert.deepEqual(planNarrationCaption(ocr, narration, 600, 900), {
    bounds: { x: 113, y: 135, width: 169, height: 66 },
    lines: [
      { x: 120, y: 140, width: 128, height: 20 },
      { x: 145, y: 176, width: 130, height: 20 },
    ],
  })
  assert.equal(planNarrationCaption(ocr, { ...narration, kind: 'speech' }, 600, 900), null)
  assert.equal(planNarrationCaption(ocr, {
    ...narration,
    lines: narration.lines.map((line) => ({ ...line, y: line.y + 90 })),
  }, 600, 900), null)
  assert.equal(planNarrationCaption(ocr.map((word) => ({ ...word, text: 'WRONG' })), narration, 600, 900), null)
})

test('narration caption uses complete contiguous OCR geometry for tight regions', () => {
  const narration = {
    x: 100,
    y: 120,
    width: 180,
    height: 110,
    safe: { x: 105, y: 125, width: 170, height: 100 },
    lines: [
      { x: 108, y: 128, width: 128, height: 28 },
      { x: 106, y: 161, width: 158, height: 28 },
    ],
    source: 'THE NIGHT STILL REMEMBERS EVERYTHING',
    text: '黑夜仍然記得一切。',
    kind: 'narration' as const,
  }
  const ocr = [
    { x: 112, y: 132, width: 35, height: 20, confidence: 96, line: '1:1:1:1', text: 'THE' },
    { x: 154, y: 132, width: 76, height: 20, confidence: 94, line: '1:1:1:1', text: 'NIGHT' },
    { x: 110, y: 165, width: 42, height: 20, confidence: 93, line: '1:1:1:2', text: 'STILL' },
    { x: 159, y: 165, width: 101, height: 20, confidence: 91, line: '1:1:1:2', text: 'REMEMBERS' },
    { x: 120, y: 198, width: 130, height: 20, confidence: 95, line: '1:1:1:3', text: 'EVERYTHING' },
  ]
  const plan = planNarrationCaption(ocr, narration, 600, 900)
  assert.deepEqual(plan, {
    bounds: { x: 103, y: 127, width: 164, height: 96 },
    lines: [
      { x: 112, y: 132, width: 118, height: 20 },
      { x: 110, y: 165, width: 150, height: 20 },
      { x: 120, y: 198, width: 130, height: 20 },
    ],
  })
  assert.ok((plan?.bounds.width ?? 0) * (plan?.bounds.height ?? 0) > narration.width * narration.height * 0.7)

  const disjoint = ocr.map((word) => word.line === '1:1:1:3' ? { ...word, y: word.y + 55 } : word)
  assert.equal(planNarrationCaption(disjoint, narration, 600, 900), null)
  assert.equal(planNarrationCaption([
    ...ocr,
    { x: 125, y: 220, width: 65, height: 20, confidence: 93, line: '1:1:1:4', text: 'AGAIN' },
    { x: 120, y: 242, width: 90, height: 20, confidence: 92, line: '1:1:1:5', text: 'FOREVER' },
  ], {
    ...narration,
    height: 140,
    safe: { ...narration.safe, height: 130 },
    source: `${narration.source} AGAIN FOREVER`,
  }, 600, 900), null)
})

test('narration caption without model rows requires at least two strict-safe OCR rows', () => {
  const narration = {
    x: 90,
    y: 90,
    width: 220,
    height: 100,
    safe: { x: 100, y: 100, width: 200, height: 80 },
    lines: [],
    source: 'ONLY THE TRUTH',
    text: '只有真相。',
    kind: 'narration' as const,
  }
  const ocr = [
    { x: 115, y: 112, width: 50, height: 18, confidence: 96, line: '1:1:1:1', text: 'ONLY' },
    { x: 172, y: 112, width: 38, height: 18, confidence: 95, line: '1:1:1:1', text: 'THE' },
    { x: 125, y: 145, width: 90, height: 18, confidence: 94, line: '1:1:1:2', text: 'TRUTH' },
  ]
  assert.ok(planNarrationCaption(ocr, narration, 600, 900))
  assert.equal(planNarrationCaption(ocr.filter((word) => word.line === '1:1:1:1'), { ...narration, source: 'ONLY THE' }, 600, 900), null)
  assert.equal(planNarrationCaption(ocr.map((word) => word.line === '1:1:1:2' ? { ...word, y: 192 } : word), narration, 600, 900), null)
})

test('model-backed narration tolerates one cropped single-letter source word', () => {
  const narration = {
    x: 80,
    y: 100,
    width: 360,
    height: 130,
    safe: { x: 90, y: 105, width: 340, height: 115 },
    lines: [
      { x: 100, y: 112, width: 300, height: 24 },
      { x: 110, y: 150, width: 280, height: 24 },
    ],
    source: 'I WANTED TO RUN TO THAT PERSON RIGHT AWAY',
    text: '我想即刻跑到嗰個人身邊。',
    kind: 'narration' as const,
  }
  const ocr = [
    { x: 105, y: 114, width: 105, height: 20, confidence: 96, line: '1:1:1:1', text: 'WANTED' },
    { x: 218, y: 114, width: 35, height: 20, confidence: 95, line: '1:1:1:1', text: 'TO' },
    { x: 112, y: 153, width: 48, height: 20, confidence: 96, line: '1:1:1:2', text: 'RUN' },
    { x: 168, y: 153, width: 35, height: 20, confidence: 95, line: '1:1:1:2', text: 'TO' },
    { x: 211, y: 153, width: 58, height: 20, confidence: 95, line: '1:1:1:2', text: 'THAT' },
    { x: 277, y: 153, width: 82, height: 20, confidence: 95, line: '1:1:1:2', text: 'PERSON' },
    { x: 120, y: 188, width: 68, height: 20, confidence: 96, line: '1:1:1:3', text: 'RIGHT' },
    { x: 196, y: 188, width: 58, height: 20, confidence: 96, line: '1:1:1:3', text: 'AWAY' },
  ]
  assert.ok(planNarrationCaption(ocr, narration, 600, 900))
  assert.equal(planNarrationCaption(ocr, { ...narration, lines: [], safe: { ...narration.safe, height: 120 } }, 600, 900), null)
})

test('model-backed narration limits a stylized OCR miss to one short source word', () => {
  const narration = {
    x: 80,
    y: 100,
    width: 360,
    height: 120,
    safe: { x: 90, y: 105, width: 340, height: 105 },
    lines: [
      { x: 100, y: 112, width: 300, height: 24 },
      { x: 110, y: 155, width: 280, height: 24 },
    ],
    source: 'WE BRAVELY MUSTERED UP THE COURAGE',
    text: '我哋鼓起咗勇氣。',
    kind: 'narration' as const,
  }
  const ocr = [
    { x: 105, y: 114, width: 35, height: 20, confidence: 96, line: '1:1:1:1', text: 'WE' },
    { x: 148, y: 114, width: 70, height: 20, confidence: 96, line: '1:1:1:1', text: 'BRAVELY' },
    { x: 226, y: 114, width: 110, height: 20, confidence: 95, line: '1:1:1:1', text: 'MUSTERED' },
    { x: 344, y: 114, width: 32, height: 20, confidence: 82, line: '1:1:1:1', text: 'UF' },
    { x: 115, y: 157, width: 52, height: 20, confidence: 96, line: '1:1:1:2', text: 'THE' },
    { x: 175, y: 157, width: 135, height: 20, confidence: 94, line: '1:1:1:2', text: 'COURAGE' },
  ]
  assert.ok(planNarrationCaption(ocr, narration, 600, 900))
  assert.equal(planNarrationCaption(ocr, { ...narration, source: 'WE BRAVELY MUSTERED UP TO THE COURAGE' }, 600, 900), null)
})

test('renderer accepts one clipped top row only when three clear OCR rows align', () => {
  const region = {
    x: 100,
    y: 0,
    width: 400,
    height: 240,
    safe: { x: 140, y: 0, width: 320, height: 150 },
    lines: [
      { x: 240, y: 0, width: 120, height: 20 },
      { x: 220, y: 40, width: 160, height: 25 },
      { x: 230, y: 72, width: 140, height: 25 },
      { x: 200, y: 104, width: 200, height: 25 },
    ],
    source: 'TOP THE REST IS CLEAR ENOUGH NOW',
  }
  const clearRows = [
    { x: 242, y: 0, width: 30, height: 12, confidence: 35, line: '1:1:1:1', text: '(OU' },
    { x: 278, y: 0, width: 38, height: 12, confidence: 29, line: '1:1:1:1', text: 'TMeKR' },
    { x: 322, y: 0, width: 75, height: 12, confidence: 0, line: '1:1:1:1', text: 'VANGECKROUHNS' },
    { x: 225, y: 43, width: 55, height: 19, confidence: 96, line: '1:1:1:2', text: 'THE' },
    { x: 288, y: 43, width: 86, height: 19, confidence: 95, line: '1:1:1:2', text: 'REST' },
    { x: 235, y: 75, width: 28, height: 19, confidence: 93, line: '1:1:1:3', text: 'IS' },
    { x: 271, y: 75, width: 94, height: 19, confidence: 97, line: '1:1:1:3', text: 'CLEAR' },
    { x: 205, y: 107, width: 120, height: 19, confidence: 94, line: '1:1:1:4', text: 'ENOUGH' },
    { x: 333, y: 107, width: 62, height: 19, confidence: 96, line: '1:1:1:4', text: 'NOW' },
  ]

  assert.deepEqual(matchEdgeClippedOcrLines(clearRows, region, 600, 900), [
    region.lines[0],
    { x: 225, y: 43, width: 149, height: 19 },
    { x: 235, y: 75, width: 130, height: 19 },
    { x: 205, y: 107, width: 190, height: 19 },
  ])
  const fuzzyEdgeRows = [
    ...clearRows,
    { x: 245, y: 0, width: 90, height: 18, confidence: 12, line: '1:1:1:1', text: 'DANGEROUS' },
  ]
  assert.deepEqual(matchEdgeClippedOcrLines(fuzzyEdgeRows, {
    ...region,
    source: 'TO HER DANGEROUS THE REST IS CLEAR ENOUGH NOW',
  }, 600, 900), [
    region.lines[0],
    { x: 225, y: 43, width: 149, height: 19 },
    { x: 235, y: 75, width: 130, height: 19 },
    { x: 205, y: 107, width: 190, height: 19 },
  ])
  assert.deepEqual(matchEdgeClippedOcrLines(clearRows, {
    ...region,
    y: 1,
    safe: { ...region.safe, y: 1 },
    lines: region.lines.map((line) => ({ ...line, y: line.y + 1 })),
  }, 600, 900), [])
  assert.deepEqual(matchEdgeClippedOcrLines(clearRows.map((word) => word.line === '1:1:1:3' ? { ...word, confidence: 59 } : word), region, 600, 900), [])
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

test('stopping the queue requeues an interrupted active page', async () => {
  const databaseFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'transcomic-shutdown-test-'))
  const chapterId = 8_000_000_000 + process.pid
  const mediaFolder = path.join(config.dataDir, 'media', String(chapterId))
  const originalFolder = path.join(mediaFolder, 'original')
  const originalPath = path.join(originalFolder, '001.webp')
  const sourcePage = { url: 'https://static.comix.to/shutdown-test.webp', width: 120, height: 180, scramble: false }
  const store = new Store(databaseFolder)
  try {
    store.upsertSeries({
      hid: 'shutdown-test', title: '關閉測試', altTitles: [], type: 'manga', status: 'releasing',
      originalLanguage: 'en', poster: {}, latestChapter: 1, synopsis: '', url: '/title/shutdown-test',
    })
    store.upsertChapters('shutdown-test', [{ id: chapterId, mangaId: 1, number: 1, volume: 1, name: '', language: 'en', url: '/title/shutdown-test/chapter-1' }])
    store.upsertPages(chapterId, [sourcePage])
    fs.mkdirSync(originalFolder, { recursive: true })
    fs.writeFileSync(originalPath, await sharp({ create: { width: 120, height: 180, channels: 3, background: '#fff' } }).webp().toBuffer())
    store.updatePage(chapterId, 1, { original_path: `media/${chapterId}/original/001.webp` })
    store.createJob({ id: 'shutdown-job', chapter_id: chapterId, model: 'gpt-5.6-luna', reasoning_effort: 'max' })

    let rejectTranslation: ((error: Error) => void) | undefined
    let translationStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { translationStarted = resolve })
    const translator = {
      translate: () => new Promise((_, reject) => {
        rejectTranslation = reject
        translationStarted?.()
      }),
    } as unknown as ConstructorParameters<typeof TranslationQueue>[2]
    const comix = {
      getChapterPages: async () => [sourcePage],
    } as unknown as ConstructorParameters<typeof TranslationQueue>[1]
    const queue = new TranslationQueue(store, comix, translator)
    queue.start()
    await started
    const stopped = queue.stop()
    rejectTranslation?.(new Error('translation process stopped'))
    await stopped

    assert.equal(store.getJob('shutdown-job')?.status, 'queued')
    assert.equal(store.listPages(chapterId)[0]?.status, 'pending')
    assert.equal(store.getChapter(chapterId)?.status, 'queued')
  } finally {
    store.db.close()
    fs.rmSync(databaseFolder, { recursive: true, force: true })
    fs.rmSync(mediaFolder, { recursive: true, force: true })
  }
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
