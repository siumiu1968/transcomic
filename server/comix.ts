import { chromium, type Browser, type BrowserContext, type Page } from 'patchright'
import { config } from './config.js'
import type { SourceChapter, SourcePage, SourceSeries } from './types.js'

interface Paged<T> {
  items: T[]
  meta: { lastPage?: number; hasNext?: boolean; page?: number }
}

interface ChapterPayload extends SourceChapter {
  pages?: { baseUrl?: string; items?: SourcePage[] }
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

  async search(query: string): Promise<Paged<SourceSeries>> {
    return this.locked(async () => {
      const { page } = await this.ready()
      const href = await this.moduleHref(page)
      return page.evaluate(async ({ href, query }) => {
        const client = await import(href)
        return client.c.list({ keyword: query, limit: 12 })
      }, { href, query }) as Promise<Paged<SourceSeries>>
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
        return chapters
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
      return items.map((item) => ({ ...item, url: new URL(item.url, baseUrl || 'https://comix.to').toString() }))
    })
  }

  async downloadSource(rawUrl: string): Promise<{ body: Buffer; contentType: string }> {
    if (!isAllowedSourceUrl(rawUrl)) throw new Error('圖片來源網域不受信任')
    const { context } = await this.locked(() => this.ready())
    const response = await context.request.get(rawUrl, {
      headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', Referer: 'https://comix.to/' },
      timeout: 90_000,
    })
    if (!response.ok()) throw new Error(`圖片下載失敗 (${response.status()})`)
    return { body: Buffer.from(await response.body()), contentType: response.headers()['content-type'] ?? 'image/webp' }
  }

  async close(): Promise<void> {
    await this.browser?.close()
    this.browser = undefined
    this.context = undefined
    this.page = undefined
  }
}
