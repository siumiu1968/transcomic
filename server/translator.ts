import OpenAI from 'openai'
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

export class MangaTranslator {
  private client?: OpenAI

  modelFor(mode: TranslationMode): string {
    if (mode === 'fast') return config.modelFast
    if (mode === 'quality') return config.modelQuality
    return config.modelBalanced
  }

  async translate(image: Buffer, model: string): Promise<TranslationResult> {
    this.client ??= new OpenAI({ maxRetries: 2, timeout: 180_000 })
    const prepared = await sharp(image)
      .rotate()
      .resize({ width: config.maxImageEdge, height: config.maxImageEdge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 86 })
      .toBuffer()
    const imageUrl = `data:image/webp;base64,${prepared.toString('base64')}`
    const response = await this.client.responses.create({
      model,
      input: [{
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              '你係專業漫畫本地化編輯。辨認本頁所有值得閱讀嘅對白、旁白同重要音效字。',
              '將內容自然翻譯成繁體中文（香港用語），保留人名、語氣、敬語同角色個性；唔好加入原圖不存在嘅內容。',
              '每個區域用 0 至 1000 正規化座標，框住完整原文／對話泡範圍；translation 只放最終譯文。',
              '無可讀文字時回傳空 regions。',
            ].join('\n'),
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
    return normalize(JSON.parse(response.output_text))
  }
}
