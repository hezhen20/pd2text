import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { EpisodeMeta, EpisodeRecord, ProgressEvent, TranscriptSegment } from '../../shared/types'
import { formatDuration } from '../../shared/types'
import { getRecord, saveRecord } from '../store'
import { DeskException } from './error'
import { fetchEpisodeMeta, parseEpisodeId } from './web'
import { transcribe, cancelAsr } from './asr'

export { parseEpisodeId } from './web'

// 进度出口：startedAt 由主流程统一补齐，各阶段只负责描述自己。
type ProgressSink = (event: Omit<ProgressEvent, 'startedAt'>) => void

function mbText(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// 主流程：贴链接 → 免登录取元数据 → 下载音频 → 语音转文字 → 归档。
// 不依赖账号。官方逐字稿接口已弃用（需 token 且发码被风控），
// 但 parseTranscriptBody / mergeShortSegments 仍保留，将来若有官方稿可复用。

function pickString(...values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim()
  return undefined
}

function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

// ---- 逐字稿解析（官方稿兜底，当前主链路不使用） ----

function toMs(value: unknown, keyHint = ''): number {
  if (value == null) return 0
  if (typeof value === 'string') {
    const clock = value.trim().match(/^(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)$/)
    if (clock) {
      const h = Number(clock[1] || 0)
      const m = Number(clock[2])
      const s = Number(clock[3].replace(',', '.'))
      return Math.round((h * 3600 + m * 60 + s) * 1000)
    }
  }
  const n = asNumber(value)
  if (n === undefined || n < 0) return 0
  if (/ms|millis|millisecond/i.test(keyHint)) return Math.round(n)
  return n > 10_000 ? Math.round(n) : Math.round(n * 1000)
}

function extractText(item: any): string {
  if (typeof item === 'string') return item.trim()
  if (Array.isArray(item)) {
    const candidate = [...item].reverse().find((v) => typeof v === 'string' && v.trim())
    return typeof candidate === 'string' ? candidate.trim() : ''
  }
  if (!item || typeof item !== 'object') return ''
  const direct = pickString(item.text, item.content, item.sentence, item.value, item.word, item.transcript, item.s)
  if (direct) return stripHtml(direct)
  if (Array.isArray(item.words)) {
    return item.words.map((w: any) => (typeof w === 'string' ? w : pickString(w?.text, w?.word, w?.content) || '')).join('').trim()
  }
  return ''
}

function collectItems(parsed: any): any[] {
  if (Array.isArray(parsed)) return parsed
  if (!parsed || typeof parsed !== 'object') return []
  for (const key of ['segments', 'data', 'transcript', 'transcripts', 'items', 'sentences', 'paragraphs', 'result', 'content', 'list', 'utterances', 'results']) {
    const value = parsed[key]
    if (Array.isArray(value)) return value
    if (value && typeof value === 'object') {
      const nested = collectItems(value)
      if (nested.length) return nested
    }
  }
  return []
}

function parseClockLines(text: string): TranscriptSegment[] | null {
  const lines = text.split(/\r?\n/)
  const out: TranscriptSegment[] = []
  let start = 0
  let end = 0
  let buffer: string[] = []
  let sawClock = false
  const flush = () => {
    const value = buffer.join(' ').trim()
    if (value) out.push({ index: out.length + 1, startMs: start, endMs: end || start + 3000, text: value })
    buffer = []
  }
  for (const raw of lines) {
    const line = raw.trim()
    const range = line.match(/^(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})/)
    if (range) {
      flush()
      start = toMs(range[1].replace(',', '.'))
      end = toMs(range[2].replace(',', '.'))
      sawClock = true
      continue
    }
    const single = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]?\s+(.+)$/)
    if (single) {
      flush()
      start = toMs(single[1].replace(',', '.'))
      end = 0
      buffer.push(single[2])
      sawClock = true
      continue
    }
    if (!line || /^\d+$/.test(line) || /^WEBVTT/.test(line)) { flush(); continue }
    buffer.push(line)
  }
  flush()
  return sawClock && out.length ? out : null
}

interface RawTime { start: number; end: number; startIsMs: boolean; endIsMs: boolean }

const START_KEYS = ['startTime', 'startMs', 'startTimeMs', 'start_time', 'start', 'beginTime', 'begin', 'from', 'offset', 'timestamp', 'time']
const END_KEYS = ['endTime', 'endMs', 'endTimeMs', 'end_time', 'end', 'stopTime', 'to']

