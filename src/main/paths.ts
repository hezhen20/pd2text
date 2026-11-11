import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { StorageInfo, StorageItem } from '../shared/types'
import { DeskException } from './xyz/error'

// 数据目录：默认落在系统的用户数据目录（Windows 上是
// C:\Users\<name>\AppData\Roaming\tengsheng），音频、归档、本地语音模型都在里面，
// 一小时的单集音频就有几十 MB，模型有几百 MB，用的时间一长 C 盘肉眼可见地变少。
//
// 这里给用户一个可迁移的出口：
//   - 默认目录里放一个极小的指针文件 data-root.json，记住用户选的新位置；
//   - 启动时（app ready 之前）读它，把 userData 整个指过去，
//     Chromium 自己的缓存也就跟着搬走，不再往 C 盘写；
//   - whisper 模型缓存走 HF_HOME，同样落在数据目录下。
// 指针文件必须留在默认目录里，否则换了位置就再也找不到新位置在哪。

const POINTER_FILE = 'data-root.json'

let defaultRootCache = ''

/**
 * 系统默认位置。必须在 app.setPath('userData') 之前取，之后取就是新位置了，
 * 所以第一次调用时记下来。
 */
export function defaultRoot(): string {
  if (!defaultRootCache) defaultRootCache = app.getPath('userData')
  return defaultRootCache
}

/** 当前实际使用的数据目录（app.setPath 之后即新位置）。 */
export function dataRoot(): string {
  return app.getPath('userData')
}

function pointerPath(): string {
  return path.join(defaultRoot(), POINTER_FILE)
}

function readPointer(): string | null {
  try {
    const raw = fs.readFileSync(pointerPath(), 'utf-8')
    const parsed = JSON.parse(raw) as { root?: unknown }
    const root = typeof parsed.root === 'string' ? parsed.root.trim() : ''
    return root || null
  } catch {
    return null
  }
}

function writePointer(root: string): void {
  fs.mkdirSync(defaultRoot(), { recursive: true })
  fs.writeFileSync(pointerPath(), JSON.stringify({ root }, null, 2), 'utf-8')
}

/** 目录可写才算可用：防止用户把数据放到已拔掉的移动硬盘上，启动即崩。 */
function usable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, '.write-probe')
    fs.writeFileSync(probe, 'ok', 'utf-8')
    fs.rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 启动时调用（必须在 app.whenReady 之前）。
 * 自定义目录不可用（盘没插、权限变了）时静默回落到默认目录，不让应用起不来。
 */
export function applyDataRoot(): { root: string; custom: boolean } {
  const fallback = defaultRoot()
  const custom = readPointer()
  if (!custom) return { root: fallback, custom: false }
  if (path.resolve(custom) === path.resolve(fallback)) return { root: fallback, custom: false }
  if (!usable(custom)) {
    console.warn(`[paths] 自定义数据目录不可用，回落到默认位置：${custom}`)
    return { root: fallback, custom: false }
  }
  app.setPath('userData', custom)
  return { root: custom, custom: true }
}

function dirStats(dir: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return { bytes, files }
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        const nested = dirStats(full)
        bytes += nested.bytes
        files += nested.files
      } else if (entry.isFile()) {
        bytes += fs.statSync(full).size
        files += 1
      }
    } catch {
      // 正在被写入 / 已被删除，跳过
    }
  }
  return { bytes, files }
}

/** 老版本把 whisper 模型丢在 ~/.cache/huggingface，这里单独量一下体积。 */
function legacyModelDir(): string {
  return path.join(os.homedir(), '.cache', 'huggingface')
}

/** 只算 whisper 权重本身：缓存目录里可能还有别的工具留下的东西，不该算在头上。 */
function legacyModelBytes(): number {
  return legacyWhisperModels()
    .reduce((sum, name) => sum + dirStats(path.join(legacyModelDir(), 'hub', name)).bytes, 0)
}

export function storageInfo(): StorageInfo {
  const root = dataRoot()
  const items: StorageItem[] = [
    { key: 'data', label: '归档与文稿', ...dirStats(path.join(root, 'data')) },
    { key: 'audio', label: '音频缓存', ...dirStats(path.join(root, 'audio')) },
    { key: 'models', label: '本地语音模型', ...dirStats(path.join(root, 'whisper')) },
    { key: 'hf', label: '模型权重缓存', ...dirStats(path.join(root, 'huggingface')) }
  ]
  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0)
  const legacy = path.resolve(legacyModelDir()) === path.resolve(path.join(root, 'huggingface'))
    ? 0
    : legacyModelBytes()
  return {
    root,
    defaultRoot: defaultRoot(),
    custom: path.resolve(root) !== path.resolve(defaultRoot()),
    totalBytes,
    items,
    legacyModelBytes: legacy
  }
}

function copyDir(from: string, to: string): void {
  if (!fs.existsSync(from)) return
  fs.mkdirSync(to, { recursive: true })
  fs.cpSync(from, to, { recursive: true, force: true, errorOnExist: false })
}

/** 老位置已经下好的 whisper 模型目录名。别去动别的工具留在 HF 缓存里的模型。 */
function legacyWhisperModels(): string[] {
  try {
    return fs.readdirSync(path.join(legacyModelDir(), 'hub'))
      .filter((name) => /^models--Systran--faster-whisper-/i.test(name))
  } catch {
    return []
  }
}

