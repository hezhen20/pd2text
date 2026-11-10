import { spawn, execFileSync } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { getSettings } from '../store'
import { DeskException } from './error'
import type { TranscriptSegment } from '../../shared/types'

// 语音转文字。两条路径：
//   本地  —— faster-whisper CLI（首次用前需 python + pip install faster-whisper）
//   云端  —— SiliconFlow 的 SenseVoiceSmall（OpenAI 兼容 /audio/transcriptions）
// 两者都产出带时间戳的分段，供渲染与 SRT 导出使用。
//
// 本地这条路的进度由 Python 侧用 JSONL 主动上报（stdout 一行一条），分四段：
//   boot        启动解释器、import faster_whisper    → 不可测，界面走「进行中」
//   download    首次拉取模型（轮询 HF 缓存体积）      → 可测（MB）
//   load        加载模型权重                          → 不可测，但通常只要几秒
//   transcribe  逐句识别（已识别时间戳 / 音频总长）    → 可测（真实进度）
// 进度回调的 pct 为 null 表示「这一阶段没有可测百分比」，由界面显示不确定态。

const WHISPER_PY = `import sys, json, os, time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def send(phase, label, detail=None, percent=None):
    msg = {"_xy": "p", "phase": phase, "label": label}
    if detail is not None:
        msg["detail"] = detail
    if percent is not None:
        msg["percent"] = int(percent)
    print(json.dumps(msg, ensure_ascii=True), flush=True)


def clock(sec):
    sec = int(max(0, sec))
    return "%d:%02d" % (sec // 60, sec % 60)


send("boot", "加载 faster-whisper", "首次启动较慢，之后会快一些")

from faster_whisper import WhisperModel

model_arg = sys.argv[1]
audio = sys.argv[2]

# 离线优先：如果本地 HuggingFace 缓存已有模型，用本地路径加载，避免联网（代理可能拦截）。
repo = None
local_dir = None
if os.path.isdir(model_arg):
    local_dir = model_arg
else:
    repo = model_arg
    cache_root = os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")
    org_repo = repo.replace("/", "--")
    if os.path.isdir(os.path.join(cache_root, "models--" + org_repo)):
        snapshots = os.path.join(cache_root, "models--" + org_repo, "snapshots")
        if os.path.isdir(snapshots):
            subs = sorted(os.listdir(snapshots))
            if subs:
                local_dir = os.path.join(snapshots, subs[-1])

if local_dir:
    send("load", "加载本地模型", model_arg + " · 已缓存")
else:
    send("download", "首次下载模型", repo + " · 需要联网，模型较大")

t0 = time.time()
model = WhisperModel(local_dir if local_dir else repo, device="cpu", compute_type="int8")
send("load", "模型已就绪", "加载耗时 " + clock(time.time() - t0) + " 秒，开始解码音频")

send("transcribe", "识别语音", "正在解码音频、检测人声，首句出现前会稍慢", 0)
try:
    segments, info = model.transcribe(audio, vad_filter=True, language=None, beam_size=5, verbose=False)
except TypeError:
    # 旧版本 faster-whisper 没有 verbose 参数
    segments, info = model.transcribe(audio, vad_filter=True, language=None, beam_size=5)

duration = float(getattr(info, "duration", 0) or 0)
out = []
last = -1
for s in segments:
    out.append({"start": s.start, "end": s.end, "text": s.text.strip()})
    if duration > 0:
        pct = int(min(99, s.end / duration * 100))
        detail = clock(s.end) + " / " + clock(duration) + " · 已识别 " + str(len(out)) + " 句"
    else:
        pct = min(99, len(out))
        detail = "已识别 " + str(len(out)) + " 句"
    if pct > last:
        last = pct
        send("transcribe", "识别语音", detail, pct)

send("done", "识别完成", "共 " + str(len(out)) + " 句")

# 结果优先写文件（显式 utf-8）。Windows 下 stdout 的默认码页常是 GBK，
# 中文经管道传给 Node 会被按 UTF-8 解码成乱码；文件通道不受控制台编码影响。
payload = json.dumps({"segments": out, "language": info.language}, ensure_ascii=False)
result_path = sys.argv[3] if len(sys.argv) > 3 else ""
if result_path:
    with open(result_path, "w", encoding="utf-8") as f:
        f.write(payload)
try:
    print(payload)
except Exception:
    pass
`