function rawNumber(value: unknown, keyHint: string): { n: number; isMs: boolean } {
  if (value == null) return { n: 0, isMs: false }
  if (typeof value === 'string') {
    const clock = value.trim().match(/^(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)$/)
    if (clock) {
      const h = Number(clock[1] || 0)
      const m = Number(clock[2])
      const s = Number(clock[3].replace(',', '.'))
      return { n: Math.round((h * 3600 + m * 60 + s) * 1000), isMs: true }
    }
  }
  const n = asNumber(value)
  if (n === undefined || n < 0) return { n: 0, isMs: false }
  return { n, isMs: /ms|milli/i.test(keyHint) }
}

function firstRaw(item: Record<string, unknown>, keys: string[]): { n: number; isMs: boolean } {
  for (const key of keys) {
    if (item[key] !== undefined) {
      const value = rawNumber(item[key], key)
      if (value.n > 0 || value.isMs) return value
    }
  }
  return { n: 0, isMs: false }
}

function applyTimeline(segments: TranscriptSegment[], raws: RawTime[], durationSec?: number): TranscriptSegment[] {
  const flexible = raws.flatMap((r) => [r.startIsMs ? 0 : r.start, r.endIsMs ? 0 : r.end]).filter((n) => n > 0)
  let factor = 1000
  if (flexible.length) {
    const max = Math.max(...flexible)
    if (max > 10_000) factor = 1
    else if (durationSec && durationSec > 0) {
      const expected = durationSec * 1000
      const scoreSeconds = Math.abs(Math.log(Math.max(max * 1000, 1) / expected))
      const scoreMillis = Math.abs(Math.log(Math.max(max, 1) / expected))
      factor = scoreMillis < scoreSeconds ? 1 : 1000
    }
  }
  return segments.map((seg, i) => {
    const raw = raws[i]
    if (!raw) return seg
    return {
      ...seg,
      startMs: raw.startIsMs ? Math.round(raw.start) : Math.round(raw.start * factor),
      endMs: raw.endIsMs ? Math.round(raw.end) : Math.round(raw.end * factor)
    }
  })
}

export function parseTranscriptBody(body: string, durationSec?: number): TranscriptSegment[] {
  let segments: TranscriptSegment[] = []
  const raws: RawTime[] = []
  let alreadyTimed = false
  let parsed: any = null
  try { parsed = JSON.parse(body) } catch { /* 可能是纯文本字幕 */ }

  if (parsed) {
    if (typeof parsed === 'string') {
      segments = [{ index: 1, startMs: 0, endMs: 0, text: stripHtml(parsed) }]
      alreadyTimed = true
    } else {
      const items = collectItems(parsed)
      for (const item of items) {
        const text = extractText(item)
        if (!text) continue
        let start = { n: 0, isMs: false }
        let end = { n: 0, isMs: false }
        if (Array.isArray(item)) {
          start = rawNumber(item[0], 'start')
          end = rawNumber(item[1], 'end')
        } else if (item && typeof item === 'object') {
          start = firstRaw(item as Record<string, unknown>, START_KEYS)
          end = firstRaw(item as Record<string, unknown>, END_KEYS)
        }
        const speaker = item && typeof item === 'object'
          ? pickString(item.speaker, item.speakerName, item.role, item.who, item.name)
          : undefined
        segments.push({ index: segments.length + 1, startMs: 0, endMs: 0, text, speaker })
        raws.push({ start: start.n, end: end.n, startIsMs: start.isMs, endIsMs: end.isMs })
      }
      if (!segments.length) {
        const direct = pickString(parsed.text, parsed.content, parsed.transcript)
        if (direct) {
          segments = [{ index: 1, startMs: 0, endMs: 0, text: stripHtml(direct) }]
          alreadyTimed = true
        }
      }
    }
  }

  if (!segments.length) {
    const clock = parseClockLines(body)
    if (clock) segments = clock
    else {
      segments = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((text, i) => ({
        index: i + 1, startMs: 0, endMs: 0, text: stripHtml(text)
      }))
    }
    alreadyTimed = true
  }

  if (!alreadyTimed && raws.length) segments = applyTimeline(segments, raws, durationSec)
  return mergeShortSegments(segments)
}

function needsSpace(a: string, b: string): boolean {
  return /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b)
}

