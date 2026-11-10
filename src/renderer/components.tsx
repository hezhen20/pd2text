import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { AudioCacheStats, DeskError, EpisodeRecord, ExportFormat, ExportScope, HistoryItem, ProgressEvent, Settings } from '@shared/types'
import { formatDate, formatDuration, formatStamp } from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from './api'

/* ---------- 通用小件 ---------- */

export function Markdown({ text }: { text: string }): ReactNode {
  const html = marked.parse(text, { async: false, gfm: true }) as string
  // 摘要来自模型输出，属于不可信输入。原先的手写正则只挡得住带引号的
  // on*="..."，<img src=x onerror=alert(1)> 这类无引号写法可以直接绕过，
  // 所以换成 DOMPurify 的正经白名单。
  const safe = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style']
  })
  return <div className="md" dangerouslySetInnerHTML={{ __html: safe }} />
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function highlight(text: string, query: string): ReactNode {
  if (!query.trim()) return text
  const parts = text.split(new RegExp(`(${escapeRegExp(query.trim())})`, 'gi'))
  return parts.map((part, i) =>
    part.toLowerCase() === query.trim().toLowerCase() ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>
  )
}

function elapsedText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 MB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 归档文字里 U+FFFD 占比过高，说明当时解码错了，原文不可还原。 */
function isCorrupted(text: string): boolean {
  if (text.length < 40) return false
  let bad = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0xfffd) bad++
  return bad / text.length > 0.01
}

export function ProgressLine({ event }: { event: ProgressEvent | null }): ReactNode {
  const startedAt = event?.startedAt ?? 0
  const running = !!event && event.stage !== 'done'
  const [now, setNow] = useState(() => Date.now())

  // 秒表：让「没动」也能看出程序还活着。
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [running, startedAt])

  if (!event) return null
  const measured = !event.indeterminate
  const elapsed = running && startedAt > 0 ? elapsedText(now - startedAt) : ''

  return (
    <div className="progress" aria-live="polite">
      <div className="progress-row">
        <span className="mono label-xs">{event.label}</span>
        <span className="mono label-xs muted">
          {measured ? `${Math.round(event.percent)}%` : elapsed ? `已用 ${elapsed}` : '进行中'}
        </span>
      </div>
      <div className={measured ? 'progress-track' : 'progress-track is-waiting'}>
        <div
          className="progress-fill"
          style={measured ? { width: `${Math.max(0, Math.min(100, event.percent))}%` } : undefined}
        />
      </div>
      {(event.detail || (measured && elapsed)) && (
        <p className="progress-detail mono label-xs">
          {measured && elapsed ? <span className="progress-elapsed">已用 {elapsed}</span> : null}
          {event.detail ? <span className="progress-note">{event.detail}</span> : null}
        </p>
      )}
    </div>
  )
}

export function ErrorNote({ error, onAction }: { error: DeskError; onAction: () => void }): ReactNode {
  const actionable = error.code === 'NO_API_KEY' || error.code === 'NO_ASR_KEY' || error.code === 'ASR_LOCAL_ERROR'
  return (
    <div className="error-note" role="alert">
      <div className="error-head">
        <span className="mono label-xs">未能完成 · {error.code}</span>
      </div>
      <p className="error-title">{error.message}</p>
      {error.hint && <p className="error-hint">{error.hint}</p>}
      {actionable && (
        <button className="text-action" onClick={onAction}>
          {error.code === 'NO_API_KEY' ? '去填写 API Key →' : '去设置转写方式 →'}
        </button>
      )}
    </div>
  )
}

export function Toast({ text }: { text: string }): ReactNode {
  if (!text) return null
  return <div className="toast mono label-xs">{text}</div>
}

/* ---------- 顶栏 ---------- */

interface TopBarProps {
  settings: Settings
  onSettings: () => void
  onTheme: () => void
  onHome: () => void
}

