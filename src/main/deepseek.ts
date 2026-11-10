import { formatStamp } from '../shared/types'
import type { EpisodeRecord, SummaryEvent } from '../shared/types'
import { getRecord, getSettings, saveRecord } from './store'
import { DeskException } from './xyz/error'

let activeController: AbortController | null = null

export function cancelSummary(): void {
  activeController?.abort()
  activeController = null
}

const EDITOR_PROMPT = `你是一位中文播客的文字编辑，正在把逐字稿整理成一份可以存档的编读摘要。

写作准则：
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

const CHUNK_PROMPT = `你在为一档中文播客做逐字稿分块整理。下面是文稿的一个片段。
请提取这一段的 4–6 条要点，每条以「- 」开头，保留原文里的人名、数字、专有名词和关键原话，带上时间点。
不要开场白，不要总结感想，只输出要点列表。`

interface Message { role: 'system' | 'user'; content: string }

function endpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '') || 'https://api.deepseek.com'
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
}

async function chat(
  messages: Message[],
  options: { stream?: boolean; onDelta?: (text: string) => void } = {}
): Promise<string> {
  const settings = getSettings()
  const key = settings.deepseekApiKey.trim()
  if (!key) {
    throw new DeskException('NO_API_KEY', '还没有填 DeepSeek API Key', '在设置 → DeepSeek 里填入 key 后再提炼。')
  }
  const controller = new AbortController()
  activeController = controller
  let response: Response
  try {
    response = await fetch(endpoint(settings.deepseekBaseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: settings.deepseekModel || 'deepseek-flash',
        messages,
        stream: Boolean(options.stream),
        temperature: 0.3
      }),
      signal: controller.signal
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw new DeskException('CANCELLED', '已停止')
    throw new DeskException('NETWORK', '连接 DeepSeek 失败', '请检查网络或 API 地址。')
  }
  if (!response.ok) {
    const text = await response.text()
    const hint = response.status === 401
      ? 'API Key 无效或已过期。'
      : response.status === 429
        ? '请求太频繁或余额不足。'
        : text.slice(0, 200)
    throw new DeskException('LLM_ERROR', `DeepSeek 返回 HTTP ${response.status}`, hint)
  }

  if (!options.stream) {
    const json = await response.json() as any
    if (activeController === controller) activeController = null
    const content = json?.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new DeskException('LLM_ERROR', 'DeepSeek 没有返回内容')
    return content.trim()
  }

  const reader = response.body?.getReader()
  if (!reader) throw new DeskException('LLM_ERROR', '无法读取 DeepSeek 的流式响应')
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let json: any
        try { json = JSON.parse(payload) } catch { continue }
        const delta: string = json?.choices?.[0]?.delta?.content ?? ''
        if (delta) {
          full += delta
          options.onDelta?.(delta)
        }
      }
    }
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw new DeskException('CANCELLED', '已停止')
    throw new DeskException('LLM_ERROR', '读取摘要时中断', String(error))
  } finally {
    activeController = null
  }
  return full.trim()
}

function chunkRecord(record: EpisodeRecord): string[] {
  const hasTime = record.segments.some((s) => s.startMs > 0 || s.endMs > 0)
  const lines = record.segments.map((s) => {
    const stamp = hasTime ? `[${formatStamp(s.startMs)}] ` : ''
    const speaker = s.speaker ? `${s.speaker}：` : ''
    return `${stamp}${speaker}${s.text}`
  })
  const chunks: string[] = []
  let buffer = ''
  for (const line of lines) {
    if (buffer.length + line.length > 5200 && buffer) {
      chunks.push(buffer)
      buffer = ''
    }
    buffer += `${line}\n`
  }
  if (buffer.trim()) chunks.push(buffer)
  return chunks
}

export async function generateSummary(eid: string, emit: (event: SummaryEvent) => void): Promise<EpisodeRecord> {
  const record = getRecord(eid)
  if (!record) throw new DeskException('NOT_FOUND', '找不到这份文稿')
  const chunks = chunkRecord(record)
  let material = ''

  if (chunks.length === 1) {
    emit({ type: 'stage', text: '通读全文' })
    material = chunks[0]
  } else {
    const notes: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      emit({ type: 'stage', text: `分段整理 ${i + 1} / ${chunks.length}` })
      const part = await chat([
        { role: 'system', content: CHUNK_PROMPT },
        { role: 'user', content: `节目：《${record.meta.title}》\n\n${chunks[i]}` }
      ])
      notes.push(`【第 ${i + 1} 段】\n${part}`)
    }
    material = notes.join('\n\n')
  }

  emit({ type: 'stage', text: '落笔成稿' })
  const summary = await chat(
    [
      { role: 'system', content: EDITOR_PROMPT },
      {
        role: 'user',
        content: `节目：${record.meta.title}\n来源：${record.meta.podcast}\n时长：${record.meta.durationSec ?? '未知'} 秒\n\n${material}`
      }
    ],
    { stream: true, onDelta: (text) => emit({ type: 'delta', text }) }
  )
  if (!summary) throw new DeskException('LLM_ERROR', 'DeepSeek 返回了空摘要')

  const next: EpisodeRecord = { ...record, summary, summaryGeneratedAt: new Date().toISOString() }
  saveRecord(next)
  emit({ type: 'done', text: summary, record: next })
  return next
}
