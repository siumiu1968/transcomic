import sharp from 'sharp'
import type { TranslationRegion, TranslationResult } from './types.js'

const MIN_FONT_SIZE = 12
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u
const OPENING_PUNCTUATION = new Set([...`（「『《【〈〔〖`])
const CLOSING_PUNCTUATION = new Set([...`，。！？、：；）》」』】〉〕〗…`])

interface PixelBox {
  x: number
  y: number
  width: number
  height: number
}

interface PixelRegion extends PixelBox {
  safe: PixelBox
  text: string
  kind: 'speech' | 'narration'
  edgeFallback: boolean
}

function escapeMarkup(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character] ?? character)
}

export function normalizeDisplayText(value: string): string {
  const compact = value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\.{3,}/g, '……')
    .replace(/…{3,}/g, '……')
    .trim()
  if (!CJK_PATTERN.test(compact)) return compact
  return compact
    .replace(/\s*([，。！？、：；）》」』】])/gu, '$1')
    .replace(/([（《「『【])\s*/gu, '$1')
    .replace(/[!！]{2,}/gu, '！！')
    .replace(/[?？]{2,}/gu, '？？')
    .replace(/\s+/g, '')
}

function characterWeight(character: string): number {
  if (/\s/u.test(character)) return 0.3
  if (CLOSING_PUNCTUATION.has(character) || OPENING_PUNCTUATION.has(character)) return 0.55
  if ((character.codePointAt(0) ?? 0) <= 0xff) return 0.58
  return 1
}

function weightOf(characters: string[]): number {
  return characters.reduce((total, character) => total + characterWeight(character), 0)
}

function balanceParagraph(paragraph: string, maximumWidth: number, fontSize: number): string[] {
  const characters = [...paragraph]
  if (characters.length === 0) return []
  const capacity = Math.max(2, maximumWidth / (fontSize * 1.04))
  const totalWeight = weightOf(characters)
  const lineCount = Math.max(1, Math.ceil(totalWeight / capacity))
  if (lineCount === 1) return [paragraph]

  const lines: string[] = []
  let start = 0
  for (let line = 0; line < lineCount - 1 && start < characters.length; line += 1) {
    const remainingLines = lineCount - line
    const target = weightOf(characters.slice(start)) / remainingLines
    let end = start
    let current = 0
    while (end < characters.length && current < target) {
      current += characterWeight(characters[end])
      end += 1
    }
    if (end < characters.length && CLOSING_PUNCTUATION.has(characters[end])) end += 1
    while (end > start + 1 && OPENING_PUNCTUATION.has(characters[end - 1])) end -= 1
    const minimumRemaining = remainingLines - 1
    if (characters.length - end < minimumRemaining) end = characters.length - minimumRemaining
    lines.push(characters.slice(start, end).join(''))
    start = end
  }
  if (start < characters.length) lines.push(characters.slice(start).join(''))
  return lines
}

export function balanceTranslationLines(text: string, maximumWidth: number, fontSize: number): string[] {
  return text.split('\n').flatMap((paragraph) => balanceParagraph(paragraph, maximumWidth, fontSize))
}

function toPixelRegion(region: TranslationRegion, imageWidth: number, imageHeight: number): PixelRegion | null {
  if (region.kind === 'sfx') return null
  const text = normalizeDisplayText(region.translation)
  if (!text) return null
  const convert = (box: TranslationRegion['bubble']): PixelBox => {
    const x = Math.max(0, Math.round(box.x / 1000 * imageWidth))
    const y = Math.max(0, Math.round(box.y / 1000 * imageHeight))
    return {
      x,
      y,
      width: Math.min(imageWidth - x, Math.round(box.width / 1000 * imageWidth)),
      height: Math.min(imageHeight - y, Math.round(box.height / 1000 * imageHeight)),
    }
  }
  const bubble = convert(region.bubble)
  const safe = convert(region.safe)
  const { x, y, width, height } = bubble
  if (width < 28 || height < 24) return null
  const edgeMargin = Math.max(4, Math.round(Math.min(imageWidth, imageHeight) * 0.006))
  if (safe.width < 18 || safe.height < 14) return null
  if (safe.x < x || safe.y < y || safe.x + safe.width > x + width || safe.y + safe.height > y + height) return null
  if (width > imageWidth * 0.65 && height < imageHeight * 0.08) return null
  const edgeFallback = x < edgeMargin || y < edgeMargin || x + width > imageWidth * 0.97 || y + height > imageHeight * 0.97
  return { ...bubble, safe, text, kind: region.kind === 'narration' ? 'narration' : 'speech', edgeFallback }
}