export function TopBar({ settings, onSettings, onTheme, onHome }: TopBarProps): ReactNode {
  return (
    <header className="topbar">
      <button className="brand no-drag" onClick={onHome} title="回到首页">
        <span className="brand-zh">誊声</span>
        <span className="brand-divider" />
        <span className="brand-en mono">VERBATIM DESK</span>
      </button>
      <div className="topbar-right no-drag">
        <span className="status">
          <i className="dot" />
          <span className="mono label-xs">{settings.asrEngine === 'cloud' ? '云端转写' : '本地转写'}</span>
        </span>
        <span className="topbar-sep" />
        <button className="top-link mono label-xs" onClick={onTheme}>
          {settings.theme === 'paper' ? '墨' : '纸'} <span className="muted">/ 主题</span>
        </button>
        <button className="top-link mono label-xs" onClick={onSettings}>设置</button>
      </div>
    </header>
  )
}

/* ---------- 首页 ---------- */

interface HomeProps {
  link: string
  setLink: (value: string) => void
  onSubmit: () => void
  loading: boolean
  progress: ProgressEvent | null
  error: DeskError | null
  onErrorAction: () => void
  onCancel: () => void
  history: HistoryItem[]
  onOpenHistory: (eid: string) => void
  onRemoveHistory: (eid: string) => void
}

export function HomeView(props: HomeProps): ReactNode {
  const { link, setLink, onSubmit, loading, progress, error, onErrorAction, onCancel, history, onOpenHistory, onRemoveHistory } = props
  return (
    <main className="home scroll-area">
      <div className="home-inner">
        <p className="eyebrow mono">A DESK FOR SPOKEN WORDS　·　01</p>
        <h1 className="display">
          把声音，<br />
          <em>誊</em>成文字。
        </h1>
        <div className="short-rule" />
        <p className="lede">
          粘贴一期小宇宙播客，取回完整的文字稿。可以带走，也可以让 AI 替你先读一遍，留下值得留下的部分。
        </p>

        <form
          className={`entry ${loading ? 'is-busy' : ''}`}
          onSubmit={(e) => { e.preventDefault(); onSubmit() }}
        >
          <input
            className="entry-input"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="粘贴小宇宙单集链接，按 Enter"
            spellCheck={false}
            autoFocus
            disabled={loading}
          />
          <button className="entry-go" type="submit" disabled={loading || !link.trim()} aria-label="开始誊写">
            <span>誊写</span>
            <span className="entry-arrow">↵</span>
          </button>
        </form>
        <p className="entry-hint mono label-xs">
          支持 https://www.xiaoyuzhoufm.com/episode/… 及 App 分享的整段文案
        </p>

        {loading && <ProgressLine event={progress} />}
        {loading && (
          <button className="text-action" onClick={onCancel}>停止</button>
        )}
        {!loading && error && <ErrorNote error={error} onAction={onErrorAction} />}

        <section className="history-block">
          <div className="section-head mono label-xs">
            <span>最近誊写</span>
            <span className="muted">{String(history.length).padStart(2, '0')} 期归档</span>
          </div>
          {history.length === 0 ? (
            <p className="empty-history">还没有归档。第一期，从上面那一行开始。</p>
          ) : (
            <div className="history-list">
              {history.map((item, i) => (
                <div className="history-row" key={item.eid} onClick={() => onOpenHistory(item.eid)}>
                  <span className="mono label-xs muted">{String(i + 1).padStart(2, '0')}</span>
                  <span className="history-title">{item.title}</span>
                  <span className="mono label-xs muted history-meta">{item.podcast} · {formatDate(item.fetchedAt)}</span>
                  <span className="mono label-xs muted history-count">{item.charCount.toLocaleString('zh-CN')} 字</span>
                  <button
                    className="history-del"
                    title="从归档移除"
                    onClick={(e) => { e.stopPropagation(); onRemoveHistory(item.eid) }}
                  >×</button>
                </div>
              ))}
            </div>
          )}
        </section>

        <footer className="home-foot mono label-xs muted">
          文字稿由语音识别生成 · 音频与文稿只保存在这台机器上
        </footer>
      </div>
    </main>
  )
}

/* ---------- 阅读页 ---------- */

type SummaryStatus = 'idle' | 'working' | 'done' | 'error'

