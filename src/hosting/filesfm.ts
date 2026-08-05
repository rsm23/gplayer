import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

export class FilesFmExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || this.id.length === 0) return
    this.#loaded = true
    const pageUrl = safeHttpUrl(this.id)
    if (pageUrl === '') return
    try {
      const response = await this.http.get({ url: pageUrl })
      if (response.status < 200 || response.status >= 300) return

      const sessionId = between(response.body, "strHttpCacheKey + '", "';")
      const pictureUrl = javascriptField(response.body, 'picture_url')
      const file = safeHttpUrl(
        pictureUrl
          .replace('thumb_show.php?i=', 'thumb_video/')
          .replace('&view', sessionId)
      )
      if (file === '') return

      this.referer = pageUrl
      this.title = javascriptField(response.body, 'item_name')
      this.image = safeHttpUrl(
        openGraphImage(response.body)
          .replace('thumb_show', 'thumb_video_picture')
          .replace('&view', '')
      )
      this.sources.push({ file, type: 'video/mp4', label: 'Original' })
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
    }
  }
}

function javascriptField(input: string, field: string): string {
  const match = input.match(new RegExp(`["']${escapeRegExp(field)}["']\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, 'i'))
  if (match?.[1] === undefined) return ''
  try {
    const value: unknown = JSON.parse(match[1])
    return typeof value === 'string' ? decodeHtml(value).trim() : ''
  } catch {
    return ''
  }
}

function openGraphImage(input: string): string {
  const tags = input.match(/<meta\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    if (!/(?:property|name)\s*=\s*["']og:image["']/i.test(tag)) continue
    return decodeHtml(tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? '').trim()
  }
  return ''
}

function between(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start)
  if (startIndex < 0) return ''
  const contentStart = startIndex + start.length
  const endIndex = value.indexOf(end, contentStart)
  return endIndex < 0 ? '' : value.slice(contentStart, endIndex).trim()
}

function safeHttpUrl(value: string): string {
  try {
    const url = new URL(decodeHtml(value).replaceAll('\\/', '/').trim())
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.toString()
      : ''
  } catch {
    return ''
  }
}

function decodeHtml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
