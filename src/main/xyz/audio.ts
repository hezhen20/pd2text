import fs from 'node:fs'
import path from 'node:path'
import type { AudioCacheStats, CacheClearResult } from '../../shared/types'

// 音频缓存：下载过的单集音频留在 audio 目录，文件名就是 eid。
// 删掉归档不会带走音频（重转同一期可复用，不必重新下载），于是这里负责
// 把「没人认领的音频」统计出来、按需清理。只碰 *.m4a，别的文件一概不动。

export interface AudioFile {
  eid: string
  file: string
  bytes: number
}

export interface CacheContext {
  dir: string
  /** 仍有归档记录的 eid。 */
  tracked: Set<string>
  /** 正在下载中的文件不能被清理掉。 */
  isBusy: (file: string) => boolean
}

const AUDIO_EXT = '.m4a'

export function listAudioFiles(dir: string): AudioFile[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: AudioFile[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith(AUDIO_EXT)) continue
    const file = path.join(dir, name)
    let bytes = 0
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile()) continue
      bytes = stat.size
    } catch {
      // 刚好被别的进程挪走，跳过
      continue
    }
    out.push({ eid: name.slice(0, -AUDIO_EXT.length), file, bytes })
  }
  return out
}

export function audioCacheStats(ctx: CacheContext): AudioCacheStats {
  const stats: AudioCacheStats = { files: 0, bytes: 0, orphanFiles: 0, orphanBytes: 0 }
  for (const item of listAudioFiles(ctx.dir)) {
    stats.files += 1
    stats.bytes += item.bytes
    if (!ctx.tracked.has(item.eid)) {
      stats.orphanFiles += 1
      stats.orphanBytes += item.bytes
    }
  }
  return stats
}

/** 清理音频缓存：orphan 只删没有归档的，all 全删（下载中的除外）。 */
export function clearAudioCache(ctx: CacheContext, scope: 'orphan' | 'all'): CacheClearResult {
  const result: CacheClearResult = { freedFiles: 0, freedBytes: 0 }
  for (const item of listAudioFiles(ctx.dir)) {
    if (scope === 'orphan' && ctx.tracked.has(item.eid)) continue
    if (ctx.isBusy(item.file)) continue
    try {
      fs.rmSync(item.file, { force: true })
      result.freedFiles += 1
      result.freedBytes += item.bytes
    } catch {
      // 被占用 / 权限不足：跳过，不打断整批
    }
  }
  return result
}
