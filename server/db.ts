import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ChapterRow, JobRow, PageRow, SeriesRow, SourceChapter, SourcePage, SourceSeries } from './types.js'

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
    this.db.prepare("UPDATE jobs SET status='queued', started_at='' WHERE status='running'").run()
    this.db.prepare("UPDATE chapters SET status='queued' WHERE status='translating'").run()
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
      INSERT INTO pages (chapter_id, position, source_url, width, height)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chapter_id, position) DO UPDATE SET
        source_url=excluded.source_url, width=excluded.width, height=excluded.height
    `)
    this.db.exec('BEGIN')
    try {
      pages.forEach((page, index) => statement.run(chapterId, index + 1, page.url, page.width ?? 0, page.height ?? 0))
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

  updatePage(chapterId: number, position: number, values: Partial<Pick<PageRow, 'original_path' | 'translated_path' | 'status' | 'error' | 'width' | 'height'>>): void {
    const entries = Object.entries(values)
    if (entries.length === 0) return
    const fields = entries.map(([key]) => `${key}=?`).join(', ')
    this.db.prepare(`UPDATE pages SET ${fields} WHERE chapter_id=? AND position=?`).run(...entries.map(([, value]) => value), chapterId, position)
  }

  setChapterStatus(id: number, status: ChapterRow['status']): void {
    this.db.prepare('UPDATE chapters SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, id)
  }

  createJob(job: Pick<JobRow, 'id' | 'chapter_id' | 'model'>): void {
    this.db.prepare('INSERT INTO jobs (id, chapter_id, model) VALUES (?, ?, ?)').run(job.id, job.chapter_id, job.model)
    this.setChapterStatus(job.chapter_id, 'queued')
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
      WHERE j.status='queued' ORDER BY j.created_at
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