/** 把连续的短句并成可读段落（同说话人、间隔 < 2.5s、长度 < 110）。 */
export function mergeShortSegments(input: TranscriptSegment[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = []
  let buffer: TranscriptSegment | null = null
  for (const seg of input) {
    if (!buffer) { buffer = { ...seg }; continue }
    const gap = seg.startMs - buffer.endMs
    const sameSpeaker = (buffer.speaker || '') === (seg.speaker || '')
    const hasTime = buffer.startMs > 0 || seg.startMs > 0
    if (sameSpeaker && (!hasTime || (gap >= 0 && gap < 2500)) && buffer.text.length < 110) {
      buffer.text += (needsSpace(buffer.text, seg.text) ? ' ' : '') + seg.text
      buffer.endMs = Math.max(buffer.endMs, seg.endMs)
    } else {
      out.push(buffer)
      buffer = { ...seg }
    }
  }
  if (buffer) out.push(buffer)
  return out.map((s, i) => ({ ...s, index: i + 1 }))
}

// ---- 音频下载 ----

function audioDir(): string {
  return path.join(app.getPath('userData'), 'audio')
}

export function audioDirPath(): string {
  return audioDir()
}

// 正在写的文件：清理缓存时要跳过，否则会删掉下载一半的音频。
const activeAudio = new Set<string>()

export function isAudioBusy(file: string): boolean {
  return activeAudio.has(file)
}

function audioPathFor(eid: string): string {
  return path.join(audioDir(), `${eid}.m4a`)
}

const AUDIO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// 空闲超时（连续这么久没收到新数据才中断），而不是整个下载的总超时，
// 否则大文件在慢网下会被误杀，留下半截文件。
const IDLE_TIMEOUT_MS = 60_000

interface AudioProbe {
  total: number
  supportsRange: boolean
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // 忽略：只是提前断开连接
  }
}

/** 探测音频总长与 Range 支持。HEAD 被 CDN 拒绝时，用 `Range: bytes=0-0` 读 Content-Range。 */
async function probeAudio(url: string): Promise<AudioProbe> {
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': AUDIO_UA },
      signal: AbortSignal.timeout(20_000)
    })
    const total = Number(head.headers.get('content-length')) || 0
    const supportsRange = (head.headers.get('accept-ranges') || '').toLowerCase() === 'bytes'
    if (head.ok && total > 0) return { total, supportsRange }
  } catch {
    // 落到下面的 Range 探测
  }
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': AUDIO_UA, Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(20_000)
    })
    const contentRange = response.headers.get('content-range') // 形如 bytes 0-0/55760898
    const totalFromRange = contentRange?.match(/\/\s*(\d+)\s*$/)?.[1]
    if (response.status === 206 && totalFromRange) {
      await discardBody(response)
      return { total: Number(totalFromRange), supportsRange: true }
    }
    const total = Number(response.headers.get('content-length')) || 0
    const supportsRange = (response.headers.get('accept-ranges') || '').toLowerCase() === 'bytes'
    await discardBody(response)
    if (response.ok) return { total, supportsRange }
  } catch {
    // 探测失败：按“总长未知、不支持续传”处理，直接整段下载
  }
  return { total: 0, supportsRange: false }
}

async function downloadAudio(url: string, eid: string, emit: ProgressSink): Promise<string> {
  const dir = audioDir()
  fs.mkdirSync(dir, { recursive: true })
  const dest = audioPathFor(eid)
  activeAudio.add(dest)
  try {
    return await fetchAudioInto(url, dest, emit)
  } finally {
    activeAudio.delete(dest)
  }
}

