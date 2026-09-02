import sharp from 'sharp'
import { detectOcrWords, detectTesseractWords, type OcrWord } from './ocr.js'
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
  id: number
  safe: PixelBox
  lines: PixelBox[]
  source: string
  text: string
  kind: 'speech' | 'narration'
  captionPlate?: boolean
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
  const lines = (region.lines ?? []).map(convert).filter((line) => line.width >= 3 && line.height >= 3)
  const { x, y, width, height } = bubble
  if (width < 28 || height < 24) return null
  if (safe.width < 18 || safe.height < 14) return null
  if (safe.x < x || safe.y < y || safe.x + safe.width > x + width || safe.y + safe.height > y + height) return null
  if (width > imageWidth * 0.65 && height < imageHeight * 0.08) return null
  if (lines.some((line) => line.x < safe.x - 1 || line.y < safe.y - 1 || line.x + line.width > safe.x + safe.width + 1 || line.y + line.height > safe.y + safe.height + 1)) return null
  return { id: region.id, ...bubble, safe, lines, source: region.source, text, kind: region.kind === 'narration' ? 'narration' : 'speech' }
}

async function createTextLayer(region: PixelRegion, imageWidth: number): Promise<{ input: Buffer; top: number; left: number } | null> {
  const padding = Math.max(6, Math.round(Math.min(region.width, region.height) * (region.kind === 'speech' ? 0.11 : 0.08)))
  const width = Math.max(16, region.width - padding * 2)
  const height = Math.max(16, region.height - padding * 2)
  const maximumFontSize = Math.max(MIN_FONT_SIZE, Math.floor(Math.min(
    48,
    imageWidth / 22,
    region.width * 0.3,
  )))

  async function renderAt(fontSize: number) {
    const lines = balanceTranslationLines(region.text, width, fontSize)
    return sharp({
      text: {
        text: `<span foreground="${region.captionPlate ? '#ffffff' : '#111111'}" weight="700">${escapeMarkup(lines.join('\n'))}</span>`,
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
  // Do not force an overflowing minimum-size layer into a small bubble. A
  // clipped/oversized translation is harder to read and can cover artwork.
  if (!best) return null
  return {
    input: best.data,
    left: Math.round(region.x + padding + Math.max(0, (width - best.info.width) / 2)),
    top: Math.round(region.y + padding + Math.max(0, (height - best.info.height) / 2)),
  }
}

interface InkComponent extends PixelBox {
  area: number
}

interface InkRow extends PixelBox {
  components: InkComponent[]
  density: number
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function findInkComponents(gray: Uint8Array, width: number, height: number, threshold = 170): InkComponent[] {
  const visited = new Uint8Array(gray.length)
  const components: InkComponent[] = []
  const queue = new Int32Array(gray.length)
  for (let origin = 0; origin < gray.length; origin += 1) {
    if (visited[origin] || gray[origin] >= threshold) continue
    let head = 0
    let tail = 0
    let left = width
    let top = height
    let right = 0
    let bottom = 0
    queue[tail++] = origin
    visited[origin] = 1
    while (head < tail) {
      const index = queue[head++]
      const x = index % width
      const y = Math.floor(index / width)
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
      for (const neighbour of [index - 1, index + 1, index - width, index + width]) {
        if (neighbour < 0 || neighbour >= gray.length || visited[neighbour] || gray[neighbour] >= threshold) continue
        if (Math.abs(neighbour % width - x) > 1) continue
        visited[neighbour] = 1
        queue[tail++] = neighbour
      }
    }
    if (tail >= 2) components.push({ x: left, y: top, width: right - left + 1, height: bottom - top + 1, area: tail })
  }
  return components
}

function groupInkRows(components: InkComponent[], gray: Uint8Array, width: number, height: number): InkRow[] {
  const rows: InkRow[] = []
  for (const component of [...components].sort((left, right) => left.y - right.y || left.x - right.x)) {
    const centre = component.y + component.height / 2
    const row = rows.find((candidate) => {
      const candidateCentre = candidate.y + candidate.height / 2
      const candidateHeight = Math.max(candidate.height, component.height)
      return Math.abs(centre - candidateCentre) <= candidateHeight * 0.75
        || component.y <= candidate.y + candidate.height + Math.max(2, candidateHeight * 0.2)
          && component.y + component.height >= candidate.y - Math.max(2, candidateHeight * 0.2)
    })
    if (row) {
      const right = Math.max(row.x + row.width, component.x + component.width)
      const bottom = Math.max(row.y + row.height, component.y + component.height)
      row.x = Math.min(row.x, component.x)
      row.y = Math.min(row.y, component.y)
      row.width = right - row.x
      row.height = bottom - row.y
      row.components.push(component)
    } else {
      rows.push({ ...component, components: [component], density: 0 })
    }
  }
  return rows.map((row) => {
    let dark = 0
    for (let y = row.y; y < Math.min(height, row.y + row.height); y += 1) {
      for (let x = row.x; x < Math.min(width, row.x + row.width); x += 1) {
        if (gray[y * width + x] < 190) dark += 1
      }
    }
    return { ...row, density: dark / Math.max(1, row.width * row.height) }
  })
}

function visualRowScore(row: InkRow): number {
  return row.components.length * 0.9 + Math.min(2, row.density * 7) + Math.min(2, row.width / 45)
}

function chooseVisualRows(rows: InkRow[], region: PixelRegion): InkRow[] {
  if (rows.length === 0) return []
  const modelCentres = region.lines.map((line) => line.y + line.height / 2)
  const modelCount = Math.max(1, modelCentres.length)
  const typicalHeight = Math.max(4, median(rows.map((row) => row.height)))
  const safeCentre = region.safe.y + region.safe.height / 2
  const maxCount = Math.min(12, rows.length, modelCount + 1)
  let best: InkRow[] = []
  let bestScore = Number.POSITIVE_INFINITY
  for (let count = 1; count <= maxCount; count += 1) {
    for (let start = 0; start <= rows.length - count; start += 1) {
      const block = rows.slice(start, start + count)
      if (block.slice(1).some((row, index) => row.y - (block[index].y + block[index].height) > typicalHeight * 1.8)) continue
      const centres = block.map((row) => row.y + row.height / 2)
      const offset = modelCentres.length === centres.length
        ? median(centres.map((centre, index) => centre - modelCentres[index]))
        : centres.reduce((total, centre) => total + centre, 0) / centres.length - safeCentre
      const alignment = modelCentres.length === centres.length
        ? centres.reduce((total, centre, index) => total + Math.abs(centre - modelCentres[index] - offset), 0) / centres.length
        : Math.abs((centres[0] + centres.at(-1)!) / 2 - safeCentre)
      // The model's line count is a useful prior, but a single model box can
      // contain two short stylized rows. Keep the penalty small enough for
      // that common case while still preferring a compact contiguous block.
      const countPenalty = Math.abs(count - modelCount) * typicalHeight * 0.2
      const distancePenalty = Math.min(typicalHeight * 4, Math.abs(offset)) * 0.18
      const qualityBonus = block.reduce((total, row) => total + visualRowScore(row), 0) * typicalHeight
      const score = alignment * 0.55 + countPenalty + distancePenalty - qualityBonus
      if (score < bestScore) {
        bestScore = score
        best = block
      }
    }
  }
  return best
}

export async function detectVisualTextLines(image: Buffer, region: PixelRegion): Promise<PixelBox[]> {
  const marginX = Math.max(3, Math.round(region.safe.width * 0.14))
  const marginY = Math.max(6, Math.round(region.safe.height * 0.38))
  const left = Math.max(region.x, region.safe.x - marginX)
  const top = Math.max(region.y, region.safe.y - marginY)
  const right = Math.min(region.x + region.width, region.safe.x + region.safe.width + marginX)
  const bottom = Math.min(region.y + region.height, region.safe.y + region.safe.height + marginY)
  const width = right - left
  const height = bottom - top
  if (width < 10 || height < 10) return []
  const gray = await sharp(image)
    .rotate()
    .extract({ left, top, width, height })
    .grayscale()
    .extractChannel(0)
    .raw()
    .toBuffer()
  const maximumWidth = Math.max(10, Math.round((region.safe.width + marginX * 2) * 0.96))
  const modelLineHeight = median(region.lines.map((line) => line.height))
  const maximumHeight = Math.max(8, Math.round(region.safe.height * 0.45), Math.round(modelLineHeight * 1.35))
  const components = findInkComponents(gray, width, height).filter((component) => {
    const componentRight = component.x + component.width
    const componentBottom = component.y + component.height
    return component.width <= maximumWidth
      && component.height <= maximumHeight
      && component.area >= Math.max(2, Math.round(component.width * component.height * 0.04))
      && componentRight > region.safe.x - left - marginX * 0.5
      && component.x < region.safe.x - left + region.safe.width + marginX * 0.5
      && componentBottom > region.safe.y - top - marginY * 0.75
      && component.y < region.safe.y - top + region.safe.height + marginY * 0.75
  })
  const rows = groupInkRows(components, gray, width, height)
    .filter((row) => {
      const absolute = { x: left + row.x, y: top + row.y, width: row.width, height: row.height }
      const safeLeft = region.safe.x - marginX
      const safeRight = region.safe.x + region.safe.width + marginX
      const safeTop = region.safe.y - marginY
      const safeBottom = region.safe.y + region.safe.height + marginY
      const inkArea = row.components.reduce((total, component) => total + component.area, 0)
      const singleGlyph = row.components.length === 1 && inkArea >= 16 && row.width <= region.safe.width * 0.85
      return (row.components.length >= 2 || singleGlyph)
        && row.density >= 0.12
        && row.width >= Math.max(6, region.safe.width * 0.04)
        && row.width <= region.safe.width * 1.2
        && row.height >= 5
        && row.height <= Math.max(18, region.safe.height * 0.85)
        && absolute.x >= safeLeft && absolute.x + absolute.width <= safeRight
        && absolute.y >= safeTop && absolute.y + absolute.height <= safeBottom
    })
    .sort((leftRow, rightRow) => leftRow.y - rightRow.y)
  const selected = chooseVisualRows(rows, region)
  if (selected.length === 0) return []
  const padding = Math.max(2, Math.round(median(selected.map((row) => row.height)) * 0.2))
  return selected.map((row) => ({
    x: Math.max(region.x, left + row.x - padding),
    y: Math.max(region.y, top + row.y - padding),
    width: Math.min(region.x + region.width, left + row.x + row.width + padding) - Math.max(region.x, left + row.x - padding),
    height: Math.min(region.y + region.height, top + row.y + row.height + padding) - Math.max(region.y, top + row.y - padding),
  }))
}

function normalizedWord(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function isSourceWord(value: string): boolean {
  return value.length >= 2 || value === 'i' || value === 'a'
}

function ocrWordVariants(value: string): string[] {
  const corrected = value
    .replace(/0/g, 'o')
    .replace(/[1|]/g, 'i')
    .replace(/[56]/g, 's')
  return corrected === value ? [value] : [value, corrected]
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      )
    }
    for (let index = 0; index < current.length; index += 1) previous[index] = current[index]
  }
  return previous[right.length]
}

export interface ResidualSourceText {
  regionId: number
  source: string
  residualText: string
  matchedWords: string[]
  sourceCoverage: number
  bounds: PixelBox
}

export interface ResidualSourceTextOptions {
  imageWidth: number
  imageHeight: number
  minimumSourceConfidence?: number
  minimumRenderedConfidence?: number
}

const NON_DIALOGUE_SOURCE_PATTERN = /(?:https?:\/\/|www\.|\.com\b|\.net\b|\.org\b|(?:all rights reserved)|(?:do not (?:repost|distribute))|copyright|©)/iu
const CREDIT_SOURCE_PATTERN = /(?:scanlat|translat|typeset|letter(?:er|ing)?|proofread|cleaner|editor|raw(?:s| provider)?|credit|watermark|patreon|instagram|facebook|twitter)\b/iu

function isResidualQaEligibleRegion(region: TranslationRegion): boolean {
  if (region.kind === 'sfx' || NON_DIALOGUE_SOURCE_PATTERN.test(region.source)) return false
  const latin = region.source.match(/[A-Za-z]+/gu) ?? []
  const safeTouchesPageEdge = region.safe.x <= 30 || region.safe.y <= 30
    || region.safe.x + region.safe.width >= 970 || region.safe.y + region.safe.height >= 970
  const startsLikeCredit = /^\s*(?:scanlat|translat|typeset|letter(?:er|ing)?|proofread|cleaner|editor|raws?|credits?|watermark)\b/iu.test(region.source)
  if (latin.length <= 8 && CREDIT_SOURCE_PATTERN.test(region.source) && (startsLikeCredit || safeTouchesPageEdge)) return false
  return latin.some((word) => word.length >= 2)
}

function sourceTokenMatch(value: string, source: string): boolean {
  if (!value || !source) return false
  const candidates = ocrWordVariants(value)
  return candidates.some((candidate) => {
    if (candidate === source) return true
    if (source.length >= 4 && candidate.includes(source)) return true
    if (candidate.length >= 4 && source.includes(candidate)) return true
    const maximumDistance = source.length >= 8 ? 2 : source.length >= 4 ? 1 : 0
    return editDistance(candidate, source) <= maximumDistance
  })
}

function wordInsideBounds(word: OcrWord, bounds: PixelBox, marginRatio: number): boolean {
  const centreX = word.x + word.width / 2
  const centreY = word.y + word.height / 2
  return centreX >= bounds.x - bounds.width * marginRatio
    && centreX <= bounds.x + bounds.width * (1 + marginRatio)
    && centreY >= bounds.y - bounds.height * marginRatio
    && centreY <= bounds.y + bounds.height * (1 + marginRatio)
}

function sameWordPosition(source: OcrWord, rendered: OcrWord): { same: boolean; overlap: number } {
  const left = Math.max(source.x, rendered.x)
  const top = Math.max(source.y, rendered.y)
  const right = Math.min(source.x + source.width, rendered.x + rendered.width)
  const bottom = Math.min(source.y + source.height, rendered.y + rendered.height)
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top)
  const overlap = intersection / Math.max(1, Math.min(source.width * source.height, rendered.width * rendered.height))
  const deltaX = Math.abs(source.x + source.width / 2 - rendered.x - rendered.width / 2)
  const deltaY = Math.abs(source.y + source.height / 2 - rendered.y - rendered.height / 2)
  const widthRatio = rendered.width / Math.max(1, source.width)
  const heightRatio = rendered.height / Math.max(1, source.height)
  return {
    same: (overlap >= 0.35 || deltaX <= Math.max(source.width, rendered.width) * 0.32)
      && deltaY <= Math.max(source.height, rendered.height) * 0.45
      && widthRatio >= 0.5 && widthRatio <= 1.9
      && heightRatio >= 0.5 && heightRatio <= 1.9,
    overlap,
  }
}

/**
 * Finds source-language words which OCR sees in the same place before and
 * after rendering. Geometry and the model source must both agree, so unrelated
 * page text, credits, watermarks and SFX are not promoted to cleanup targets.
 */
export function findResidualSourceText(
  sourceWords: OcrWord[],
  renderedWords: OcrWord[],
  regions: TranslationRegion[],
  options: ResidualSourceTextOptions,
): ResidualSourceText[] {
  const sourceConfidence = options.minimumSourceConfidence ?? 35
  const renderedConfidence = options.minimumRenderedConfidence ?? 45
  return regions.flatMap((region): ResidualSourceText[] => {
    if (!isResidualQaEligibleRegion(region)) return []
    const convert = (box: TranslationRegion['safe']): PixelBox => {
      const x = Math.max(0, Math.round(box.x / 1000 * options.imageWidth))
      const y = Math.max(0, Math.round(box.y / 1000 * options.imageHeight))
      return {
        x,
        y,
        width: Math.max(0, Math.min(options.imageWidth - x, Math.round(box.width / 1000 * options.imageWidth))),
        height: Math.max(0, Math.min(options.imageHeight - y, Math.round(box.height / 1000 * options.imageHeight))),
      }
    }
    const safe = convert(region.safe)
    if (safe.width < 8 || safe.height < 8) return []
    const retainedTranslationTokens = new Set(
      (region.translation.match(/[A-Za-z]+/gu) ?? []).map((word) => normalizedWord(word)),
    )
    const sourceTokens = (region.source.match(/[A-Za-z]+/gu) ?? [])
      .map((word) => normalizedWord(word))
      .filter((word) => !retainedTranslationTokens.has(word))
    if (sourceTokens.length === 0) return []
    const originalCandidates = sourceWords.filter((word) => {
      const normalized = normalizedWord(word.text)
      return word.confidence >= sourceConfidence
        && /[a-z]/u.test(normalized)
        && wordInsideBounds(word, safe, 0.2)
        && sourceTokens.some((token) => sourceTokenMatch(normalized, token))
    })
    const matches: Array<{ token: string; sourceWord: OcrWord; renderedWord: OcrWord; overlap: number }> = []
    for (const sourceWord of originalCandidates) {
      const original = normalizedWord(sourceWord.text)
      const token = sourceTokens.find((candidate) => sourceTokenMatch(original, candidate))
      if (!token) continue
      let best: { word: OcrWord; overlap: number } | undefined
      for (const renderedWord of renderedWords) {
        const rendered = normalizedWord(renderedWord.text)
        if (renderedWord.confidence < renderedConfidence
          || !/[a-z]/u.test(rendered)
          || !wordInsideBounds(renderedWord, safe, 0.2)
          || !sourceTokenMatch(rendered, token)) continue
        const position = sameWordPosition(sourceWord, renderedWord)
        if (!position.same || best && best.overlap >= position.overlap) continue
        best = { word: renderedWord, overlap: position.overlap }
      }
      if (best) matches.push({ token, sourceWord, renderedWord: best.word, overlap: best.overlap })
    }
    if (matches.length === 0) return []
    const uniqueTokens = [...new Set(matches.map((match) => match.token))]
    const matchedCharacters = uniqueTokens.reduce((total, token) => total + token.length, 0)
    const totalCharacters = sourceTokens.reduce((total, token) => total + token.length, 0)
    const sourceCoverage = matchedCharacters / Math.max(1, totalCharacters)
    const strongSingle = matches.some((match) => match.token.length >= 2
      && match.sourceWord.confidence >= 85
      && match.renderedWord.confidence >= 85
      && match.overlap >= 0.55)
    if (!strongSingle && uniqueTokens.length < 2 && (matchedCharacters < 5 || sourceCoverage < 0.35)) return []
    const boxes = matches.map((match) => match.renderedWord)
    const left = Math.min(...boxes.map((box) => box.x))
    const top = Math.min(...boxes.map((box) => box.y))
    const right = Math.max(...boxes.map((box) => box.x + box.width))
    const bottom = Math.max(...boxes.map((box) => box.y + box.height))
    return [{
      regionId: region.id,
      source: region.source,
      residualText: uniqueTokens.join(' '),
      matchedWords: uniqueTokens,
      sourceCoverage,
      bounds: { x: left, y: top, width: right - left, height: bottom - top },
    }]
  })
}

interface OcrLine extends PixelBox {
  confidence: number
}

interface OcrMatch {
  lines: OcrLine[]
  allLines?: OcrLine[]
  coverage: number
  complete: boolean
  unmatchedCharacters?: number
  incompleteSourceWords?: number
}

type OcrRegion = Pick<PixelRegion, 'x' | 'y' | 'width' | 'height' | 'safe' | 'lines' | 'source'>

const minimumOcrCoverage = 0.92

interface NarrationCaptionPlan {
  bounds: PixelBox
  lines: PixelBox[]
}

export function filterUsableOcrLines<T extends PixelBox>(lines: T[], region: Pick<PixelRegion, 'safe'> & Partial<Pick<PixelRegion, 'lines'>>): T[] {
  const minimumHeight = Math.max(4, Math.min(12, Math.round(region.safe.height * 0.08)))
  const modelLineHeight = median((region.lines ?? []).map((line) => line.height))
  const maximumHeight = Math.max(minimumHeight, Math.round(region.safe.height * 0.65), Math.round(modelLineHeight * 1.35))
  const maximumWidth = Math.max(8, Math.round(region.safe.width * 1.45))
  const marginX = region.safe.width * 0.35
  const marginY = region.safe.height * 0.35
  return lines.filter((line) => {
    const centreX = line.x + line.width / 2
    const centreY = line.y + line.height / 2
    return line.width >= 4
      && line.height >= minimumHeight
      && line.height <= maximumHeight
      && line.width <= maximumWidth
      && centreX >= region.safe.x - marginX
      && centreX <= region.safe.x + region.safe.width + marginX
      && centreY >= region.safe.y - marginY
      && centreY <= region.safe.y + region.safe.height + marginY
  })
}

function matchOcrLinesWithCoverage(words: OcrWord[], region: Pick<PixelRegion, 'x' | 'y' | 'width' | 'height' | 'source'>, strictSafe = false): OcrMatch {
  const sourceWords = region.source.split(/\s+/u).map(normalizedWord).filter(isSourceWord)
  if (sourceWords.length === 0) return { lines: [], coverage: 0, complete: false }
  // The model's safe box is the strongest available spatial prior. Full-page
  // OCR still gets a little tolerance around it, while callers that only have
  // a plain region (including the pure matcher test) use that region directly.
  const bounds = 'safe' in region ? (region as PixelRegion).safe : region
  const isSpatiallyUsable = (word: OcrWord): boolean => {
    const normalized = normalizedWord(word.text)
    const centreX = word.x + word.width / 2
    const centreY = word.y + word.height / 2
    const marginX = bounds.width * (strictSafe ? 0.32 : 0.35)
    const marginY = bounds.height * (strictSafe ? 0.32 : 0.35)
    const reliableSingleLetter = normalized.length === 1 && word.confidence >= 70
    return (isSourceWord(normalized) || reliableSingleLetter)
      && centreX >= bounds.x - marginX && centreX <= bounds.x + bounds.width + marginX
      && centreY >= bounds.y - marginY && centreY <= bounds.y + bounds.height + marginY
  }
  const spatialWords = words.filter(isSpatiallyUsable)
  const coveredCharacters = sourceWords.map(() => new Set<number>())
  const matchedWords: OcrWord[] = []
  for (const word of spatialWords) {
    const normalized = normalizedWord(word.text)
    if (!isSourceWord(normalized)) continue
    let bestIndex = -1
    let bestRatio = Number.POSITIVE_INFINITY
    let bestPositions: number[] = []
    let bestNewCharacters = -1
    for (let index = 0; index < sourceWords.length; index += 1) {
      const source = sourceWords[index]
      const variant = ocrWordVariants(normalized)
        .map((candidate) => ({ candidate, distance: editDistance(source, candidate) }))
        .sort((left, right) => left.distance - right.distance)[0]?.candidate ?? normalized
      const sourceOffset = source.indexOf(variant)
      const positions = sourceOffset >= 0
        ? Array.from({ length: variant.length }, (_, offset) => sourceOffset + offset).filter((position) => position < source.length)
        : variant.includes(source)
          ? Array.from({ length: source.length }, (_, position) => position)
          : []
      const ratio = positions.length > 0 ? 0 : editDistance(source, variant) / Math.max(source.length, variant.length)
      if (ratio > 0.38) continue
      const fallbackPositions = positions.length > 0
        ? positions
        : Array.from({ length: source.length }, (_, position) => position)
      const newCharacters = fallbackPositions.reduce((total, position) => total + (coveredCharacters[index].has(position) ? 0 : 1), 0)
      if (ratio < bestRatio || (ratio === bestRatio && newCharacters > bestNewCharacters)) {
        bestRatio = ratio
        bestIndex = index
        bestPositions = fallbackPositions
        bestNewCharacters = newCharacters
      }
    }
    if (bestIndex < 0 || bestNewCharacters <= 0) continue
    const minimumConfidence = normalized.length <= 1 ? 70 : normalized.length <= 3 ? 40 : 10
    const reliableLowConfidenceMatch = normalized.length >= 2 && bestRatio <= 0.34
    if (word.confidence < minimumConfidence && !reliableLowConfidenceMatch) continue
    for (const position of bestPositions) coveredCharacters[bestIndex].add(position)
    matchedWords.push(word)
  }
  const totalCharacters = sourceWords.reduce((total, word) => total + word.length, 0)
  const matchedCharacters = coveredCharacters.reduce((total, characters) => total + characters.size, 0)
  const matchedCoverage = matchedCharacters / Math.max(1, totalCharacters)
  const complete = coveredCharacters.every((characters, index) => characters.size / sourceWords[index].length >= 0.85)
  const unmatchedCharacters = totalCharacters - matchedCharacters
  const incompleteSourceWords = coveredCharacters.filter((characters, index) => characters.size / sourceWords[index].length < 0.85).length
  if (matchedCoverage < 0.38) return { lines: [], coverage: matchedCoverage, complete, unmatchedCharacters, incompleteSourceWords }
  // If one word on a Tesseract line matches the model source, include its
  // low-confidence siblings in the same tight line box. Stylized short words
  // such as "IS" are often unreadable to OCR but still need to be erased.
  const matchedLineIds = new Set(matchedWords.map((word) => word.line).filter(Boolean))
  const sourceInitials = new Set(region.source.split(/\s+/u).map(normalizedWord).filter((word) => word.length === 1))
  const isNearbyLineSibling = (word: OcrWord): boolean => matchedWords.some((matched) => {
    const horizontalGap = Math.max(0, Math.max(matched.x, word.x) - Math.min(matched.x + matched.width, word.x + word.width))
    if (matchedLineIds.has(word.line) && matched.line === word.line) return horizontalGap <= Math.max(5, Math.max(matched.height, word.height) * 1.5)
    const normalized = normalizedWord(word.text)
    const verticalDelta = Math.abs(word.y + word.height / 2 - matched.y - matched.height / 2)
    return normalized.length === 1
      && sourceInitials.has(normalized)
      && word.confidence >= 70
      && word.x <= matched.x
      && horizontalGap <= Math.max(5, Math.max(matched.height, word.height) * 1.5)
      && verticalDelta <= Math.max(matched.height, word.height) * 0.62
  })
  const lineWords = [
    ...matchedWords,
    ...spatialWords.filter((word) => isNearbyLineSibling(word) && !matchedWords.includes(word)),
  ]
  const grouped: OcrWord[][] = []
  for (const word of lineWords.sort((left, right) => left.y - right.y || left.x - right.x)) {
    const centre = word.y + word.height / 2
    let line = grouped.find((candidate) => {
      const candidateCentre = median(candidate.map((item) => item.y + item.height / 2))
      const sameTesseractLine = candidate[0]?.line !== '' && candidate[0]?.line === word.line
      return sameTesseractLine || Math.abs(centre - candidateCentre) <= Math.max(word.height, median(candidate.map((item) => item.height))) * 0.62
    })
    if (!line) {
      line = []
      grouped.push(line)
    }
    line.push(word)
  }
  const lines = grouped.map((line): OcrLine => {
    const left = Math.min(...line.map((word) => word.x))
    const top = Math.min(...line.map((word) => word.y))
    const right = Math.max(...line.map((word) => word.x + word.width))
    const bottom = Math.max(...line.map((word) => word.y + word.height))
    const confidence = Math.max(...line.filter((word) => matchedWords.includes(word)).map((word) => word.confidence))
    return { x: left, y: top, width: right - left, height: bottom - top, confidence }
  }).sort((left, right) => left.y - right.y || left.x - right.x)
  const typicalHeight = Math.max(4, median(lines.map((line) => line.height)))
  const blocks: OcrLine[][] = []
  for (const line of lines) {
    const block = blocks.at(-1)
    const previous = block?.at(-1)
    if (!block || !previous || line.y - (previous.y + previous.height) > typicalHeight * 0.85) blocks.push([line])
    else block.push(line)
  }
  const contiguousLines = blocks.sort((left, right) => {
    if (right.length !== left.length) return right.length - left.length
    const area = (value: OcrLine[]) => value.reduce((total, line) => total + line.width * line.height, 0)
    return area(right) - area(left)
  })[0] ?? []
  return { lines: contiguousLines, allLines: lines, coverage: matchedCoverage, complete, unmatchedCharacters, incompleteSourceWords }
}

export function matchOcrLines(words: OcrWord[], region: Pick<PixelRegion, 'x' | 'y' | 'width' | 'height' | 'source'>): PixelBox[] {
  return matchOcrLinesWithCoverage(words, region).lines.map(({ x, y, width, height }) => ({ x, y, width, height }))
}

export function modelBackedVisualLinesAreTight(lines: PixelBox[], modelLines: PixelBox[]): boolean {
  if (lines.length === 0 || lines.length !== modelLines.length) return false
  const visual = [...lines].sort((left, right) => left.y - right.y || left.x - right.x)
  const model = [...modelLines].sort((left, right) => left.y - right.y || left.x - right.x)
  return model.every((expected, index) => {
    const actual = visual[index]
    const overlapLeft = Math.max(actual.x, expected.x)
    const overlapTop = Math.max(actual.y, expected.y)
    const overlapRight = Math.min(actual.x + actual.width, expected.x + expected.width)
    const overlapBottom = Math.min(actual.y + actual.height, expected.y + expected.height)
    const intersection = Math.max(0, overlapRight - overlapLeft) * Math.max(0, overlapBottom - overlapTop)
    const modelOverlap = intersection / Math.max(1, expected.width * expected.height)
    const visualOverlap = intersection / Math.max(1, actual.width * actual.height)
    const widthRatio = actual.width / Math.max(1, expected.width)
    const heightRatio = actual.height / Math.max(1, expected.height)
    const centreDeltaX = Math.abs(actual.x + actual.width / 2 - expected.x - expected.width / 2)
    const centreDeltaY = Math.abs(actual.y + actual.height / 2 - expected.y - expected.height / 2)
    return modelOverlap >= 0.5 && visualOverlap >= 0.5
      && widthRatio >= 0.65 && widthRatio <= 1.45
      && heightRatio >= 0.65 && heightRatio <= 1.45
      && centreDeltaX <= Math.max(actual.width, expected.width) * 0.3
      && centreDeltaY <= Math.max(actual.height, expected.height) * 0.3
  })
}

function narrationCaptionPlanFromMatch(match: OcrMatch, region: PixelRegion, imageWidth: number, imageHeight: number): NarrationCaptionPlan | null {
  const sourceLines = match.allLines ?? match.lines
  if (region.kind !== 'narration' || match.coverage < minimumOcrCoverage || sourceLines.length === 0) return null
  // Stylized narration can lose one very short OCR word (for example NO→NC or
  // UP→UF) while every model row still aligns. Keep the allowance bounded by
  // both source characters and words; rows without model geometry stay strict.
  if (!match.complete && (region.lines.length === 0
    || match.unmatchedCharacters === undefined || match.unmatchedCharacters > 2
    || match.incompleteSourceWords === undefined || match.incompleteSourceWords > 1)) return null
  if (sourceLines.some((line) => line.confidence < 25) || median(sourceLines.map((line) => line.confidence)) < 55) return null

  const aligned = (ocr: PixelBox, model: PixelBox): boolean => {
    const overlapLeft = Math.max(ocr.x, model.x)
    const overlapTop = Math.max(ocr.y, model.y)
    const overlapRight = Math.min(ocr.x + ocr.width, model.x + model.width)
    const overlapBottom = Math.min(ocr.y + ocr.height, model.y + model.height)
    const intersection = Math.max(0, overlapRight - overlapLeft) * Math.max(0, overlapBottom - overlapTop)
    const overlap = intersection / Math.max(1, Math.min(ocr.width * ocr.height, model.width * model.height))
    const centreDeltaX = Math.abs(ocr.x + ocr.width / 2 - model.x - model.width / 2)
    const centreDeltaY = Math.abs(ocr.y + ocr.height / 2 - model.y - model.height / 2)
    return overlap >= 0.35
      && centreDeltaX <= Math.max(ocr.width, model.width) * 0.55
      && centreDeltaY <= Math.max(ocr.height, model.height) * 0.75
  }
  const lineHeight = Math.max(5, median(sourceLines.map((line) => line.height)))
  const sortedLines = [...sourceLines].sort((left, right) => left.y - right.y || left.x - right.x)
  const withinEnvelope = (box: PixelBox, envelope: PixelBox, overflow: number): boolean => {
    return box.x >= envelope.x - overflow
      && box.y >= envelope.y - overflow
      && box.x + box.width <= envelope.x + envelope.width + overflow
      && box.y + box.height <= envelope.y + envelope.height + overflow
  }
  const contiguous = sortedLines.every((line, index) => {
    if (index === 0) return true
    const previous = sortedLines[index - 1]
    return line.y - (previous.y + previous.height) <= lineHeight * 1.5
  })
  if (!contiguous || !sortedLines.every((line) => withinEnvelope(line, region, lineHeight))) return null
  if (region.lines.length > 0) {
    if (sortedLines.length < region.lines.length || sortedLines.length > region.lines.length + 2) return null
    if (!region.lines.every((model) => sortedLines.some((line) => aligned(line, model)))) return null
    if (!sortedLines.every((line) => withinEnvelope(line, region.safe, lineHeight))) return null
  } else {
    if (sortedLines.length < 2) return null
    if (!sortedLines.every((line) => withinEnvelope(line, region.safe, lineHeight * 0.5))) return null
  }

  const paddingX = Math.max(4, Math.min(10, Math.round(lineHeight * 0.35)))
  const paddingY = Math.max(3, Math.min(8, Math.round(lineHeight * 0.25)))
  const left = Math.max(0, Math.min(...sortedLines.map((line) => line.x)) - paddingX)
  const top = Math.max(0, Math.min(...sortedLines.map((line) => line.y)) - paddingY)
  const right = Math.min(imageWidth, Math.max(...sortedLines.map((line) => line.x + line.width)) + paddingX)
  const bottom = Math.min(imageHeight, Math.max(...sortedLines.map((line) => line.y + line.height)) + paddingY)
  const bounds = { x: left, y: top, width: right - left, height: bottom - top }
  const plateArea = bounds.width * bounds.height
  if (bounds.width < 18 || bounds.height < 14) return null
  if (plateArea > imageWidth * imageHeight * 0.08) return null
  if (!withinEnvelope(bounds, region, lineHeight) || !withinEnvelope(bounds, region.safe, lineHeight)) return null
  return {
    bounds,
    lines: sortedLines.map(({ x, y, width, height }) => ({ x, y, width, height })),
  }
}

export function planNarrationCaption(words: OcrWord[], region: PixelRegion, imageWidth: number, imageHeight: number): NarrationCaptionPlan | null {
  const match = matchOcrLinesWithCoverage(words, region, true)
  return narrationCaptionPlanFromMatch(match, region, imageWidth, imageHeight)
}

interface PreparedLayerBase {
  overlay: { input: Buffer; top: number; left: number }
  layout: PixelRegion
}

interface PreparedLayer extends PreparedLayerBase {
  fallback?: PreparedLayerBase
}

async function createNarrationCaptionPlate(match: OcrMatch, region: PixelRegion, imageWidth: number, imageHeight: number): Promise<PreparedLayerBase | null> {
  const plan = narrationCaptionPlanFromMatch(match, region, imageWidth, imageHeight)
  if (!plan) return null
  const { x, y, width, height } = plan.bounds
  const radius = Math.max(5, Math.min(12, Math.round(Math.min(width, height) * 0.12)))
  const plate = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect x="0.75" y="0.75" width="${Math.max(1, width - 1.5)}" height="${Math.max(1, height - 1.5)}" rx="${radius}" fill="#17151f" stroke="#ffffff" stroke-opacity="0.45" stroke-width="1.5"/></svg>`)
  return {
    overlay: { input: await sharp(plate).png().toBuffer(), top: y, left: x },
    layout: { ...region, x, y, width, height, safe: { x, y, width, height }, captionPlate: true },
  }
}

async function narrationPlanHasColoredInk(image: Buffer, plan: NarrationCaptionPlan): Promise<boolean> {
  const { x, y, width, height } = plan.bounds
  const sampled = await sharp(image)
    .extract({ left: x, top: y, width, height })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  let linePixels = 0
  let coloredInkPixels = 0
  for (let localY = 0; localY < height; localY += 1) {
    for (let localX = 0; localX < width; localX += 1) {
      const absoluteX = x + localX
      const absoluteY = y + localY
      if (!plan.lines.some((line) => absoluteX >= line.x && absoluteX < line.x + line.width && absoluteY >= line.y && absoluteY < line.y + line.height)) continue
      linePixels += 1
      const offset = (localY * width + localX) * sampled.info.channels
      const r = sampled.data[offset]
      const g = sampled.data[offset + 1]
      const b = sampled.data[offset + 2]
      const spread = Math.max(r, g, b) - Math.min(r, g, b)
      const luminance = (r + g + b) / 3
      if (spread >= 28 && luminance <= 215) coloredInkPixels += 1
    }
  }
  return coloredInkPixels >= Math.max(10, Math.round(linePixels * 0.008))
}

function edgeAwareCleanupLines(match: OcrMatch, region: OcrRegion, imageWidth: number, imageHeight: number): PixelBox[] {
  if (match.coverage >= minimumOcrCoverage || match.coverage < 0.68) return []
  // Infer only one row that is physically clipped by the page. Every visible
  // model row still has to agree with a clear OCR row before pixels are changed.
  const modelLines = [...region.lines].sort((left, right) => left.y - right.y || left.x - right.x)
  const ocrLines = [...match.lines].sort((left, right) => left.y - right.y || left.x - right.x)
  const edges = [
    { regionTouches: region.x === 0 && region.safe.x === 0, lineTouches: (line: PixelBox) => line.x === 0 },
    { regionTouches: region.y === 0 && region.safe.y === 0, lineTouches: (line: PixelBox) => line.y === 0 },
    { regionTouches: region.x + region.width === imageWidth && region.safe.x + region.safe.width === imageWidth, lineTouches: (line: PixelBox) => line.x + line.width === imageWidth },
    { regionTouches: region.y + region.height === imageHeight && region.safe.y + region.safe.height === imageHeight, lineTouches: (line: PixelBox) => line.y + line.height === imageHeight },
  ]
  for (const edge of edges) {
    if (!edge.regionTouches) continue
    const clippedLines = modelLines.filter(edge.lineTouches)
    const visibleLines = modelLines.filter((line) => !edge.lineTouches(line))
    const clippedOcrLines = ocrLines.filter(edge.lineTouches)
    const visibleOcrLines = ocrLines.filter((line) => !edge.lineTouches(line))
    // Tesseract can fuzzy-match a few mangled glyphs on the cropped row. Treat
    // that single low-confidence edge row as clipped rather than as a fourth
    // visible row; a clear edge row must still pass the normal 0.92 gate.
    if (clippedLines.length !== 1 || clippedOcrLines.length > 1 || clippedOcrLines.some((line) => line.confidence >= 60)) continue
    if (visibleLines.length < 3 || visibleOcrLines.length !== visibleLines.length) continue
    if (visibleOcrLines.some((line) => line.confidence < 60 || edge.lineTouches(line))) continue
    const typicalModelHeight = median(visibleLines.map((line) => line.height))
    if (clippedLines[0].height > typicalModelHeight * 1.5 || clippedLines[0].width > region.safe.width) continue

    const aligned = visibleOcrLines.every((line, index) => {
      const model = visibleLines[index]
      const overlapLeft = Math.max(line.x, model.x)
      const overlapTop = Math.max(line.y, model.y)
      const overlapRight = Math.min(line.x + line.width, model.x + model.width)
      const overlapBottom = Math.min(line.y + line.height, model.y + model.height)
      const intersection = Math.max(0, overlapRight - overlapLeft) * Math.max(0, overlapBottom - overlapTop)
      const overlap = intersection / Math.max(1, Math.min(line.width * line.height, model.width * model.height))
      const centreDelta = Math.abs(line.y + line.height / 2 - model.y - model.height / 2)
      const widthRatio = line.width / Math.max(1, model.width)
      const heightRatio = line.height / Math.max(1, model.height)
      return overlap >= 0.45
        && centreDelta <= Math.max(line.height, model.height) * 0.55
        && widthRatio >= 0.45 && widthRatio <= 1.8
        && heightRatio >= 0.45 && heightRatio <= 1.8
    })
    if (aligned) return [clippedLines[0], ...visibleOcrLines.map(({ x, y, width, height }) => ({ x, y, width, height }))]
  }
  return []
}

export function matchEdgeClippedOcrLines(words: OcrWord[], region: OcrRegion, imageWidth: number, imageHeight: number): PixelBox[] {
  const match = matchOcrLinesWithCoverage(words, region, true)
  return edgeAwareCleanupLines({ ...match, lines: filterUsableOcrLines(match.lines, region) }, region, imageWidth, imageHeight)
}

async function regionalOcrWords(image: Buffer, region: PixelRegion, imageWidth: number, imageHeight: number, psm: number, expandVertical = false): Promise<OcrWord[]> {
  // OCR the whole model bubble so short first/last rows near the safe-box edge
  // are not clipped. Source matching below still enforces the tighter safe-box
  // spatial prior before any pixels are changed.
  const topMargin = expandVertical ? Math.max(6, Math.round(region.safe.height * 0.3)) : 0
  const bottomMargin = expandVertical ? Math.max(4, Math.round(region.safe.height * 0.1)) : 0
  const left = Math.max(0, region.x)
  const top = Math.max(0, region.y - topMargin)
  const right = Math.min(region.x + region.width, imageWidth)
  const bottom = Math.min(region.y + region.height + bottomMargin, imageHeight)
  const width = right - left
  const height = bottom - top
  if (width < 12 || height < 12) return []
  const scale = 4
  const prepared = await sharp(image)
    .extract({ left, top, width, height })
    .resize({ width: width * scale, height: height * scale, fit: 'fill' })
    .grayscale()
    .normalize()
    .png()
    .toBuffer()
  const words = (await detectTesseractWords(prepared, psm))
    .map((word) => ({ ...word, line: `${psm}:${expandVertical ? 'expanded' : 'bubble'}:${word.line}` }))
  const mappedWords = words.map((word) => ({
    ...word,
    x: Math.round(left + word.x / scale),
    y: Math.round(top + word.y / scale),
    width: Math.max(1, Math.round(word.width / scale)),
    height: Math.max(1, Math.round(word.height / scale)),
  }))
  const minimumWordHeight = Math.max(4, Math.min(12, Math.round(region.safe.height * 0.08)))
  return mappedWords.filter((word) => word.height >= minimumWordHeight)
}

function aggressiveCleanupIsSafe(match: OcrMatch, region: PixelRegion): boolean {
  if (!match.complete || match.coverage < minimumOcrCoverage || match.lines.length === 0) return false
  if (match.lines.some((line) => line.confidence < 35) || median(match.lines.map((line) => line.confidence)) < 60) return false
  if (region.lines.length > 0 && match.lines.length > region.lines.length + 2) return false
  const padding = Math.max(3, Math.round(median(match.lines.map((line) => line.height)) * 0.42))
  const boxes = match.lines.map((line) => ({
    x: line.x - padding,
    y: line.y - padding,
    width: line.width + padding * 2,
    height: line.height + padding * 2,
  }))
  const envelopeMarginX = region.safe.width * 0.22
  const envelopeMarginY = region.safe.height * 0.22
  if (boxes.some((box) => box.x < region.x || box.y < region.y
    || box.x + box.width > region.x + region.width || box.y + box.height > region.y + region.height
    || box.x < region.safe.x - envelopeMarginX || box.y < region.safe.y - envelopeMarginY
    || box.x + box.width > region.safe.x + region.safe.width + envelopeMarginX
    || box.y + box.height > region.safe.y + region.safe.height + envelopeMarginY)) return false
  const totalArea = boxes.reduce((total, box) => total + box.width * box.height, 0)
  return totalArea <= region.width * region.height * 0.32
    && totalArea <= region.safe.width * region.safe.height * 1.15
}

async function createLineCleanupLayer(image: Buffer, region: PixelRegion, imageWidth: number, imageHeight: number, ocrWords: OcrWord[], aggressive = false): Promise<PreparedLayer | null> {
  let rawMatch = matchOcrLinesWithCoverage(ocrWords, region)
  let match = { ...rawMatch, lines: filterUsableOcrLines(rawMatch.lines, region) }
  // Full-page OCR is fast, but a bubble crop is much more accurate for small or
  // stylized lettering. Only use its result when its source coverage improves.
  if (!match.complete || match.coverage < 0.98 || match.lines.length === 0) {
    const regionalWords = await regionalOcrWords(image, region, imageWidth, imageHeight, 11)
    let rawRegionalMatch = matchOcrLinesWithCoverage(regionalWords, region, true)
    let regionalMatch = { ...rawRegionalMatch, lines: filterUsableOcrLines(rawRegionalMatch.lines, region) }
    if (regionalMatch.coverage < minimumOcrCoverage || regionalMatch.lines.length === 0) {
      const expandedWords = await regionalOcrWords(image, region, imageWidth, imageHeight, 11, true)
      const expandedMatch = matchOcrLinesWithCoverage([...regionalWords, ...expandedWords], region, true)
      const usableExpanded = { ...expandedMatch, lines: filterUsableOcrLines(expandedMatch.lines, region) }
      if (usableExpanded.coverage > regionalMatch.coverage || usableExpanded.lines.length > regionalMatch.lines.length) {
        rawRegionalMatch = expandedMatch
        regionalMatch = usableExpanded
      }
    }
    if (regionalMatch.coverage < minimumOcrCoverage || regionalMatch.lines.length === 0) {
      const fallbackWords = await regionalOcrWords(image, region, imageWidth, imageHeight, 6)
      const fallbackMatch = matchOcrLinesWithCoverage([...regionalWords, ...fallbackWords], region, true)
      const usableFallback = { ...fallbackMatch, lines: filterUsableOcrLines(fallbackMatch.lines, region) }
      if (usableFallback.coverage > regionalMatch.coverage || usableFallback.lines.length > regionalMatch.lines.length) {
        rawRegionalMatch = fallbackMatch
        regionalMatch = usableFallback
      }
    }
    const usableRegionalMatch = regionalMatch
    const areaOf = (candidate: OcrMatch): number => candidate.lines.reduce((total, line) => total + line.width * line.height, 0)
    const coverageDelta = usableRegionalMatch.coverage - match.coverage
    const closeCoverage = Math.abs(coverageDelta) <= 0.03
    const sourceMoreComplete = (rawRegionalMatch.unmatchedCharacters ?? Number.POSITIVE_INFINITY) < (rawMatch.unmatchedCharacters ?? Number.POSITIVE_INFINITY)
    const tighterOrMoreComplete = usableRegionalMatch.lines.length > match.lines.length
      || areaOf(usableRegionalMatch) < areaOf(match)
    if (usableRegionalMatch.lines.length > 0 && (usableRegionalMatch.complete && !match.complete || coverageDelta > 0.03 || (sourceMoreComplete && coverageDelta >= 0) || (closeCoverage && tighterOrMoreComplete) || match.lines.length === 0)) {
      rawMatch = rawRegionalMatch
      match = usableRegionalMatch
    }
  }
  const safeAreaRatio = region.safe.width * region.safe.height / Math.max(1, region.width * region.height)
  if (!aggressive && region.kind === 'narration' && safeAreaRatio >= 0.6) {
    const plan = narrationCaptionPlanFromMatch(rawMatch, region, imageWidth, imageHeight)
    if (plan && await narrationPlanHasColoredInk(image, plan)) {
      const preferredCaption = await createNarrationCaptionPlate(rawMatch, region, imageWidth, imageHeight)
      if (preferredCaption) return preferredCaption
    }
  }
  // CV is a last resort for bubbles Tesseract could not read at all. Never mix
  // guessed CV rows into a partially matched OCR result: that caused artwork
  // and neighboring bubbles to be painted over in the old renderer.
  const edgeLines = edgeAwareCleanupLines(match, region, imageWidth, imageHeight)
  const verifiedOcrLines = match.coverage >= minimumOcrCoverage && match.lines.length > 0
  // Aggressive retry expands only a source-linked OCR mask. It must never turn
  // the CV fallback or a weak partial match into a larger artwork-covering box.
  if (aggressive && !aggressiveCleanupIsSafe(match, region)) return null
  const narrationFallback = (): Promise<PreparedLayerBase | null> => {
    return aggressive ? Promise.resolve(null) : createNarrationCaptionPlate(rawMatch, region, imageWidth, imageHeight)
  }
  const ocrLines = verifiedOcrLines || edgeLines.length > 0
  const lines = verifiedOcrLines
    ? match.lines
    : edgeLines.length > 0
      ? edgeLines
    : match.coverage < minimumOcrCoverage && match.lines.length === 0
      ? await detectVisualTextLines(image, region)
      : []
  if (lines.length === 0) {
    return narrationFallback()
  }
  const padding = Math.max(2, Math.round(median(lines.map((line) => line.height)) * (aggressive ? 0.42 : 0.28)))
  const boundaryLeft = aggressive ? region.x : ocrLines ? 0 : region.x
  const boundaryTop = aggressive ? region.y : ocrLines ? 0 : region.y
  const boundaryRight = aggressive ? region.x + region.width : ocrLines ? imageWidth : region.x + region.width
  const boundaryBottom = aggressive ? region.y + region.height : ocrLines ? imageHeight : region.y + region.height
  const boxes = lines.map((line) => ({
    left: Math.max(boundaryLeft, line.x - padding),
    top: Math.max(boundaryTop, line.y - padding),
    right: Math.min(boundaryRight, line.x + line.width + padding),
    bottom: Math.min(boundaryBottom, line.y + line.height + padding),
  })).filter((box) => box.right > box.left && box.bottom > box.top)
  if (boxes.length === 0) {
    return narrationFallback()
  }
  const left = Math.min(...boxes.map((box) => box.left))
  const top = Math.min(...boxes.map((box) => box.top))
  const right = Math.max(...boxes.map((box) => box.right))
  const bottom = Math.max(...boxes.map((box) => box.bottom))
  const width = right - left
  const height = bottom - top
  const [sampled, grayscale] = await Promise.all([
    sharp(image)
      .extract({ left, top, width, height })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true }),
    sharp(image)
      .extract({ left, top, width, height })
      .grayscale()
      .extractChannel(0)
      .raw()
      .toBuffer(),
  ])
  const alpha = Buffer.alloc(width * height)
  const rawDark = new Uint8Array(width * height)
  const lightSamples: Array<{ r: number; g: number; b: number; luminance: number }> = []
  const inkThreshold = 190
  const isInsideBox = (x: number, y: number): boolean => boxes.some((box) => {
    return x >= box.left - left && x < box.right - left && y >= box.top - top && y < box.bottom - top
  })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isInsideBox(x, y)) continue
      const index = y * width + x
      const value = grayscale[index]
      const offset = index * sampled.info.channels
      const r = sampled.data[offset]
      const g = sampled.data[offset + 1]
      const b = sampled.data[offset + 2]
      if (value < inkThreshold) {
        rawDark[index] = 1
      } else if (value >= 180) {
        lightSamples.push({ r, g, b, luminance: (r + g + b) / 3 })
      }
    }
  }
  const lineHeight = Math.max(5, median(lines.map((line) => line.height)))
  const componentMaximumWidth = Math.max(18, Math.round(lineHeight * (aggressive ? 3 : 2.5)))
  const componentMaximumHeight = Math.max(8, Math.round(lineHeight * (aggressive ? 1.4 : 1.25)))
  const components = findInkComponents(grayscale, width, height, inkThreshold)
  const acceptedComponents = components.filter((component) => {
    if (component.width > componentMaximumWidth || component.height > componentMaximumHeight) return false
    if (component.area < Math.max(2, Math.round(component.width * component.height * 0.04))) return false
    const margin = Math.max(1, Math.round(lineHeight * 0.06))
    return boxes.some((box) => {
      const boxLeft = box.left - left
      const boxTop = box.top - top
      const boxRight = box.right - left
      const boxBottom = box.bottom - top
      return component.x >= boxLeft + margin
        && component.y >= boxTop + margin
        && component.x + component.width <= boxRight - margin
        && component.y + component.height <= boxBottom - margin
    })
  })
  const dark = new Uint8Array(width * height)
  let darkPixels = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (!rawDark[index]) continue
      if (!acceptedComponents.some((component) => x >= component.x && x < component.x + component.width && y >= component.y && y < component.y + component.height)) continue
      dark[index] = 1
      darkPixels += 1
    }
  }
  if (darkPixels < 2 || lightSamples.length < 4) {
    return narrationFallback()
  }
  const dilationRadius = Math.max(1, Math.min(aggressive ? 7 : 5, Math.round(lineHeight * (aggressive ? 0.2 : 0.13))))
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!dark[y * width + x]) continue
      for (let dy = -dilationRadius; dy <= dilationRadius; dy += 1) {
        for (let dx = -dilationRadius; dx <= dilationRadius; dx += 1) {
          if (dx * dx + dy * dy > dilationRadius * dilationRadius) continue
          const targetX = x + dx
          const targetY = y + dy
          if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height || !isInsideBox(targetX, targetY)) continue
          alpha[targetY * width + targetX] = 255
        }
      }
    }
  }
  const maskedPixels = alpha.reduce((total, value) => total + (value > 0 ? 1 : 0), 0)
  if (maskedPixels === 0) {
    return narrationFallback()
  }
  const sortedLuminance = lightSamples.map((sample) => sample.luminance).sort((leftValue, rightValue) => leftValue - rightValue)
  const highPercentile = sortedLuminance[Math.floor((sortedLuminance.length - 1) * 0.8)] ?? 180
  const brightSamples = lightSamples.filter((sample) => sample.luminance >= highPercentile)
  if (brightSamples.length < 2) {
    return narrationFallback()
  }
  const background = {
    r: Math.round(brightSamples.reduce((total, sample) => total + sample.r, 0) / brightSamples.length),
    g: Math.round(brightSamples.reduce((total, sample) => total + sample.g, 0) / brightSamples.length),
    b: Math.round(brightSamples.reduce((total, sample) => total + sample.b, 0) / brightSamples.length),
  }
  const backgroundLuminance = (background.r + background.g + background.b) / 3
  if (backgroundLuminance < 180) {
    return narrationFallback()
  }
  const channelSpread = Math.max(background.r, background.g, background.b) - Math.min(background.r, background.g, background.b)
  const monochromeBubble = channelSpread <= 18
  if (!monochromeBubble && maskedPixels > region.width * region.height * 0.35) {
    return narrationFallback()
  }
  if (monochromeBubble) {
    const nearWhite = Math.max(235, Math.round((background.r + background.g + background.b) / 3))
    background.r = nearWhite
    background.g = nearWhite
    background.b = nearWhite
  }
  const tightMonochromeOcr = ocrLines && monochromeBubble && lines.every((line) => {
    const centreX = line.x + line.width / 2
    const centreY = line.y + line.height / 2
    return line.x >= region.safe.x - region.safe.width * 0.2
      && line.x + line.width <= region.safe.x + region.safe.width * 1.2
      && line.width <= region.safe.width * 1.1
      && centreX >= region.safe.x - region.safe.width * 0.2
      && centreX <= region.safe.x + region.safe.width * 1.2
      && centreY >= region.safe.y - region.safe.height * 0.2
      && centreY <= region.safe.y + region.safe.height * 1.2
  })
  const tightModelBackedVisual = !ocrLines && monochromeBubble && region.kind === 'speech'
    && modelBackedVisualLinesAreTight(lines, region.lines)
  if (tightMonochromeOcr || tightModelBackedVisual) {
    // On light B/W bubbles, a tightly verified OCR box or a CV row backed by
    // every model line is safer than reconstructing anti-aliased glyph pixels.
    for (const box of boxes) {
      for (let y = box.top - top; y < box.bottom - top; y += 1) {
        alpha.fill(255, y * width + box.left - left, y * width + box.right - left)
      }
    }
    const filledPixels = alpha.reduce((total, value) => total + (value > 0 ? 1 : 0), 0)
    if (filledPixels > region.width * region.height * (aggressive ? 0.4 : 0.55)
      || aggressive && filledPixels > region.safe.width * region.safe.height * 1.15) {
      return narrationFallback()
    }
    background.r = 255
    background.g = 255
    background.b = 255
  }
  const input = await sharp({ create: { width, height, channels: 3, background } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer()
  const fallback = await narrationFallback()
  return {
    overlay: { input, top, left },
    // Keep the typesetter aligned to the text that was actually found. Using
    // the model's whole safe box here lets a long translation grow over art.
    layout: { ...region, x: left, y: top, width, height, safe: { x: left, y: top, width, height } },
    ...(fallback ? { fallback } : {}),
  }
}

export interface RenderTranslationResult {
  image: Buffer
  expectedRegions: number
  renderedRegions: number
  skippedRegionIds: number[]
}

export interface RenderTranslationOptions {
  ocrWordsOverride?: OcrWord[]
  aggressiveRegionIds?: Iterable<number>
}

export async function renderTranslationDetailed(
  image: Buffer,
  result: TranslationResult,
  ocrWordsOverrideOrOptions?: OcrWord[] | RenderTranslationOptions,
  legacyOptions: RenderTranslationOptions = {},
): Promise<RenderTranslationResult> {
  const options = Array.isArray(ocrWordsOverrideOrOptions)
    ? { ...legacyOptions, ocrWordsOverride: ocrWordsOverrideOrOptions }
    : (ocrWordsOverrideOrOptions ?? legacyOptions)
  const aggressiveRegionIds = new Set(options.aggressiveRegionIds ?? [])
  const normalizedImage = await sharp(image).rotate().png().toBuffer()
  const base = sharp(normalizedImage)
  const metadata = await base.metadata()
  const width = metadata.width ?? 1
  const height = metadata.height ?? 1
  const expected = result.regions.filter((region) => region.kind !== 'sfx' && normalizeDisplayText(region.translation))
  const expectedRegions = expected.length
  const expectedRegionIds = expected.map((region) => region.id)
  const regions = expected.flatMap((region) => {
    const converted = toPixelRegion(region, width, height)
    return converted ? [converted] : []
  })
  if (regions.length === 0) {
    return { image: await base.webp({ quality: 92 }).toBuffer(), expectedRegions, renderedRegions: 0, skippedRegionIds: expectedRegionIds }
  }
  const ocrWords = options.ocrWordsOverride ?? await detectOcrWords(normalizedImage)
  const renderedRegions = await Promise.all(regions.map(async (region) => {
    let prepared = await createLineCleanupLayer(normalizedImage, region, width, height, ocrWords, aggressiveRegionIds.has(region.id))
    if (!prepared) return null
    let textLayer = await createTextLayer(prepared.layout, width)
    if (!textLayer && prepared.fallback) {
      prepared = prepared.fallback
      textLayer = await createTextLayer(prepared.layout, width)
    }
    if (!textLayer) return null
    return { id: region.id, cleanup: prepared.overlay, text: textLayer }
  }))
  const cleanupOverlays = renderedRegions.flatMap((region) => region ? [region.cleanup] : [])
  const textOverlays = renderedRegions.flatMap((region) => region ? [region.text] : [])
  const renderedRegionIds = new Set(renderedRegions.flatMap((region) => region ? [region.id] : []))
  const skippedRegionIds = expectedRegionIds.filter((id) => !renderedRegionIds.has(id))
  if (cleanupOverlays.length === 0) {
    return { image: await base.webp({ quality: 92 }).toBuffer(), expectedRegions, renderedRegions: 0, skippedRegionIds }
  }
  const rendered = await base.composite([
    ...cleanupOverlays,
    ...textOverlays,
  ]).webp({ quality: 92 }).toBuffer()
  return { image: rendered, expectedRegions, renderedRegions: cleanupOverlays.length, skippedRegionIds }
}

export async function renderTranslation(image: Buffer, result: TranslationResult): Promise<Buffer> {
  return (await renderTranslationDetailed(image, result)).image
}