async function createTextLayer(region: PixelRegion, imageWidth: number): Promise<{ input: Buffer; top: number; left: number }> {
  const padding = Math.max(6, Math.round(Math.min(region.width, region.height) * (region.kind === 'speech' ? 0.11 : 0.08)))
  const width = Math.max(16, region.width - padding * 2)
  const height = Math.max(16, region.height - padding * 2)
  const maximumFontSize = Math.max(MIN_FONT_SIZE, Math.floor(Math.min(
    42,
    imageWidth / 26,
    region.width * 0.18,
    region.height * (region.kind === 'speech' ? 0.23 : 0.2),
  )))

  async function renderAt(fontSize: number) {
    const lines = balanceTranslationLines(region.text, width, fontSize)
    return sharp({
      text: {
        text: `<span foreground="#111111" weight="700">${escapeMarkup(lines.join('\n'))}</span>`,
        font: `Noto Sans CJK HK ${fontSize}`,
        width,
        align: 'centre',
        rgba: true,
        wrap: 'char',
        spacing: 0,
      },
    }).png().toBuffer({ resolveWithObject: true })
  }

  let lower = MIN_FONT_SIZE
  let upper = maximumFontSize
  let best: Awaited<ReturnType<typeof renderAt>> | undefined
  while (lower <= upper) {
    const fontSize = Math.floor((lower + upper) / 2)
    const rendered = await renderAt(fontSize)
    if (rendered.info.width <= width && rendered.info.height <= height) {
      best = rendered
      lower = fontSize + 1
    } else {
      upper = fontSize - 1
    }
  }
  if (!best) {
    const lines = balanceTranslationLines(region.text, width, MIN_FONT_SIZE)
    best = await sharp({
      text: {
        text: `<span foreground="#111111" weight="700">${escapeMarkup(lines.join('\n'))}</span>`,
        font: 'Noto Sans CJK HK',
        width,
        height,
        align: 'centre',
        rgba: true,
        wrap: 'char',
      },
    }).png().toBuffer({ resolveWithObject: true })
  }
  return {
    input: best.data,
    left: Math.round(region.x + padding + Math.max(0, (width - best.info.width) / 2)),
    top: Math.round(region.y + padding + Math.max(0, (height - best.info.height) / 2)),
  }
}

