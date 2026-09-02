import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCompletenessPrompt,
  findUncoveredDialogueHints,
  mergeCompletenessResults,
  mergeTranslationResults,
  parseTranslationOutput,
  TranslationCompletenessError,
  withCompletenessRepair,
} from './translator.js'

test('audit cannot erase valid primary line geometry with invalid replacement lines', () => {
  const primary = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 1,
    bubble: { x: 100, y: 100, width: 240, height: 220 },
    safe: { x: 130, y: 140, width: 170, height: 120 },
    lines: [{ x: 150, y: 160, width: 130, height: 24 }],
    source: 'Remember me.', translation: '記住我。', kind: 'speech',
  }] }))
  const audit = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 1,
    bubble: { x: 90, y: 90, width: 280, height: 260 },
    safe: { x: 120, y: 120, width: 200, height: 150 },
    lines: [{ x: 40, y: 40, width: 40, height: 20 }],
    source: 'Remember me.', translation: '唔應採用', kind: 'speech',
  }] }))

  assert.deepEqual(mergeTranslationResults(primary, audit), primary)
})

test('audit may supply missing line geometry without changing primary wording', () => {
  const primary = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 1,
    bubble: { x: 100, y: 100, width: 240, height: 220 },
    safe: { x: 130, y: 140, width: 170, height: 120 },
    source: 'Remember me.', translation: '記住我。', kind: 'speech',
  }] }))
  const audit = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 1,
    bubble: { x: 110, y: 110, width: 230, height: 210 },
    safe: { x: 140, y: 150, width: 160, height: 110 },
    lines: [{ x: 150, y: 165, width: 130, height: 24 }],
    source: 'Remember me.', translation: '唔應採用', kind: 'speech',
  }] }))

  const merged = mergeTranslationResults(primary, audit)
  assert.equal(merged.regions[0]?.translation, '記住我。')
  assert.deepEqual(merged.regions[0]?.lines, [{ x: 150, y: 165, width: 130, height: 24 }])
})

test('audit may correct existing geometry without changing primary wording', () => {
  const primary = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 1,
    bubble: { x: 100, y: 100, width: 240, height: 220 },
    safe: { x: 130, y: 140, width: 170, height: 120 },
    lines: [{ x: 150, y: 160, width: 130, height: 24 }],
    source: 'Remember me.', translation: '記住我。', kind: 'speech',
  }] }))
  const audit = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 1,
    bubble: { x: 500, y: 500, width: 240, height: 220 },
    safe: { x: 530, y: 540, width: 170, height: 120 },
    lines: [{ x: 550, y: 560, width: 130, height: 24 }],
    source: 'Remember me.', translation: '不應採用', kind: 'speech',
  }] }))

  const merged = mergeTranslationResults(primary, audit)
  assert.equal(merged.regions.length, 1)
  assert.equal(merged.regions[0]?.translation, '記住我。')
  assert.deepEqual(merged.regions[0]?.safe, { x: 530, y: 540, width: 170, height: 120 })
})

test('audit keeps heavily overlapping bubbles with different dialogue distinct', () => {
  const primary = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 1,
    bubble: { x: 100, y: 100, width: 200, height: 200 },
    safe: { x: 130, y: 130, width: 140, height: 120 },
    lines: [{ x: 145, y: 150, width: 110, height: 22 }],
    source: 'First bubble', translation: '第一個泡', kind: 'speech',
  }] }))
  const audit = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 2,
    bubble: { x: 115, y: 115, width: 200, height: 200 },
    safe: { x: 145, y: 145, width: 140, height: 120 },
    lines: [{ x: 160, y: 165, width: 110, height: 22 }],
    source: 'Second bubble', translation: '第二個泡', kind: 'speech',
  }] }))

  assert.equal(mergeTranslationResults(primary, audit).regions.length, 2)
})

test('parser accepts safe text geometry touching a genuinely clipped page edge', () => {
  const parsed = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 1,
    bubble: { x: 30, y: 0, width: 430, height: 170 },
    safe: { x: 70, y: 0, width: 350, height: 82 },
    lines: [{ x: 90, y: 1, width: 310, height: 20 }],
    source: 'YET THE MOMENT I HEARD THE OTHERS CRYING...',
    translation: '但當我聽到其他人喊嗰一刻……',
    kind: 'speech',
  }] }))

  assert.equal(parsed.regions.length, 1)
  assert.equal(parsed.regions[0]?.safe.y, 0)
})

