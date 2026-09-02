import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import { config, type OcrEngineName } from './config.js'
import type { TranslationBox } from './types.js'

export type OcrEngine = OcrEngineName

export interface OcrWord {
  x: number
  y: number
  width: number
  height: number
  confidence: number
  line: string
  text: string
  engine?: OcrEngine
  engines?: OcrEngine[]
}

export interface OcrHint {
  text: string
  box: TranslationBox
  confidence?: number
  engine?: OcrEngine
  engines?: OcrEngine[]
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
const ocrCache = new Map<string, { expiresAt: number, promise: Promise<OcrDetection> }>()
const tesseractCache = new Map<string, { expiresAt: number, promise: Promise<OcrWord[]> }>()

interface WorkerResponse {
  id: string
  words: OcrWord[]
  error?: string
}

interface OcrWorkerRequest {
  id: string
  image: Buffer
  resolve: (words: OcrWord[]) => void
  reject: (error: Error) => void
}

export interface OcrDetection {
  words: OcrWord[]
  successfulEngines: OcrEngine[]
  failedEngines: OcrEngine[]
}

export interface JsonlOcrWorkerOptions {
  pythonPath?: string
  workerPath?: string
  timeoutMs?: number
}

function ocrEngineError(engine: OcrEngine, detail: string): Error {
  return new Error(`${engine} OCR ${detail}`)
}

function isOcrEngine(value: unknown): value is OcrEngine {
  return value === 'rapidocr' || value === 'paddleocr' || value === 'tesseract'
}

function validatedWord(value: unknown, fallbackEngine?: OcrEngine): OcrWord | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<OcrWord>
  const numbers = [candidate.x, candidate.y, candidate.width, candidate.height, candidate.confidence]
  if (!numbers.every((number) => typeof number === 'number' && Number.isFinite(number))) return null
  if ((candidate.width ?? 0) <= 0 || (candidate.height ?? 0) <= 0 || typeof candidate.text !== 'string' || !candidate.text.trim()) return null
  const engine = isOcrEngine(candidate.engine) ? candidate.engine : fallbackEngine
  return {
    x: Math.round(candidate.x ?? 0),
    y: Math.round(candidate.y ?? 0),
    width: Math.max(1, Math.round(candidate.width ?? 0)),
    height: Math.max(1, Math.round(candidate.height ?? 0)),
    confidence: Math.max(0, Math.min(100, candidate.confidence ?? 0)),
    line: typeof candidate.line === 'string' && candidate.line ? candidate.line : `${engine ?? 'ocr'}:0`,
    text: candidate.text.trim(),
    ...(engine ? { engine, engines: [engine] } : {}),
  }
}

export function parseOcrWorkerResponse(value: string, fallbackEngine: OcrEngine): WorkerResponse | null {
  try {
    const parsed = JSON.parse(value) as { id?: unknown, words?: unknown, error?: unknown }
    if (typeof parsed.id !== 'string' || !Array.isArray(parsed.words)) return null
    return {
      id: parsed.id,
      words: parsed.words.flatMap((word) => {
        const validated = validatedWord(word, fallbackEngine)
        return validated ? [validated] : []
      }),
      ...(typeof parsed.error === 'string' && parsed.error.trim() ? { error: parsed.error.trim().slice(0, 500) } : {}),
    }
  } catch {
    return null
  }
}

function intersectionArea(left: OcrWord, right: OcrWord): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  return width * height
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, '')
}

export function wordsAreGeometricDuplicates(left: OcrWord, right: OcrWord): boolean {
  const intersection = intersectionArea(left, right)
  if (intersection <= 0) return false
  const leftArea = left.width * left.height
  const rightArea = right.width * right.height
  const containment = intersection / Math.max(1, Math.min(leftArea, rightArea))
  const iou = intersection / Math.max(1, leftArea + rightArea - intersection)
  if (iou >= 0.82) return true
  const leftText = normalizedText(left.text)
  const rightText = normalizedText(right.text)
  const shorterLength = Math.max(1, Math.min(leftText.length, rightText.length))
  const textLengthRatio = Math.max(leftText.length, rightText.length) / shorterLength
  const areaRatio = Math.max(leftArea, rightArea) / Math.max(1, Math.min(leftArea, rightArea))
  // RapidOCR commonly returns one whole row while Tesseract returns its
  // individual words. Both granularities are useful for coverage and cleanup,
  // so only collapse contained boxes when their text and area are comparable.
  return containment >= 0.82
    && textLengthRatio <= 1.65
    && areaRatio <= 2.2
    && Boolean(leftText && rightText && (leftText.includes(rightText) || rightText.includes(leftText)))
}

function wordQuality(word: OcrWord): number {
  return word.confidence + Math.min(20, normalizedText(word.text).length) * 0.4
}

function preferredDuplicate(left: OcrWord, right: OcrWord): OcrWord {
  const leftText = normalizedText(left.text)
  const rightText = normalizedText(right.text)
  if (leftText.includes(rightText) && leftText.length > rightText.length && left.confidence >= right.confidence - 12) return left
  if (rightText.includes(leftText) && rightText.length > leftText.length && right.confidence >= left.confidence - 12) return right
  return wordQuality(left) >= wordQuality(right) ? left : right
}