function connectedBubbleInterior(gray: Uint8Array, width: number, height: number, safe: PixelBox): { mask: Buffer; bounds: PixelBox } | null {
  const visited = new Uint8Array(width * height)
  let best: number[] = []
  let bestOverlap = -1
  let bestBounds: PixelBox = { x: 0, y: 0, width: 0, height: 0 }
  const safeLeft = Math.max(0, safe.x)
  const safeTop = Math.max(0, safe.y)
  const safeRight = Math.min(width, safe.x + safe.width)
  const safeBottom = Math.min(height, safe.y + safe.height)

  for (let origin = 0; origin < gray.length; origin += 1) {
    if (visited[origin] || gray[origin] < 205) continue
    const queue = new Int32Array(gray.length)
    const component: number[] = []
    let head = 0
    let tail = 0
    let overlap = 0
    let minimumX = width
    let minimumY = height
    let maximumX = 0
    let maximumY = 0
    let touchesBoundary = false
    queue[tail++] = origin
    visited[origin] = 1
    while (head < tail) {
      const index = queue[head++]
      component.push(index)
      const x = index % width
      const y = Math.floor(index / width)
      minimumX = Math.min(minimumX, x)
      minimumY = Math.min(minimumY, y)
      maximumX = Math.max(maximumX, x)
      maximumY = Math.max(maximumY, y)
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBoundary = true
      if (x >= safeLeft && x < safeRight && y >= safeTop && y < safeBottom) overlap += 1
      const neighbours = [index - 1, index + 1, index - width, index + width]
      for (const neighbour of neighbours) {
        if (neighbour < 0 || neighbour >= gray.length || visited[neighbour] || gray[neighbour] < 205) continue
        const neighbourX = neighbour % width
        if (Math.abs(neighbourX - x) > 1) continue
        visited[neighbour] = 1
        queue[tail++] = neighbour
      }
    }
    if (!touchesBoundary && (overlap > bestOverlap || (overlap === bestOverlap && component.length > best.length))) {
      best = component
      bestOverlap = overlap
      bestBounds = { x: minimumX, y: minimumY, width: maximumX - minimumX + 1, height: maximumY - minimumY + 1 }
    }
  }

  const safeArea = Math.max(1, (safeRight - safeLeft) * (safeBottom - safeTop))
  if (best.length < width * height * 0.08 || bestOverlap < Math.max(3, safeArea * 0.01)) return null
  const mask = Buffer.alloc(width * height)
  for (const index of best) mask[index] = 255
  return { mask, bounds: bestBounds }
}

function fillEnclosedHoles(mask: Uint8Array, width: number, height: number): Buffer {
  const exterior = new Uint8Array(mask.length)
  const queue = new Int32Array(mask.length)
  let head = 0
  let tail = 0
  const seed = (index: number) => {
    if (mask[index] === 0 && exterior[index] === 0) {
      exterior[index] = 1
      queue[tail++] = index
    }
  }
  for (let x = 0; x < width; x += 1) {
    seed(x)
    seed((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y += 1) {
    seed(y * width)
    seed(y * width + width - 1)
  }
  while (head < tail) {
    const index = queue[head++]
    const x = index % width
    const neighbours = [index - 1, index + 1, index - width, index + width]
    for (const neighbour of neighbours) {
      if (neighbour < 0 || neighbour >= mask.length || mask[neighbour] !== 0 || exterior[neighbour]) continue
      if (Math.abs(neighbour % width - x) > 1) continue
      exterior[neighbour] = 1
      queue[tail++] = neighbour
    }
  }
  const filled = Buffer.alloc(mask.length)
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] > 0 || exterior[index] === 0) filled[index] = 255
  }
  return filled
}