// 进度回调：pct 为 null 表示该阶段耗时不可测（界面显示不确定态）。
export type AsrProbe = (pct: number | null, label: string, detail?: string) => void

interface PyProgress {
  _xy?: string
  phase?: string
  label?: string
  detail?: string
  percent?: number
}

// 模型下载 / 加载整体占 0–15%，识别占 15–100%。
const MODEL_SPAN = 15

let activeProcess: import('node:child_process').ChildProcess | null = null

function cancelActive(): void {
  activeProcess?.kill()
  activeProcess = null
}

export function cancelAsr(): void {
  cancelActive()
}

function maxTranscribeSeconds(): number {
  // 过长的单集（>3 小时）先截断，避免耗时失控。3 小时 = 10800 秒。
  return 3 * 3600
}

// ---- 本地 faster-whisper ----

function modelDir(): string {
  return path.join(app.getPath('userData'), 'whisper')
}

function modelName(model: string): string {
  // faster-whisper 用 HF 命名，tiny/base/small/medium 对应 SysML/* 变体。
  const map: Record<string, string> = {
    tiny: 'Systran/faster-whisper-tiny',
    base: 'Systran/faster-whisper-base',
    small: 'Systran/faster-whisper-small',
    medium: 'Systran/faster-whisper-medium'
  }
  return map[model] || map.small
}

// 各模型的 CTranslate2 权重体积（MB），用于首次下载时估算百分比。
const MODEL_SIZE_MB: Record<string, number> = { tiny: 75, base: 145, small: 490, medium: 1530 }

function hfCacheRoot(): string {
  return path.join(os.homedir(), '.cache', 'huggingface', 'hub')
}

function hfModelRoot(model: string): string {
  return path.join(hfCacheRoot(), `models--${modelName(model).replace('/', '--')}`)
}

/** 已在本地缓存则返回快照目录，否则 null（说明首跑要联网下载）。 */
function cachedSnapshot(model: string): string | null {
  const snapshots = path.join(hfModelRoot(model), 'snapshots')
  try {
    const subs = fs.readdirSync(snapshots).filter((name) => !name.startsWith('.'))
    if (!subs.length) return null
    const latest = path.join(snapshots, subs[subs.length - 1])
    return fs.statSync(latest).isDirectory() ? latest : null
  } catch {
    return null
  }
}

function dirSizeBytes(dir: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += dirSizeBytes(full)
      else if (entry.isFile()) total += fs.statSync(full).size
    } catch {
      // 下载中的半截文件可能刚好被替换，忽略
    }
  }
  return total
}

function ensurePythonScript(scriptPath: string): void {
  // 内容变化时重写，确保脚本与代码同步（旧版本可能不感知本地缓存）。
  const current = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf-8') : ''
  if (current !== WHISPER_PY) fs.writeFileSync(scriptPath, WHISPER_PY, 'utf-8')
}

// 探测一个已装好 faster-whisper 的 Python 解释器。
// 系统 PATH 里的 `python` 可能是某个隔离环境（未装 faster-whisper），
// 因此按候选列表依次验证，优先返回真正能 import faster_whisper 的那个。
function candidatePythons(): string[] {
  const list: string[] = []
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local')
    const ver = ['Python313', 'Python312', 'Python311', 'Python310']
    for (const v of ver) {
      list.push(path.join(localAppData, 'Programs', 'Python', v, 'python.exe'))
    }
    // 常见系统级安装
    list.push('C:\\Python313\\python.exe', 'C:\\Python312\\python.exe')
    list.push('py')
    list.push('python')
  } else {
    list.push('python3', 'python')
  }
  return list
}

