import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const BASE_URL = 'https://emturbovid.com/'

export class TurboVipPlayExtractor extends BaseExtractor {
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
    try {
      const pageUrl = new URL(`t/${encodeURIComponent(this.id)}`, BASE_URL)
      const response = await this.http.get({ url: pageUrl })
      if (response.status < 200 || response.status >= 300) return

      const file = assignment(response.body, 'urlPlay')
      if (!isHttpUrl(file)) return
      const embedDomain = assignment(response.body, 'domainEmbed')
        .split(',')
        .map((value) => value.trim())
        .find((value) => value !== '' && value.toLowerCase() !== 'no')
      if (embedDomain !== undefined && isHostname(embedDomain)) this.referer = `https://${embedDomain}/`
      this.image = safeHttpUrl(assignment(response.body, 'urlPoster'))
      this.title = htmlTitle(response.body)
      this.sources.push({
        file,
        type: file.toLowerCase().includes('m3u') ? 'hls' : 'video/mp4',
        label: 'Original'
      })
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
    }
  }
}

function assignment(input: string, name: string): string {
  const match = input.match(new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))
  return decodeHtml(match?.[2] ?? '').replaceAll('\\/', '/').trim()
}

function htmlTitle(input: string): string {
  const value = input.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''
  return decodeHtml(value.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function safeHttpUrl(value: string): string {
  return isHttpUrl(value) ? new URL(value).toString() : ''
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}

function isHostname(value: string): boolean {
  if (!/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(value)) return false
  try {
    const url = new URL(`https://${value}/`)
    return url.hostname.includes('.') && !url.username && !url.password
  } catch {
    return false
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
