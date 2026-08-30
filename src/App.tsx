import { useCallback, useEffect, useState } from 'react'
import {
  BookMarked, BookOpen, Check, ChevronRight, CircleAlert, Clock3, Download,
  Languages, Library, LoaderCircle, Pause, Play, Plus, RefreshCw, Search,
  ShieldCheck, Sparkles, Square, X,
} from 'lucide-react'
import { api, sourceImage } from './api'
import { Reader } from './Reader'
import type { Chapter, Job, SearchSeries, Series } from './types'
import './App.css'

type TranslationMode = 'fast' | 'balanced' | 'quality'

interface LibraryResponse { items: Series[] }
interface SeriesResponse { series: Series; chapters: Chapter[] }
interface JobsResponse { items: Job[] }
interface SearchResponse { items: SearchSeries[]; meta?: { page?: number; lastPage?: number; hasNext?: boolean } }

function chapterNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function synopsisText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gu, '$1')
    .replace(/[*_~`#>]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function statusLabel(status: Chapter['status'] | Job['status']): string {
  return ({
    ready: '未翻譯', queued: '等候中', translating: '翻譯中', running: '翻譯中',
    completed: '已完成', failed: '失敗', cancelled: '已取消',
  })[status] ?? status
}

function Status({ value }: { value: Chapter['status'] | Job['status'] }) {
  const icon = value === 'completed' ? <Check /> : value === 'failed' ? <CircleAlert /> : value === 'running' || value === 'translating' ? <LoaderCircle className="spin" /> : value === 'queued' ? <Clock3 /> : null
  return <span className={`status status-${value}`}>{icon}{statusLabel(value)}</span>
}

function Brand() {
  return (
    <div className="brand" aria-label="TransComic">
      <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
        <path d="M8.5 6.5h20a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H19l-6.8 5v-5H8.5a3 3 0 0 1-3-3v-17a3 3 0 0 1 3-3Z" />
        <path d="M20 7v22M7 17.8h12.8M20.2 21.4h10.6" />
        <path className="brand-spark" d="m26.2 10.3.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z" />
      </svg>
      <strong>TransComic</strong>
    </div>
  )
}

function App() {
  const [library, setLibrary] = useState<Series[]>([])
  const [selectedHid, setSelectedHid] = useState('')
  const [seriesData, setSeriesData] = useState<SeriesResponse | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [query, setQuery] = useState('')
  const [searchedQuery, setSearchedQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchSeries[]>([])
  const [hasSearched, setHasSearched] = useState(false)
  const [searchPage, setSearchPage] = useState(1)
  const [searchHasNext, setSearchHasNext] = useState(false)
  const [searching, setSearching] = useState(false)
  const [importing, setImporting] = useState('')
  const [selectedChapters, setSelectedChapters] = useState<Set<number>>(new Set())
  const [mode, setMode] = useState<TranslationMode>('balanced')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [readerId, setReaderId] = useState<number | null>(() => {
    const value = Number(new URLSearchParams(location.search).get('read'))
    return Number.isSafeInteger(value) && value > 0 ? value : null
  })

  const loadLibrary = useCallback(async (preferred?: string) => {
    const response = await api<LibraryResponse>('/library')
    setLibrary(response.items)
    setSelectedHid((current) => preferred ?? (current || response.items[0]?.hid || ''))
  }, [])

  const loadSeries = useCallback(async (hid: string) => {
    if (!hid) return
    const response = await api<SeriesResponse>(`/library/${hid}`)
    setSeriesData(response)
  }, [])

  const loadJobs = useCallback(async () => {
    const response = await api<JobsResponse>('/jobs')
    setJobs(response.items)
  }, [])

  // Initial server state is loaded once when the workbench mounts.
  // oxlint-disable react/set-state-in-effect
  useEffect(() => {
    void Promise.all([loadLibrary(), loadJobs()])
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : '載入失敗'))
      .finally(() => setLoading(false))
  }, [loadJobs, loadLibrary])
  // oxlint-enable react/set-state-in-effect

  // The selected library item owns the chapter list shown in the centre pane.
  // oxlint-disable react/set-state-in-effect
  useEffect(() => {
    if (!selectedHid) return
    void loadSeries(selectedHid).catch((loadError) => setError(loadError instanceof Error ? loadError.message : '載入漫畫失敗'))
  }, [loadSeries, selectedHid])
  // oxlint-enable react/set-state-in-effect

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadJobs()
      if (selectedHid && jobs.some((job) => job.status === 'running' || job.status === 'queued')) void loadSeries(selectedHid)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [jobs, loadJobs, loadSeries, selectedHid])

  useEffect(() => {
    const popstate = () => {
      const value = Number(new URLSearchParams(location.search).get('read'))
      setReaderId(Number.isSafeInteger(value) && value > 0 ? value : null)
    }
    window.addEventListener('popstate', popstate)
    return () => window.removeEventListener('popstate', popstate)
  }, [])

  const openReader = (chapterId: number) => {
    const url = new URL(location.href)
    url.searchParams.set('read', String(chapterId))
    history.pushState({}, '', url)
    setReaderId(chapterId)
  }

  const closeReader = () => {
    const url = new URL(location.href)
    url.searchParams.delete('read')
    history.pushState({}, '', url)
    setReaderId(null)
  }

  const search = async (event: React.FormEvent) => {
    event.preventDefault()
    if (query.trim().length < 2) return
    setSearching(true)
    setError('')
    try {
      const response = await api<SearchResponse>(`/search?q=${encodeURIComponent(query.trim())}&page=1`)
      setSearchResults(response.items)
      setSearchedQuery(query.trim())
      setSearchPage(response.meta?.page ?? 1)
      setSearchHasNext(response.meta?.hasNext ?? (response.meta?.lastPage ?? 1) > 1)
      setHasSearched(true)
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : '搜尋失敗')
    } finally {
      setSearching(false)
    }
  }

  const loadMoreSearch = async () => {
    if (searching || !searchHasNext) return
    setSearching(true)
    setError('')
    try {
      const nextPage = searchPage + 1
      const response = await api<SearchResponse>(`/search?q=${encodeURIComponent(searchedQuery)}&page=${nextPage}`)
      setSearchResults((current) => [...new Map([...current, ...response.items].map((item) => [item.hid, item])).values()])
      setSearchPage(response.meta?.page ?? nextPage)
      setSearchHasNext(response.meta?.hasNext ?? (response.meta?.lastPage ?? nextPage) > nextPage)
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : '載入更多結果失敗')
    } finally {
      setSearching(false)
    }
  }

  const importSeries = async (result: SearchSeries) => {
    setImporting(result.hid)
    setError('')
    try {
      await api<SeriesResponse>(`/library/${result.hid}`, { method: 'POST' })
      await loadLibrary(result.hid)
      await loadSeries(result.hid)
      setSearchResults([])
      setHasSearched(false)
      setSearchedQuery('')
      setSearchPage(1)
      setSearchHasNext(false)
      setQuery('')
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : '加入書庫失敗')
    } finally {
      setImporting('')
    }
  }

  const toggleChapter = (chapterId: number) => {
    setSelectedChapters((current) => {
      const next = new Set(current)
      if (next.has(chapterId)) next.delete(chapterId)
      else next.add(chapterId)
      return next
    })
  }

  const startTranslation = async () => {
    if (selectedChapters.size === 0) return
    setError('')
    try {
      const forceChapterIds = (seriesData?.chapters ?? [])
        .filter((chapter) => selectedChapters.has(chapter.id) && chapter.status === 'completed')
        .map((chapter) => chapter.id)
      await api('/translate', {
        method: 'POST',
        body: JSON.stringify({ chapterIds: [...selectedChapters], forceChapterIds, mode }),
      })
      setSelectedChapters(new Set())
      await Promise.all([loadJobs(), selectedHid ? loadSeries(selectedHid) : Promise.resolve()])
    } catch (translationError) {
      setError(translationError instanceof Error ? translationError.message : '建立翻譯工作失敗')
    }
  }

  const activeJobs = jobs.filter((job) => job.status === 'running' || job.status === 'queued')
  const recentJobs = jobs.filter((job) => job.status !== 'running' && job.status !== 'queued').slice(0, 8)
  const selectedSeries = seriesData?.series
  const chapters = seriesData?.chapters ?? []
  const allSelected = chapters.length > 0 && chapters.every((chapter) => selectedChapters.has(chapter.id))
  const untranslated = chapters.filter((chapter) => chapter.status !== 'completed').map((chapter) => chapter.id)
  const selectedCompleted = chapters.filter((chapter) => selectedChapters.has(chapter.id) && chapter.status === 'completed').length

  if (readerId) return <Reader chapterId={readerId} onClose={closeReader} />

  return (
    <div className="app-shell">
      <header className="app-header">
        <Brand />
        <form className="global-search" onSubmit={search}>
          <Search />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋 Comix 漫畫…" aria-label="搜尋漫畫" />
          {query && <button type="button" className="clear-search" aria-label="清除搜尋" onClick={() => { setQuery(''); setSearchedQuery(''); setSearchResults([]); setHasSearched(false); setSearchPage(1); setSearchHasNext(false) }}><X /></button>}
          <button type="submit" disabled={searching || query.trim().length < 2}>{searching ? <LoaderCircle className="spin" /> : '搜尋'}</button>
        </form>
        <div className="header-actions">
          <button className="queue-shortcut" onClick={() => document.getElementById('translation-queue')?.scrollIntoView({ behavior: 'smooth' })}><Download /><span>佇列</span><b>{activeJobs.length}</b></button>
          <div className="admin-chip"><ShieldCheck /><span>最高管理員</span></div>
        </div>
      </header>

      {error && <div className="error-banner"><CircleAlert /><span>{error}</span><button onClick={() => setError('')}><X /></button></div>}

      {hasSearched && (
        <section className="search-drawer">
          <div className="drawer-heading"><div><Search /><strong>搜尋結果</strong><span>{searchResults.length}</span></div><button className="icon-button" aria-label="關閉搜尋結果" onClick={() => { setSearchedQuery(''); setSearchResults([]); setHasSearched(false); setSearchPage(1); setSearchHasNext(false) }}><X /></button></div>
          {searchResults.length === 0 ? <div className="search-empty"><BookOpen /><strong>搵唔到相關漫畫</strong><span>試吓輸入其他作品名稱。</span></div> : <>
          <div className="search-grid">
            {searchResults.map((result) => {
              const exists = library.some((item) => item.hid === result.hid)
              const poster = result.poster?.large ?? result.poster?.medium
              return (
                <article key={result.hid} className="search-card">
                  <div className="cover"><img src={sourceImage(poster)} alt="" /></div>
                  <div><strong>{result.title}</strong><span>{result.originalLanguage?.toUpperCase()} · {result.status}</span><small>最新第 {result.latestChapter || '—'} 話</small></div>
                  <button className={`button ${exists ? '' : 'primary'}`} disabled={exists || importing === result.hid} onClick={() => void importSeries(result)}>
                    {importing === result.hid ? <LoaderCircle className="spin" /> : exists ? <Check /> : <Plus />}{exists ? '已在書庫' : '加入書庫'}
                  </button>
                </article>
              )
            })}
          </div>
          {searchHasNext && <div className="search-more-row"><button className="button" disabled={searching} onClick={() => void loadMoreSearch()}>{searching ? <LoaderCircle className="spin" /> : <Plus />}載入更多</button></div>}
          </>}
        </section>
      )}

      <main className="workspace">
        <aside className="library-panel panel">
          <div className="panel-heading"><div><Library /><strong>我的書庫</strong><span>{library.length}</span></div><button className="icon-button" title="重新整理" onClick={() => void loadLibrary()}><RefreshCw /></button></div>
          {loading ? <div className="library-skeleton" aria-label="載入書庫"><i /><i /><i /></div> : library.length === 0 ? (
            <div className="empty-state compact"><BookMarked /><strong>書庫未有漫畫</strong><span>喺上方搜尋並加入。</span></div>
          ) : (
            <div className="library-list">
              {library.map((item) => (
                <button key={item.hid} className={item.hid === selectedHid ? 'active' : ''} onClick={() => { setSelectedChapters(new Set()); setSelectedHid(item.hid) }}>
                  <div className="mini-cover">{item.poster_url ? <img src={sourceImage(item.poster_url)} alt="" loading="lazy" /> : <BookOpen />}</div>
                  <div><strong>{item.title}</strong><span>{item.translated_count} / {item.chapter_count} 話已譯</span><i><b style={{ width: `${item.chapter_count ? item.translated_count / item.chapter_count * 100 : 0}%` }} /></i></div>
                  <ChevronRight />
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="catalog-panel panel">
          {!selectedSeries ? (
            <div className="empty-state large"><Languages /><strong>揀一套漫畫開始</strong><span>你只會翻譯自己明確選擇嘅章節。</span></div>
          ) : (
            <>
              <div className="series-hero">
                <div className="series-cover">{selectedSeries.poster_url ? <img src={sourceImage(selectedSeries.poster_url)} alt={`${selectedSeries.title}封面`} /> : <BookOpen />}</div>
                <div className="series-copy">
                  <span className="eyebrow">{selectedSeries.source_language?.toUpperCase()} · {selectedSeries.status}</span>
                  <h1>{selectedSeries.title}</h1>
                  <p>{synopsisText(selectedSeries.synopsis) || '未有作品簡介。'}</p>
                  <div className="series-stats"><span><strong>{selectedSeries.chapter_count}</strong>章節</span><span><strong>{selectedSeries.translated_count}</strong>已完成</span><span><strong>{activeJobs.filter((job) => job.series_hid === selectedSeries.hid).length}</strong>處理中</span></div>
                </div>
              </div>

              <div className="chapter-toolbar">
                <div className="selection-actions">
                  <button className="text-button" onClick={() => setSelectedChapters(new Set(allSelected ? [] : chapters.map((chapter) => chapter.id)))}>{allSelected ? '取消全選' : '全選'}</button>
                  <button className="text-button" onClick={() => setSelectedChapters(new Set(untranslated))}>揀未翻譯</button>
                  <span>已揀 {selectedChapters.size} 話</span>
                </div>
                <div className="translate-actions">
                  <div className="segmented model-picker">
                    <button className={mode === 'fast' ? 'active' : ''} onClick={() => setMode('fast')} title="GPT-5.6 Luna">快速</button>
                    <button className={mode === 'balanced' ? 'active' : ''} onClick={() => setMode('balanced')} title="GPT-5.6 Luna">標準</button>
                    <button className={mode === 'quality' ? 'active' : ''} onClick={() => setMode('quality')} title="GPT-5.6 Luna">最高品質</button>
                  </div>
                  <button className="button primary translate-button" disabled={selectedChapters.size === 0} onClick={() => void startTranslation()}><Sparkles />{selectedCompleted === selectedChapters.size && selectedCompleted > 0 ? '重新翻譯' : '開始翻譯'}</button>
                </div>
              </div>

              <div className="chapter-table" role="table" aria-label="章節">
                <div className="chapter-row chapter-head" role="row"><span /><span>章節</span><span>語言</span><span>進度</span><span>狀態</span><span /></div>
                {chapters.map((chapter) => (
                  <div key={chapter.id} className={`chapter-row ${selectedChapters.has(chapter.id) ? 'selected' : ''}`} role="row">
                    <label className="checkbox"><input type="checkbox" checked={selectedChapters.has(chapter.id)} onChange={() => toggleChapter(chapter.id)} /><span><Check /></span></label>
                    <button className="chapter-title" onClick={() => openReader(chapter.id)}><strong>第 {chapterNumber(chapter.number)} 話</strong><small>{chapter.name || `Chapter ${chapterNumber(chapter.number)}`}</small></button>
                    <span className="language-tag">{chapter.language?.toUpperCase()}</span>
                    <span className="page-progress">{chapter.page_count ? `${chapter.translated_pages}/${chapter.page_count} 頁` : '未載入'}</span>
                    <Status value={chapter.status} />
                    <button className="read-button" onClick={() => openReader(chapter.id)}><BookOpen />閱讀</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        <aside id="translation-queue" className="queue-panel panel">
          <div className="panel-heading"><div><Download /><strong>翻譯佇列</strong><span>{activeJobs.length}</span></div></div>
          {activeJobs.length === 0 ? (
            <div className="empty-state compact"><Pause /><strong>而家冇工作</strong><span>揀章節後開始翻譯。</span></div>
          ) : (
            <div className="job-list active-jobs">
              {activeJobs.map((job) => {
                const percent = job.total_pages ? Math.round(job.current_page / job.total_pages * 100) : 0
                return (
                  <article key={job.id} className="job-card active">
                    <div className="job-top"><span className="job-icon">{job.status === 'running' ? <Play /> : <Clock3 />}</span><div><strong>{job.series_title}</strong><span>第 {chapterNumber(job.chapter_number)} 話</span></div><button className="icon-button" title="取消" onClick={() => void api(`/jobs/${job.id}/cancel`, { method: 'POST' }).then(loadJobs)}><Square /></button></div>
                    <div className="job-progress"><i><b style={{ width: `${percent}%` }} /></i><span>{job.total_pages ? `${job.current_page}/${job.total_pages}` : '準備中'} · {percent}%</span></div>
                    <small>{job.model.replace('gpt-5.6-', '').toUpperCase()}</small>
                  </article>
                )
              })}
            </div>
          )}

          {recentJobs.length > 0 && <div className="queue-section-title">最近完成</div>}
          <div className="job-list recent-jobs">
            {recentJobs.map((job) => (
              <button key={job.id} className="job-card recent" onClick={() => setSelectedHid(job.series_hid)}>
                <span className={`job-dot ${job.status}`} />
                <div><strong>{job.series_title}</strong><span>第 {chapterNumber(job.chapter_number)} 話</span>{job.error && <small title={job.error}>{job.error}</small>}</div>
                <Status value={job.status} />
              </button>
            ))}
          </div>
        </aside>
      </main>
    </div>
  )
}

export default App
