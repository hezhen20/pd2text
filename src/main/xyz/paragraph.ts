import type { TranscriptSegment } from '../../shared/types'

// 云端模型（SenseVoiceSmall 这类）只回一整块纯文本，没有分段也没有时间戳。
// 一段两三万字塞进阅读页会撑成一条极窄的长条，导出、摘要切分也都会跟着退化。
// 这里把它按句读断成段落：只动展示粒度，一个字都不增删。

/** 一句结束（换行也算）。省略号、感叹号连写时归到同一句末。 */
const SENT_END = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '\n'])

/** 认不出的断句（没有标点的口播）最多撑到这么长就必须硬切。 */
const HARD_LIMIT = 180

export const PARAGRAPH_MAX = 300

function splitSentences(text: string): string[] {
  const out: string[] = []
  let buf = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n') {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
    if (!SENT_END.has(ch)) continue
    // 「……」「？！」这类连写，等最后一个标点再断。
    const next = text[i + 1]
    if (next && SENT_END.has(next) && next !== '\n') continue
    if (buf.trim()) out.push(buf.trim())
    buf = ''
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

/** 没有标点的长句：先在逗号处找最靠近上限的落点，找不到才按字数硬切。 */
function breakLong(sentence: string): string[] {
  if (sentence.length <= HARD_LIMIT) return [sentence]
  const out: string[] = []
  let rest = sentence
  while (rest.length > HARD_LIMIT) {
    const window = rest.slice(0, HARD_LIMIT)
    const comma = Math.max(window.lastIndexOf('，'), window.lastIndexOf('、'), window.lastIndexOf(','))
    const cut = comma > HARD_LIMIT * 0.4 ? comma + 1 : HARD_LIMIT
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut)
  }
  if (rest.trim()) out.push(rest.trim())
  return out
}

/** 把长文本断成可读段落。拼回去应该和原文逐字一致（只丢掉首尾空白）。 */
export function splitParagraphs(text: string, max = PARAGRAPH_MAX): string[] {
  const sentences = splitSentences(text).flatMap(breakLong)
  const out: string[] = []
  let buf = ''
  for (const sentence of sentences) {
    if (buf && buf.length + sentence.length > max) {
      out.push(buf)
      buf = ''
    }
    buf += sentence
  }
  if (buf.trim()) out.push(buf)
  return out.filter((p) => p.trim())
}

/**
 * 把超长分段拆成段落。时间戳原样复制给每一段——没有时间轴的时候都是 0，
 * 有的情况下宁可几段共用一个起点，也好过整段被压成一条。
 */
export function splitLongSegments(input: TranscriptSegment[], max = PARAGRAPH_MAX): TranscriptSegment[] {
  if (!input.some((seg) => seg.text.length > max)) return input
  const out: TranscriptSegment[] = []
  for (const seg of input) {
    if (seg.text.length <= max) {
      out.push({ ...seg })
      continue
    }
    for (const text of splitParagraphs(seg.text, max)) {
      out.push({ ...seg, text })
    }
  }
  return out.map((seg, i) => ({ ...seg, index: i + 1 }))
}
