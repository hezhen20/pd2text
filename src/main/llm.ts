import { DEFAULT_CHUNK_PROMPT, DEFAULT_SUMMARY_PROMPT, formatStamp } from '../shared/types'
import type { EpisodeRecord, LlmTestResult, Settings, SummaryEvent } from '../shared/types'
import { getRecord, getSettings, saveRecord } from './store'
import { DeskException } from './xyz/error'

// 摘要用的模型服务。默认指向 DeepSeek，但字段全是可配的：
// 模型名会变（官方现在叫 deepseek-flash，以后可能又换），也可能有人想用别家的
// OpenAI 兼容服务，所以不许把模型名写死在代码里。

let activeController: AbortController | null = null

export function cancelSummary(): void {
  activeController?.abort()
  activeController = null
}

export interface LlmConfig {
  apiKey: string
  baseUrl: string
  model: string
}

const FALLBACK_MODEL = 'deepseek-flash'

/** 从设置（或界面上的草稿）取一份模型配置。 */
export function resolveLlm(patch: Partial<Settings> = {}): LlmConfig {
  const settings = { ...getSettings(), ...patch }
  return {
    apiKey: settings.llmApiKey.trim(),
    baseUrl: settings.llmBaseUrl.trim() || 'https://api.deepseek.com',
    model: settings.llmModel.trim() || FALLBACK_MODEL
  }
}

function baseOf(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '') || 'https://api.deepseek.com'
  // 用户可能把完整的 chat/completions 地址粘进来，这里只保留 base。
  return base.replace(/\/chat\/completions$/, '')
}

function chatEndpoint(baseUrl: string): string {
  return `${baseOf(baseUrl)}/chat/completions`
}

function modelsEndpoint(baseUrl: string): string {
  return `${baseOf(baseUrl)}/models`
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseOf(baseUrl)).host
  } catch {
    return baseOf(baseUrl)
  }
}

/** 服务端的错误正文：优先取 OpenAI 兼容格式里的 error.message。 */
function serverMessage(body: string): string {
  const text = body.trim()
  if (!text) return ''
  try {
    const json = JSON.parse(text) as any
    const message = json?.error?.message ?? json?.message ?? json?.error
    if (typeof message === 'string' && message.trim()) return message.trim()
  } catch {
    // 不是 JSON，按纯文本截断
  }
  return text.replace(/\s+/g, ' ').slice(0, 240)
}

/** 这条错误是不是「模型名不对」。 */
function looksLikeModelError(status: number, message: string): boolean {
  if (![400, 404, 422].includes(status)) return false
  return /model/i.test(message) || /模型/.test(message)
}

/**
 * 把 HTTP 失败翻译成用户能照着改的提示。
 * 模型名写错是最容易发生的一种：服务端只会回一句 Model Not Exist，
 * 如果直接透传给用户，看起来很像「这个应用坏了」。
 */
function httpError(status: number, body: string, config: LlmConfig): DeskException {
  const detail = serverMessage(body)
  const model = config.model
  const host = hostOf(config.baseUrl)

  if (status === 401 || status === 403) {
    return new DeskException('AUTH_ERROR', 'API Key 无效或已过期',
      `服务端返回：${detail || `HTTP ${status}`}。请到 设置 → 模型 里重新填一次 Key（注意别带上多余空格）。`)
  }
  if (status === 402) {
    return new DeskException('NO_BALANCE', '账户余额不足', detail || '充值后再试。')
  }
  if (status === 429) {
    return new DeskException('RATE_LIMIT', '请求太频繁或已达额度上限',
      `${detail || ''} 稍等一会儿再试，或到服务商后台看看额度。`.trim())
  }
  if (looksLikeModelError(status, detail)) {
    return new DeskException('MODEL_INVALID', `模型「${model}」不可用`,
      `服务端返回：${detail || `HTTP ${status}`}。模型名可能写错了，或者这个账号没有该模型。` +
      `请到 设置 → 模型 里核对模型名（可点「测试连接」查看 ${host} 实际提供的模型）。`)
  }
  if (status === 404) {
    return new DeskException('BAD_ENDPOINT', `接口地址不对（HTTP 404）`,
      `请求打到了 ${host}/chat/completions，但没有这个接口。请到 设置 → 模型 里检查 API 地址，` +
      `一般形如 https://api.deepseek.com 或 https://xxx/v1。`)
  }
  return new DeskException('LLM_ERROR', `模型服务返回 HTTP ${status}`, detail || undefined)
}

async function request(url: string, init: RequestInit, config: LlmConfig): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw new DeskException('CANCELLED', '已停止')
    throw new DeskException('NETWORK', `连接 ${hostOf(config.baseUrl)} 失败`,
      `请检查网络、代理，或 设置 → 模型 里的 API 地址是否写对（当前是 ${config.baseUrl}）。`)
  }
}

