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
const SECRET_FIELDS = ['deepseekApiKey', 'cloudAsrApiKey'] as const

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

function openSettings(raw: Partial<Settings>): Settings {
  const merged: Settings = { ...DEFAULT_SETTINGS, ...raw }
  const next = { ...merged }
  for (const field of SECRET_FIELDS) next[field] = openSecret(String(merged[field] ?? ''))
  return next
}

function sealSettings(settings: Settings): Settings {
  const next = { ...settings }
  for (const field of SECRET_FIELDS) next[field] = sealSecret(settings[field])
  return next
}

export function getSettings(): Settings {
  return openSettings(read<Partial<Settings>>('settings.json', {}))
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
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