test('OCR completeness gate catches obvious clipped dialogue outside translated safe boxes', () => {
  const translated = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 1,
    bubble: { x: 274, y: 384, width: 443, height: 317 },
    safe: { x: 338, y: 526, width: 313, height: 89 },
    lines: [{ x: 394, y: 529, width: 212, height: 17 }],
    source: "I'LL GO ASK THAT PERSON FOR HELP, LIKE YOU SUGGESTED.",
    translation: '我會照你嘅建議，去搵嗰個人幫手。',
    kind: 'speech',
  }] }))
  const hints = [
    { text: "I'LL GO ASK", box: { x: 396, y: 529, width: 219, height: 16 }, confidence: 91 },
    { text: "B, BUT HE ISN'T", box: { x: 155, y: 953, width: 272, height: 16 }, confidence: 95 },
    { text: 'COMING TO THE', box: { x: 148, y: 974, width: 285, height: 25 }, confidence: 95 },
  ]

  assert.deepEqual(findUncoveredDialogueHints(hints, translated).map(({ text }) => text), [
    "B, BUT HE ISN'T",
    'COMING TO THE',
  ])
})

test('OCR completeness gate accepts source-matched OCR inside a bubble but outside its narrow safe box', () => {
  const translated = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 1,
    bubble: { x: 792, y: 15, width: 208, height: 205 },
    safe: { x: 887, y: 56, width: 97, height: 71 },
    lines: [{ x: 900, y: 65, width: 70, height: 20 }],
    source: 'HUFF, HUFF... WHY...',
    translation: '呼、呼……點解……',
    kind: 'speech',
  }] }))
  const fragmentedHints = [
    { text: 'UFE', box: { x: 847, y: 52, width: 74, height: 24 }, confidence: 67 },
    { text: 'WHY...', box: { x: 838, y: 93, width: 85, height: 27 }, confidence: 100 },
  ]
  const unrelatedHint = { text: 'RUN NOW', box: { x: 805, y: 150, width: 100, height: 24 }, confidence: 98 }

  assert.deepEqual(findUncoveredDialogueHints(fragmentedHints, translated), [])
  assert.deepEqual(findUncoveredDialogueHints([unrelatedHint], translated).map(({ text }) => text), ['RUN NOW'])
})

test('OCR completeness gate joins nearby short rows but ignores isolated SFX and credits', () => {
  const hints = [
    { text: 'OLD', box: { x: 410, y: 30, width: 50, height: 18 }, confidence: 95 },
    { text: 'MAN', box: { x: 415, y: 55, width: 58, height: 18 }, confidence: 94 },
    { text: 'SNORT', box: { x: 700, y: 400, width: 90, height: 24 }, confidence: 90 },
    { text: 'DRIP DRIP', box: { x: 720, y: 500, width: 110, height: 18 }, confidence: 96 },
    { text: 'HUFF HUFF', box: { x: 710, y: 540, width: 120, height: 17 }, confidence: 94 },
    { text: 'WOBBLE WOBBLE', box: { x: 700, y: 575, width: 140, height: 18 }, confidence: 93 },
    { text: 'fake dialogue shaped artwork', box: { x: 500, y: 700, width: 180, height: 30 }, confidence: 42 },
    { text: 'DIVASCANS.ORG', box: { x: 20, y: 10, width: 180, height: 20 }, confidence: 92 },
    { text: 'CHAPTER 17', box: { x: 300, y: 900, width: 160, height: 18 }, confidence: 97 },
  ]

  assert.deepEqual(findUncoveredDialogueHints(hints, { regions: [] }).map(({ text }) => text), ['OLD', 'MAN'])
})

test('OCR completeness gate keeps only continuation story text on the actual end-credit page', () => {
  const hints = [
    { text: 'To Be Continued', box: { x: 320, y: 80, width: 360, height: 55 }, confidence: 97 },
    { text: 'Partners', box: { x: 420, y: 300, width: 160, height: 24 }, confidence: 96 },
    { text: 'All rights reserved', box: { x: 350, y: 345, width: 300, height: 20 }, confidence: 95 },
    { text: 'Published under license', box: { x: 330, y: 380, width: 340, height: 20 }, confidence: 94 },
    { text: 'All rights reserved. Published under license from partners', box: { x: 180, y: 397, width: 640, height: 20 }, confidence: 96 },
    { text: 'Translation and localization produced by', box: { x: 260, y: 415, width: 480, height: 20 }, confidence: 96 },
    { text: 'Produced by MOON STUDIO', box: { x: 340, y: 450, width: 320, height: 22 }, confidence: 93 },
    { text: 'tappytoon', box: { x: 420, y: 470, width: 160, height: 22 }, confidence: 96 },
    { text: 'STUDIO', box: { x: 450, y: 485, width: 100, height: 26 }, confidence: 92 },
    { text: 'LOGO', box: { x: 460, y: 520, width: 80, height: 24 }, confidence: 91 },
  ]

  assert.deepEqual(findUncoveredDialogueHints(hints, { regions: [] }).map(({ text }) => text), ['To Be Continued'])
})

