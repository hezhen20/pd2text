export type ExportFormat = 'txt' | 'md' | 'srt' | 'json'
export type ExportScope = 'transcript' | 'summary' | 'both'
export type Theme = 'paper' | 'ink'
export type AsrEngine = 'local' | 'cloud'
export type LocalAsrModel = 'tiny' | 'base' | 'small' | 'medium'
export type LlmProvider = 'deepseek' | 'custom'

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
  /** DeepSeek 官方按默认值走；自定义 = 任意 OpenAI 兼容服务。 */
  llmProvider: LlmProvider
  llmApiKey: string
  llmBaseUrl: string
  llmModel: string
  /** 摘要提示词。用户可改，留空时回落到 DEFAULT_SUMMARY_PROMPT。 */
  summaryPrompt: string
  /** 长文稿分段通读用的提示词。 */
  chunkPrompt: string
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

/** 数据目录里某一类文件的占用。 */
export interface StorageItem {
  key: 'data' | 'audio' | 'models' | 'hf'
  label: string
  bytes: number
  files: number
}

export interface StorageInfo {
  /** 当前实际使用的数据目录。 */
  root: string
  /** 系统默认位置（未改过时与 root 相同）。 */
  defaultRoot: string
  /** 是否已改成自定义目录。 */
  custom: boolean
  totalBytes: number
  items: StorageItem[]
  /** 老版本遗留在用户主目录 huggingface 缓存里的模型体积（改目录后可迁走）。 */
  legacyModelBytes: number
}

export interface LlmTestResult {
  ok: boolean
  model: string
  message: string
  hint?: string
  /** 服务端 /models 返回的可用模型名，便于用户对照着改。 */
  models: string[]
}

/** 模型服务预设。只用来填默认地址与常见模型名，用户随时可以改。 */
export const LLM_PRESETS: { id: LlmProvider; label: string; baseUrl: string; model: string; models: string[] }[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner']
  },
  {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    model: '',
    models: []
  }
]

export const DEFAULT_SUMMARY_PROMPT = `你是一位中文播客的文字编辑，正在把逐字稿整理成一份可以存档的编读摘要。

写作准则：
- 文稿来自语音识别，个别字词（尤其人名、机构名、同音字）可能识别有误；遇到明显的识别错误请按上下文语义校正后再写下，不要照抄错字，也不要因此改变原意。
- 只依据给定的文稿，不补充外部知识，不臆测嘉宾未说过的观点。
- 语气克制、具体，像纸刊的编者按；不要营销腔，不要「本文主要讲述了」「希望对你有帮助」这类套话。
- 保留具体的人名、机构名、数字、时间与原文措辞。
- 严格按以下 Markdown 结构输出，不要加开场白或结尾：

## 一句话
（不超过 40 字，说清这一期真正在谈什么）

## 脉络
（3–6 条，按内容推进顺序，每条以「- 」开头，尽量带上文稿里的时间点）

## 核心观点
（4–8 条，每条以「- 」开头，写清楚论点、论据或结论，不要空泛的概括）

## 值得记下的原话
（3–5 条，逐字引用文稿中的句子，用 > 开头，并在末尾标注时间点）

## 留白
（1–2 条，指出文稿里没说透、值得继续追问的地方）`

export const DEFAULT_CHUNK_PROMPT = `你在为一档中文播客做逐字稿分块整理。下面是文稿的一个片段。
请提取这一段的 4–6 条要点，每条以「- 」开头，保留原文里的人名、数字、专有名词和关键原话，带上时间点。
文稿来自语音识别，明显的错字请按上下文校正。
不要开场白，不要总结感想，只输出要点列表。`

export const DEFAULT_SETTINGS: Settings = {
  llmProvider: 'deepseek',
  llmApiKey: '',
  llmBaseUrl: 'https://api.deepseek.com',
  llmModel: 'deepseek-flash',
  summaryPrompt: DEFAULT_SUMMARY_PROMPT,
  chunkPrompt: DEFAULT_CHUNK_PROMPT,
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
  llmTest: 'llm:test',
  exportSave: 'export:save',
  clipboardCopy: 'clipboard:copy',
  clipboardEpisode: 'clipboard:episode',
  cacheStats: 'cache:stats',
  cacheClear: 'cache:clear',
  storageInfo: 'storage:info',
  storageChoose: 'storage:choose',
  storageRelocate: 'storage:relocate',
  storageAdoptModels: 'storage:adopt-models',
  storageOpen: 'storage:open',
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
