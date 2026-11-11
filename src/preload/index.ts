import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '../shared/types'

export interface DeskBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<any>
  on: (channel: string, listener: (data: any) => void) => () => void
  platform: NodeJS.Process['platform']
}

// 白名单：只放行主进程真正注册过的通道。
// 之前这里是裸的 ipcRenderer.invoke 透传，渲染层一旦有脚本注入
// （例如摘要里混进恶意 HTML），就能借它去调任意 IPC 通道。
const INVOKE_CHANNELS = new Set<string>([
  CH.settingsGet,
  CH.settingsSet,
  CH.episodeFetch,
  CH.episodeCancel,
  CH.historyList,
  CH.historyGet,
  CH.historyRemove,
  CH.summaryGenerate,
  CH.summaryCancel,
  CH.llmTest,
  CH.exportSave,
  CH.clipboardCopy,
  CH.clipboardEpisode,
  CH.cacheStats,
  CH.cacheClear,
  CH.storageInfo,
  CH.storageChoose,
  CH.storageRelocate,
  CH.storageAdoptModels,
  CH.storageOpen,
  CH.openExternal
])

const EVENT_CHANNELS = new Set<string>([CH.progress, CH.summaryStream])

const bridge: DeskBridge = {
  invoke: (channel, ...args) => {
    if (!INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel, listener) => {
    if (!EVENT_CHANNELS.has(channel)) return () => {}
    const subscription = (_event: unknown, data: unknown) => listener(data)
    ipcRenderer.on(channel, subscription)
    return () => ipcRenderer.removeListener(channel, subscription)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('desk', bridge)
