import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { CH } from '../shared/types'
import type { DeskError, EpisodeRecord, ExportFormat, ExportScope, ProgressEvent, Settings } from '../shared/types'
import { cancelSummary, generateSummary, testLlm } from './llm'
import { buildContent, copyText, saveExport } from './exporter'
import { getRecord, listHistory, listRecordIds, removeRecord, setSettings, getSettings } from './store'
import { adoptLegacyModels, dataRoot, relocateDataRoot, storageInfo } from './paths'
import { audioCacheStats, clearAudioCache } from './xyz/audio'
import { DeskException } from './xyz/error'
import { audioDirPath, fetchEpisode, cancelFetch, isAudioBusy, parseEpisodeId } from './xyz/transcript'

let windowRef: BrowserWindow | null = null

export function bindWindow(win: BrowserWindow): void {
  windowRef = win
}

export function emit(channel: string, data: unknown): void {
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send(channel, data)
}

function toDeskError(error: unknown): DeskError {
  if (error instanceof DeskException) return { code: error.code, message: error.message, hint: error.hint }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'UNKNOWN', message }
}

type Handler = (...args: any[]) => Promise<unknown> | unknown

function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      const data = await fn(...args)
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: toDeskError(error) }
    }
  })
}

/** 换数据目录后必须重启：userData 只在启动时读一次。 */
function relaunchSoon(): void {
  setTimeout(() => {
    app.relaunch()
    app.exit(0)
  }, 700)
}

export function registerIpc(): void {
  handle(CH.settingsGet, () => getSettings())
  handle(CH.settingsSet, (patch: Partial<Settings>) => {
    const next = setSettings(patch)
    if (patch.theme && windowRef && !windowRef.isDestroyed() && process.platform === 'win32') {
      const ink = patch.theme === 'ink'
      try {
        windowRef.setTitleBarOverlay({
          color: ink ? '#171614' : '#F4F1EA',
          symbolColor: ink ? '#E8E3D8' : '#1B1A17',
          height: 48
        })
      } catch { /* 不支持 titleBarOverlay 的系统忽略 */ }
    }
    return next
  })

  handle(CH.episodeFetch, async (input: string, force: boolean) => {
    const progress = (event: ProgressEvent) => emit(CH.progress, event)
    if (!force) {
      const eid = parseEpisodeId(input)
      const cached = eid ? getRecord(eid) : null
      if (cached?.segments?.length) {
        progress({ stage: 'done', label: '从本地归档取回', percent: 100 })
        return cached
      }
    }
    return fetchEpisode(input, progress)
  })

  handle(CH.episodeCancel, () => { cancelFetch(); return true })

  handle(CH.historyList, () => listHistory())
  handle(CH.historyGet, (eid: string) => getRecord(eid))
  handle(CH.historyRemove, (eid: string) => { removeRecord(eid); return true })

  // 音频缓存：删归档不会带走音频，这里给一个可见、可控的出口。
  const cacheContext = () => ({
    dir: audioDirPath(),
    tracked: new Set(listRecordIds()),
    isBusy: isAudioBusy
  })
  handle(CH.cacheStats, () => audioCacheStats(cacheContext()))
  handle(CH.cacheClear, (scope: 'orphan' | 'all') => clearAudioCache(cacheContext(), scope === 'all' ? 'all' : 'orphan'))

  // 存储：数据目录默认在系统盘，音频和模型会越攒越大，这里给查看与迁移的入口。
  handle(CH.storageInfo, () => storageInfo())
  handle(CH.storageChoose, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择数据目录',
      defaultPath: dataRoot(),
      buttonLabel: '用这个文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  handle(CH.storageRelocate, (target: string) => {
    const result = relocateDataRoot(target)
    relaunchSoon()
    return result
  })
  handle(CH.storageAdoptModels, () => adoptLegacyModels())
  handle(CH.storageOpen, async (target?: string) => {
    const dir = typeof target === 'string' && target.trim() ? target : dataRoot()
    await shell.openPath(dir)
    return true
  })

  handle(CH.llmTest, (patch: Partial<Settings>) => testLlm(patch ?? {}))

  handle(CH.summaryGenerate, (eid: string) =>
    generateSummary(eid, (event) => emit(CH.summaryStream, event))
  )
  handle(CH.summaryCancel, () => { cancelSummary(); return true })

  handle(CH.exportSave, (eid: string, format: ExportFormat, scope: ExportScope) => {
    const record = getRecord(eid)
    if (!record) throw new DeskException('NOT_FOUND', '找不到这份文稿')
    return saveExport(record, format, scope)
  })
  handle(CH.clipboardCopy, (text: string) => { copyText(text); return true })
  handle(CH.clipboardEpisode, (eid: string, format: ExportFormat, scope: ExportScope) => {
    const record = getRecord(eid) as EpisodeRecord | null
    if (!record) throw new DeskException('NOT_FOUND', '找不到这份文稿')
    copyText(buildContent(record, format, scope))
    return true
  })
  handle(CH.openExternal, (url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
    return false
  })
}