function hasFasterWhisper(py: string): boolean {
  try {
    execFileSync(py, ['-c', 'import faster_whisper'], { timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

let resolvedPython: string | null = null

function resolvePython(): string {
  if (resolvedPython) return resolvedPython
  for (const py of candidatePythons()) {
    if (hasFasterWhisper(py)) {
      resolvedPython = py
      return py
    }
  }
  // 没找到已装好的环境，退回 PATH 里的 python，运行时给出明确报错。
  return process.platform === 'win32' ? 'python' : 'python3'
}

/** 读 Python 写下的结果文件（显式 utf-8），读完即删。 */
function readWhisperResult(file: string): string | null {
  try {
    const text = fs.readFileSync(file, 'utf-8')
    return text.trim() ? text : null
  } catch {
    return null
  } finally {
    fs.rmSync(file, { force: true })
  }
}

/** stdout 全量解码：优先严格 UTF-8，失败再按 GB18030（中文 Windows 默认码页）兜底。 */
function decodeStdout(raw: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(raw)
    } catch {
      return raw.toString('utf-8')
    }
  }
}

/** 没有结果文件时的退路：从整段 stdout 里找最后一行 payload。 */
function finalPayloadLine(raw: Buffer, cached: string): string {
  const lines = decodeStdout(raw).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{') && lines[i].includes('"segments"')) return lines[i]
  }
  return cached
}

/** 乱码率：U+FFFD 占比。用于在上游编码仍出错时拦下脏数据，而不是存进记录里。 */
function garbleRatio(text: string): number {
  if (!text) return 0
  let bad = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0xfffd) bad++
  return bad / text.length
}

async function runWhisper(model: string, audioPath: string, onProgress: AsrProbe): Promise<TranscriptSegment[]> {
  const dir = modelDir()
  fs.mkdirSync(dir, { recursive: true })
  const scriptPath = path.join(dir, 'transcribe.py')
  ensurePythonScript(scriptPath)

  onProgress(null, '检查 Python 环境', '寻找已装好 faster-whisper 的解释器')
  const py = resolvePython()

  // 首跑要先从 HuggingFace 拉模型：轮询缓存目录体积，把「下载中」变成可见的 MB 进度。
  const totalMb = MODEL_SIZE_MB[model] ?? 0
  const needsDownload = !cachedSnapshot(model)

  return new Promise((resolve, reject) => {
    // 结果文件：Python 侧显式 utf-8 写盘，绕开控制台码页（中文 Windows 管道默认 GBK）。
    const resultPath = path.join(dir, `result-${Date.now()}.json`)
    const args = [scriptPath, modelName(model), audioPath, resultPath]
    // PYTHONUTF8 / PYTHONIOENCODING 双保险：即使脚本里的 reconfigure 没生效，
    // 解释器也不会退回 GBK 码页去写中文。
    const child = spawn(py, args, {
      cwd: dir,
      shell: false,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    })
    activeProcess = child

    const rawOut: Buffer[] = []
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    let buffer = ''
    let stderr = ''
    let finalLine = ''
    let stopped = false
    let watchTimer: ReturnType<typeof setInterval> | null = null

    const stopWatch = (): void => {
      if (watchTimer) clearInterval(watchTimer)
      watchTimer = null
    }

    const cleanup = (): void => {
      stopped = true
      stopWatch()
      if (activeProcess === child) activeProcess = null
    }

    const applyPhase = (msg: PyProgress): void => {
      const phase = msg.phase || ''
      const label = msg.label || '处理中'
      if (phase === 'transcribe') {
        const pct = typeof msg.percent === 'number' ? msg.percent : 0
        onProgress(MODEL_SPAN + Math.round(pct * ((100 - MODEL_SPAN) / 100)), label, msg.detail)
        return
      }
      if (phase === 'done') {
        onProgress(100, label, msg.detail)
        return
      }
      // 进入 load / transcribe 后下载监控就没事了
      if (phase === 'load' || phase === 'boot') stopWatch()
      onProgress(null, label, msg.detail)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      rawOut.push(chunk)
      buffer += outDecoder.write(chunk)
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.startsWith('{"_xy"')) {
          try {
            applyPhase(JSON.parse(line) as PyProgress)
          } catch {
            // 半行 / 损坏行，忽略
          }
        } else if (line) {
          finalLine = line
        }
        index = buffer.indexOf('\n')
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = errDecoder.write(chunk)
      stderr += text
      // 兜底：某些 faster-whisper 版本仍往 stderr 打 tqdm 进度条。
      // 只在「本次新到的内容」里取最后一处百分比——旧写法在累计串上取第一处，
      // 一旦出现过一次数字，后面每次都会命中同一个值，进度条会永久冻住。
      const found = [...text.matchAll(/(\d{1,3})%/g)]
      if (found.length) {
        const pct = Number(found[found.length - 1][1])
        if (Number.isFinite(pct) && pct <= 100) {
          onProgress(MODEL_SPAN + Math.round(pct * ((100 - MODEL_SPAN) / 100)), '识别语音')
        }
      }
    })

    child.on('error', () => {
      cleanup()
      fs.rmSync(resultPath, { force: true })
      reject(new DeskException('ASR_LOCAL_ERROR', '找不到本地 Python 环境',
        '本地转写需要 Python 3 与 faster-whisper。可在设置里切换到「云端」，或安装 Python 后运行 pip install faster-whisper。'))
    })

    child.on('close', (code) => {
      const wasStopped = stopped
      cleanup()
      if (wasStopped) {
        fs.rmSync(resultPath, { force: true })
        return
      }
      if (code !== 0) {
        fs.rmSync(resultPath, { force: true })
        const hint = stderr.includes('faster_whisper') || stderr.includes('ModuleNotFoundError')
          ? '缺少 faster-whisper，请先运行 pip install faster-whisper。'
          : stderr.slice(-400) || `进程退出码 ${code}`
        reject(new DeskException('ASR_LOCAL_ERROR', '本地转写失败', hint))
        return
      }
      const payload = readWhisperResult(resultPath) ?? finalPayloadLine(Buffer.concat(rawOut), finalLine)
      try {
        const parsed = JSON.parse(payload.trim())
        const raw: { start: number; end: number; text: string }[] = parsed?.segments ?? []
        const segments = raw
          .map((s, i) => ({
            index: i + 1,
            startMs: Math.round(s.start * 1000),
            endMs: Math.round(s.end * 1000),
            text: s.text
          }))
          .filter((s) => s.text.trim())
        const garble = garbleRatio(segments.map((s) => s.text).join(''))
        if (garble > 0.01) {
          reject(new DeskException('ASR_ENCODING', '转写文字出现乱码',
            '识别结果里有大量无法解码的字符（编码错乱）。请重新转写这一期；若反复出现，把这条提示反馈给开发者。'))
          return
        }
        resolve(segments)
      } catch {
        reject(new DeskException('ASR_LOCAL_ERROR', '本地转写输出无法解析', payload.slice(-400)))
      }
    })

    if (needsDownload) {
      let lastMb = -1
      onProgress(totalMb > 0 ? 0 : null, '首次下载模型',
        totalMb > 0 ? `${modelName(model)} · 约 ${totalMb} MB，需要联网` : `${modelName(model)} · 需要联网`)
      watchTimer = setInterval(() => {
        const mb = Math.round(dirSizeBytes(hfModelRoot(model)) / (1024 * 1024))
        if (mb === lastMb) return
        lastMb = mb
        const pct = totalMb > 0 ? Math.min(MODEL_SPAN - 3, Math.round((mb / totalMb) * (MODEL_SPAN - 3))) : null
        onProgress(pct, '首次下载模型',
          totalMb > 0 ? `已下载 ${mb} / 约 ${totalMb} MB` : `已下载 ${mb} MB`)
      }, 800)
    } else {
      onProgress(null, '加载本地模型',
        `${modelName(model).split('/').pop()} · 已缓存，直接载入`)
    }
  })
}