export function deduplicateOcrWords(words: OcrWord[]): OcrWord[] {
  const retained: OcrWord[] = []
  for (const candidate of [...words].sort((left, right) => wordQuality(right) - wordQuality(left))) {
    const duplicateIndexes = retained.flatMap((word, index) => wordsAreGeometricDuplicates(word, candidate) ? [index] : [])
    if (duplicateIndexes.length === 0) {
      retained.push({
        ...candidate,
        engines: [...new Set([...(candidate.engines ?? []), ...(candidate.engine ? [candidate.engine] : [])])],
      })
      continue
    }
    const duplicates = duplicateIndexes.flatMap((index) => retained[index] ? [retained[index]] : [])
    const preferred = duplicates.reduce(preferredDuplicate, candidate)
    const engines = [...new Set([preferred, candidate, ...duplicates].flatMap((word) => [
      ...(word.engines ?? []),
      ...(word.engine ? [word.engine] : []),
    ]))]
    for (const index of duplicateIndexes.sort((left, right) => right - left)) retained.splice(index, 1)
    retained.push({
      ...preferred,
      engines,
    })
  }
  return retained.sort((left, right) => left.y - right.y || left.x - right.x)
}

export class JsonlOcrWorker {
  private child?: ChildProcessWithoutNullStreams
  private stdoutBuffer = ''
  private disabledUntil = 0
  private readonly queued: OcrWorkerRequest[] = []
  private active?: OcrWorkerRequest & { timeout: ReturnType<typeof setTimeout> }
  private closing = false

  constructor(
    private readonly engine: Exclude<OcrEngine, 'tesseract'>,
    private readonly options: JsonlOcrWorkerOptions = {},
  ) {}

  run(image: Buffer): Promise<OcrWord[]> {
    if (this.closing) return Promise.reject(ocrEngineError(this.engine, 'worker is closed'))
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      this.queued.push({ id, image, resolve, reject })
      this.pump()
    })
  }

  close(): Promise<void> {
    this.closing = true
    const child = this.child
    const closed = child && child.exitCode === null
      ? new Promise<void>((resolve) => child.once('close', () => resolve()))
      : Promise.resolve()
    this.stop(child, ocrEngineError(this.engine, 'worker is shutting down'), false, false)
    return closed
  }

  private pump(): void {
    if (this.closing || this.active) return
    const request = this.queued.shift()
    if (!request) return
    const child = this.ensureStarted()
    if (!child) {
      request.reject(ocrEngineError(this.engine, 'worker is unavailable'))
      queueMicrotask(() => this.pump())
      return
    }
    const timeout = setTimeout(() => {
      this.stop(child, ocrEngineError(this.engine, 'request timed out'), false, true)
    }, this.options.timeoutMs ?? config.ocrWorkerTimeoutMs)
    this.active = { ...request, timeout }
    child.stdin.write(`${JSON.stringify({ id: request.id, image_base64: request.image.toString('base64') })}\n`, (error) => {
      if (error) this.stop(child, ocrEngineError(this.engine, 'stdin failed'))
    })
  }

  private ensureStarted(): ChildProcessWithoutNullStreams | undefined {
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child
    if (this.closing || Date.now() < this.disabledUntil) return undefined
    const child = spawn(this.options.pythonPath ?? config.ocrPythonPath, [
      '-u',
      this.options.workerPath ?? config.ocrWorkerPath,
      '--backend',
      this.engine,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    })
    this.child = child
    this.stdoutBuffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consume(chunk))
    child.stderr.resume()
    child.stdin.on('error', () => this.stop(child, ocrEngineError(this.engine, 'stdin failed')))
    child.once('error', () => this.stop(child, ocrEngineError(this.engine, 'worker failed')))
    child.once('close', (code) => this.stop(child, ocrEngineError(this.engine, `worker exited (${code ?? 'signal'})`)))
    return child
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk
    if (this.stdoutBuffer.length > 8_000_000) {
      this.stop()
      return
    }
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      const response = parseOcrWorkerResponse(line, this.engine)
      if (response && this.active?.id === response.id) {
        const active = this.active
        this.active = undefined
        clearTimeout(active.timeout)
        if (response.error) active.reject(ocrEngineError(this.engine, 'request failed'))
        else active.resolve(response.words)
        this.pump()
      }
      newline = this.stdoutBuffer.indexOf('\n')
    }
  }

  private stop(
    child = this.child,
    reason = ocrEngineError(this.engine, 'worker stopped'),
    disable = true,
    preserveQueued = false,
  ): void {
    if (child && this.child !== child) return
    this.child = undefined
    this.stdoutBuffer = ''
    if (disable && !this.closing) this.disabledUntil = Date.now() + 60_000
    if (child && !child.killed) child.kill('SIGKILL')
    if (this.active) {
      clearTimeout(this.active.timeout)
      this.active.reject(reason)
      this.active = undefined
    }
    if (!preserveQueued) {
      for (const queued of this.queued.splice(0)) queued.reject(reason)
    }
    if (preserveQueued && !this.closing) queueMicrotask(() => this.pump())
  }
}