interface Message { role: 'system' | 'user'; content: string }

async function chat(
  messages: Message[],
  options: { stream?: boolean; onDelta?: (text: string) => void; config?: LlmConfig } = {}
): Promise<string> {
  const config = options.config ?? resolveLlm()
  if (!config.apiKey) {
    throw new DeskException('NO_API_KEY', '还没有填模型的 API Key',
      '在 设置 → 模型 里填入 Key 后再提炼。只用文稿和导出功能的话，不填也没关系。')
  }
  const controller = new AbortController()
  activeController = controller
  const response = await request(chatEndpoint(config.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: Boolean(options.stream),
      temperature: 0.3
    }),
    signal: controller.signal
  }, config)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    if (activeController === controller) activeController = null
    throw httpError(response.status, text, config)
  }

  if (!options.stream) {
    const json = await response.json().catch(() => null) as any
    if (activeController === controller) activeController = null
    const content = json?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      const why = json?.error ? serverMessage(JSON.stringify(json)) : ''
      throw new DeskException('LLM_ERROR', '模型没有返回内容',
        why || '服务端响应格式和预期不一样，可能 API 地址指向了别的服务。')
    }
    return content.trim()
  }

  const reader = response.body?.getReader()
  if (!reader) throw new DeskException('LLM_ERROR', '无法读取模型的流式响应')
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
    if (activeController === controller) activeController = null
  }
  return full.trim()
}

/**
 * 测试连接：先看 /models 能不能列出模型，再用当前模型名发一次最小请求。
 * 这样「Key 错」「地址错」「模型名错」三种情况能分开说清楚。
 */
export async function testLlm(patch: Partial<Settings>): Promise<LlmTestResult> {
  const config = resolveLlm(patch)
  if (!config.apiKey) {
    return { ok: false, model: config.model, message: '还没有填 API Key', models: [] }
  }

  let models: string[] = []
  try {
    const response = await fetch(modelsEndpoint(config.baseUrl), {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(15_000)
    })
    if (response.ok) {
      const json = await response.json().catch(() => null) as any
      const list = Array.isArray(json?.data) ? json.data : []
      models = list.map((item: any) => String(item?.id ?? '')).filter(Boolean).slice(0, 60)
    }
  } catch {
    // /models 不一定每个服务都提供，失败不影响后面的真实请求
  }

  try {
    await chat(
      [{ role: 'user', content: '回复两个字：可用' }],
      { config }
    )
    const matched = !models.length || models.includes(config.model)
    return {
      ok: true,
      model: config.model,
      models,
      message: matched
        ? `连接正常，${config.model} 可用`
        : `连接正常，但返回的模型列表里没有「${config.model}」，请确认模型名`,
      ...(matched ? {} : { hint: `可用模型：${models.slice(0, 8).join('、')}${models.length > 8 ? ' …' : ''}` })
    }
  } catch (error) {
    return {
      ok: false,
      model: config.model,
      models,
      message: error instanceof DeskException ? error.message : '连接失败',
      hint: error instanceof DeskException ? error.hint : String(error)
    }
  }
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

  // 提示词跟着设置走：用户在 设置 → 摘要提示词 里改了就按改的来。
  const settings = getSettings()
  const summaryPrompt = settings.summaryPrompt.trim() || DEFAULT_SUMMARY_PROMPT
  const chunkPrompt = settings.chunkPrompt.trim() || DEFAULT_CHUNK_PROMPT
  const config = resolveLlm(settings)
  const chunks = chunkRecord(record)
  let material = ''

  if (chunks.length === 1) {
    emit({ type: 'stage', text: '通读全文' })
    material = chunks[0]
  } else {
    const notes: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      emit({ type: 'stage', text: `分段整理 ${i + 1} / ${chunks.length}` })
      const part = await chat(
        [
          { role: 'system', content: chunkPrompt },
          { role: 'user', content: `节目：《${record.meta.title}》\n\n${chunks[i]}` }
        ],
        { config }
      )
      notes.push(`【第 ${i + 1} 段】\n${part}`)
    }
    material = notes.join('\n\n')
  }

  emit({ type: 'stage', text: '落笔成稿' })
  const summary = await chat(
    [
      { role: 'system', content: summaryPrompt },
      {
        role: 'user',
        content: `节目：${record.meta.title}\n来源：${record.meta.podcast}\n时长：${record.meta.durationSec ?? '未知'} 秒\n\n${material}`
      }
    ],
    { stream: true, onDelta: (text) => emit({ type: 'delta', text }), config }
  )
  if (!summary) throw new DeskException('LLM_ERROR', '模型返回了空摘要', `当前模型：${config.model}`)

  const next: EpisodeRecord = { ...record, summary, summaryGeneratedAt: new Date().toISOString() }
  saveRecord(next)
  emit({ type: 'done', text: summary, record: next })
  return next
}