// ---- 云端 SenseVoiceSmall ----

async function runCloud(audioPath: string, onProgress: AsrProbe): Promise<TranscriptSegment[]> {
  const settings = getSettings()
  const key = settings.cloudAsrApiKey.trim()
  if (!key) {
    throw new DeskException('NO_ASR_KEY', '还没有填云端 ASR 的 API Key',
      '在设置 → 语音转文字里填入 SiliconFlow API Key，或切换回「本地」。')
  }
  const base = settings.cloudAsrBaseUrl.trim().replace(/\/+$/, '') || 'https://api.siliconflow.cn/v1'
  const model = settings.cloudAsrModel.trim() || 'FunAudioLLM/SenseVoiceSmall'

  const audio = fs.readFileSync(audioPath)
  const mb = (audio.length / (1024 * 1024)).toFixed(1)
  onProgress(10, '上传音频', `${mb} MB · 交给 ${model.split('/').pop()}`)

  const boundary = `----xyt${Date.now().toString(16)}`
  const header = Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="audio.m4a"\r\n' +
    'Content-Type: audio/mp4\r\n\r\n'
  )
  const footer = Buffer.from(
    `\r\n--${boundary}\r\n` +
    'Content-Disposition: form-data; name="model"\r\n\r\n' +
    `${model}\r\n` +
    `--${boundary}--\r\n`
  )
  const body = Buffer.concat([header, audio, footer])

  onProgress(35, '云端识别中', '音频已提交，等待返回整篇文本')
  let response: Response
  try {
    response = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body,
      signal: AbortSignal.timeout(120_000)
    })
  } catch (error) {
    throw new DeskException('ASR_CLOUD_ERROR', '调用云端 ASR 失败', '请检查网络或 API 地址。')
  }
  if (!response.ok) {
    const text = await response.text()
    const hint = response.status === 401
      ? 'API Key 无效或已过期。'
      : response.status === 429
        ? '请求太频繁或余额不足。'
        : text.slice(0, 200)
    throw new DeskException('ASR_CLOUD_ERROR', `云端 ASR 返回 HTTP ${response.status}`, hint)
  }
  onProgress(95, '解析返回结果', '整理文本')
  const json = await response.json() as any
  const text: string = typeof json?.text === 'string' ? json.text : ''
  if (!text.trim()) {
    throw new DeskException('ASR_CLOUD_ERROR', '云端没有返回转写文本', JSON.stringify(json).slice(0, 300))
  }
  // SenseVoiceSmall 返回纯文本（无时间戳）。这里按整段归档，后续可由 AI 校对分段。
  return [{
    index: 1,
    startMs: 0,
    endMs: 0,
    text: text.trim()
  }]
}

// ---- 统一入口 ----

export interface AsrResult {
  segments: TranscriptSegment[]
  engine: 'local' | 'cloud'
}

export async function transcribe(audioPath: string, onProgress: AsrProbe): Promise<AsrResult> {
  const settings = getSettings()
  if (settings.asrEngine === 'cloud') {
    const segments = await runCloud(audioPath, onProgress)
    return { segments, engine: 'cloud' }
  }

  const model = settings.localAsrModel || 'small'
  onProgress(null, '准备本地识别', `${model} 模型 · CPU int8`)
  const segments = await runWhisper(model, audioPath, onProgress)
  return { segments, engine: 'local' }
}
