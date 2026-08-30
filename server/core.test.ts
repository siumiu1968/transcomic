import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { isAllowedSourceUrl } from './comix.js'
import { Store } from './db.js'
import { renderTranslation } from './renderer.js'

test('source image allowlist blocks SSRF targets', () => {
  assert.equal(isAllowedSourceUrl('https://static.comix.to/poster.webp'), true)
  assert.equal(isAllowedSourceUrl('https://j24n.wowpic2.store/page'), true)
  assert.equal(isAllowedSourceUrl('http://static.comix.to/page'), false)
  assert.equal(isAllowedSourceUrl('https://127.0.0.1/page'), false)
  assert.equal(isAllowedSourceUrl('https://comix.to.example.com/page'), false)
})

test('renderer preserves page dimensions and emits webp', async () => {
  const source = await sharp({ create: { width: 600, height: 900, channels: 3, background: '#ddd7c8' } }).png().toBuffer()
  const output = await renderTranslation(source, {
    regions: [{ x: 160, y: 170, width: 420, height: 180, translation: '呢個世界，仲有好多故事。', kind: 'speech' }],
  })
  const metadata = await sharp(output).metadata()
  assert.equal(metadata.width, 600)
  assert.equal(metadata.height, 900)
  assert.equal(metadata.format, 'webp')
})

test('store imports a series and chapters without duplicating them', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'transcomic-test-'))
  try {
    const store = new Store(folder)
    store.upsertSeries({
      hid: 'demo', title: '測試漫畫', altTitles: [], type: 'manga', status: 'releasing',
      originalLanguage: 'ja', poster: {}, latestChapter: 2, synopsis: '', url: '/title/demo',
    })
    const chapters = [
      { id: 101, mangaId: 1, number: 1, volume: 1, name: '', language: 'ja', url: '/title/demo/101-chapter-1' },
      { id: 102, mangaId: 1, number: 2, volume: 1, name: '', language: 'ja', url: '/title/demo/102-chapter-2' },
    ]
    store.upsertChapters('demo', chapters)
    store.upsertChapters('demo', chapters)
    assert.equal(store.listSeries()[0]?.chapter_count, 2)
    assert.deepEqual(store.listChapters('demo').map((chapter) => chapter.id), [102, 101])
    store.upsertChapters('demo', [chapters[1]])
    assert.deepEqual(store.listChapters('demo').map((chapter) => chapter.id), [102])
    store.db.close()
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
