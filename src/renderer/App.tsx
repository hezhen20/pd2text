import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from './api'
import { HomeView, ReaderView, SettingsDrawer, Toast, TopBar } from './components'
import { DEFAULT_SETTINGS } from '@shared/types'
import type {
  DeskError, EpisodeRecord, ExportFormat, ExportScope,
  HistoryItem, ProgressEvent, Settings
} from '@shared/types'

type SummaryStatus = 'idle' | 'working' | 'done' | 'error'

function toDeskError(error: unknown): DeskError {
  if (error instanceof ApiError) return { code: error.code, message: error.message, hint: error.hint }
  return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [record, setRecord] = useState<EpisodeRecord | null>(null)
  const [link, setLink] = useState('')
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const [error, setError] = useState<DeskError | null>(null)
  const [drawer, setDrawer] = useState(false)
  const [query, setQuery] = useState('')
  const [toast, setToast] = useState('')
  const [summaryText, setSummaryText] = useState('')
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus>('idle')
  const [summaryStage, setSummaryStage] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function notify(text: string): void {
    setToast(text)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 3600)
  }

  async function refreshHistory(): Promise<void> {
    setHistory(await api.history.list())
  }

  useEffect(() => {
    void (async () => {
      const [s, h] = await Promise.all([api.settings.get(), api.history.list()])
      setSettings(s)
      setHistory(h)
      document.documentElement.dataset.theme = s.theme
    })()
    document.body.classList.add(api.platform === 'darwin' ? 'platform-mac' : 'platform-win')

    const offProgress = api.onProgress((event) => setProgress(event))
    const offSummary = api.onSummary((event) => {
      if (event.type === 'stage') setSummaryStage(event.text ?? '')
      else if (event.type === 'delta') setSummaryText((prev) => prev + (event.text ?? ''))
      else if (event.type === 'done') {
        setSummaryText(event.text ?? '')
        setSummaryStatus('done')
        if (event.record) setRecord(event.record)
        void refreshHistory()
      } else if (event.type === 'error') {
        setSummaryStatus('error')
        notify(event.message ?? '摘要没能写成')
      }
    })
    return () => { offProgress(); offSummary() }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  async function saveSettings(patch: Partial<Settings>): Promise<void> {
    setSettings(await api.settings.set(patch))
  }

  async function submit(value = link, force = false): Promise<void> {
    const text = value.trim()
    if (!text || loading) return
    setError(null)
    setQuery('')
    setProgress(null)
    setLoading(true)
    try {
      const next = await api.episode.fetch(text, force)
      setRecord(next)
      setSummaryText(next.summary ?? '')
      setSummaryStatus(next.summary ? 'done' : 'idle')
      setSummaryStage('')
      await refreshHistory()
    } catch (caught) {
      const err = toDeskError(caught)
      setError(err)
      // 在阅读页里点「重新转写」时首页不可见，错误得用 toast 说出来。
      if (record) notify(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function cancelFetch(): Promise<void> {
    await api.episode.cancel()
  }

  async function openHistory(eid: string): Promise<void> {
    const item = await api.history.get(eid)
    if (!item) { notify('这份归档已经不在了'); void refreshHistory(); return }
    setRecord(item)
    setSummaryText(item.summary ?? '')
    setSummaryStatus(item.summary ? 'done' : 'idle')
    setSummaryStage('')
    setQuery('')
    setError(null)
  }

  async function removeHistory(eid: string): Promise<void> {
    await api.history.remove(eid)
    await refreshHistory()
    notify('已从归档移除')
  }

  async function summarize(): Promise<void> {
    if (!record) return
    setSummaryText('')
    setSummaryStage('准备通读')
    setSummaryStatus('working')
    try {
      const next = await api.summary.generate(record.meta.eid)
      setRecord(next)
      setSummaryText(next.summary ?? '')
      setSummaryStatus('done')
      void refreshHistory()
    } catch (caught) {
      const err = toDeskError(caught)
      if (err.code === 'CANCELLED') setSummaryStatus(record.summary ? 'done' : 'idle')
      else { setSummaryStatus('error'); notify(err.message) }
    }
  }

  async function cancelSummary(): Promise<void> {
    await api.summary.cancel()
    setSummaryStatus(record?.summary ? 'done' : 'idle')
  }

  async function exportFile(format: ExportFormat, scope: ExportScope): Promise<void> {
    if (!record) return
    if (scope === 'summary' && !record.summary) { notify('还没有摘要可导出'); return }
    try {
      const filePath = await api.exportFile.save(record.meta.eid, format, scope)
      if (filePath) notify(`已导出 · ${filePath.split(/[\\/]/).pop()}`)
    } catch (caught) { notify(toDeskError(caught).message) }
  }

  async function copyEpisode(scope: ExportScope, format: ExportFormat): Promise<void> {
    if (!record) return
    await api.clipboard.episode(record.meta.eid, format, scope)
    notify('已复制到剪贴板')
  }

  async function copyText(text: string, message = '已复制'): Promise<void> {
    await api.clipboard.copy(text)
    notify(message)
  }

  return (
    <div className="app grain">
      <TopBar
        settings={settings}
        onSettings={() => setDrawer(true)}
        onTheme={() => void saveSettings({ theme: settings.theme === 'paper' ? 'ink' : 'paper' })}
        onHome={() => { setRecord(null); setError(null); setQuery('') }}
      />

      {record ? (
        <ReaderView
          record={record}
          settings={settings}
          query={query}
          setQuery={setQuery}
          onBack={() => { setRecord(null); setError(null); setQuery('') }}
          onRefetch={() => void submit(record.meta.link, true)}
          onCopy={(scope, format) => void copyEpisode(scope, format)}
          onExport={(format, scope) => void exportFile(format, scope)}
          onCopySegment={(text) => void copyText(text, '这一段已复制')}
          onOpenLink={() => void api.openExternal(record.meta.link)}
          summaryText={summaryText}
          summaryStatus={summaryStatus}
          summaryStage={summaryStage}
          onSummarize={() => void summarize()}
          onCancelSummary={() => void cancelSummary()}
          onCopySummary={() => void copyText(summaryText, '摘要已复制')}
          onOpenSettings={() => setDrawer(true)}
          hasApiKey={Boolean(settings.deepseekApiKey.trim())}
        />
      ) : (
        <HomeView
          link={link}
          setLink={setLink}
          onSubmit={() => void submit()}
          loading={loading}
          progress={progress}
          error={error}
          onErrorAction={() => setDrawer(true)}
          onCancel={() => void cancelFetch()}
          history={history}
          onOpenHistory={(eid) => void openHistory(eid)}
          onRemoveHistory={(eid) => void removeHistory(eid)}
        />
      )}

      <SettingsDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        settings={settings}
        onSaveSettings={(patch) => void saveSettings(patch)}
        notify={notify}
      />
      <Toast text={toast} />
    </div>
  )
}
