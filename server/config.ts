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
  modelFast: process.env.TRANSLATION_MODEL_FAST ?? 'gpt-5.6-luna',
  modelBalanced: process.env.TRANSLATION_MODEL_BALANCED ?? 'gpt-5.6-terra',
  modelQuality: process.env.TRANSLATION_MODEL_QUALITY ?? 'gpt-5.6-sol',
  maxImageEdge: integer('MAX_IMAGE_EDGE', 2048),
  translationBackend: process.env.TRANSLATION_BACKEND ?? 'openai',
  codexCliPath: process.env.CODEX_CLI_PATH ?? 'codex',
  codexTimeoutMs: integer('CODEX_TIMEOUT_SECONDS', 300) * 1000,
}
