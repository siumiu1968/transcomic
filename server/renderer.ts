import sharp from 'sharp'
import type { TranslationRegion, TranslationResult } from './types.js'

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character] ?? character)
}

function fitLines(text: string, boxWidth: number, boxHeight: number): { fontSize: number; lines: string[] } {
  const characters = [...text.replace(/\s+/g, ' ').trim()]
  let fontSize = Math.min(40, Math.max(14, boxHeight * 0.28))
  while (fontSize >= 12) {
    const perLine = Math.max(2, Math.floor((boxWidth - fontSize) / (fontSize * 0.95)))
    const lines: string[] = []
    for (let index = 0; index < characters.length; index += perLine) lines.push(characters.slice(index, index + perLine).join(''))
    if (lines.length * fontSize * 1.28 <= boxHeight - fontSize * 0.5) return { fontSize, lines }
    fontSize -= 1
  }
  const perLine = Math.max(2, Math.floor((boxWidth - 12) / 11.4))
  const lines: string[] = []
  for (let index = 0; index < characters.length; index += perLine) lines.push(characters.slice(index, index + perLine).join(''))
  return { fontSize: 12, lines: lines.slice(0, Math.max(1, Math.floor(boxHeight / 15))) }
}

function regionSvg(region: TranslationRegion, imageWidth: number, imageHeight: number): string {
  const x = Math.round(region.x / 1000 * imageWidth)
  const y = Math.round(region.y / 1000 * imageHeight)
  const width = Math.max(16, Math.round(region.width / 1000 * imageWidth))
  const height = Math.max(16, Math.round(region.height / 1000 * imageHeight))
  const padding = Math.max(6, Math.min(16, width * 0.05))
  const { fontSize, lines } = fitLines(region.translation, width - padding * 2, height - padding * 2)
  const lineHeight = fontSize * 1.25
  const totalHeight = lines.length * lineHeight
  const startY = y + Math.max(padding + fontSize, (height - totalHeight) / 2 + fontSize)
  const fill = region.kind === 'sfx' ? '#fffef4e8' : '#fffef8f5'
  const radius = region.kind === 'narration' ? 2 : Math.min(22, height * 0.18)
  const text = lines.map((line, index) => `<text x="${x + width / 2}" y="${startY + index * lineHeight}" text-anchor="middle" font-family="Noto Sans CJK HK, Noto Sans CJK TC, sans-serif" font-size="${fontSize}" font-weight="700" fill="#111111">${escapeXml(line)}</text>`).join('')
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="#222222" stroke-width="1.5"/>${text}`
}

export async function renderTranslation(image: Buffer, result: TranslationResult): Promise<Buffer> {
  const base = sharp(image).rotate()
  const metadata = await base.metadata()
  const width = metadata.width ?? 1
  const height = metadata.height ?? 1
  if (result.regions.length === 0) return base.webp({ quality: 92 }).toBuffer()
  const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${result.regions.map((region) => regionSvg(region, width, height)).join('')}</svg>`)
  return base.composite([{ input: svg, top: 0, left: 0 }]).webp({ quality: 92 }).toBuffer()
}
