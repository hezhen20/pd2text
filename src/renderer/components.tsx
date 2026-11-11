import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type {
  AudioCacheStats, DeskError, EpisodeRecord, ExportFormat, ExportScope, HistoryItem,
  LlmProvider, ProgressEvent, Settings, StorageInfo
} from '@shared/types'
import { DEFAULT_CHUNK_PROMPT, DEFAULT_SUMMARY_PROMPT, LLM_PRESETS, formatDate, formatDuration, formatStamp } from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from './api'

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
  const actionable = error.code === 'NO_API_KEY' || error.code === 'NO_ASR_KEY'
    || error.code === 'ASR_LOCAL_ERROR' || error.code === 'MODEL_INVALID'
    || error.code === 'AUTH_ERROR' || error.code === 'BAD_ENDPOINT'
  return (
    <div className="error-note" role="alert">
      <div className="error-head">
        <span className="mono label-xs">未能完成 · {error.code}</span>
      </div>
      <p className="error-title">{error.message}</p>
      {error.hint && <p className="error-hint">{error.hint}</p>}
      {actionable && (
        <button className="text-action" onClick={onAction}>
          {error.code === 'NO_API_KEY' ? '去填写 API Key →' : '去设置 →'}
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
  summaryError: DeskError | null
  onSummarize: () => void
  onCancelSummary: () => void
  onCopySummary: () => void
  onOpenSettings: () => void
  hasApiKey: boolean
}

export function ReaderView(props: ReaderProps): ReactNode {
  const {
    record, settings, query, setQuery, onBack, onRefetch, onCopy, onExport, onCopySegment, onOpenLink,
    summaryText, summaryStatus, summaryStage, summaryError,
    onSummarize, onCancelSummary, onCopySummary, onOpenSettings, hasApiKey
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
  const modelLabel = (settings.llmModel.trim() || 'deepseek-flash').split('/').pop()
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
              <span className="mono label-xs muted aside-model" title={settings.llmModel || 'deepseek-flash'}>{modelLabel}</span>
            </div>
            {summaryStatus === 'idle' && !summaryText && (
              <div className="summary-empty">
                <p>让编辑先读一遍。<br />留下脉络、观点和原话，不替你下结论。</p>
                {!hasApiKey && <p className="summary-warning mono label-xs">需要先在设置里填入模型 API Key</p>}
                <button className="solid-action" onClick={hasApiKey ? onSummarize : onOpenSettings}>
                  {hasApiKey ? '开始提炼' : '去填写 Key'}
                </button>
                <p className="summary-foot mono label-xs muted">
                  转写受语音模型限制，个别词句可能不准；提炼时会按上下文语义校正，再落笔。
                  <br />
                  长文稿会分段通读，最后合成一稿。
                </p>
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
              <div className="summary-error">
                <p className="error-head mono label-xs">
                  没能写成{summaryError ? ` · ${summaryError.code}` : ''}
                </p>
                <p className="error-title">{summaryError?.message ?? '这一次没写成'}</p>
                {summaryError?.hint && <p className="error-hint">{summaryError.hint}</p>}
                <div className="summary-actions">
                  <button className="solid-action" onClick={onSummarize}>再试一次</button>
                  <button className="text-action small" onClick={onOpenSettings}>去设置</button>
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </main>
  )
}

/* ---------- 提示词编辑块 ---------- */

interface PromptFieldProps {
  label: string
  value: string
  defaultText: string
  editing: boolean
  onToggle: () => void
  onChange: (value: string) => void
  onReset: () => void
}

/**
 * 默认只展示不可编辑的预览：提示词是给愿意调的人用的，
 * 不该让每个用户一进设置就面对一大段可改的文本。
 */
function PromptField({ label, value, defaultText, editing, onToggle, onChange, onReset }: PromptFieldProps): ReactNode {
  const isDefault = value.trim() === defaultText.trim()
  return (
    <div className="prompt-block">
      <div className="prompt-head">
        <span className="mono label-xs muted">{label}</span>
        <button className="text-action small" onClick={onToggle}>{editing ? '收起' : '编辑'}</button>
      </div>
      {editing ? (
        <textarea
          className="prompt-area"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          rows={14}
        />
      ) : (
        <p className="prompt-preview">{value}</p>
      )}
      <div className="prompt-foot">
        <span className="mono label-xs muted">
          {editing ? '改动会自动保存，下次提炼生效' : isDefault ? '默认提示词' : '已自定义'}
        </span>
        {!isDefault && <button className="text-action small" onClick={onReset}>恢复默认</button>}
      </div>
    </div>
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

type TestState = { status: 'idle' | 'testing' | 'ok' | 'fail'; message: string; hint?: string; models: string[] }

export function SettingsDrawer({ open, onClose, settings, onSaveSettings, notify }: SettingsProps): ReactNode {
  const [draft, setDraft] = useState<Settings>(settings)
  const [cache, setCache] = useState<AudioCacheStats | null>(null)
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [clearing, setClearing] = useState(false)
  const [confirmAll, setConfirmAll] = useState(false)
  const [busy, setBusy] = useState<'move' | 'models' | ''>('')
  const [pendingDir, setPendingDir] = useState('')
  const [editor, setEditor] = useState<'summary' | 'chunk' | null>(null)
  const [test, setTest] = useState<TestState>({ status: 'idle', message: '', models: [] })
  const promptTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 只在抽屉打开时同步一次：自动保存会不断回传新设置，
  // 如果每次都覆盖 draft，正在输入的 API Key 会被吃掉。
  useEffect(() => {
    if (!open) return
    setDraft(settings)
    setTest({ status: 'idle', message: '', models: [] })
    setPendingDir('')
    setEditor(null)
    setConfirmAll(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    void refreshCache()
    void refreshStorage()
  }, [open])

  useEffect(() => () => { if (promptTimer.current) clearTimeout(promptTimer.current) }, [])

  // 「清空全部」是二次确认：4 秒内再点一下才真删。
  useEffect(() => {
    if (!confirmAll) return
    const timer = setTimeout(() => setConfirmAll(false), 4000)
    return () => clearTimeout(timer)
  }, [confirmAll])

  const refreshCache = async (): Promise<void> => {
    try { setCache(await api.cache.stats()) } catch { setCache(null) }
  }

  const refreshStorage = async (): Promise<void> => {
    try { setStorage(await api.storage.info()) } catch { setStorage(null) }
  }

  const clearCache = async (scope: 'orphan' | 'all'): Promise<void> => {
    if (scope === 'all' && !confirmAll) { setConfirmAll(true); return }
    setConfirmAll(false)
    setClearing(true)
    try {
      const result = await api.cache.clear(scope)
      notify(result.freedFiles ? `已释放 ${formatBytes(result.freedBytes)}` : '没有需要清理的音频')
      await refreshCache()
      await refreshStorage()
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

  /** 提示词：边写边存，700ms 内没有新输入就落盘。 */
  const editPrompt = (key: 'summaryPrompt' | 'chunkPrompt', value: string): void => {
    setDraft((d) => ({ ...d, [key]: value }))
    if (promptTimer.current) clearTimeout(promptTimer.current)
    promptTimer.current = setTimeout(() => {
      onSaveSettings({ [key]: value } as Partial<Settings>)
    }, 700)
  }

  const useProvider = (id: LlmProvider): void => {
    if (id === 'deepseek') {
      const preset = LLM_PRESETS.find((p) => p.id === 'deepseek')!
      patch({ llmProvider: 'deepseek', llmBaseUrl: preset.baseUrl, llmModel: preset.model }, true)
    } else {
      patch({ llmProvider: 'custom' }, true)
    }
    setTest({ status: 'idle', message: '', models: [] })
  }

  const runTest = async (): Promise<void> => {
    setTest({ status: 'testing', message: '正在连接…', models: [] })
    try {
      const result = await api.llm.test({
        llmApiKey: draft.llmApiKey,
        llmBaseUrl: draft.llmBaseUrl,
        llmModel: draft.llmModel
      })
      setTest({
        status: result.ok ? 'ok' : 'fail',
        message: result.message,
        hint: result.hint,
        models: result.models ?? []
      })
    } catch (error) {
      setTest({
        status: 'fail',
        message: error instanceof ApiError ? error.message : '测试失败',
        hint: error instanceof ApiError ? error.hint : undefined,
        models: []
      })
    }
  }

  const chooseDir = async (): Promise<void> => {
    try {
      const dir = await api.storage.choose()
      if (dir) setPendingDir(dir)
    } catch {
      notify('没能选择目录')
    }
  }

  const moveData = async (): Promise<void> => {
    if (!pendingDir) return
    setBusy('move')
    try {
      await api.storage.relocate(pendingDir)
      notify('正在复制数据，完成后应用会自动重启')
    } catch (error) {
      setBusy('')
      notify(error instanceof ApiError ? error.message : '移动失败')
    }
  }

  const adoptModels = async (): Promise<void> => {
    setBusy('models')
    try {
      const result = await api.storage.adoptModels()
      notify(result.moved ? `已迁移 ${formatBytes(result.bytes)} 模型` : '没有可迁移的模型')
      await refreshStorage()
    } catch {
      notify('迁移失败，可能文件正被占用')
    } finally {
      setBusy('')
    }
  }

  const modelOptions = [
    ...new Set([...(LLM_PRESETS.find((p) => p.id === draft.llmProvider)?.models ?? []), ...test.models])
  ]

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
                本地转写需要本机已装 Python 3，并运行过 <span className="mono">pip install faster-whisper</span>。首次使用会按所选模型自动下载权重（small 约 466MB），权重存在下面的数据目录里。
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
            <h3>模型</h3>
          </div>
          <p className="group-note">
            用来提炼摘要。默认 DeepSeek，也可以填任何 OpenAI 兼容的接口与模型名。key 留空不影响文稿和导出。
          </p>

          <div className="pref-row">
            <span>服务</span>
            <div className="segmented mono label-xs">
              {LLM_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  className={draft.llmProvider === preset.id ? 'active' : ''}
                  onClick={() => useProvider(preset.id)}
                >{preset.label}</button>
              ))}
            </div>
          </div>

          <label className="field">
            <span className="mono label-xs muted">API KEY</span>
            <input
              type="password"
              value={draft.llmApiKey}
              onChange={(e) => patch({ llmApiKey: e.target.value })}
              onBlur={() => onSaveSettings({ llmApiKey: draft.llmApiKey })}
              placeholder="sk-…（留空）"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="mono label-xs muted">模型名</span>
            <input
              list="llm-model-options"
              value={draft.llmModel}
              onChange={(e) => patch({ llmModel: e.target.value })}
              onBlur={() => onSaveSettings({ llmModel: draft.llmModel })}
              placeholder="deepseek-flash"
              spellCheck={false}
            />
            <datalist id="llm-model-options">
              {modelOptions.map((name) => <option key={name} value={name} />)}
            </datalist>
          </label>
          <label className="field">
            <span className="mono label-xs muted">API 地址</span>
            <input
              value={draft.llmBaseUrl}
              onChange={(e) => patch({ llmBaseUrl: e.target.value })}
              onBlur={() => onSaveSettings({ llmBaseUrl: draft.llmBaseUrl })}
              placeholder="https://api.deepseek.com"
              spellCheck={false}
            />
          </label>

          <button className="line-action" onClick={() => void runTest()} disabled={test.status === 'testing'}>
            {test.status === 'testing' ? '正在测试…' : '测试连接'}
          </button>
          {(test.status === 'ok' || test.status === 'fail') && (
            <p className={`form-msg ${test.status === 'ok' ? 'is-ok' : ''}`}>
              {test.message}
              {test.hint ? <><br />{test.hint}</> : null}
            </p>
          )}
          <p className="fine-print">
            模型名可以直接手写（各家命名不同，也可能随时改）。万一写错，摘要区会直接把服务端返回的错误显示出来，照着改就行。
          </p>
        </section>

        <section className="field-group">
          <div className="group-head">
            <span className="group-no mono label-xs">03</span>
            <h3>摘要提示词</h3>
          </div>
          <p className="group-note">
            决定 AI 怎么读这份稿子、写成什么样子。默认值已经调好，不改也能用；想换角度、换口径时再动它。
          </p>

          <PromptField
            label="成稿提示词"
            value={draft.summaryPrompt}
            defaultText={DEFAULT_SUMMARY_PROMPT}
            editing={editor === 'summary'}
            onToggle={() => setEditor(editor === 'summary' ? null : 'summary')}
            onChange={(value) => editPrompt('summaryPrompt', value)}
            onReset={() => { setEditor('summary'); editPrompt('summaryPrompt', DEFAULT_SUMMARY_PROMPT) }}
          />
          <PromptField
            label="分段通读提示词"
            value={draft.chunkPrompt}
            defaultText={DEFAULT_CHUNK_PROMPT}
            editing={editor === 'chunk'}
            onToggle={() => setEditor(editor === 'chunk' ? null : 'chunk')}
            onChange={(value) => editPrompt('chunkPrompt', value)}
            onReset={() => { setEditor('chunk'); editPrompt('chunkPrompt', DEFAULT_CHUNK_PROMPT) }}
          />
          <p className="fine-print">
            只有长文稿（约 5000 字以上）才会走「分段通读」，短稿直接通读全文后成稿。
          </p>
        </section>

        <section className="field-group">
          <div className="group-head">
            <span className="group-no mono label-xs">04</span>
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
            <span className="group-no mono label-xs">05</span>
            <h3>存储</h3>
          </div>
          <p className="group-note">
            归档、音频和本地语音模型都放在数据目录里，默认是系统用户目录（通常在 C 盘）。用的时间越长占得越多 —— 换到空间大的盘可以一次腾出来。
          </p>

          <div className="path-box">
            <span className="mono label-xs muted">当前数据目录</span>
            <p className="path-text mono">{storage?.root ?? '读取中…'}</p>
            {storage && (
              <p className="path-size mono label-xs muted">
                {storage.items
                  .filter((item) => item.bytes > 0)
                  .map((item) => `${item.label} ${formatBytes(item.bytes)}`)
                  .join(' · ') || '暂无占用'}
                {storage.totalBytes > 0 ? ` · 合计 ${formatBytes(storage.totalBytes)}` : ''}
              </p>
            )}
          </div>

          {storage && storage.legacyModelBytes > 0 && (
            <button className="line-action" onClick={() => void adoptModels()} disabled={busy === 'models'}>
              {busy === 'models'
                ? '正在迁移模型…'
                : `把旧位置的语音模型搬进数据目录（${formatBytes(storage.legacyModelBytes)}）`}
            </button>
          )}

          <button className="line-action" onClick={() => void chooseDir()} disabled={busy === 'move'}>更改数据目录…</button>
          <button className="line-action" onClick={() => void api.storage.open()}>在文件管理器中打开</button>

          {pendingDir && (
            <div className="move-confirm">
              <p className="mono label-xs muted">将把数据复制到</p>
              <p className="path-text mono">{pendingDir}</p>
              <p className="fine-print">
                复制完成后应用会自动重启，之后所有新数据都写在新位置。原位置的归档、音频、模型会被清理，只留一个记录新位置的小文件。
              </p>
              <div className="move-actions">
                <button className="solid-action" onClick={() => void moveData()} disabled={busy === 'move'}>
                  {busy === 'move' ? '正在复制…' : '确认移动并重启'}
                </button>
                <button className="text-action small" onClick={() => setPendingDir('')} disabled={busy === 'move'}>取消</button>
              </div>
            </div>
          )}

          <div className="pref-row storage-row">
            <span>音频缓存</span>
            <span className="mono label-xs muted">
              {cache ? `${cache.files} 个 · ${formatBytes(cache.bytes)}` : '统计中…'}
            </span>
          </div>
          <div className="pref-row storage-row">
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
          誊声 0.3 · 数据保存在本机，路径可在上面改
        </p>
      </aside>
    </>
  )
}