async function createCleanupLayer(image: Buffer, region: PixelRegion, imageWidth: number, imageHeight: number): Promise<{ overlay: { input: Buffer; top: number; left: number }; layout: PixelRegion } | null> {
  const marginX = Math.round(region.width * 0.18)
  const marginY = Math.round(region.height * 0.22)
  const left = Math.max(0, region.x - marginX)
  const top = Math.max(0, region.y - marginY)
  const right = Math.min(imageWidth, region.x + region.width + marginX)
  const bottom = Math.min(imageHeight, region.y + region.height + marginY)
  const width = right - left
  const height = bottom - top
  const gray = await sharp(image)
    .rotate()
    .extract({ left, top, width, height })
    .grayscale()
    .extractChannel(0)
    .raw()
    .toBuffer()
  const relativeSafe = {
    x: region.safe.x - left,
    y: region.safe.y - top,
    width: region.safe.width,
    height: region.safe.height,
  }
  const interior = connectedBubbleInterior(gray, width, height, relativeSafe)
  if (!interior) return null
  if (interior.bounds.x + interior.bounds.width >= width - 2 && left + width > imageWidth * 0.94) return null
  const filledInterior = fillEnclosedHoles(interior.mask, width, height)
  const darkText = Buffer.alloc(width * height)
  const guard = Math.max(2, Math.round(imageWidth / 520))
  for (let y = guard; y < height - guard; y += 1) {
    for (let x = guard; x < width - guard; x += 1) {
      const index = y * width + x
      if (filledInterior[index] > 127 && gray[index] < 190) darkText[index] = 255
    }
  }
  const alpha = Buffer.alloc(width * height)
  const dilation = Math.max(2, Math.round(imageWidth / 400))
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (darkText[y * width + x] === 0) continue
      for (let offsetY = -dilation; offsetY <= dilation; offsetY += 1) {
        for (let offsetX = -dilation; offsetX <= dilation; offsetX += 1) {
          if (offsetX * offsetX + offsetY * offsetY > dilation * dilation) continue
          const targetX = x + offsetX
          const targetY = y + offsetY
          if (targetX >= 0 && targetX < width && targetY >= 0 && targetY < height) alpha[targetY * width + targetX] = 255
        }
      }
    }
  }
  const input = await sharp({ create: { width, height, channels: 3, background: '#fffefb' } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer()
  return {
    overlay: { input, top, left },
    layout: {
      ...region,
      x: left + interior.bounds.x,
      y: top + interior.bounds.y,
      width: interior.bounds.width,
      height: interior.bounds.height,
    },
  }
}

async function createSafeCleanupLayer(image: Buffer, region: PixelRegion): Promise<{ overlay: { input: Buffer; top: number; left: number }; layout: PixelRegion } | null> {
  const { x: left, y: top, width, height } = region.safe
  const gray = await sharp(image)
    .rotate()
    .extract({ left, top, width, height })
    .grayscale()
    .extractChannel(0)
    .raw()
    .toBuffer()
  const alpha = Buffer.alloc(width * height)
  const dilation = Math.max(1, Math.round(Math.min(width, height) / 80))
  let darkPixels = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (gray[y * width + x] >= 190) continue
      darkPixels += 1
      for (let offsetY = -dilation; offsetY <= dilation; offsetY += 1) {
        for (let offsetX = -dilation; offsetX <= dilation; offsetX += 1) {
          if (offsetX * offsetX + offsetY * offsetY > dilation * dilation) continue
          const targetX = x + offsetX
          const targetY = y + offsetY
          if (targetX >= 0 && targetX < width && targetY >= 0 && targetY < height) alpha[targetY * width + targetX] = 255
        }
      }
    }
  }
  if (darkPixels === 0) return null
  const input = await sharp({ create: { width, height, channels: 3, background: '#fffefb' } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer()
  return {
    overlay: { input, top, left },
    layout: { ...region, x: left, y: top, width, height },
  }
}

export async function renderTranslation(image: Buffer, result: TranslationResult): Promise<Buffer> {
  const base = sharp(image).rotate()
  const metadata = await base.metadata()
  const width = metadata.width ?? 1
  const height = metadata.height ?? 1
  const regions = result.regions.flatMap((region) => {
    const converted = toPixelRegion(region, width, height)
    return converted ? [converted] : []
  })
  if (regions.length === 0) return base.webp({ quality: 92 }).toBuffer()
  const renderedRegions = await Promise.all(regions.map(async (region) => {
    let prepared = region.edgeFallback
      ? await createSafeCleanupLayer(image, region)
      : await createCleanupLayer(image, region, width, height)
    if (!prepared && !region.edgeFallback) prepared = await createSafeCleanupLayer(image, region)
    if (!prepared) return null
    return [prepared.overlay, await createTextLayer(prepared.layout, width)]
  }))
  const overlays = renderedRegions.flatMap((region) => region ?? [])
  if (overlays.length === 0) return base.webp({ quality: 92 }).toBuffer()
  return base.composite([
    ...overlays,
  ]).webp({ quality: 92 }).toBuffer()
}