/** 把老位置已经下好的 HF 模型搬过来，省得用户重新下几百 MB。 */
function importLegacyModels(targetHub: string): number {
  let copied = 0
  for (const name of legacyWhisperModels()) {
    try {
      copyDir(path.join(legacyModelDir(), 'hub', name), path.join(targetHub, name))
      copied += 1
    } catch {
      // 模型没搬完不影响主流程，缺了下次会重新下载
    }
  }
  return copied
}

/**
 * 复制成功后才删老位置的模型副本 —— 只删确认已经搬过去的那几个。
 * 不这么做的结果是「两边各占一份」，用户以为腾出了 C 盘，其实没有。
 */
function purgeLegacyModels(targetHub: string): number {
  let freed = 0
  for (const name of legacyWhisperModels()) {
    const dest = path.join(targetHub, name)
    if (!fs.existsSync(dest) || dirStats(dest).bytes <= 0) continue
    const src = path.join(legacyModelDir(), 'hub', name)
    const bytes = dirStats(src).bytes
    try {
      fs.rmSync(src, { recursive: true, force: true })
      freed += bytes
    } catch {
      // 被占用就留着，新位置已经能用了
    }
  }
  // 缓存根目录空了才一起删，里面还有别的东西就留着
  try {
    const hub = path.join(legacyModelDir(), 'hub')
    if (fs.readdirSync(hub).length === 0) fs.rmSync(legacyModelDir(), { recursive: true, force: true })
  } catch {
    // 忽略
  }
  return freed
}

/**
 * 搬完家后清掉旧位置里属于本应用的数据：整个 userData 都是我们的，
 * 只剩一个记录新位置的指针文件要留下（它得留在默认位置，否则下次找不到新位置）。
 * 被 Chromium 占住的文件删不掉就跳过，反正已经不再用了。
 */
function cleanupOldRoot(oldRoot: string): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(oldRoot, { withFileTypes: true })
  } catch {
    return
  }
  const isDefault = path.resolve(oldRoot) === path.resolve(defaultRoot())
  for (const entry of entries) {
    if (isDefault && entry.name === POINTER_FILE) continue
    try {
      fs.rmSync(path.join(oldRoot, entry.name), { recursive: true, force: true })
    } catch {
      // 占用中，忽略
    }
  }
}

/**
 * 换数据目录：复制数据 → 写指针 → 清旧位置。成功后调用方需要重启应用，
 * 因为 userData 只能在启动时改。
 */
export function relocateDataRoot(targetRaw: string, moveAudio = true): { root: string } {
  const current = dataRoot()
  const target = path.resolve(String(targetRaw || '').trim())
  if (!targetRaw || !target) {
    throw new DeskException('BAD_PATH', '没有选出目录', '请重新选择一个文件夹。')
  }
  if (target === path.resolve(current)) {
    throw new DeskException('SAME_PATH', '这就是当前的数据目录', '不用换了，选另一个文件夹即可。')
  }
  const rel = path.relative(current, target)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new DeskException('BAD_PATH', '不能把数据目录放到它自己里面', '请选择一个与当前目录无关的文件夹。')
  }
  if (!usable(target)) {
    throw new DeskException('NOT_WRITABLE', '这个目录写不进去', '可能是没有权限，或所在磁盘是只读的。换一个文件夹试试。')
  }
  if (fs.existsSync(path.join(target, 'data', 'index.json'))) {
    throw new DeskException('DIR_IN_USE', '这个目录里已经有一份誊声的数据', '为避免两份归档混在一起，请换一个空文件夹。')
  }

  try {
    copyDir(path.join(current, 'data'), path.join(target, 'data'))
    if (moveAudio) copyDir(path.join(current, 'audio'), path.join(target, 'audio'))
    copyDir(path.join(current, 'whisper'), path.join(target, 'whisper'))
    copyDir(path.join(current, 'huggingface'), path.join(target, 'huggingface'))
  } catch (error) {
    throw new DeskException('COPY_FAILED', '复制数据失败',
      `${error instanceof Error ? error.message : String(error)}　旧数据还在原处，可以重试或换一个目录。`)
  }
  // 本机已经下过的语音模型一并带过去，并把老缓存清掉（复制失败时清不动，也不会误删）
  const targetHub = path.join(target, 'huggingface', 'hub')
  importLegacyModels(targetHub)
  purgeLegacyModels(targetHub)

  writePointer(target)
  cleanupOldRoot(current)
  return { root: target }
}

/** 老位置的模型搬进当前数据目录（用户暂时不想换数据目录时也能腾 C 盘）。 */
export function adoptLegacyModels(): { moved: boolean; bytes: number } {
  const target = path.join(dataRoot(), 'huggingface', 'hub')
  if (path.resolve(legacyModelDir()) === path.resolve(path.join(dataRoot(), 'huggingface'))) {
    return { moved: false, bytes: 0 }
  }
  if (!legacyWhisperModels().length) return { moved: false, bytes: 0 }
  const copied = importLegacyModels(target)
  if (!copied) return { moved: false, bytes: 0 }
  const freed = purgeLegacyModels(target)
  return { moved: true, bytes: freed }
}
