import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Store } from './db.js'

test('scramble metadata invalidates a previously saved source and translation', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'transcomic-scramble-test-'))
  try {
    const store = new Store(folder)
    store.upsertSeries({
      hid: 'series', title: '測試', altTitles: [], type: 'manga', status: 'releasing', originalLanguage: '', poster: {}, latestChapter: 1, url: '/title/series',
    })
    store.upsertChapters('series', [{ id: 10, mangaId: 1, number: 1, volume: 1, name: '', language: '', url: '/title/series/10' }])
    store.upsertPages(10, [{ width: 1280, height: 2400, url: 'https://static.comix.to/1.webp' }])
    store.updatePage(10, 1, { original_path: 'media/10/original/001.webp', translated_path: 'media/10/translated/001.webp', translation_json: '{"regions":[]}', status: 'completed' })
    store.upsertPages(10, [{ width: 1280, height: 2400, url: 'https://static.comix.to/1.webp', scramble: true }])
    assert.deepEqual({ ...store.listPages(10)[0] }, {
      chapter_id: 10, position: 1, source_url: 'https://static.comix.to/1.webp', original_path: '', translated_path: '', width: 1280, height: 2400, scramble: 1, status: 'pending', error: '', translation_json: '',
    })
    store.db.close()
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
