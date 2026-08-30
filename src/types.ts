export interface Series {
  hid: string
  title: string
  alt_titles: string
  poster_url: string
  source_language: string
  status: string
  synopsis: string
  chapter_count: number
  translated_count: number
  created_at: string
  updated_at: string
}

export interface SearchSeries {
  hid: string
  title: string
  altTitles: string[]
  poster: { medium?: string; large?: string }
  originalLanguage: string
  status: string
  synopsis?: string
  latestChapter: number
}

export interface Chapter {
  id: number
  series_hid: string
  number: number
  volume: number
  name: string
  language: string
  page_count: number
  translated_pages: number
  status: 'ready' | 'queued' | 'translating' | 'completed' | 'failed'
  updated_at: string
}

export interface Job {
  id: string
  chapter_id: number
  series_hid: string
  series_title: string
  chapter_number: number
  model: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  current_page: number
  total_pages: number
  error: string
  created_at: string
}

export interface ReaderPage {
  position: number
  width: number
  height: number
  status: string
  originalUrl: string
  translatedUrl: string | null
}
