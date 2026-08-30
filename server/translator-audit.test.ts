import assert from 'node:assert/strict'
import test from 'node:test'
import {
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

test('completeness pipeline fails closed when the bounded third pass returns no regions', async () => {
  const hints = [{ text: 'WE HAVE NOT SEEN HIM', box: { x: 120, y: 20, width: 260, height: 28 }, confidence: 96 }]
  await assert.rejects(
    withCompletenessRepair({ regions: [] }, hints, async () => ({ regions: [] })),
    (error: unknown) => {
      assert.ok(error instanceof TranslationCompletenessError)
      assert.deepEqual(error.partialResult, { regions: [] })
      assert.deepEqual(error.unresolvedHints, hints)
      return true
    },
  )
})
