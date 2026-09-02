import path from 'node:path'
import { loadEnvFile } from 'node:process'

try {
  loadEnvFile()
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}

function integer(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(value) ? value : fallback
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, integer(name, fallback)))
}

const reasoningEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = typeof reasoningEfforts[number]

function reasoningEffort(name: string, fallback: ReasoningEffort): ReasoningEffort {
  const value = process.env[name]
  return reasoningEfforts.includes(value as ReasoningEffort) ? value as ReasoningEffort : fallback
}

export function assertTranslationModel(value: string, name = '翻譯模型'): 'gpt-5.6-luna' {
  if (value !== 'gpt-5.6-luna') throw new Error(`${name} 只允許使用 gpt-5.6-luna`)
  return value
}

function translationModel(name: string): 'gpt-5.6-luna' {
  return assertTranslationModel(process.env[name]?.trim() || 'gpt-5.6-luna', name)
}

const supportedOcrEngines = ['rapidocr', 'paddleocr', 'tesseract'] as const
export type OcrEngineName = typeof supportedOcrEngines[number]

export function ocrEngines(value = process.env.OCR_ENGINES): OcrEngineName[] {
  const requested = (value ?? 'rapidocr,tesseract')
    .split(',')
    .map((engine) => engine.trim().toLowerCase())
    .filter((engine): engine is OcrEngineName => supportedOcrEngines.includes(engine as OcrEngineName))
  return [...new Set([...requested, 'tesseract' as const])]
}

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: integer('PORT', 4178),
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  authMode: process.env.AUTH_MODE ?? (process.env.NODE_ENV === 'production' ? 'proxy' : 'off'),
  trustedHeader: (process.env.TRUSTED_PROXY_HEADER ?? 'x-transcomic-admin').toLowerCase(),
  trustedValue: process.env.TRUSTED_PROXY_VALUE ?? '1',
  comixProxyUrl: process.env.COMIX_PROXY_URL,
  comixBootstrapUrl: process.env.COMIX_BOOTSTRAP_URL ?? 'https://comix.to/title/n9vgy',
  browserExecutablePath: process.env.PATCHRIGHT_EXECUTABLE_PATH,
  browserHeadless: process.env.BROWSER_HEADLESS !== '0',
  modelFast: translationModel('TRANSLATION_MODEL_FAST'),
  modelBalanced: translationModel('TRANSLATION_MODEL_BALANCED'),
  modelQuality: translationModel('TRANSLATION_MODEL_QUALITY'),
  effortFast: reasoningEffort('TRANSLATION_EFFORT_FAST', 'low'),
  effortBalanced: reasoningEffort('TRANSLATION_EFFORT_BALANCED', 'high'),
  effortQuality: reasoningEffort('TRANSLATION_EFFORT_QUALITY', 'max'),
  effortAudit: reasoningEffort('TRANSLATION_EFFORT_AUDIT', 'low'),
  translationChapterConcurrency: boundedInteger('TRANSLATION_CHAPTER_CONCURRENCY', 2, 1, 4),
  maxImageEdge: integer('MAX_IMAGE_EDGE', 2048),
  ocrEngines: ocrEngines(),
  tesseractPath: process.env.TESSERACT_PATH ?? 'tesseract',
  ocrPythonPath: process.env.OCR_PYTHON_PATH ?? 'python3',
  ocrWorkerPath: path.resolve(process.env.OCR_WORKER_PATH ?? './server/ocr_worker.py'),
  ocrWorkerTimeoutMs: boundedInteger('OCR_WORKER_TIMEOUT_SECONDS', 45, 5, 180) * 1000,
  translationBackend: process.env.TRANSLATION_BACKEND ?? 'openai',
  codexCliPath: process.env.CODEX_CLI_PATH ?? 'codex',
  codexTimeoutMs: integer('CODEX_TIMEOUT_SECONDS', 300) * 1000,
}