const pythonWorkers = {
  rapidocr: new JsonlOcrWorker('rapidocr'),
  paddleocr: new JsonlOcrWorker('paddleocr'),
}

export async function shutdownOcrWorkers(): Promise<void> {
  await Promise.all(Object.values(pythonWorkers).map((worker) => worker.close()))
}

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
      engine: 'tesseract',
      engines: ['tesseract'],
    }]
  })
}

async function runTesseract(image: Buffer, psm: number): Promise<OcrWord[]> {
  await acquireTesseractSlot()
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(config.tesseractPath, ['stdin', 'stdout', '-l', 'eng', '--psm', String(psm), 'tsv'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, LC_ALL: 'C' },
      })
      const chunks: Buffer[] = []
      let bytes = 0
      let settled = false
      let timedOut = false
      let forceKill: ReturnType<typeof setTimeout> | undefined
      const finish = (error: Error | undefined, words: OcrWord[] = []) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (forceKill) clearTimeout(forceKill)
        if (error) reject(error)
        else resolve(words)
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
      child.once('error', () => finish(ocrEngineError('tesseract', 'process failed')))
      child.once('close', (code) => {
        if (timedOut) finish(ocrEngineError('tesseract', 'request timed out'))
        else if (code !== 0) finish(ocrEngineError('tesseract', `process exited (${code ?? 'signal'})`))
        else finish(undefined, parseTesseractTsv(Buffer.concat(chunks).toString('utf8')))
      })
      child.stdin.on('error', () => {})
      child.stdin.end(image)
    })
  } finally {
    releaseTesseractSlot()
  }
}

export function detectOcrWordsDetailed(image: Buffer, psm = 11): Promise<OcrDetection> {
  const now = Date.now()
  const key = `${config.ocrEngines.join(',')}:${psm}:${crypto.createHash('sha256').update(image).digest('hex')}`
  const cached = ocrCache.get(key)
  if (cached && cached.expiresAt > now) return cached.promise
  if (cached) ocrCache.delete(key)
  const promise = Promise.all(config.ocrEngines.map(async (engine) => {
    try {
      const words = engine === 'tesseract' ? await runTesseract(image, psm) : await pythonWorkers[engine].run(image)
      return { engine, words, success: true as const }
    } catch {
      return { engine, words: [], success: false as const }
    }
  })).then((results): OcrDetection => {
    const successfulEngines = results.filter(({ success }) => success).map(({ engine }) => engine)
    const detection = {
      words: deduplicateOcrWords(results.flatMap(({ words }) => words)),
      successfulEngines,
      failedEngines: results.filter(({ success }) => !success).map(({ engine }) => engine),
    }
    if (successfulEngines.length === 0) ocrCache.delete(key)
    return detection
  })
  ocrCache.set(key, { expiresAt: now + 10 * 60_000, promise })
  while (ocrCache.size > 32) {
    const oldest = ocrCache.keys().next().value as string | undefined
    if (!oldest) break
    ocrCache.delete(oldest)
  }
  return promise
}

export function detectOcrWords(image: Buffer, psm = 11): Promise<OcrWord[]> {
  return detectOcrWordsDetailed(image, psm).then(({ words }) => words)
}

/** Targeted crop fallback used by the renderer; full-page QA uses the ensemble above. */
export function detectTesseractWords(image: Buffer, psm = 11): Promise<OcrWord[]> {
  const now = Date.now()
  const key = `tesseract:${psm}:${crypto.createHash('sha256').update(image).digest('hex')}`
  const cached = tesseractCache.get(key)
  if (cached && cached.expiresAt > now) return cached.promise
  if (cached) tesseractCache.delete(key)
  // Regional OCR is an optional renderer fallback. A full-page detailed pass
  // is responsible for deciding whether OCR as a whole is available.
  const promise = runTesseract(image, psm).catch(() => [])
  tesseractCache.set(key, { expiresAt: now + 10 * 60_000, promise })
  while (tesseractCache.size > 32) {
    const oldest = tesseractCache.keys().next().value as string | undefined
    if (!oldest) break
    tesseractCache.delete(oldest)
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
    const engines = [...new Set(sorted.flatMap((word) => word.engines ?? (word.engine ? [word.engine] : [])))]
    return [{
      text,
      box: {
        x: Math.max(0, Math.round(left / Math.max(1, imageWidth) * 1000)),
        y: Math.max(0, Math.round(top / Math.max(1, imageHeight) * 1000)),
        width: Math.max(1, Math.round((right - left) / Math.max(1, imageWidth) * 1000)),
        height: Math.max(1, Math.round((bottom - top) / Math.max(1, imageHeight) * 1000)),
      },
      confidence: Math.round(median(reliableCore.length > 0 ? reliableCore : confidences)),
      ...(engines[0] ? { engine: engines[0], engines } : {}),
    }]
  }).sort((left, right) => left.box.y - right.box.y || right.box.x - left.box.x).slice(0, 120)
}
