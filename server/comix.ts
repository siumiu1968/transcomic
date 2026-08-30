import { chromium, type Browser, type BrowserContext, type Page } from 'patchright'
import { config } from './config.js'
import type { SourceChapter, SourcePage, SourceSeries } from './types.js'

interface Paged<T> {
  items: T[]
  meta: { lastPage?: number; hasNext?: boolean; page?: number }
}

interface ChapterPayload extends SourceChapter {
  pages?: { baseUrl?: string; items?: Array<SourcePage & { s?: number }> }
}

export interface SourceImageRequest {
  chapterUrl?: string
  pagePosition?: number
  scramble?: boolean
}

const COMIX_SEARCH_PAGE_SIZE = 28

export function buildComixSearchParams(query: string, page = 1) {
  return {
    keyword: query.trim(),
    page,
    limit: COMIX_SEARCH_PAGE_SIZE,
    content_rating: ['safe', 'suggestive'],
    order: { relevance: 'desc' },
  }
}

export function isAllowedSourceUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    return host === 'comix.to' || host.endsWith('.comix.to') || /^(?:[a-z0-9-]+\.)*wowpic\d*\.store$/.test(host)
  } catch {
    return false
  }
}

export class ComixClient {
  private browser?: Browser
  private context?: BrowserContext
  private page?: Page
  private tail: Promise<void> = Promise.resolve()

  private locked<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private async ready(): Promise<{ context: BrowserContext; page: Page }> {
    if (this.context && this.page && !this.page.isClosed()) return { context: this.context, page: this.page }
    this.browser = await chromium.launch({
      headless: config.browserHeadless,
      executablePath: config.browserExecutablePath,
      proxy: config.comixProxyUrl ? { server: config.comixProxyUrl } : undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    this.context = await this.browser.newContext({ locale: 'zh-HK', viewport: { width: 1365, height: 900 } })
    this.page = await this.context.newPage()
    await this.navigate(this.page, config.comixBootstrapUrl)
    return { context: this.context, page: this.page }
  }

  private async navigate(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await page.waitForSelector('#app-root[data-app-mounted]', { timeout: 90_000 })
  }

  private async moduleHref(page: Page): Promise<string> {
    const href = await page.evaluate(() => {
      const candidates = [
        ...[...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')].map((element) => element.href),
        ...performance.getEntriesByType('resource').map((entry) => entry.name),
      ]
      return candidates.find((url) => /\/env-[^/]+\.js$/.test(url)) ?? ''
    })
    if (!href) throw new Error('暫時無法載入 Comix 連接模組')
    return href
  }

  async search(query: string, searchPage = 1): Promise<Paged<SourceSeries>> {
    return this.locked(async () => {
      const { page } = await this.ready()
      const href = await this.moduleHref(page)
      const params = buildComixSearchParams(query, searchPage)
      return page.evaluate(async ({ href, params }) => {
        const client = await import(href)
        return client.c.list(params)
      }, { href, params }) as Promise<Paged<SourceSeries>>
    })
  }

  async getSeries(hid: string): Promise<SourceSeries> {
    return this.locked(async () => {
      const { page } = await this.ready()
      const href = await this.moduleHref(page)
      return page.evaluate(async ({ href, hid }) => {
        const client = await import(href)
        return client.c.get(hid)
      }, { href, hid }) as Promise<SourceSeries>
    })
  }

  async getAllChapters(hid: string): Promise<SourceChapter[]> {
    return this.locked(async () => {
      const { page } = await this.ready()
      const href = await this.moduleHref(page)
      return page.evaluate(async ({ href, hid }) => {
        const client = await import(href)
        const chapters: SourceChapter[] = []
        let current = 1
        let last = 1
        do {
          const response = await client.c.chapters(hid, { page: current, limit: 100, order: { number: 'desc' } })
          chapters.push(...(response.items ?? []))
          last = response.meta?.lastPage ?? current
          current += 1
        } while (current <= last)
        const preferred = new Map<string, SourceChapter>()
        for (const chapter of chapters) {
          const key = String(chapter.number)
          const current = preferred.get(key)
          if (!current || (chapter.isOfficial && !current.isOfficial) || (chapter.isOfficial === current.isOfficial && chapter.id > current.id)) {
            preferred.set(key, chapter)
          }
        }
        return [...preferred.values()].sort((left, right) => right.number - left.number || right.id - left.id)
      }, { href, hid }) as Promise<SourceChapter[]>
    })
  }

  async getChapterPages(chapter: Pick<SourceChapter, 'id' | 'url'>): Promise<SourcePage[]> {
    return this.locked(async () => {
      const { page } = await this.ready()
      if (!chapter.url.startsWith('/title/')) throw new Error('章節來源路徑無效')
      await this.navigate(page, new URL(chapter.url, 'https://comix.to').toString())
      const href = await this.moduleHref(page)
      const payload = await page.evaluate(async ({ href, chapterId }) => {
        const client = await import(href)
        return client.b.get(`/chapters/${chapterId}`)
      }, { href, chapterId: chapter.id }) as ChapterPayload
      const baseUrl = payload.pages?.baseUrl ?? ''
      const items = payload.pages?.items ?? []
      return items.map((item) => ({
        ...item,
        scramble: item.s === 1,
        url: new URL(item.url, baseUrl || 'https://comix.to').toString(),
      }))
    })
  }

  async downloadSource(rawUrl: string, request: SourceImageRequest = {}): Promise<{ body: Buffer; contentType: string }> {
    if (!isAllowedSourceUrl(rawUrl)) throw new Error('圖片來源網域不受信任')
    return this.locked(async () => {
      const { context, page } = await this.ready()
      if (!request.scramble) {
        const response = await context.request.get(rawUrl, {
          headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', Referer: 'https://comix.to/' },
          timeout: 90_000,
        })
        if (!response.ok()) throw new Error(`圖片下載失敗 (${response.status()})`)
        return { body: Buffer.from(await response.body()), contentType: response.headers()['content-type'] ?? 'image/webp' }
      }
      const chapterUrl = request.chapterUrl
      const pagePosition = request.pagePosition
      if (!chapterUrl?.startsWith('/title/') || typeof pagePosition !== 'number' || !Number.isInteger(pagePosition) || pagePosition < 1) {
        throw new Error('亂序圖片缺少章節定位資料')
      }
      const chapterHref = new URL(chapterUrl, 'https://comix.to')
      if (new URL(page.url()).pathname !== chapterHref.pathname) await this.navigate(page, chapterHref.toString())
      const pageSelector = `.rpage-page[data-page="${pagePosition}"] canvas`
      await page.waitForSelector(`[aria-label="Go to page ${pagePosition}"]`, { timeout: 90_000 })
      // Reader ads can sit above the progress rail; the button's own handler is still valid.
      await page.locator(`[aria-label="Go to page ${pagePosition}"]`).click({ force: true })
      await page.waitForSelector(pageSelector, { timeout: 90_000 })
      await page.waitForTimeout(250)
      const dataUrl = await page.evaluate((selector) => {
        const canvas = document.querySelector<HTMLCanvasElement>(selector)
        if (!canvas || canvas.width === 0 || canvas.height === 0) throw new Error('原站未產生還原圖片')
        return canvas.toDataURL('image/png')
      }, pageSelector)
      const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
      if (!match) throw new Error('原站還原圖片格式無效')
      return { body: Buffer.from(match[1], 'base64'), contentType: 'image/png' }
    })
  }

  async close(): Promise<void> {
    await this.browser?.close()
    this.browser = undefined
    this.context = undefined
    this.page = undefined
  }
}
