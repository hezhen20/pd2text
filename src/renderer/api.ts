import { CH, DEFAULT_SETTINGS } from '@shared/types'
import type {
  AudioCacheStats, CacheClearResult, DeskError, EpisodeRecord, ExportFormat, ExportScope,
  HistoryItem, LlmTestResult, ProgressEvent, Settings, StorageInfo, SummaryEvent
} from '@shared/types'

declare global {
  interface Window {
    desk: {
      invoke: (channel: string, ...args: unknown[]) => Promise<any>
      on: (channel: string, listener: (data: any) => void) => () => void
      platform: NodeJS.Process['platform']
    }
  }
}

export class ApiError extends Error {
  code: string
  hint?: string
  constructor(error: DeskError) {
    super(error.message)
    this.code = error.code
    this.hint = error.hint
  }
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await window.desk.invoke(channel, ...args)
  if (result?.ok) return result.data as T
  throw new ApiError(result?.error ?? { code: 'UNKNOWN', message: '发生了未知错误' })
}

export const api = {
  platform: window.desk.platform,
  settings: {
    get: () => call<Settings>(CH.settingsGet),
    set: (patch: Partial<Settings>) => call<Settings>(CH.settingsSet, patch)
  },
  episode: {
    fetch: (input: string, force = false) => call<EpisodeRecord>(CH.episodeFetch, input, force),
    cancel: () => call<boolean>(CH.episodeCancel)
  },
  history: {
    list: () => call<HistoryItem[]>(CH.historyList),
    get: (eid: string) => call<EpisodeRecord | null>(CH.historyGet, eid),
    remove: (eid: string) => call<boolean>(CH.historyRemove, eid)
  },
  summary: {
    generate: (eid: string) => call<EpisodeRecord>(CH.summaryGenerate, eid),
    cancel: () => call<boolean>(CH.summaryCancel)
  },
  llm: {
    test: (patch: Partial<Settings>) => call<LlmTestResult>(CH.llmTest, patch)
  },
  cache: {
    stats: () => call<AudioCacheStats>(CH.cacheStats),
    clear: (scope: 'orphan' | 'all') => call<CacheClearResult>(CH.cacheClear, scope)
  },
  storage: {
    info: () => call<StorageInfo>(CH.storageInfo),
    choose: () => call<string | null>(CH.storageChoose),
    relocate: (target: string) => call<{ root: string }>(CH.storageRelocate, target),
    adoptModels: () => call<{ moved: boolean; bytes: number }>(CH.storageAdoptModels),
    open: (target?: string) => call<boolean>(CH.storageOpen, target)
  },
  exportFile: {
    save: (eid: string, format: ExportFormat, scope: ExportScope) => call<string | null>(CH.exportSave, eid, format, scope)
  },
  clipboard: {
    copy: (text: string) => call<boolean>(CH.clipboardCopy, text),
    episode: (eid: string, format: ExportFormat, scope: ExportScope) => call<boolean>(CH.clipboardEpisode, eid, format, scope)
  },
  openExternal: (url: string) => call<boolean>(CH.openExternal, url),
  onProgress: (listener: (event: ProgressEvent) => void) => window.desk.on(CH.progress, listener),
  onSummary: (listener: (event: SummaryEvent) => void) => window.desk.on(CH.summaryStream, listener)
}

export const fallbackSettings: Settings = DEFAULT_SETTINGS
