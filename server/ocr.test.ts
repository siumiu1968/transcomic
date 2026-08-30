import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOcrHints, parseTesseractTsv } from './ocr.js'

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
