export type TranslationMode = 'fast' | 'balanced' | 'quality'

export interface SourceSeries {
  hid: string
  title: string
  altTitles: string[]
  type: string
  status: string
  originalLanguage: string
  poster: { medium?: string; large?: string }
  latestChapter: number
  year?: number
  synopsis?: string
  url: string
}

export interface SourceChapter {
  id: number
  mangaId: number
  number: number
  volume: number
  name: string
  language: string
  isOfficial?: boolean
  createdAtFormatted?: string
  url: string
}

export interface SourcePage {
  width: number
  height: number
  url: string
  scramble?: boolean
}

export interface TranslationRegion {
  id: number
  bubble: TranslationBox
  safe: TranslationBox
  source: string
  translation: string
  kind: 'speech' | 'narration' | 'sfx'
}

export interface TranslationBox {
  x: number
  y: number
  width: number
  height: number
}

export interface TranslationResult {
  regions: TranslationRegion[]
}

export interface SeriesRow {
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

export interface ChapterRow {
  id: number
  series_hid: string
  number: number
  volume: number
  name: string
  language: string
  source_url: string
  page_count: number
  translated_pages: number
  status: 'ready' | 'queued' | 'translating' | 'completed' | 'failed'
  created_at: string
  updated_at: string
}

export interface PageRow {
  chapter_id: number
  position: number
  source_url: string
  original_path: string
  translated_path: string
  width: number
  height: number
  scramble: number | null
  status: 'pending' | 'translating' | 'completed' | 'failed'
  error: string
  translation_json: string
}

export interface JobRow {
  id: string
  chapter_id: number
  series_hid: string
  series_title: string
  chapter_number: number
  model: string
  reasoning_effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  current_page: number
  total_pages: number
  error: string
  created_at: string
  started_at: string
  finished_at: string
}
