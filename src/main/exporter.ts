import { app, clipboard, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { formatDate, formatDuration, formatSrtStamp, formatStamp } from '../shared/types'
import type { EpisodeRecord, ExportFormat, ExportScope } from '../shared/types'
import { safeFileName } from './store'

const EXT_LABEL: Record<ExportFormat, string> = {
  txt: '纯文本',
  md: 'Markdown',
  srt: '字幕文件',
  json: '结构化数据'
}

function plain(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*]\s+/gm, '· ')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim()
}

function header(record: EpisodeRecord, markdown: boolean): string {
  const m = record.meta
  const lines = [
    markdown ? `# ${m.title}` : m.title,
    markdown ? '' : '─'.repeat(28),
    `节目　${m.podcast}`,
    `发布　${formatDate(m.publishedAt)}`,
    `时长　${formatDuration(m.durationSec)}`,
    `字数　${record.charCount.toLocaleString('zh-CN')}`,
    `来源　${m.link}`,
    ''
  ]
  return lines.join('\n')
}

function transcriptText(record: EpisodeRecord, markdown: boolean, timestamps: boolean): string {
  const hasTime = record.segments.some((s) => s.startMs > 0 || s.endMs > 0)
  return record.segments
    .map((s) => {
      const stamp = timestamps && hasTime ? formatStamp(s.startMs) : ''
      const speaker = s.speaker ? `${s.speaker}：` : ''
      if (!stamp) return `${speaker}${s.text}`
      return markdown ? `**${stamp}**　${speaker}${s.text}` : `[${stamp}] ${speaker}${s.text}`
    })
    .join(markdown ? '\n\n' : '\n')
}

function srtText(record: EpisodeRecord): string {
  let auto = 0
  return record.segments
    .map((s, i) => {
      const start = s.startMs || auto
      const end = s.endMs > start ? s.endMs : start + 3000
      auto = end
      return `${i + 1}\n${formatSrtStamp(start)} --> ${formatSrtStamp(end)}\n${s.speaker ? `${s.speaker}：` : ''}${s.text}\n`
    })
    .join('\n')
}

export function buildContent(record: EpisodeRecord, format: ExportFormat, scope: ExportScope): string {
  if (format === 'srt') return srtText(record)
  if (format === 'json') {
    return JSON.stringify(
      {
        meta: record.meta,
        fetchedAt: record.fetchedAt,
        charCount: record.charCount,
        ...(scope !== 'transcript' && record.summary ? { summary: record.summary } : {}),
        ...(scope !== 'summary' ? { segments: record.segments, plainText: record.plainText } : {})
      },
      null,
      2
    )
  }
  const markdown = format === 'md'
  const parts: string[] = [header(record, markdown)]
  if ((scope === 'summary' || scope === 'both') && record.summary) {
    parts.push(markdown ? '## 摘要\n' : '摘　要\n' + '─'.repeat(28))
    parts.push(markdown ? record.summary : plain(record.summary), '')
  }
  if (scope === 'summary' && !record.summary) {
    parts.push('（还没有生成摘要）')
  }
  if (scope === 'transcript' || scope === 'both') {
    parts.push(markdown ? '## 逐字稿\n' : '逐 字 稿\n' + '─'.repeat(28))
    parts.push(transcriptText(record, markdown, true))
  }
  return parts.join('\n').trimEnd() + '\n'
}

export async function saveExport(
  record: EpisodeRecord,
  format: ExportFormat,
  scope: ExportScope
): Promise<string | null> {
  const name = safeFileName(`${record.meta.title} - ${scope === 'summary' ? '摘要' : '文字稿'}`)
  const suffix = format === 'md' && scope === 'summary' ? '-摘要' : ''
  const result = await dialog.showSaveDialog({
    title: '导出',
    defaultPath: path.join(app.getPath('documents'), `${name}${suffix}.${format}`),
    filters: [{ name: EXT_LABEL[format], extensions: [format] }, { name: '全部文件', extensions: ['*'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation']
  })
  if (result.canceled || !result.filePath) return null
  fs.writeFileSync(result.filePath, buildContent(record, format, scope), 'utf-8')
  return result.filePath
}

export function copyText(text: string): void {
  clipboard.writeText(text)
}