interface ReaderProps {
  record: EpisodeRecord
  settings: Settings
  query: string
  setQuery: (value: string) => void
  onBack: () => void
  onRefetch: () => void
  onCopy: (scope: ExportScope, format: ExportFormat) => void
  onExport: (format: ExportFormat, scope: ExportScope) => void
  onCopySegment: (text: string) => void
  onOpenLink: () => void
  summaryText: string
  summaryStatus: SummaryStatus
  summaryStage: string
  onSummarize: () => void
  onCancelSummary: () => void
  onCopySummary: () => void
  onOpenSettings: () => void
  hasApiKey: boolean
}

export function ReaderView(props: ReaderProps): ReactNode {
  const {
    record, settings, query, setQuery, onBack, onRefetch, onCopy, onExport, onCopySegment, onOpenLink,
    summaryText, summaryStatus, summaryStage, onSummarize, onCancelSummary, onCopySummary, onOpenSettings, hasApiKey
  } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [scope, setScope] = useState<ExportScope>('both')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const showStamps = settings.showTimestamps && record.segments.some((s) => s.startMs > 0 || s.endMs > 0)
  // 旧版本把 GBK 字节当 UTF-8 存过档：这类文字满屏 U+FFFD，不可还原，只能重转。
  const corrupted = isCorrupted(record.segments.map((s) => s.text).join(''))
  const filtered = query.trim()
    ? record.segments.filter((s) => s.text.toLowerCase().includes(query.trim().toLowerCase()))
    : record.segments
  const formats: { key: ExportFormat; label: string; note: string }[] = [
    { key: 'md', label: 'Markdown', note: '.md　适合笔记软件' },
    { key: 'txt', label: '纯文本', note: '.txt　最轻' },
    { key: 'srt', label: '字幕', note: '.srt　带时间轴' },
    { key: 'json', label: '结构化数据', note: '.json　原始分段' }
  ]

  return (
    <main className="reader scroll-area">
      <div className="reader-inner">
        <button className="crumb mono label-xs" onClick={onBack}>← 返回案头</button>

        <div className="ep-head">
          <div>
            <p className="ep-kicker mono label-xs">{record.meta.podcast}　/　第 {String(record.meta.eid).slice(-4).toUpperCase()} 号</p>
            <h2 className="ep-title">{record.meta.title}</h2>
            <div className="ep-meta mono label-xs muted">
              <span>{formatDate(record.meta.publishedAt)}</span><i>·</i>
              <span>{formatDuration(record.meta.durationSec)}</span><i>·</i>
              <span>{record.charCount.toLocaleString('zh-CN')} 字</span><i>·</i>
              <span>{record.segments.length} 段</span>
            </div>
            <button className="text-action small" onClick={onOpenLink}>在小宇宙打开 ↗</button>
          </div>
          {record.meta.cover && <img className="ep-cover" src={record.meta.cover} alt="" referrerPolicy="no-referrer" />}
        </div>

        <div className="toolbar">
          <div className="toolbar-left">
            <span className="tool-label mono label-xs">逐字稿</span>
            <span className="tool-sep" />
            <input
              className="search-input mono label-xs"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="在文稿里找一句…"
              spellCheck={false}
            />
            {query && <button className="search-clear" onClick={() => setQuery('')}>×</button>}
          </div>
          <div className="toolbar-right">
            <button className="tool-btn mono label-xs" onClick={() => onCopy('transcript', 'txt')}>复制全文</button>
            <button className="tool-btn mono label-xs" onClick={onRefetch}>重新取回</button>
            <div className="export-wrap" ref={menuRef}>
              <button className="tool-btn primary mono label-xs" onClick={() => setMenuOpen(!menuOpen)}>
                导出 <span className="caret">▾</span>
              </button>
              {menuOpen && (
                <div className="export-menu">
                  <p className="mono label-xs muted">包含内容</p>
                  <div className="scope-row">
                    {([['transcript', '文稿'], ['summary', '摘要'], ['both', '两者']] as const).map(([key, label]) => (
                      <button
                        key={key}
                        className={`scope-btn mono label-xs ${scope === key ? 'active' : ''}`}
                        onClick={() => setScope(key)}
                      >{label}</button>
                    ))}
                  </div>
                  <div className="menu-rule" />
                  {formats.map((f) => (
                    <button
                      key={f.key}
                      className="format-row"
                      onClick={() => { onExport(f.key, scope); setMenuOpen(false) }}
                    >
                      <span>{f.label}</span><span className="mono label-xs muted">{f.note}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {corrupted && (
          <div className="reader-notice">
            <p className="error-head mono label-xs">文稿编码异常</p>
            <p className="error-title">这期的文字当时按错误编码存了下来</p>
            <p className="error-hint">原文无法还原，重新转写一次即可恢复。本地已有音频的话不会重新下载。</p>
            <button className="text-action" onClick={onRefetch}>重新转写</button>
          </div>
        )}

        <div className="reader-grid">
          <section className="transcript">
            {query && <p className="result-count mono label-xs muted">找到 {filtered.length} 段</p>}
            {filtered.length === 0 && <p className="empty-history">这一句没有出现在文稿里。</p>}
            {filtered.map((seg) => (
              <div className="segment" key={seg.index}>
                {showStamps && <span className="stamp mono label-xs">{formatStamp(seg.startMs)}</span>}
                <div className="segment-body">
                  {seg.speaker && <span className="speaker">{seg.speaker}</span>}
                  <span className="segment-text">{highlight(seg.text, query)}</span>
                  <button className="seg-copy mono label-xs" onClick={() => onCopySegment(seg.text)}>复制</button>
                </div>
              </div>
            ))}
          </section>

          <aside className="aside">
            <div className="aside-head">
              <span className="mono label-xs">摘要 / ABSTRACT</span>
              <span className="mono label-xs muted">DEEPSEEK</span>
            </div>
            {summaryStatus === 'idle' && !summaryText && (
              <div className="summary-empty">
                <p>让编辑先读一遍。<br />留下脉络、观点和原话，不替你下结论。</p>
                {!hasApiKey && <p className="summary-warning mono label-xs">需要先在设置里填入 DeepSeek API Key</p>}
                <button className="solid-action" onClick={hasApiKey ? onSummarize : onOpenSettings}>
                  {hasApiKey ? '开始提炼' : '去填写 Key'}
                </button>
                <p className="summary-foot mono label-xs muted">长文稿会分段通读，再落笔成稿</p>
              </div>
            )}
            {summaryStatus === 'working' && (
              <div className="summary-working">
                <p className="mono label-xs accent">{summaryStage || '正在通读'}</p>
                <div className="thinking-rule" />
                {summaryText ? <Markdown text={summaryText} /> : <p className="muted">正在读…</p>}
                <button className="text-action small" onClick={onCancelSummary}>停止</button>
              </div>
            )}
            {(summaryStatus === 'done' || (summaryStatus === 'idle' && summaryText)) && (
              <div className="summary-done">
                <Markdown text={summaryText} />
                <div className="summary-actions">
                  <button className="text-action small" onClick={onSummarize}>重新提炼</button>
                  <button className="text-action small" onClick={onCopySummary}>复制摘要</button>
                  <button className="text-action small" onClick={() => onExport('md', 'summary')}>导出摘要</button>
                </div>
              </div>
            )}
            {summaryStatus === 'error' && (
              <div className="summary-empty">
                <p>这一次没写成。</p>
                <button className="solid-action" onClick={onSummarize}>再试一次</button>
              </div>
            )}
          </aside>
        </div>
      </div>
    </main>
  )
}

/* ---------- 设置抽屉 ---------- */

interface SettingsProps {
  open: boolean
  onClose: () => void
  settings: Settings
  onSaveSettings: (patch: Partial<Settings>) => void
  notify: (text: string) => void
}

export function SettingsDrawer({ open, onClose, settings, onSaveSettings, notify }: SettingsProps): ReactNode {
  const [draft, setDraft] = useState<Settings>(settings)
  const [cache, setCache] = useState<AudioCacheStats | null>(null)
  const [clearing, setClearing] = useState(false)
  const [confirmAll, setConfirmAll] = useState(false)

  useEffect(() => { setDraft(settings) }, [settings, open])

  const refreshCache = async (): Promise<void> => {
    try { setCache(await api.cache.stats()) } catch { setCache(null) }
  }

  useEffect(() => {
    if (!open) return
    setConfirmAll(false)
    void refreshCache()
  }, [open])

  // 「清空全部」是二次确认：4 秒内再点一下才真删。
  useEffect(() => {
    if (!confirmAll) return
    const timer = setTimeout(() => setConfirmAll(false), 4000)
    return () => clearTimeout(timer)
  }, [confirmAll])

  const clearCache = async (scope: 'orphan' | 'all'): Promise<void> => {
    if (scope === 'all' && !confirmAll) { setConfirmAll(true); return }
    setConfirmAll(false)
    setClearing(true)
    try {
      const result = await api.cache.clear(scope)
      notify(result.freedFiles ? `已释放 ${formatBytes(result.freedBytes)}` : '没有需要清理的音频')
      await refreshCache()
    } catch {
      notify('清理失败，可能还有文件被占用')
    } finally {
      setClearing(false)
    }
  }

  const patch = (value: Partial<Settings>, immediate = false) => {
    setDraft((d) => ({ ...d, ...value }))
    if (immediate) onSaveSettings(value)
  }

  if (!open) return null
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer scroll-area">
        <div className="drawer-head">
          <span className="drawer-title">设置</span>
          <button className="drawer-close" onClick={onClose}>×</button>
        </div>

        <section className="field-group">
          <div className="group-head">
            <span className="group-no mono label-xs">01</span>
            <h3>语音转文字</h3>
          </div>
          <p className="group-note">决定音频怎么变成文字稿。本地离线不联网、不花钱；云端更快更准，需要 API Key。</p>

          <div className="pref-row">
            <span>转写引擎</span>
            <div className="segmented mono label-xs">
              <button className={draft.asrEngine === 'local' ? 'active' : ''} onClick={() => patch({ asrEngine: 'local' }, true)}>本地</button>
              <button className={draft.asrEngine === 'cloud' ? 'active' : ''} onClick={() => patch({ asrEngine: 'cloud' }, true)}>云端</button>
            </div>
          </div>

          {draft.asrEngine === 'local' ? (
            <>
              <label className="field">
                <span className="mono label-xs muted">模型精度</span>
                <select
                  value={draft.localAsrModel}
                  onChange={(e) => patch({ localAsrModel: e.target.value as any }, true)}
                >
                  <option value="tiny">tiny · 最快</option>
                  <option value="base">base · 快</option>
                  <option value="small">small · 均衡（推荐）</option>
                  <option value="medium">medium · 更准更慢</option>
                </select>
              </label>
              <p className="fine-print">
                本地转写需要本机已装 Python 3，并运行过 <span className="mono">pip install faster-whisper</span>。首次使用会按所选模型自动下载权重（small 约 466MB）。
              </p>
            </>
          ) : (
            <>
              <label className="field">
                <span className="mono label-xs muted">API KEY</span>
                <input
                  type="password"
                  value={draft.cloudAsrApiKey}
                  onChange={(e) => patch({ cloudAsrApiKey: e.target.value })}
                  onBlur={() => onSaveSettings({ cloudAsrApiKey: draft.cloudAsrApiKey })}
                  placeholder="sk-…（SiliconFlow）"
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span className="mono label-xs muted">模型</span>
                <input
                  value={draft.cloudAsrModel}
                  onChange={(e) => patch({ cloudAsrModel: e.target.value })}
                  onBlur={() => onSaveSettings({ cloudAsrModel: draft.cloudAsrModel })}
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span className="mono label-xs muted">API 地址</span>
                <input
                  value={draft.cloudAsrBaseUrl}
                  onChange={(e) => patch({ cloudAsrBaseUrl: e.target.value })}
                  onBlur={() => onSaveSettings({ cloudAsrBaseUrl: draft.cloudAsrBaseUrl })}
                  spellCheck={false}
                />
              </label>
              <p className="fine-print">
                默认使用硅基流动（SiliconFlow）的 SenseVoiceSmall，中文识别效果好、按音频时长计费。云端结果不带时间戳，可配合摘要功能校对。
              </p>
            </>
          )}
        </section>

        <section className="field-group">
          <div className="group-head">
            <span className="group-no mono label-xs">02</span>
            <h3>DeepSeek</h3>
          </div>
          <p className="group-note">用于提炼摘要。key 留空也能正常使用文稿与导出功能。</p>
          <label className="field">
            <span className="mono label-xs muted">API KEY</span>
            <input
              type="password"
              value={draft.deepseekApiKey}
              onChange={(e) => patch({ deepseekApiKey: e.target.value })}
              onBlur={() => onSaveSettings({ deepseekApiKey: draft.deepseekApiKey })}
              placeholder="sk-…（留空）"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="mono label-xs muted">模型</span>
            <select
              value={draft.deepseekModel}
              onChange={(e) => patch({ deepseekModel: e.target.value }, true)}
            >
              <option value="deepseek-flash">deepseek-flash</option>
              <option value="deepseek-reasoner">deepseek-reasoner</option>
            </select>
          </label>
          <label className="field">
            <span className="mono label-xs muted">API 地址</span>
            <input
              value={draft.deepseekBaseUrl}
              onChange={(e) => patch({ deepseekBaseUrl: e.target.value })}
              onBlur={() => onSaveSettings({ deepseekBaseUrl: draft.deepseekBaseUrl })}
              spellCheck={false}
            />
          </label>
        </section>

        <section className="field-group">
          <div className="group-head">
            <span className="group-no mono label-xs">03</span>
            <h3>阅读偏好</h3>
          </div>
          <div className="pref-row">
            <span>显示时间戳</span>
            <button className={`switch ${draft.showTimestamps ? 'on' : ''}`} onClick={() => patch({ showTimestamps: !draft.showTimestamps }, true)}>
              <i />
            </button>
          </div>
          <div className="pref-row">
            <span>界面主题</span>
            <div className="segmented mono label-xs">
              <button className={draft.theme === 'paper' ? 'active' : ''} onClick={() => patch({ theme: 'paper' }, true)}>纸</button>
              <button className={draft.theme === 'ink' ? 'active' : ''} onClick={() => patch({ theme: 'ink' }, true)}>墨</button>
            </div>
          </div>
          <div className="pref-row">
            <span>默认导出格式</span>
            <select
              value={draft.defaultExportFormat}
              onChange={(e) => patch({ defaultExportFormat: e.target.value as ExportFormat }, true)}
            >
              <option value="md">Markdown</option>
              <option value="txt">纯文本</option>
              <option value="srt">字幕</option>
              <option value="json">JSON</option>
            </select>
          </div>
        </section>

        <section className="field-group">
          <div className="group-head">
            <span className="group-no mono label-xs">04</span>
            <h3>存储</h3>
          </div>
          <p className="group-note">下载过的音频留在本机。删掉归档不会带走音频 —— 重转同一期时可以直接复用，不必重新下载。</p>

          <div className="pref-row">
            <span>音频缓存</span>
            <span className="mono label-xs muted">
              {cache ? `${cache.files} 个 · ${formatBytes(cache.bytes)}` : '统计中…'}
            </span>
          </div>
          <div className="pref-row">
            <span>已无归档的音频</span>
            <span className="mono label-xs muted">
              {cache ? `${cache.orphanFiles} 个 · ${formatBytes(cache.orphanBytes)}` : '—'}
            </span>
          </div>

          {cache && cache.orphanFiles > 0 && (
            <button className="line-action" onClick={() => void clearCache('orphan')} disabled={clearing}>
              清理已无归档的音频（{formatBytes(cache.orphanBytes)}）
            </button>
          )}
          <button className="line-action" onClick={() => void clearCache('all')} disabled={clearing || !cache?.files}>
            {confirmAll ? '再点一次确认清空' : `清空全部音频缓存${cache?.files ? `（${formatBytes(cache.bytes)}）` : ''}`}
          </button>
          <p className="fine-print">只删音频文件，文稿、摘要和导出记录都不受影响。正在下载的文件会被跳过。</p>
        </section>

        <p className="drawer-foot mono label-xs muted">
          誊声 0.2 · 音频与文稿保存在本机用户数据目录
        </p>
      </aside>
    </>
  )
}
