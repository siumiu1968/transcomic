import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, BookOpen, Columns2, Expand, GalleryVerticalEnd, Languages,
  PanelLeftClose, PanelLeftOpen, RefreshCw, RotateCcw, ZoomIn, ZoomOut,
} from 'lucide-react'
import { api } from './api'
import type { Chapter, ReaderPage, Series } from './types'

type Layout = 'long' | 'single' | 'double'

interface ReaderData {
  chapter: Chapter
  series: Series
  pages: ReaderPage[]
}

interface ReaderProps {
  chapterId: number
  onClose: () => void
}

function chapterLabel(chapter: Chapter): string {
  return `第 ${Number.isInteger(chapter.number) ? chapter.number : chapter.number.toFixed(1)} 話`
}

export function Reader({ chapterId, onClose }: ReaderProps) {
  const [data, setData] = useState<ReaderData | null>(null)
  const [error, setError] = useState('')
  const [layout, setLayout] = useState<Layout>('long')
  const [translated, setTranslated] = useState(true)
  const [rtl, setRtl] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [current, setCurrent] = useState(0)
  const [sidebar, setSidebar] = useState(true)
  const viewportRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      setData(await api<ReaderData>(`/chapters/${chapterId}/pages`))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '載入失敗')
    }
  }, [chapterId])

  // Loading external chapter state on identity changes is intentional.
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const step = layout === 'double' ? 2 : 1
  const visiblePages = useMemo(() => {
    if (!data) return []
    if (layout === 'long') return data.pages
    const pages = data.pages.slice(current, current + step)
    return layout === 'double' && rtl ? [...pages].reverse() : pages
  }, [current, data, layout, rtl, step])

  const move = (direction: -1 | 1) => {
    if (!data || layout === 'long') return
    setCurrent((value) => Math.max(0, Math.min(data.pages.length - 1, value + direction * step)))
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') move(rtl ? 1 : -1)
      if (event.key === 'ArrowRight') move(rtl ? -1 : 1)
      if (event.key.toLowerCase() === 'o') setTranslated((value) => !value)
      if (event.key === 'Escape' && !document.fullscreenElement) onClose()
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  })

  const jump = (position: number) => {
    setCurrent(position - 1)
    if (layout === 'long') document.getElementById(`reader-page-${position}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const displayUrl = (page: ReaderPage) => translated && page.translatedUrl ? page.translatedUrl : page.originalUrl

  if (!data && !error) return <main className="reader-loading"><RefreshCw className="spin" /><span>載入章節…</span></main>
  if (error) return (
    <main className="reader-loading">
      <p>{error}</p>
      <div className="inline-actions"><button className="button" onClick={onClose}>返回</button><button className="button primary" onClick={() => void load()}>重試</button></div>
    </main>
  )
  if (!data) return null

  return (
    <div className={`reader-shell ${sidebar ? '' : 'sidebar-closed'}`}>
      <header className="reader-header">
        <button className="icon-button" title="返回工作台" onClick={onClose}><ArrowLeft /></button>
        <div className="reader-heading">
          <strong>{data.series.title}</strong>
          <span>{chapterLabel(data.chapter)}{data.chapter.name ? ` · ${data.chapter.name}` : ''}</span>
        </div>
        <div className="reader-tools">
          <button className="icon-button desktop-only" title={sidebar ? '收起頁面列' : '打開頁面列'} onClick={() => setSidebar((value) => !value)}>{sidebar ? <PanelLeftClose /> : <PanelLeftOpen />}</button>
          <div className="segmented compact" aria-label="閱讀模式">
            <button className={layout === 'long' ? 'active' : ''} title="長條閱讀" onClick={() => setLayout('long')}><GalleryVerticalEnd /></button>
            <button className={layout === 'single' ? 'active' : ''} title="單頁閱讀" onClick={() => setLayout('single')}><BookOpen /></button>
            <button className={layout === 'double' ? 'active' : ''} title="雙頁閱讀" onClick={() => setLayout('double')}><Columns2 /></button>
          </div>
          <button className={`toggle-button ${translated ? 'active' : ''}`} onClick={() => setTranslated((value) => !value)} title="切換原文／譯文"><Languages /><span>{translated ? '中文' : '原文'}</span></button>
          <button className="icon-button desktop-only" title="縮小" onClick={() => setZoom((value) => Math.max(0.6, value - 0.1))}><ZoomOut /></button>
          <button className="zoom-value desktop-only" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button className="icon-button desktop-only" title="放大" onClick={() => setZoom((value) => Math.min(1.8, value + 0.1))}><ZoomIn /></button>
          <button className="icon-button desktop-only" title="重新整理譯文" onClick={() => void load()}><RotateCcw /></button>
          <button className="icon-button" title="全螢幕" onClick={() => void document.documentElement.requestFullscreen()}><Expand /></button>
        </div>
      </header>

      <aside className="reader-sidebar">
        <div className="sidebar-meta"><span>{data.pages.length} 頁</span><button onClick={() => setRtl((value) => !value)}>{rtl ? '右至左' : '左至右'}</button></div>
        <div className="thumbnail-list">
          {data.pages.map((page) => (
            <button key={page.position} className={current === page.position - 1 ? 'active' : ''} onClick={() => jump(page.position)}>
              <img src={displayUrl(page)} alt={`第 ${page.position} 頁`} loading="lazy" />
              <span>{page.position}</span>
              {page.translatedUrl && <i aria-label="已翻譯" />}
            </button>
          ))}
        </div>
      </aside>

      <main ref={viewportRef} className={`reader-viewport layout-${layout}`} style={{ '--reader-zoom': zoom } as React.CSSProperties}>
        <div className="page-stage">
          {visiblePages.map((page) => (
            <img
              id={`reader-page-${page.position}`}
              key={`${page.position}-${translated}`}
              src={displayUrl(page)}
              width={page.width || undefined}
              height={page.height || undefined}
              loading={page.position <= 2 ? 'eager' : 'lazy'}
              alt={`${chapterLabel(data.chapter)}第 ${page.position} 頁`}
              onClick={() => layout !== 'long' && move(1)}
            />
          ))}
        </div>
      </main>

      {layout !== 'long' && (
        <nav className="reader-pager">
          <button disabled={current <= 0} onClick={() => move(-1)}>上一頁</button>
          <span>{current + 1}{step === 2 && current + 2 <= data.pages.length ? `–${current + 2}` : ''} / {data.pages.length}</span>
          <button disabled={current + step >= data.pages.length} onClick={() => move(1)}>下一頁</button>
        </nav>
      )}

      <nav className="mobile-reader-bar">
        <button onClick={() => setLayout((value) => value === 'long' ? 'single' : 'long')}>{layout === 'long' ? <BookOpen /> : <GalleryVerticalEnd />}<span>版面</span></button>
        <button className={translated ? 'active' : ''} onClick={() => setTranslated((value) => !value)}><Languages /><span>{translated ? '中文' : '原文'}</span></button>
        <button onClick={() => setZoom((value) => value >= 1.4 ? 0.8 : value + 0.2)}><ZoomIn /><span>{Math.round(zoom * 100)}%</span></button>
        <button onClick={() => void load()}><RefreshCw /><span>整理</span></button>
      </nav>
    </div>
  )
}
