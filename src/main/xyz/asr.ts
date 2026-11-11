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
// 本地这条路的进度由 Python 侧用 JSONL 主动上报（stdout 一行一条），分五段：
//   boot        启动解释器、import faster_whisper    → 不可测，界面走「进行中」
//   download    首次拉取模型（轮询 HF 缓存体积）      → 可测（MB）
//   load        加载模型权重                          → 不可测，但通常只要几秒
//   decode      把整段音频解码成 16k 单声道            → 不可测，长音频要等一会儿
//   transcribe  逐句识别（已识别时间戳 / 音频总长）    → 可测（真实进度）
// 进度回调的 pct 为 null 表示「这一阶段没有可测百分比」，由界面显示不确定态。
//
// 失败原因由 Python 侧以 {"_xy":"e","kind":...} 显式上报，Node 侧只按 kind 出提示。
// 不要再去 stderr 里搜关键字：traceback 的文件路径里就带着 faster_whisper，
// 那样任何报错都会被误判成「没装 faster-whisper」。

const WHISPER_PY = `import sys, json, os, time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

SR = 16000
# 每段 5 分钟。整段一次做 STFT 是长音频崩掉的主因：
# 1.5 小时的音频要一口气申请 1.7GB 以上的 float64 数组，直接 _ArrayMemoryError。
CHUNK_SEC = 300
# 切点前后各找 12 秒里最安静的位置下刀，尽量不从词中间劈开。
SEARCH_SEC = 12
# 末尾剩下的不足这么长，就并进上一段。
TAIL_SEC = 20


def send(phase, label, detail=None, percent=None):
    msg = {"_xy": "p", "phase": phase, "label": label}
    if detail is not None:
        msg["detail"] = detail
    if percent is not None:
        msg["percent"] = int(percent)
    print(json.dumps(msg, ensure_ascii=True), flush=True)


def fail(kind, phase, message):
    msg = {"_xy": "e", "kind": kind, "phase": phase, "message": str(message)[:800]}
    try:
        print(json.dumps(msg, ensure_ascii=True), flush=True)
    except Exception:
        pass
    sys.exit(1)


def clock(sec):
    sec = int(max(0, sec))
    return "%d:%02d" % (sec // 60, sec % 60)


def is_memory_error(exc):
    text = str(exc)
    return isinstance(exc, MemoryError) or "allocate" in text or "bad_alloc" in text


def plan_chunks(samples, np):
    total = len(samples)
    if total <= int(CHUNK_SEC * 1.4 * SR):
        return [(0, total)]
    hop = CHUNK_SEC * SR
    search = SEARCH_SEC * SR
    win = int(0.25 * SR)
    bounds = []
    start = 0
    while start + hop + TAIL_SEC * SR < total:
        target = start + hop
        lo = max(start + 60 * SR, target - search)
        hi = min(total, target + search)
        cut = target
        try:
            seg = samples[lo:hi]
            frames = len(seg) // win
            if frames > 0:
                block = seg[: frames * win].reshape(frames, win).astype("float32")
                energy = (block.astype("float64") ** 2).mean(axis=1)
                cut = lo + int(np.argmin(energy)) * win + win // 2
        except Exception:
            cut = target
        if cut <= start + 30 * SR:
            cut = target
        bounds.append((start, cut))
        start = cut
    bounds.append((start, total))
    return bounds


send("boot", "加载 faster-whisper", "首次启动较慢，之后会快一些")

try:
    import numpy as np
except Exception as exc:
    fail("module", "boot", "import numpy 失败：" + str(exc))

try:
    from faster_whisper import WhisperModel
except Exception as exc:
    fail("module", "boot", "import faster_whisper 失败：" + str(exc))

model_arg = sys.argv[1]
audio_path = sys.argv[2]

# 离线优先：如果本地 HuggingFace 缓存已有模型，用本地路径加载，避免联网（代理可能拦截）。
# HF_HOME 由应用注入，指向数据目录；老版本可能把模型下在 ~/.cache/huggingface。
repo = None
local_dir = None
if os.path.isdir(model_arg):
    local_dir = model_arg
else:
    repo = model_arg
    hf_home = os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface")
    org_repo = repo.replace("/", "--")
    for cache_root in [os.path.join(hf_home, "hub"), os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")]:
        if os.path.isdir(os.path.join(cache_root, "models--" + org_repo)):
            snapshots = os.path.join(cache_root, "models--" + org_repo, "snapshots")
            if os.path.isdir(snapshots):
                subs = sorted(os.listdir(snapshots))
                if subs:
                    local_dir = os.path.join(snapshots, subs[-1])
                    break

if local_dir:
    send("load", "加载本地模型", model_arg + " · 已缓存")
else:
    send("download", "首次下载模型", repo + " · 需要联网，模型较大")

t0 = time.time()
try:
    model = WhisperModel(local_dir if local_dir else repo, device="cpu", compute_type="int8")
except Exception as exc:
    fail("load", "load", "模型加载失败：" + str(exc))
send("load", "模型已就绪", "加载耗时 " + clock(time.time() - t0) + " 秒，开始解码音频")

# 先解码成 16k 单声道 float32：1.5 小时约 350MB，比整段 STFT 的几 GB 省得多。
# 老版本没有 audio.decode_audio，就退回「整段交给模型」的老路。
decode_audio = None
try:
    from faster_whisper.audio import decode_audio as _decode
    decode_audio = _decode
except Exception:
    decode_audio = None

samples = None
if decode_audio is not None:
    send("decode", "解码音频", "整段解码成 16k 单声道，长音频会等得久一点")
    try:
        samples = decode_audio(audio_path, sampling_rate=SR)
    except Exception as exc:
        fail("memory" if is_memory_error(exc) else "audio", "decode", "音频解码失败：" + str(exc))

jobs = []
if samples is None:
    # 老版本没有 decode_audio：整段交给模型，行为与从前一致
    jobs = [(None, 0.0)]
    total_sec = 0.0
    send("transcribe", "识别语音", "正在解码音频、检测人声，首句出现前会稍慢", 0)
else:
    total_sec = len(samples) / float(SR)
    bounds = plan_chunks(samples, np)
    # 只记下标，逐段切片：一次性把 20 段都复制出来等于把整段音频在内存里存了第二份
    for span in bounds:
        jobs.append((span, span[0] / float(SR)))
    note = "正在检测人声，首句出现前会稍慢"
    if len(bounds) > 1:
        note = "长音频分 " + str(len(bounds)) + " 段识别，正在检测人声"
    send("transcribe", "识别语音", note, 0)

out = []
language = None
can_verbose = True
last_pct = -1

for span, offset in jobs:
    piece = audio_path if span is None else samples[span[0]:span[1]]
    try:
        if can_verbose:
            try:
                segments, info = model.transcribe(piece, vad_filter=True, language=language, beam_size=5, verbose=False)
            except TypeError:
                # 新版 faster-whisper 去掉了 verbose 参数
                can_verbose = False
                segments, info = model.transcribe(piece, vad_filter=True, language=language, beam_size=5)
        else:
            segments, info = model.transcribe(piece, vad_filter=True, language=language, beam_size=5)
    except Exception as exc:
        fail("memory" if is_memory_error(exc) else "transcribe", "transcribe", str(exc))

    if language is None:
        language = getattr(info, "language", None)
    if total_sec <= 0:
        total_sec = float(getattr(info, "duration", 0) or 0)

    try:
        for s in segments:
            text = (s.text or "").strip()
            if text:
                out.append({"start": s.start + offset, "end": s.end + offset, "text": text})
            done = offset + float(s.end)
            if total_sec > 0:
                pct = int(min(99, done / total_sec * 100))
                detail = clock(done) + " / " + clock(total_sec) + " · 已识别 " + str(len(out)) + " 句"
            else:
                pct = min(99, len(out))
                detail = "已识别 " + str(len(out)) + " 句"
            if pct > last_pct:
                last_pct = pct
                send("transcribe", "识别语音", detail, pct)
    except Exception as exc:
        fail("memory" if is_memory_error(exc) else "transcribe", "transcribe", str(exc))

send("done", "识别完成", "共 " + str(len(out)) + " 句")

# 结果优先写文件（显式 utf-8）。Windows 下 stdout 的默认码页常是 GBK，
# 中文经管道传给 Node 会被按 UTF-8 解码成乱码；文件通道不受控制台编码影响。
payload = json.dumps({"segments": out, "language": language}, ensure_ascii=False)
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
  kind?: string
  message?: string
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
  // 模型权重跟着数据目录走：默认在用户数据目录下的 huggingface/hub，
  // 不再默认落到 C 盘的 ~/.cache（small 一个就 460MB 以上）。
  return path.join(hfHome(), 'hub')
}

function hfHome(): string {
  return path.join(app.getPath('userData'), 'huggingface')
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

/** 把本次失败的现场写进数据目录，界面只放一句人话，真正的原因留在盘上能查。 */
function writeRunLog(dir: string, lines: string[]): string {
  const file = path.join(dir, 'last-run.log')
  const body = [`[${new Date().toISOString()}]`, ...lines].join('\n')
  try {
    fs.writeFileSync(file, body, 'utf-8')
  } catch {
    // 日志写不进去不影响报错本身
  }
  return file
}

/** traceback 里最有用的一行：末尾那行异常结论。 */
function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return lines.length ? lines[lines.length - 1] : ''
}

/**
 * 把失败翻译成人话。
 *
 * 老写法只要 stderr 里出现 `faster_whisper` 就断定「缺少 faster-whisper」，
 * 而凡是 faster-whisper 内部抛出的异常，traceback 的文件路径里都带着这个词——
 * 于是内存不足、音频损坏、模型文件缺失统统被说成「没装 faster-whisper」，
 * 用户明明装好了也只会一头雾水。现在只认 Python 显式上报的 kind。
 */
function describeFailure(
  code: number | null,
  stderr: string,
  pyError: PyProgress | null,
  logPath: string,
  py: string
): DeskException {
  const kind = pyError?.kind || ''
  const detail = (pyError?.message || '').trim()
  const raw = detail || stderr
  const missingModule = /No module named ['"]?(faster_whisper|faster[-_]whisper)/i.test(raw)
  const outOfMemory = kind === 'memory'
    || /MemoryError|Unable to allocate|_ArrayMemoryError|bad_alloc|Out of memory/i.test(raw)

  if (missingModule) {
    return new DeskException('ASR_LOCAL_ERROR', '本地转写失败',
      `这个 Python 里没有 faster-whisper：${py}。给它装上（pip install faster-whisper），或者在设置里切到「云端」。`)
  }
  if (outOfMemory) {
    return new DeskException('ASR_LOCAL_ERROR', '这一期太长，内存不够用了',
      `本地识别需要把音频分段读进内存，这台机器当时腾不出空间。可以先关掉浏览器等占内存的程序再重试，或在设置里换「云端」转写。详细日志：${logPath}`)
  }
  if (kind === 'audio') {
    return new DeskException('ASR_LOCAL_ERROR', '音频解码失败',
      `${detail.slice(0, 200) || '本地缓存里的音频读不出来'}　可以重新转写这一期；若反复出现，说明下载下来的音频文件有问题。`)
  }
  if (kind === 'load') {
    return new DeskException('ASR_LOCAL_ERROR', '本地模型加载失败',
      `${detail.slice(0, 300)}　模型文件可能不完整，可以到设置里删掉后重新下载。`)
  }
  if (kind === 'transcribe') {
    return new DeskException('ASR_LOCAL_ERROR', '识别中断',
      `${detail.slice(0, 200) || '识别过程中被中断'}　详细日志：${logPath}`)
  }
  const tail = detail || lastLine(stderr) || (code === null ? '进程被中止' : `进程退出码 ${code}`)
  return new DeskException('ASR_LOCAL_ERROR', '本地转写失败', `${tail.slice(0, 300)}　详细日志：${logPath}`)
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
    // HF_HOME 让模型权重落在数据目录里（而不是 C 盘的 ~/.cache）。
    const child = spawn(py, args, {
      cwd: dir,
      shell: false,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        HF_HOME: hfHome()
      }
    })
    activeProcess = child

    const rawOut: Buffer[] = []
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    let buffer = ''
    let stderr = ''
    let finalLine = ''
    let pyError: PyProgress | null = null
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
      // 进入 load / decode / transcribe 后下载监控就没事了
      if (phase === 'load' || phase === 'boot' || phase === 'decode') stopWatch()
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
            const parsed = JSON.parse(line) as PyProgress
            // 结构化报错：Python 侧显式说明失败在哪一步，界面照此出提示
            if (parsed._xy === 'e') pyError = parsed
            else applyPhase(parsed)
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
      if (found.length && !pyError) {
        const pct = Number(found[found.length - 1][1])
        if (Number.isFinite(pct) && pct <= 100) {
          onProgress(MODEL_SPAN + Math.round(pct * ((100 - MODEL_SPAN) / 100)), '识别语音')
        }
      }
    })

    child.on('error', () => {
      cleanup()
      fs.rmSync(resultPath, { force: true })
      const logPath = writeRunLog(dir, [`解释器：${py}`, 'spawn 失败：进程没能起来'])
      reject(new DeskException('ASR_LOCAL_ERROR', '找不到本地 Python 环境',
        `试过 ${py}，没能启动。本地转写需要 Python 3 与 faster-whisper；也可以在设置里切到「云端」。详细日志：${logPath}`))
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
        const logPath = writeRunLog(dir, [
          `解释器：${py}`,
          `模型：${modelName(model)}`,
          `音频：${audioPath}`,
          `退出码：${code}`,
          pyError ? `kind：${pyError.kind || '-'}　phase：${pyError.phase || '-'}` : 'kind：-',
          pyError?.message ? `message：${pyError.message}` : '',
          '--- stderr ---',
          stderr.slice(-6000)
        ].filter(Boolean))
        reject(describeFailure(code, stderr, pyError, logPath, py))
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
