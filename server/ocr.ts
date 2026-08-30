import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import type { TranslationBox } from './types.js'

export interface OcrWord {
  x: number
  y: number
  width: number
  height: number
  confidence: number
  line: string
  text: string
}

export interface OcrHint {
  text: string
  box: TranslationBox
  confidence?: number
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0)
}

const tesseractWaiters: Array<() => void> = []
let activeTesseractProcesses = 0
const ocrCache = new Map<string, { expiresAt: number, promise: Promise<OcrWord[]> }>()

async function acquireTesseractSlot(): Promise<void> {
  if (activeTesseractProcesses < 2) {
    activeTesseractProcesses += 1
    return
  }
  await new Promise<void>((resolve) => {
    tesseractWaiters.push(() => {
      activeTesseractProcesses += 1
      resolve()
    })
  })
}

function releaseTesseractSlot(): void {
  activeTesseractProcesses = Math.max(0, activeTesseractProcesses - 1)
  tesseractWaiters.shift()?.()
}

export function parseTesseractTsv(value: string): OcrWord[] {
  return value.split(/\r?\n/u).flatMap((line) => {
    const fields = line.split('\t')
    if (fields.length < 12 || fields[0] !== '5') return []
    const [left, top, width, height, confidence] = fields.slice(6, 11).map(Number)
    const text = fields.slice(11).join('\t').trim()
    if (!text || ![left, top, width, height, confidence].every(Number.isFinite) || width <= 0 || height <= 0) return []
    return [{
      x: left,
      y: top,
      width,
      height,
      confidence,
      line: fields.slice(1, 5).join(':'),
      text,
    }]
  })
}

async function runTesseract(image: Buffer, psm: number): Promise<OcrWord[]> {
  await acquireTesseractSlot()
  try {
    return await new Promise((resolve) => {
      const child = spawn(process.env.TESSERACT_PATH ?? 'tesseract', ['stdin', 'stdout', '-l', 'eng', '--psm', String(psm), 'tsv'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, LC_ALL: 'C' },
      })
      const chunks: Buffer[] = []
      let bytes = 0
      let settled = false
      let timedOut = false
      let forceKill: ReturnType<typeof setTimeout> | undefined
      const finish = (words: OcrWord[]) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (forceKill) clearTimeout(forceKill)
        resolve(words)
      }
      const timeout = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        forceKill = setTimeout(() => child.kill('SIGKILL'), 1_000)
      }, 45_000)
      child.stdout.on('data', (chunk: Buffer) => {
        if (bytes >= 2_000_000) return
        chunks.push(chunk)
        bytes += chunk.length
      })
      child.once('error', () => finish([]))
      child.once('close', (code) => finish(!timedOut && code === 0 ? parseTesseractTsv(Buffer.concat(chunks).toString('utf8')) : []))
      child.stdin.on('error', () => {})
      child.stdin.end(image)
    })
  } finally {
    releaseTesseractSlot()
  }
}

export function detectTesseractWords(image: Buffer, psm = 11): Promise<OcrWord[]> {
  const now = Date.now()
  const key = `${psm}:${crypto.createHash('sha256').update(image).digest('hex')}`
  const cached = ocrCache.get(key)
  if (cached && cached.expiresAt > now) return cached.promise
  if (cached) ocrCache.delete(key)
  const promise = runTesseract(image, psm)
  ocrCache.set(key, { expiresAt: now + 10 * 60_000, promise })
  while (ocrCache.size > 32) {
    const oldest = ocrCache.keys().next().value as string | undefined
    if (!oldest) break
    ocrCache.delete(oldest)
  }
  return promise
}

export function buildOcrHints(words: OcrWord[], imageWidth: number, imageHeight: number): OcrHint[] {
  const groups = new Map<string, OcrWord[]>()
  for (const word of words) {
    if (word.confidence < 10 || !/[\p{L}\p{N}]/u.test(word.text)) continue
    const line = groups.get(word.line) ?? []
    line.push(word)
    groups.set(word.line, line)
  }
  return [...groups.values()].flatMap((line) => {
    const sorted = [...line].sort((left, right) => left.x - right.x)
    const text = sorted.map((word) => word.text).join(' ').trim().slice(0, 160)
    if (!text) return []
    const left = Math.min(...sorted.map((word) => word.x))
    const top = Math.min(...sorted.map((word) => word.y))
    const right = Math.max(...sorted.map((word) => word.x + word.width))
    const bottom = Math.max(...sorted.map((word) => word.y + word.height))
    // A stylised word can be recognised very confidently while adjacent
    // punctuation/noise is not. Use the reliable core instead of averaging
    // all words and accidentally hiding that clear OCR signal.
    const confidences = sorted.map((word) => word.confidence)
    const reliableCore = confidences.filter((confidence) => confidence >= 60)
    return [{
      text,
      box: {
        x: Math.max(0, Math.round(left / Math.max(1, imageWidth) * 1000)),
        y: Math.max(0, Math.round(top / Math.max(1, imageHeight) * 1000)),
        width: Math.max(1, Math.round((right - left) / Math.max(1, imageWidth) * 1000)),
        height: Math.max(1, Math.round((bottom - top) / Math.max(1, imageHeight) * 1000)),
      },
      confidence: Math.round(median(reliableCore.length > 0 ? reliableCore : confidences)),
    }]
  }).sort((left, right) => left.box.y - right.box.y || right.box.x - left.box.x).slice(0, 120)
}
