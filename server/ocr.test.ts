import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ocrEngines } from './config.js'
import { buildOcrHints, deduplicateOcrWords, JsonlOcrWorker, parseOcrWorkerResponse, parseTesseractTsv } from './ocr.js'

test('Tesseract TSV becomes reading-order OCR hints', () => {
  const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext'
  const words = parseTesseractTsv([
    header,
    '5\t1\t1\t1\t1\t1\t400\t100\t50\t20\t96\tOLD',
    '5\t1\t1\t1\t1\t2\t455\t100\t55\t20\t95\tMAN',
    '5\t1\t2\t1\t1\t1\t700\t40\t70\t20\t94\tWAIT',
  ].join('\n'))
  assert.deepEqual(buildOcrHints(words, 1000, 1000).map(({ text }) => text), ['WAIT', 'OLD MAN'])
})

test('OCR hint confidence keeps a clear word despite low-confidence neighbours', () => {
  const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext'
  const words = parseTesseractTsv([
    header,
    '5\t1\t1\t1\t1\t1\t100\t100\t70\t20\t95\tCLEAR',
    '5\t1\t1\t1\t1\t2\t175\t100\t30\t20\t20\tnoisy',
    '5\t1\t1\t1\t1\t3\t210\t100\t30\t20\t20\tmarks',
  ].join('\n'))

  assert.equal(buildOcrHints(words, 1000, 1000)[0]?.confidence, 95)
})

test('OCR engine config ignores unknown engines and always keeps Tesseract fallback', () => {
  assert.deepEqual(ocrEngines('rapidocr,unknown,rapidocr'), ['rapidocr', 'tesseract'])
  assert.deepEqual(ocrEngines('paddleocr'), ['paddleocr', 'tesseract'])
})

test('Python JSONL response is validated and tagged with its engine', () => {
  const response = parseOcrWorkerResponse(JSON.stringify({
    id: 'request-1',
    words: [
      { x: 12.4, y: 20, width: 80, height: 22, confidence: 92.5, line: 'rapidocr:0', text: 'STYLISED' },
      { x: 0, y: 0, width: -1, height: 2, confidence: 99, text: 'invalid' },
    ],
  }), 'rapidocr')

  assert.equal(response?.words.length, 1)
  assert.deepEqual(response?.words[0], {
    x: 12,
    y: 20,
    width: 80,
    height: 22,
    confidence: 92.5,
    line: 'rapidocr:0',
    text: 'STYLISED',
    engine: 'rapidocr',
    engines: ['rapidocr'],
  })
  const failed = parseOcrWorkerResponse(JSON.stringify({
    id: 'request-2',
    error: 'RuntimeError: model unavailable',
    words: [],
  }), 'rapidocr')
  assert.equal(failed?.error, 'RuntimeError: model unavailable')
  assert.deepEqual(failed?.words, [])
})

test('OCR union removes geometric duplicates but retains engine provenance and misses', () => {
  const words = deduplicateOcrWords([
    { x: 100, y: 100, width: 160, height: 32, confidence: 93, line: 'rapidocr:0', text: 'BIG COLOUR', engine: 'rapidocr' },
    { x: 102, y: 101, width: 60, height: 30, confidence: 95, line: '1:1:1:1', text: 'BIG', engine: 'tesseract' },
    { x: 400, y: 220, width: 105, height: 28, confidence: 87, line: 'rapidocr:1', text: 'ITALIC', engine: 'rapidocr' },
    { x: 402, y: 221, width: 103, height: 27, confidence: 91, line: '1:1:1:2', text: 'ITALIC', engine: 'tesseract' },
  ])

  assert.equal(words.length, 3)
  assert.equal(words[0]?.text, 'BIG COLOUR')
  assert.equal(words[1]?.text, 'BIG')
  assert.equal(words[2]?.text, 'ITALIC')
  assert.deepEqual(words[2]?.engines, ['tesseract', 'rapidocr'])
})

test('Python OCR worker times out only the active request and restarts for the queued request', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'transcomic-ocr-worker-'))
  const workerPath = path.join(folder, 'worker.py')
  fs.writeFileSync(workerPath, [
    'import base64, json, sys, time',
    'for line in sys.stdin:',
    '    request = json.loads(line)',
    '    image = base64.b64decode(request["image_base64"])',
    '    if image == b"first": time.sleep(0.4)',
    '    response = {"id": request["id"], "words": [{"x": 1, "y": 2, "width": 30, "height": 12, "confidence": 95, "line": "fixture:0", "text": "OK"}]}',
    '    print(json.dumps(response), flush=True)',
  ].join('\n'))
  const worker = new JsonlOcrWorker('rapidocr', {
    pythonPath: 'python3',
    workerPath,
    timeoutMs: 200,
  })
  try {
    const [first, second] = await Promise.allSettled([worker.run(Buffer.from('first')), worker.run(Buffer.from('second'))])
    assert.equal(first.status, 'rejected')
    assert.equal(second.status, 'fulfilled')
    assert.equal(second.status === 'fulfilled' ? second.value[0]?.text : undefined, 'OK')
    await worker.close()
    await assert.rejects(worker.run(Buffer.from('after-close')), /worker is closed/u)
  } finally {
    await worker.close()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('Python OCR worker contains stdin EPIPE when the child closes its input', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'transcomic-ocr-epipe-'))
  const workerPath = path.join(folder, 'worker.py')
  fs.writeFileSync(workerPath, [
    'import json, sys, time',
    'request = json.loads(sys.stdin.readline())',
    'print(json.dumps({"id": request["id"], "words": [{"x": 1, "y": 2, "width": 30, "height": 12, "confidence": 95, "line": "fixture:0", "text": "FIRST"}]}), flush=True)',
    'sys.stdin.close()',
    'time.sleep(1)',
  ].join('\n'))
  const worker = new JsonlOcrWorker('rapidocr', {
    pythonPath: 'python3',
    workerPath,
    timeoutMs: 500,
  })
  try {
    const [first, second] = await Promise.allSettled([worker.run(Buffer.from('first')), worker.run(Buffer.from('second'))])
    assert.equal(first.status, 'fulfilled')
    assert.equal(first.status === 'fulfilled' ? first.value[0]?.text : undefined, 'FIRST')
    assert.equal(second.status, 'rejected')
  } finally {
    await worker.close()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
