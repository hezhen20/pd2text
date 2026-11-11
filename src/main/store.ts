import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS } from '../shared/types'
import type { EpisodeRecord, HistoryItem, Settings } from '../shared/types'

let root = ''

export function initStore(): void {
  root = path.join(app.getPath('userData'), 'data')
  fs.mkdirSync(path.join(root, 'records'), { recursive: true })
}

function file(name: string): string {
  return path.join(root, name)
}

function read<T>(name: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file(name), 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function write(name: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file(name)), { recursive: true })
  const tmp = `${file(name)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
  fs.renameSync(tmp, file(name))
}

/**
 * 敏感字段加密落盘。
 *
 * settings.json 里放的是 API Key，明文躺盘意味着任何能读到用户目录的程序
 * （备份工具、同步盘、别的本地应用）都能直接抄走。这里用 Electron 的
 * safeStorage：Windows 走 DPAPI、macOS 走 Keychain，密钥绑当前用户账号，
 * 拷走文件到别的机器也解不开。
 *
 * 兼容：老版本写下的是明文，读到不带前缀的值直接当明文用，
 * 下一次 setSettings 时自动升级成密文。
 */
const ENC_PREFIX = 'enc:v1:'
/** deepseekApiKey 是旧字段名，只用于读出旧数据，写回时已统一成 llmApiKey。 */
const SECRET_FIELDS = ['llmApiKey', 'cloudAsrApiKey', 'deepseekApiKey'] as const

type LegacySettings = Partial<Settings> & { deepseekApiKey?: string; deepseekModel?: string; deepseekBaseUrl?: string }

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function sealSecret(value: string): string {
  if (!value || !encryptionAvailable()) return value
  try {
    return ENC_PREFIX + safeStorage.encryptString(value).toString('base64')
  } catch {
    return value
  }
}

function openSecret(value: string): string {
  if (!value || !value.startsWith(ENC_PREFIX)) return value
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    // 换了机器 / 换了系统账号，密文解不开：当作没填，让用户重填，而不是崩掉。
    return ''
  }
}

/**
 * 读设置。顺带把 0.2 时代的 deepseek* 字段迁移到通用的 llm* 字段：
 * 那会儿只支持 DeepSeek，现在模型可配，字段名不该再绑在一家服务上。
 */
function openSettings(raw: LegacySettings): Settings {
  const bag = { ...DEFAULT_SETTINGS, ...(raw as Partial<Settings>) } as unknown as Record<string, unknown>
  for (const field of SECRET_FIELDS) {
    const value = bag[field]
    if (typeof value === 'string') bag[field] = openSecret(value)
  }
  // 旧字段迁移：只有新字段没值时才有意义，避免覆盖用户后来的选择。
  if (!raw.llmApiKey && typeof bag.deepseekApiKey === 'string' && bag.deepseekApiKey) {
    bag.llmApiKey = bag.deepseekApiKey
  }
  if (!raw.llmBaseUrl && raw.deepseekBaseUrl) bag.llmBaseUrl = raw.deepseekBaseUrl
  if (!raw.llmModel && raw.deepseekModel) bag.llmModel = raw.deepseekModel
  // 旧字段不再参与读写，留着只会在下次落盘时又写回去。
  delete bag.deepseekApiKey
  delete bag.deepseekModel
  delete bag.deepseekBaseUrl
  return bag as unknown as Settings
}

function sealSettings(settings: Settings): Settings {
  const next = { ...settings }
  const bag = next as Record<string, unknown>
  for (const field of SECRET_FIELDS) {
    const value = bag[field]
    if (typeof value === 'string') bag[field] = sealSecret(value)
  }
  return next
}

export function getSettings(): Settings {
  return openSettings(read<LegacySettings>('settings.json', {}))
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  // 空提示词会让模型丢掉输出结构，落盘时回落到默认值。
  if (!next.summaryPrompt.trim()) next.summaryPrompt = DEFAULT_SETTINGS.summaryPrompt
  if (!next.chunkPrompt.trim()) next.chunkPrompt = DEFAULT_SETTINGS.chunkPrompt
  write('settings.json', sealSettings(next))
  return next
}

export function listHistory(): HistoryItem[] {
  return read<HistoryItem[]>('index.json', [])
}

export function getRecord(eid: string): EpisodeRecord | null {
  return read<EpisodeRecord | null>(path.join('records', `${safeName(eid)}.json`), null)
}

export function saveRecord(record: EpisodeRecord): void {
  write(path.join('records', `${safeName(record.meta.eid)}.json`), record)
  const index = listHistory().filter((item) => item.eid !== record.meta.eid)
  index.unshift({
    eid: record.meta.eid,
    title: record.meta.title,
    podcast: record.meta.podcast,
    fetchedAt: record.fetchedAt,
    charCount: record.charCount,
    hasSummary: Boolean(record.summary)
  })
  write('index.json', index.slice(0, 200))
}

export function removeRecord(eid: string): void {
  try { fs.unlinkSync(file(path.join('records', `${safeName(eid)}.json`))) } catch { /* ignore */ }
  write('index.json', listHistory().filter((item) => item.eid !== eid))
}

/** 真正还有归档的 eid 列表（以 records 目录为准，index.json 只留最近 200 条）。 */
export function listRecordIds(): string[] {
  try {
    return fs
      .readdirSync(path.join(root, 'records'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
  } catch {
    return []
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '') || 'episode'
}

export function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'transcript'
}
