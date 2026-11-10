export type ExportFormat = 'txt' | 'md' | 'srt' | 'json'
export type ExportScope = 'transcript' | 'summary' | 'both'
export type Theme = 'paper' | 'ink'
export type AsrEngine = 'local' | 'cloud'
export type LocalAsrModel = 'tiny' | 'base' | 'small' | 'medium'

export interface TranscriptSegment {
  index: number
  startMs: number
  endMs: number
  text: string
  speaker?: string
}

export interface EpisodeMeta {
  eid: string
  link: string
  title: string
  podcast: string
  cover?: string
  durationSec?: number
  publishedAt?: string
  description?: string
  mediaId?: string
  enclosureUrl?: string
}

export interface EpisodeRecord {
  meta: EpisodeMeta
  segments: TranscriptSegment[]
  plainText: string
  charCount: number
  fetchedAt: string
  summary?: string
  summaryGeneratedAt?: string
}

export interface HistoryItem {
  eid: string
  title: string
  podcast: string
  fetchedAt: string
  charCount: number
  hasSummary: boolean
}

export interface Settings {
  deepseekApiKey: string
  deepseekModel: string
  deepseekBaseUrl: string
  theme: Theme
  showTimestamps: boolean
  defaultExportFormat: ExportFormat
  asrEngine: AsrEngine
  localAsrModel: LocalAsrModel
  cloudAsrApiKey: string
  cloudAsrBaseUrl: string
  cloudAsrModel: string
}

export interface ProgressEvent {
  stage: 'parse' | 'episode' | 'download' | 'transcript' | 'render' | 'done'
  label: string
  percent: number
  /** 补充说明：正在做什么、已经处理到哪（在进度条下方显示一行小字）。 */
  detail?: string
  /** 该阶段耗时不可预估（如加载模型），进度条走不确定态动画而不是停在某个百分比。 */
  indeterminate?: boolean
  /** 本次任务开始的时间戳，渲染层用来显示「已用时」秒表。 */
  startedAt?: number
}

export interface SummaryEvent {
  type: 'stage' | 'delta' | 'done' | 'error'
  text?: string
  record?: EpisodeRecord
  message?: string
}

export interface DeskError {
  code: string
  message: string
  hint?: string
}

/** 已下载音频的占用情况。orphan = 归档已删、只剩音频的空壳。 */
export interface AudioCacheStats {
  files: number
  bytes: number
  orphanFiles: number
  orphanBytes: number
}

export interface CacheClearResult {
  freedFiles: number
  freedBytes: number
}

export const DEFAULT_SETTINGS: Settings = {
  deepseekApiKey: '',
  deepseekModel: 'deepseek-flash',
  deepseekBaseUrl: 'https://api.deepseek.com',
  theme: 'paper',
  showTimestamps: true,
  defaultExportFormat: 'md',
  asrEngine: 'local',
  localAsrModel: 'small',
  cloudAsrApiKey: '',
  cloudAsrBaseUrl: 'https://api.siliconflow.cn/v1',
  cloudAsrModel: 'FunAudioLLM/SenseVoiceSmall'
}

export const CH = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  episodeFetch: 'episode:fetch',
  episodeCancel: 'episode:cancel',
  historyList: 'history:list',
  historyGet: 'history:get',
  historyRemove: 'history:remove',
  summaryGenerate: 'summary:generate',
  summaryCancel: 'summary:cancel',
  exportSave: 'export:save',
  clipboardCopy: 'clipboard:copy',
  clipboardEpisode: 'clipboard:episode',
  cacheStats: 'cache:stats',
  cacheClear: 'cache:clear',
  openExternal: 'shell:open-external',
  progress: 'event:progress',
  summaryStream: 'event:summary'
} as const

export function formatDuration(sec?: number): string {
  if (!sec || sec <= 0) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

export function formatStamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatSrtStamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms))
  const h = Math.floor(total / 3600000)
  const m = Math.floor((total % 3600000) / 60000)
  const s = Math.floor((total % 60000) / 1000)
  const f = total % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(f).padStart(3, '0')}`
}

export function formatDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}