test('OCR completeness gate retains generic labels when there is no strong credit context', () => {
  const hints = [
    { text: 'Partners', box: { x: 100, y: 80, width: 140, height: 28 }, confidence: 96 },
    { text: 'Studio', box: { x: 700, y: 280, width: 120, height: 28 }, confidence: 95 },
    { text: 'Logo', box: { x: 120, y: 480, width: 90, height: 28 }, confidence: 94 },
    { text: 'Our partners betrayed us.', box: { x: 100, y: 690, width: 310, height: 30 }, confidence: 96 },
    { text: 'The studio is on fire!', box: { x: 540, y: 760, width: 330, height: 30 }, confidence: 97 },
  ]

  assert.deepEqual(findUncoveredDialogueHints(hints, { regions: [] }).map(({ text }) => text), hints.map(({ text }) => text))
})

test('completeness repair is append-only for a repeated source region', () => {
  const current = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 1,
    bubble: { x: 100, y: 100, width: 240, height: 220 },
    safe: { x: 130, y: 140, width: 170, height: 120 },
    lines: [{ x: 150, y: 160, width: 130, height: 24 }],
    source: 'Remember me.', translation: '記住我。', kind: 'speech',
  }] }))
  const repair = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 2,
    bubble: { x: 90, y: 90, width: 280, height: 260 },
    safe: { x: 120, y: 120, width: 200, height: 150 },
    lines: [{ x: 145, y: 150, width: 140, height: 30 }],
    source: 'Remember me.', translation: '唔應覆寫', kind: 'speech',
  }] }))
  const candidate = { text: 'Remember me.', box: { x: 150, y: 160, width: 130, height: 24 }, confidence: 96 }

  const merged = mergeCompletenessResults(current, repair, [candidate])
  assert.deepEqual(merged, current)
})

test('bounded completeness repair can add multi-line frameless story narration', async () => {
  const hints = [
    { text: 'I DECIDED TO CLING', box: { x: 266, y: 58, width: 462, height: 18 }, confidence: 91 },
    { text: 'TO MY LIFE AGAIN.', box: { x: 301, y: 80, width: 392, height: 19 }, confidence: 95 },
    { text: "I DON'T WANT TO", box: { x: 210, y: 464, width: 310, height: 15 }, confidence: 96 },
    { text: 'DIE WITH YOU.', box: { x: 244, y: 487, width: 242, height: 15 }, confidence: 96 },
  ]
  const current = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 1,
    bubble: { x: 165, y: 365, width: 360, height: 250 },
    safe: { x: 206, y: 462, width: 260, height: 42 },
    lines: [{ x: 210, y: 464, width: 250, height: 15 }, { x: 244, y: 487, width: 220, height: 15 }],
    source: "I DON'T WANT TO DIE WITH YOU.", translation: '我唔想同你一齊死。', kind: 'speech',
  }] }))
  const narration = parseTranslationOutput(JSON.stringify({ regions: [{
    id: 2,
    bubble: { x: 258, y: 50, width: 478, height: 58 },
    safe: { x: 264, y: 56, width: 466, height: 48 },
    lines: [{ x: 266, y: 58, width: 462, height: 18 }, { x: 301, y: 80, width: 392, height: 19 }],
    source: 'I DECIDED TO CLING TO MY LIFE AGAIN.', translation: '我決定再次珍惜自己嘅生命。', kind: 'narration',
  }] }))

  const candidates = findUncoveredDialogueHints(hints, current)
  assert.deepEqual(candidates, hints.slice(0, 2))
  const prompt = buildCompletenessPrompt(current, candidates)
  assert.match(prompt, /旁白可以冇可見旁白框/u)
  assert.match(prompt, /kind=narration/u)
  assert.match(prompt, /唔適用於孤立／重複聲效、作品／章節名、署名、網站或版權字樣/u)

  const repaired = await withCompletenessRepair(current, hints, async () => narration)
  assert.deepEqual(repaired.regions.map(({ kind, source }) => ({ kind, source })), [
    { kind: 'narration', source: 'I DECIDED TO CLING TO MY LIFE AGAIN.' },
    { kind: 'speech', source: "I DON'T WANT TO DIE WITH YOU." },
  ])
})

test('completeness pipeline fails closed when the bounded third pass returns no regions', async () => {
  const hints = [{ text: 'WE HAVE NOT SEEN HIM', box: { x: 120, y: 20, width: 260, height: 28 }, confidence: 96 }]
  await assert.rejects(
    withCompletenessRepair({ regions: [] }, hints, async () => ({ regions: [] })),
    (error: unknown) => {
      assert.ok(error instanceof TranslationCompletenessError)
      assert.deepEqual(error.partialResult, { regions: [], memory_delta: [] })
      assert.deepEqual(error.unresolvedHints, hints)
      return true
    },
  )
})

test('completeness pipeline accepts OCR candidates explicitly classified as non-dialogue', async () => {
  const hints = [{ text: 'COFFEE SHOP', box: { x: 100, y: 100, width: 240, height: 80 }, confidence: 96 }]
  const result = await withCompletenessRepair({ regions: [] }, hints, async () => ({
    regions: [],
    ignored_ocr: [1],
  }))
  assert.deepEqual(result.regions, [])
})
