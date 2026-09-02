import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertTranslationModel } from './config.js'
import type {
  ChapterRow,
  JobRow,
  PageRow,
  SeriesMemoryEntry,
  SeriesRow,
  SourceChapter,
  SourcePage,
  SourceSeries,
  TranslationMemoryCategory,
  TranslationMemoryDelta,
} from './types.js'

const memoryCategories = new Set<TranslationMemoryCategory>(['character', 'place', 'term', 'address', 'voice'])

export function canonicalSourceKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

export function hasTranslationOutput(page: Pick<PageRow, 'translated_path' | 'translation_json' | 'status'>): boolean {
  return page.status === 'completed' && Boolean(page.translated_path && page.translation_json.trim())
}

export class Store {
  readonly db: DatabaseSync

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true })
    this.db = new DatabaseSync(path.join(dataDir, 'transcomic.sqlite'))
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS series (
        hid TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        alt_titles TEXT NOT NULL DEFAULT '[]',
        poster_url TEXT NOT NULL DEFAULT '',
        source_language TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        synopsis TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS series_memory (
        series_hid TEXT NOT NULL REFERENCES series(hid) ON DELETE CASCADE,
        category TEXT NOT NULL CHECK(category IN ('character','place','term','address','voice')),
        source_key TEXT NOT NULL,
        source TEXT NOT NULL,
        translation TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(series_hid, category, source_key)
      );
      CREATE INDEX IF NOT EXISTS series_memory_series_created
        ON series_memory(series_hid, created_at DESC);
      CREATE TABLE IF NOT EXISTS chapters (
        id INTEGER PRIMARY KEY,
        series_hid TEXT NOT NULL REFERENCES series(hid) ON DELETE CASCADE,
        number REAL NOT NULL DEFAULT 0,
        volume REAL NOT NULL DEFAULT 0,
        name TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL,
        page_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ready',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS chapters_series_number ON chapters(series_hid, number DESC);
      CREATE TABLE IF NOT EXISTS pages (
        chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        source_url TEXT NOT NULL,
        original_path TEXT NOT NULL DEFAULT '',
        translated_path TEXT NOT NULL DEFAULT '',
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        scramble INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(chapter_id, position)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        current_page INTEGER NOT NULL DEFAULT 0,
        total_pages INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at TEXT NOT NULL DEFAULT '',
        finished_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs(status, created_at);
    `)
    const pageColumns = this.db.prepare('PRAGMA table_info(pages)').all() as unknown as Array<{ name: string }>
    if (!pageColumns.some((column) => column.name === 'translation_json')) {
      this.db.exec("ALTER TABLE pages ADD COLUMN translation_json TEXT NOT NULL DEFAULT ''")
    }
    if (!pageColumns.some((column) => column.name === 'scramble')) {
      // NULL marks rows created before scramble metadata existed, so they are refreshed once.
      this.db.exec('ALTER TABLE pages ADD COLUMN scramble INTEGER')
    }
    const jobColumns = this.db.prepare('PRAGMA table_info(jobs)').all() as unknown as Array<{ name: string }>
    if (!jobColumns.some((column) => column.name === 'reasoning_effort')) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'max'")
    }
    this.db.prepare("UPDATE jobs SET status='queued', started_at='' WHERE status='running'").run()
    this.db.prepare("UPDATE chapters SET status='queued' WHERE status='translating'").run()
    this.db.prepare("UPDATE jobs SET model='gpt-5.6-luna', reasoning_effort='max' WHERE status='queued' AND model!='gpt-5.6-luna'").run()
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS jobs_luna_only_insert
      BEFORE INSERT ON jobs WHEN NEW.model!='gpt-5.6-luna'
      BEGIN SELECT RAISE(ABORT, '翻譯工作只允許使用 gpt-5.6-luna'); END;
      CREATE TRIGGER IF NOT EXISTS jobs_luna_only_model_update
      BEFORE UPDATE OF model ON jobs WHEN NEW.model!='gpt-5.6-luna'
      BEGIN SELECT RAISE(ABORT, '翻譯工作只允許使用 gpt-5.6-luna'); END;
    `)
    // A pre-region renderer could write a translated image without recording any
    // translation output. Keep the file intact, but prevent it being presented as
    // a real translation or silently skipped by a later manual retry.
    this.db.prepare(`
      UPDATE pages
      SET status='needs_retranslation', error='舊版本未有翻譯資料，請手動重譯'
      WHERE translated_path!='' AND TRIM(translation_json)='' AND status='completed'
    `).run()
    this.db.prepare(`
      UPDATE chapters
      SET status='needs_retranslation', updated_at=CURRENT_TIMESTAMP
      WHERE status='completed' AND EXISTS (
        SELECT 1 FROM pages WHERE pages.chapter_id=chapters.id AND pages.status='needs_retranslation'
      )
    `).run()
  }

  upsertSeries(series: SourceSeries): void {
    this.db.prepare(`
      INSERT INTO series (hid, title, alt_titles, poster_url, source_language, status, synopsis)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hid) DO UPDATE SET
        title=excluded.title, alt_titles=excluded.alt_titles, poster_url=excluded.poster_url,
        source_language=excluded.source_language, status=excluded.status, synopsis=excluded.synopsis,
        updated_at=CURRENT_TIMESTAMP
    `).run(series.hid, series.title, JSON.stringify(series.altTitles ?? []), series.poster?.large ?? series.poster?.medium ?? '', series.originalLanguage ?? '', series.status ?? '', series.synopsis ?? '')
  }

  upsertChapters(seriesHid: string, chapters: SourceChapter[]): void {
    const statement = this.db.prepare(`
      INSERT INTO chapters (id, series_hid, number, volume, name, language, source_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        series_hid=excluded.series_hid, number=excluded.number, volume=excluded.volume,
        name=excluded.name, language=excluded.language, source_url=excluded.source_url,
        updated_at=CURRENT_TIMESTAMP
    `)
    this.db.exec('BEGIN')
    try {
      for (const chapter of chapters) {
        statement.run(chapter.id, seriesHid, chapter.number ?? 0, chapter.volume ?? 0, chapter.name ?? '', chapter.language ?? '', chapter.url)
      }
      if (chapters.length > 0) {
        const placeholders = chapters.map(() => '?').join(',')
        this.db.prepare(`
          DELETE FROM chapters
          WHERE series_hid=? AND id NOT IN (${placeholders})
            AND id NOT IN (SELECT chapter_id FROM pages)
            AND id NOT IN (SELECT chapter_id FROM jobs)
        `).run(seriesHid, ...chapters.map((chapter) => chapter.id))
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listSeries(): SeriesRow[] {
    return this.db.prepare(`
      SELECT s.*,
        COUNT(c.id) AS chapter_count,
        COALESCE(SUM(CASE WHEN c.status='completed' THEN 1 ELSE 0 END), 0) AS translated_count
      FROM series s LEFT JOIN chapters c ON c.series_hid=s.hid
      GROUP BY s.hid ORDER BY s.updated_at DESC
    `).all() as unknown as SeriesRow[]
  }

  getSeries(hid: string): SeriesRow | undefined {
    return this.db.prepare(`
      SELECT s.*,
        COUNT(c.id) AS chapter_count,
        COALESCE(SUM(CASE WHEN c.status='completed' THEN 1 ELSE 0 END), 0) AS translated_count
      FROM series s LEFT JOIN chapters c ON c.series_hid=s.hid
      WHERE s.hid=? GROUP BY s.hid
    `).get(hid) as unknown as SeriesRow | undefined
  }

  listChapters(seriesHid: string): ChapterRow[] {
    return this.db.prepare(`
      SELECT c.*, COUNT(p.position) AS page_count,
        COALESCE(SUM(CASE WHEN p.status='completed' THEN 1 ELSE 0 END), 0) AS translated_pages
      FROM chapters c LEFT JOIN pages p ON p.chapter_id=c.id
      WHERE c.series_hid=? GROUP BY c.id ORDER BY c.number DESC, c.id DESC
    `).all(seriesHid) as unknown as ChapterRow[]
  }

  getChapter(id: number): ChapterRow | undefined {
    return this.db.prepare(`
      SELECT c.*, COUNT(p.position) AS page_count,
        COALESCE(SUM(CASE WHEN p.status='completed' THEN 1 ELSE 0 END), 0) AS translated_pages
      FROM chapters c LEFT JOIN pages p ON p.chapter_id=c.id
      WHERE c.id=? GROUP BY c.id
    `).get(id) as unknown as ChapterRow | undefined
  }

  upsertPages(chapterId: number, pages: SourcePage[]): void {
    const statement = this.db.prepare(`
      INSERT INTO pages (chapter_id, position, source_url, width, height, scramble)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chapter_id, position) DO UPDATE SET
        source_url=excluded.source_url, width=excluded.width, height=excluded.height,
        scramble=excluded.scramble,
        original_path=CASE WHEN excluded.scramble=1 AND COALESCE(pages.scramble, 0)=0 THEN '' ELSE original_path END,
        translated_path=CASE WHEN excluded.scramble=1 AND COALESCE(pages.scramble, 0)=0 THEN '' ELSE translated_path END,
        translation_json=CASE WHEN excluded.scramble=1 AND COALESCE(pages.scramble, 0)=0 THEN '' ELSE translation_json END,
        status=CASE WHEN excluded.scramble=1 AND COALESCE(pages.scramble, 0)=0 THEN 'pending' ELSE status END,
        error=CASE WHEN excluded.scramble=1 AND COALESCE(pages.scramble, 0)=0 THEN '' ELSE error END
    `)
    this.db.exec('BEGIN')
    try {
      pages.forEach((page, index) => statement.run(chapterId, index + 1, page.url, page.width ?? 0, page.height ?? 0, page.scramble ? 1 : 0))
      this.db.prepare('DELETE FROM pages WHERE chapter_id=? AND position>?').run(chapterId, pages.length)
      this.db.prepare('UPDATE chapters SET page_count=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(pages.length, chapterId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listPages(chapterId: number): PageRow[] {
    return this.db.prepare('SELECT * FROM pages WHERE chapter_id=? ORDER BY position').all(chapterId) as unknown as PageRow[]
  }

  updatePage(chapterId: number, position: number, values: Partial<Pick<PageRow, 'original_path' | 'translated_path' | 'status' | 'error' | 'width' | 'height' | 'translation_json'>>): void {
    const entries = Object.entries(values)
    if (entries.length === 0) return
    const fields = entries.map(([key]) => `${key}=?`).join(', ')
    this.db.prepare(`UPDATE pages SET ${fields} WHERE chapter_id=? AND position=?`).run(...entries.map(([, value]) => value), chapterId, position)
  }

  /**
   * Makes a page visible as completed and records its series-level terminology
   * in the same write transaction. Existing keys are immutable by design.
   */
  completePageTranslation(
    chapterId: number,
    position: number,
    translatedPath: string,
    translationJson: string,
    memoryDelta: readonly TranslationMemoryDelta[] = [],
  ): number {
    const chapter = this.db.prepare('SELECT series_hid FROM chapters WHERE id=?').get(chapterId) as { series_hid: string } | undefined
    if (!chapter) throw new Error(`章節 ${chapterId} 不存在`)
    const update = this.db.prepare(`
      UPDATE pages SET translated_path=?, translation_json=?, status='completed', error=''
      WHERE chapter_id=? AND position=?
    `)
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO series_memory (series_hid, category, source_key, source, translation, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    let inserted = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = update.run(translatedPath, translationJson, chapterId, position)
      if (Number(result.changes) !== 1) throw new Error(`頁面 ${chapterId}/${position} 不存在`)
      for (const raw of memoryDelta) {
        const category = raw.category
        if (!memoryCategories.has(category)) continue
        const source = typeof raw.source === 'string' ? raw.source.trim().slice(0, 160) : ''
        const translation = typeof raw.translation === 'string' ? raw.translation.trim().slice(0, 160) : ''
        const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 240) : ''
        const sourceKey = canonicalSourceKey(source)
        if (!sourceKey) continue
        if (category === 'voice' ? !note : !translation) continue
        inserted += Number(insert.run(chapter.series_hid, category, sourceKey, source, translation, note).changes)
      }
      this.db.exec('COMMIT')
      return inserted
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  seriesMemory(seriesHid: string, relevanceText = '', limit = 24): SeriesMemoryEntry[] {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 48)) : 24
    const relevanceKey = canonicalSourceKey(relevanceText)
    const relevant = relevanceKey ? this.db.prepare(`
      SELECT series_hid, category, source_key, source, translation, note, created_at, rowid AS memory_rowid
      FROM series_memory
      WHERE series_hid=? AND INSTR(?, source_key)>0
      ORDER BY created_at DESC, rowid DESC LIMIT 48
    `).all(seriesHid, relevanceKey) as unknown as Array<SeriesMemoryEntry & { memory_rowid: number }> : []
    const recent = this.db.prepare(`
      SELECT series_hid, category, source_key, source, translation, note, created_at, rowid AS memory_rowid
      FROM series_memory WHERE series_hid=?
      ORDER BY created_at DESC, rowid DESC LIMIT 48
    `).all(seriesHid) as unknown as Array<SeriesMemoryEntry & { memory_rowid: number }>
    const candidates = [...relevant, ...recent.filter((entry) => !relevant.some((match) => (
      match.category === entry.category && match.source_key === entry.source_key
    )))]
    const scored = candidates.map((entry, index) => {
      const translationKey = canonicalSourceKey(entry.translation)
      const sourceMatch = entry.source_key.length >= 2 && relevanceKey.includes(entry.source_key)
      const translationMatch = translationKey.length >= 2 && relevanceKey.includes(translationKey)
      return { entry, index, score: sourceMatch ? 2 : translationMatch ? 1 : 0 }
    })
    const selected = scored
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map(({ entry }) => entry)
    const seen = new Set(selected.map((entry) => `${entry.category}\0${entry.source_key}`))
    // A small recent baseline keeps recurring names available when the next
    // image cannot be searched before model vision runs; matched entries win.
    for (const entry of candidates) {
      if (selected.length >= Math.min(8, boundedLimit)) break
      const key = `${entry.category}\0${entry.source_key}`
      if (seen.has(key)) continue
      selected.push(entry)
      seen.add(key)
    }
    return selected.slice(0, boundedLimit).map(({ series_hid, category, source_key, source, translation, note, created_at }) => ({
      series_hid,
      category,
      source_key,
      source,
      translation,
      note,
      created_at,
    }))
  }

  setChapterStatus(id: number, status: ChapterRow['status']): void {
    this.db.prepare('UPDATE chapters SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, id)
  }

  resetChapterTranslation(id: number): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare("UPDATE pages SET translated_path='', translation_json='', status='pending', error='' WHERE chapter_id=?").run(id)
      this.setChapterStatus(id, 'ready')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  createJob(job: Pick<JobRow, 'id' | 'chapter_id' | 'model' | 'reasoning_effort'>): void {
    this.db.prepare('INSERT INTO jobs (id, chapter_id, model, reasoning_effort) VALUES (?, ?, ?, ?)').run(job.id, job.chapter_id, assertTranslationModel(job.model), job.reasoning_effort)
    this.setChapterStatus(job.chapter_id, 'queued')
  }

  recentSeriesTranslationJson(seriesHid: string, beforeChapterNumber: number, limit = 2): string[] {
    const rows = this.db.prepare(`
      SELECT p.translation_json
      FROM pages p JOIN chapters c ON c.id=p.chapter_id
      WHERE c.series_hid=? AND c.number<? AND p.translation_json!=''
      ORDER BY c.number DESC, p.position DESC LIMIT ?
    `).all(seriesHid, beforeChapterNumber, limit) as unknown as Array<{ translation_json: string }>
    return rows.reverse().map((row) => row.translation_json)
  }

  activeJobForChapter(chapterId: number): JobRow | undefined {
    return this.db.prepare(`
      SELECT j.*, c.series_hid, s.title AS series_title, c.number AS chapter_number
      FROM jobs j JOIN chapters c ON c.id=j.chapter_id JOIN series s ON s.hid=c.series_hid
      WHERE j.chapter_id=? AND j.status IN ('queued','running') ORDER BY j.created_at DESC LIMIT 1
    `).get(chapterId) as unknown as JobRow | undefined
  }

  listJobs(limit = 100): JobRow[] {
    return this.db.prepare(`
      SELECT j.*, c.series_hid, s.title AS series_title, c.number AS chapter_number
      FROM jobs j JOIN chapters c ON c.id=j.chapter_id JOIN series s ON s.hid=c.series_hid
      ORDER BY CASE j.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, j.created_at DESC
      LIMIT ?
    `).all(limit) as unknown as JobRow[]
  }

  queuedJobs(): JobRow[] {
    return this.db.prepare(`
      SELECT j.*, c.series_hid, s.title AS series_title, c.number AS chapter_number
      FROM jobs j JOIN chapters c ON c.id=j.chapter_id JOIN series s ON s.hid=c.series_hid
      WHERE j.status='queued'
      ORDER BY j.created_at, c.series_hid, c.number, c.id, j.rowid
    `).all() as unknown as JobRow[]
  }

  getJob(id: string): JobRow | undefined {
    return this.db.prepare(`
      SELECT j.*, c.series_hid, s.title AS series_title, c.number AS chapter_number
      FROM jobs j JOIN chapters c ON c.id=j.chapter_id JOIN series s ON s.hid=c.series_hid WHERE j.id=?
    `).get(id) as unknown as JobRow | undefined
  }

  updateJob(id: string, values: Partial<Pick<JobRow, 'status' | 'current_page' | 'total_pages' | 'error' | 'started_at' | 'finished_at'>>): void {
    const entries = Object.entries(values)
    if (entries.length === 0) return
    const fields = entries.map(([key]) => `${key}=?`).join(', ')
    this.db.prepare(`UPDATE jobs SET ${fields} WHERE id=?`).run(...entries.map(([, value]) => value), id)
  }
}
