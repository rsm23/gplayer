import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const BASE_URL = new URL('https://tapeadvertisement.com/')
const BLOCKED_RESPONSE_SIZES = new Set([7_975_278, 7_975_279])

export class StreamtapeExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  public override async getTracks() {
    await this.load()
    return this.tracks
  }

  private async load(): Promise<void> {
    if (this.#loaded || this.id.length === 0) return
    this.#loaded = true
    try {
      const embedUrl = new URL(`e/${encodeURIComponent(this.id)}`, BASE_URL)
      const page = await this.http.get({ url: embedUrl })
      if (page.status < 200 || page.status >= 300 || !/<video\b/i.test(page.body)) return

      this.title = openGraphValue(page.body, 'og:title')
      this.image = safeRemoteUrl(openGraphValue(page.body, 'og:image'), page.url)
      this.tracks.push(...captionTracks(page.body, page.url))

      const query = innerHtmlQuery(page.body)
      if (query === '') return
      const videoUrl = new URL('get_video', BASE_URL)
      videoUrl.search = query
      videoUrl.searchParams.set('stream', '1')
      const probe = await this.http.head({
        url: videoUrl,
        headers: { range: 'bytes=0-' }
      })
      const size = contentLength(probe.headers)
      if (probe.status < 200 || probe.status >= 400 || size < 0 || BLOCKED_RESPONSE_SIZES.has(size)) return
      if (probe.url.toString() === videoUrl.toString()) return
      const file = safeRemoteUrl(probe.url.toString(), probe.url)
      if (file === '') return

      this.sources.push({ file, type: 'video/mp4', label: 'Original' })
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
    }
  }
}

function innerHtmlQuery(input: string): string {
  for (const match of input.matchAll(/\.innerHTML\s*=\s*["']([^"']+)["']/gi)) {
    const value = decodeHtml(match[1] ?? '').replaceAll('\\/', '/')
    const queryIndex = value.indexOf('?')
    if (queryIndex < 0) continue
    const query = value.slice(queryIndex + 1).trim()
    if (query.length > 0 && query.length <= 8_192 && !/[\u0000-\u001f\u007f]/.test(query)) return query
  }
  return ''
}

function captionTracks(input: string, pageUrl: URL): Array<Readonly<Record<string, unknown>>> {
  const result: Array<Readonly<Record<string, unknown>>> = []
  for (const tag of input.match(/<track\b[^>]*>/gi) ?? []) {
    const attributes = parseAttributes(tag)
    if ((attributes.kind ?? '').toLowerCase() !== 'captions') continue
    const label = (attributes.label ?? '').trim()
    const file = safeRemoteUrl(attributes.src ?? '', pageUrl)
    if (file === '' || label === '' || label.toLowerCase().includes('upload')) continue
    result.push({ file, label })
  }
  return result
}

function parseAttributes(input: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const match of input.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const name = (match[1] ?? '').toLowerCase()
    if (name !== '') result[name] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return result
}

function openGraphValue(input: string, property: string): string {
  const tags = input.match(/<meta\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    if (!new RegExp(`(?:property|name)\\s*=\\s*["']${escapeRegExp(property)}["']`, 'i').test(tag)) continue
    return decodeHtml(tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? '').trim()
  }
  return ''
}

function contentLength(headers: Headers): number {
  const value = headers.get('content-length')
  if (value === null || !/^\d+$/.test(value)) return -1
  const length = Number(value)
  return Number.isSafeInteger(length) ? length : -1
}

function safeRemoteUrl(value: string, base: URL): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) return ''
  try {
    const url = new URL(value.trim(), base)
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
