import path from 'node:path'
import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

export class MediaFireExtractor extends BaseExtractor {
  #loaded = false
  readonly #pageUrl: URL | null

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
    this.#pageUrl = parseHttpUrl(`https://www.mediafire.com/file/${this.id.replace(/^\/+/, '')}`)
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || this.#pageUrl === null) return
    this.#loaded = true
    try {
      const response = await this.http.get({ url: this.#pageUrl })
      if (response.status < 200 || response.status >= 400) return
      const htmlFile = mediaFireDownloadLink(response.body)
      const file = htmlFile ?? (response.url.toString() !== this.#pageUrl.toString() ? response.url.toString() : '')
      if (!isHttpUrl(file)) return
      this.title = mediaFireTitle(response.body) || decodeURIComponent(path.posix.basename(new URL(file).pathname))
      this.sources.push({ file: decodeHtml(file), type: 'video/mp4', label: 'Original' })
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
    }
  }
}

function mediaFireDownloadLink(html: string): string | null {
  const anchor = html.match(/<a\b(?=[^>]*\bclass=["'][^"']*\bpopsok\b[^"']*["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/i)
    ?? html.match(/<a\b(?=[^>]*\bhref=["']([^"']+)["'])[^>]*\bclass=["'][^"']*\bpopsok\b[^"']*["'][^>]*>/i)
  const value = anchor?.[1]
  return value === undefined ? null : decodeHtml(value.trim())
}

function mediaFireTitle(html: string): string {
  const match = html.match(/<[^>]*\bclass=["'][^"']*\bdl-btn-label\b[^"']*["'][^>]*>([\s\S]*?)<\//i)
  return decodeHtml((match?.[1] ?? '').replace(/<[^>]+>/g, '').trim())
}

function decodeHtml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}

function isHttpUrl(value: string): boolean {
  return parseHttpUrl(value) !== null
}