async function fetchAudioInto(url: string, dest: string, emit: ProgressSink): Promise<string> {
  const { total, supportsRange } = await probeAudio(url)

  // 最多两轮：第一轮正常续传；若服务器判 416（断点越界）或续传后仍不完整，
  // 清掉本地残留再整段重下一次。
  for (let attempt = 0; attempt < 2; attempt++) {
    let existing = 0
    if (fs.existsSync(dest)) {
      existing = fs.statSync(dest).size
      if (total > 0 && existing === total) {
        // 上一次其实已经把字节收全了，只是没收尾（超时/退出），直接当完成。
        emit({ stage: 'download', label: '下载音频', percent: 100 })
        return dest
      }
      if (existing > 0 && (!supportsRange || (total > 0 && existing > total))) {
        // 残留文件不可续传（服务器不支持 Range，或本地比远端还大）
        fs.rmSync(dest, { force: true })
        existing = 0
      }
    }

    const headers: Record<string, string> = { 'User-Agent': AUDIO_UA }
    if (supportsRange && existing > 0) headers['Range'] = `bytes=${existing}-`

    const controller = new AbortController()
    let idleTimer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS)
    const bumpIdle = (): void => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS)
    }

    let downloaded = existing
    try {
      let response: Response
      try {
        response = await fetch(url, { headers, signal: controller.signal })
      } catch {
        throw new DeskException('NETWORK', '下载音频失败', '请检查网络后重试。')
      }

      if (response.status === 416) {
        // Range 起点 ≥ 服务器文件长度：本地残留和远端对不上，删掉重来。
        await discardBody(response)
        fs.rmSync(dest, { force: true })
        if (attempt === 0) continue
        throw new DeskException('CDN_ERROR', '音频服务器返回 HTTP 416', '本地缓存与服务器文件不一致，请重试。')
      }
      if (!response.ok && response.status !== 206) {
        await discardBody(response)
        throw new DeskException('CDN_ERROR', `音频服务器返回 HTTP ${response.status}`)
      }

      // 服务器忽略 Range 回了 200（整段），就只能从 0 覆盖写。
      const appending = existing > 0 && response.status === 206
      if (existing > 0 && !appending) downloaded = 0

      const fileStream = fs.createWriteStream(dest, { flags: appending ? 'a' : 'w' })
      const reader = response.body?.getReader()
      if (!reader) throw new DeskException('CDN_ERROR', '无法读取音频数据流')

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          bumpIdle()
          await new Promise<void>((resolve, reject) => {
            fileStream.write(value, (err) => (err ? reject(err) : resolve()))
          })
          downloaded += value.length
          if (total > 0) {
            emit({
              stage: 'download',
              label: '下载音频',
              percent: Math.min(100, Math.round((downloaded / total) * 100)),
              detail: `${mbText(downloaded)} / ${mbText(total)}`
            })
          }
        }
      } finally {
        await new Promise<void>((resolve) => fileStream.end(() => resolve()))
        reader.releaseLock()
      }

      if (total > 0 && downloaded < total) {
        // 连接提前断开：文件还在，下一轮会接着续传。
        if (attempt === 0) continue
        throw new DeskException('CDN_ERROR', '音频下载不完整', '可重试，已下载部分会续传。')
      }

      emit({ stage: 'download', label: '下载音频', percent: 100 })
      return dest
    } catch (error) {
      if (error instanceof DeskException) throw error
      if (controller.signal.aborted) {
        throw new DeskException('NETWORK', '下载音频超时', '网络较慢，可重试，已下载部分会续传。')
      }
      throw new DeskException('NETWORK', '下载音频失败', '请检查网络后重试。')
    } finally {
      clearTimeout(idleTimer)
    }
  }

  throw new DeskException('CDN_ERROR', '音频下载失败', '请重试。')
}

// ---- 主流程 ----

export function cancelFetch(): void {
  cancelAsr()
}

export async function fetchEpisode(
  input: string,
  emit: (event: ProgressEvent) => void
): Promise<EpisodeRecord> {
  const startedAt = Date.now()
  const send: ProgressSink = (event) => emit({ ...event, startedAt })

  const eid = parseEpisodeId(input)
  if (!eid) {
    throw new DeskException('BAD_LINK', '没有认出小宇宙单集链接', '支持 https://www.xiaoyuzhoufm.com/episode/… 以及 App 分享的整段文案。')
  }
  send({ stage: 'parse', label: '识别单集', percent: 5, detail: eid })

  send({ stage: 'episode', label: '读取单集信息', percent: 15 })
  const meta: EpisodeMeta = await fetchEpisodeMeta(eid)
  const enclosureUrl = meta.enclosureUrl
  if (!enclosureUrl) {
    throw new DeskException('NO_MEDIA', '这一期没有公开音频', '可能是付费或私有内容，暂不支持。')
  }
  send({
    stage: 'episode',
    label: '读取单集信息',
    percent: 18,
    detail: [meta.podcast, formatDuration(meta.durationSec)].filter((v) => v && v !== '—').join(' · ') || undefined
  })

  send({ stage: 'download', label: '下载音频', percent: 20 })
  const audioPath = await downloadAudio(enclosureUrl, eid, send)

  send({ stage: 'transcript', label: '准备语音识别', percent: 45, detail: '把音频交给转写引擎' })
  const result = await transcribe(audioPath, (pct, label, detail) => {
    const measured = pct !== null
    send({
      stage: 'transcript',
      label,
      // 45% 之后全部留给语音识别：可测进度线性映射到 45–96%。
      percent: measured ? Math.min(96, 45 + Math.round(pct * 0.51)) : 45,
      detail,
      indeterminate: !measured
    })
  })

  let segments = result.segments
  if (!segments.length || segments.every((s) => !s.text.trim())) {
    throw new DeskException('EMPTY_TRANSCRIPT', '转写结果是空的', '可以换个转写引擎再试。')
  }
  segments = mergeShortSegments(segments)

  const plainText = segments.map((s) => s.text).join('\n')
  const previous = getRecord(eid)
  const record: EpisodeRecord = {
    meta,
    segments,
    plainText,
    charCount: plainText.replace(/\s/g, '').length,
    fetchedAt: new Date().toISOString(),
    ...(previous?.summary
      ? { summary: previous.summary, summaryGeneratedAt: previous.summaryGeneratedAt }
      : {})
  }
  send({ stage: 'render', label: '归档', percent: 97 })
  saveRecord(record)
  send({ stage: 'done', label: '完成', percent: 100, detail: `${segments.length} 段 · ${record.charCount} 字` })
  return record
}
