import { DeskException } from './error'
import type { EpisodeMeta } from '../../shared/types'

// 免登录获取小宇宙单集元数据：优先解析单集页内嵌的 __NEXT_DATA__（SSR），
// 失败时回退到官方 RSS（用 guid === eid 校验）。
// 这条链路不接触 api.xiaoyuzhoufm.com，因此不需要任何账号凭据。

const PAGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export function parseEpisodeId(input: string): string | null {
  const text = input.trim()
  const match =
    text.match(/\/episode\/([0-9a-fA-F]{16,32})/) ||
    text.match(/[?&]eid=([0-9a-fA-F]{16,32})/) ||
    text.match(/(?:^|[^0-9a-fA-F])([0-9a-fA-F]{24})(?:$|[^0-9a-fA-F])/)
  return match ? match[1] : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function pick(...values: unknown[]): string | undefined {
  for (const v of values) {
    const s = asString(v)
    if (s) return s
  }
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

interface RawEpisode {
  eid?: unknown
  pid?: unknown
  title?: unknown
  duration?: unknown
  pubDate?: unknown
  enclosure?: { url?: unknown } | unknown
  media?: { id?: unknown; source?: { url?: unknown } } | unknown
  transcript?: { mediaId?: unknown } | unknown
  transcriptMediaId?: unknown
  shownotes?: unknown
  description?: unknown
  image?: { picUrl?: unknown; url?: unknown; smallPicUrl?: unknown } | unknown
  podcast?: { title?: unknown; image?: { picUrl?: unknown; url?: unknown } } | unknown
}

function metaFromEpisode(ep: RawEpisode, eid: string): EpisodeMeta {
  const media = ep?.media as { id?: unknown; source?: { url?: unknown } } | undefined
  const transcript = ep?.transcript as { mediaId?: unknown } | undefined
  const image = ep?.image as { picUrl?: unknown; url?: unknown; smallPicUrl?: unknown } | undefined
  const podcast = ep?.podcast as { title?: unknown; image?: { picUrl?: unknown; url?: unknown } } | undefined

  const enclosureUrl =
    pick((ep?.enclosure as { url?: unknown } | undefined)?.url) ||
    pick(media?.source?.url)
  const mediaId =
    pick(transcript?.mediaId) ||
    pick(ep?.transcriptMediaId) ||
    pick(media?.id)

  return {
    eid,
    link: `https://www.xiaoyuzhoufm.com/episode/${eid}`,
    title: pick(ep?.title) || '未命名单集',
    podcast: pick(podcast?.title) || '未知节目',
    cover: pick(image?.picUrl, image?.url, image?.smallPicUrl, podcast?.image?.picUrl, podcast?.image?.url),
    durationSec: asNumber(ep?.duration),
    publishedAt: pick(ep?.pubDate),
    description: pick(ep?.shownotes, ep?.description)
      ? stripHtml(pick(ep?.shownotes, ep?.description)!)
      : undefined,
    mediaId,
    enclosureUrl
  }
}

function nextDataFromHtml(html: string): any | null {
  const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/)
  if (!match) return null
  try { return JSON.parse(match[1]) } catch { return null }
}

async function fetchHtml(url: string, timeoutMs = 30_000): Promise<string> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': PAGE_UA, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    throw new DeskException('NETWORK', '无法打开小宇宙页面', '请检查网络后重试。')
  }
  if (!response.ok) throw new DeskException('NETWORK', `小宇宙页面返回 HTTP ${response.status}`)
  return response.text()
}

export async function fetchEpisodeMeta(eid: string): Promise<EpisodeMeta> {
  const pageUrl = `https://www.xiaoyuzhoufm.com/episode/${eid}`
  const html = await fetchHtml(pageUrl)
  const data = nextDataFromHtml(html)
  const ep = data?.props?.pageProps?.episode
  if (ep && typeof ep === 'object') {
    return metaFromEpisode(ep as RawEpisode, eid)
  }
  throw new DeskException('NOT_FOUND', '没有找到这一期节目', '请确认链接完整、单集是否已下架。')
}

// ---- RSS 回退 ----
// 小宇宙为每档播客公开提供 RSS（feed.xyzfm.space），<guid> 即 eid。
// 通过 iTunes Search 按节目名/主播名找 RSS 地址，再定位到对应单集。

async function searchRssViaItunes(term: string): Promise<string | null> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=podcast&country=cn&limit=5`
  let response: Response
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': PAGE_UA },
      signal: AbortSignal.timeout(20_000)
    })
  } catch {
    return null
  }
  if (!response.ok) return null
  const json = await response.json() as { results?: { feedUrl?: string }[] }
  const feedUrl = json?.results?.find((r) => typeof r.feedUrl === 'string')?.feedUrl
  return feedUrl ?? null
}

interface RssItem {
  guid?: string
  title?: string
  pubDate?: string
  duration?: string
  enclosureUrl?: string
  itunesDuration?: string
}

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = []
  const blocks = xml.split(/<item[^>]*>/i).slice(1)
  for (const block of blocks) {
    const body = block.split(/<\/item>/i)[0]
    if (!body) continue
    const grab = (tag: string): string | undefined => {
      const m = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : undefined
    }
    const guid = grab('guid')
    const title = grab('title')
    const pubDate = grab('pubDate')
    const itunesDuration = grab('itunes:duration')
    const enclosureMatch = body.match(/<enclosure[^>]*url="([^"]+)"/i)
    items.push({
      guid,
      title,
      pubDate,
      itunesDuration,
      enclosureUrl: enclosureMatch ? enclosureMatch[1] : undefined
    })
  }
  return items
}

function parseItunesDuration(value: string): number | undefined {
  const v = value.trim()
  const clock = v.match(/^(\d+):(\d{2}):(\d{2})$/)
  if (clock) return Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
  const sec = Number(v)
  return Number.isFinite(sec) && sec > 0 ? sec : undefined
}

export async function fetchEpisodeMetaBySearch(eid: string, terms: string[]): Promise<EpisodeMeta | null> {
  for (const term of terms) {
    const feedUrl = await searchRssViaItunes(term)
    if (!feedUrl) continue
    let xml: string
    try {
      const response = await fetch(feedUrl, {
        headers: { 'User-Agent': PAGE_UA },
        signal: AbortSignal.timeout(25_000)
      })
      if (!response.ok) continue
      xml = await response.text()
    } catch {
      continue
    }
    const item = parseRssItems(xml).find((it) => it.guid === eid)
    if (!item) continue
    return {
      eid,
      link: `https://www.xiaoyuzhoufm.com/episode/${eid}`,
      title: item.title || '未命名单集',
      podcast: term,
      publishedAt: item.pubDate,
      durationSec: item.itunesDuration ? parseItunesDuration(item.itunesDuration) : undefined,
      enclosureUrl: item.enclosureUrl
    }
  }
  return null
}
