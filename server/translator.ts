import OpenAI from 'openai'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { config } from './config.js'
import type { TranslationMode, TranslationRegion, TranslationResult } from './types.js'

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['regions'],
  properties: {
    regions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y', 'width', 'height', 'translation', 'kind'],
        properties: {
          x: { type: 'number', minimum: 0, maximum: 1000 },
          y: { type: 'number', minimum: 0, maximum: 1000 },
          width: { type: 'number', minimum: 1, maximum: 1000 },
          height: { type: 'number', minimum: 1, maximum: 1000 },
          translation: { type: 'string' },
          kind: { type: 'string', enum: ['speech', 'narration', 'sfx'] },
        },
      },
    },
  },
} as const

function clamp(value: unknown, minimum: number, maximum: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : minimum
  return Math.max(minimum, Math.min(maximum, number))
}

function normalize(value: unknown): TranslationResult {
  const raw = value && typeof value === 'object' && Array.isArray((value as { regions?: unknown }).regions)
    ? (value as { regions: unknown[] }).regions
    : []
  const regions: TranslationRegion[] = raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const region = item as Partial<TranslationRegion>
    const translation = typeof region.translation === 'string' ? region.translation.trim() : ''
    if (!translation) return []
    const x = clamp(region.x, 0, 999)
    const y = clamp(region.y, 0, 999)
    return [{
      x,
      y,
      width: clamp(region.width, 1, 1000 - x),
      height: clamp(region.height, 1, 1000 - y),
      translation,
      kind: region.kind === 'narration' || region.kind === 'sfx' ? region.kind : 'speech',
    }]
  })
  return { regions }
}

export function parseTranslationOutput(value: string): TranslationResult {
  const trimmed = value.trim()
  try {
    return normalize(JSON.parse(trimmed))
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
    if (!fenced) throw new Error('翻譯模型回傳格式無效')
    return normalize(JSON.parse(fenced))
  }
}

const translationPrompt = [
  '只分析附加嘅漫畫頁面，不得使用任何工具或讀取其他檔案。',
  '辨認本頁所有值得閱讀嘅對白、旁白同重要音效字。',
  '將內容自然翻譯成繁體中文（香港用語），保留人名、語氣、敬語同角色個性；唔好加入原圖不存在嘅內容。',
  '每個區域用 0 至 1000 正規化座標，框住完整原文／對話泡範圍；translation 只放最終譯文。',
  '無可讀文字時回傳空 regions。只輸出符合 schema 嘅 JSON。',
].join('\n')

export class MangaTranslator {
  private client?: OpenAI

  modelFor(mode: TranslationMode): string {
    if (mode === 'fast') return config.modelFast
    if (mode === 'quality') return config.modelQuality
    return config.modelBalanced
  }

  async translate(image: Buffer, model: string): Promise<TranslationResult> {
    const prepared = await sharp(image)
      .rotate()
      .resize({ width: config.maxImageEdge, height: config.maxImageEdge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 86 })
      .toBuffer()
    if (config.translationBackend === 'codex-cli') return this.translateWithCodex(prepared, model)
    return this.translateWithOpenAI(prepared, model)
  }

  private async translateWithOpenAI(prepared: Buffer, model: string): Promise<TranslationResult> {
    this.client ??= new OpenAI({ maxRetries: 2, timeout: 180_000 })
    const imageUrl = `data:image/webp;base64,${prepared.toString('base64')}`
    const response = await this.client.responses.create({
      model,
      input: [{
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: translationPrompt,
          },
          { type: 'input_image', image_url: imageUrl, detail: 'high' },
        ],
      }],
      text: {
        format: {
          type: 'json_schema',
          name: 'manga_translation',
          strict: true,
          schema: responseSchema,
        },
      },
    })
    if (!response.output_text) throw new Error('翻譯模型未有回傳內容')
    return parseTranslationOutput(response.output_text)
  }

  private async translateWithCodex(prepared: Buffer, model: string): Promise<TranslationResult> {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'transcomic-codex-'))
    const inputPath = path.join(folder, 'page.webp')
    const schemaPath = path.join(folder, 'translation.schema.json')
    const outputPath = path.join(folder, 'translation.json')
    try {
      await Promise.all([
        fs.writeFile(inputPath, prepared, { mode: 0o600 }),
        fs.writeFile(schemaPath, JSON.stringify(responseSchema), { mode: 0o600 }),
      ])
      const effort = model.includes('luna') ? 'low' : model.includes('terra') ? 'medium' : 'high'
      const args = [
        'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--sandbox', 'read-only',
        '--skip-git-repo-check', '--color', 'never', '-m', model,
        '-c', `model_reasoning_effort="${effort}"`, '-C', folder,
        '--image', inputPath, '--output-schema', schemaPath, '-o', outputPath, '-',
      ]
      await new Promise<void>((resolve, reject) => {
        const child = spawn(config.codexCliPath, args, {
          cwd: folder,
          env: { ...process.env, NO_COLOR: '1' },
          stdio: ['pipe', 'ignore', 'pipe'],
        })
        let stderr = ''
        let timedOut = false
        const timeout = setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
        }, config.codexTimeoutMs)
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < 64_000) stderr += chunk.toString('utf8')
        })
        child.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        child.once('close', (code) => {
          clearTimeout(timeout)
          if (timedOut) reject(new Error('Codex 翻譯逾時'))
          else if (code !== 0) reject(new Error(stderr.trim().split('\n').slice(-8).join('\n') || `Codex 結束代碼 ${code}`))
          else resolve()
        })
        child.stdin.end(translationPrompt)
      })
      return parseTranslationOutput(await fs.readFile(outputPath, 'utf8'))
    } finally {
      await fs.rm(folder, { recursive: true, force: true })
    }
  }
}
