import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeTranslationResults, parseTranslationOutput } from './translator.js'

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
