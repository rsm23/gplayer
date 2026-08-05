import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const APP_VERSION = '1781686444'
const TWITTER_REFERER = 'https://twitter.com/'

type JsonObject = Record<string, unknown>

export class SoundcloudExtractor extends BaseExtractor {
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
      const page = await this.http.get({ url: pageUrl })
      if (page.status < 200 || page.status >= 300) return
      const twitterPlayerUrl = safeRemoteUrl(metaValue(page.body, 'twitter:player'), page.url)
      if (twitterPlayerUrl === '') return

      this.referer = TWITTER_REFERER
      const twitterPlayer = await this.http.get({
        url: twitterPlayerUrl,
        headers: { referer: this.referer }
      })
      if (twitterPlayer.status < 200 || twitterPlayer.status >= 300) return
      const widgetSourceUrl = safeHttpUrl(new URL(twitterPlayerUrl).searchParams.get('url') ?? '')
      const widgetUrl = lastSourceUrl(twitterPlayer.body, twitterPlayer.url)
      if (widgetSourceUrl === '' || widgetUrl === '') return

      const widget = await this.http.get({
        url: widgetUrl,
        headers: { referer: this.referer }
      })
      if (widget.status < 200 || widget.status >= 300) return
      const clientId = soundcloudClientId(widget.body)
      if (clientId === '') return

      const resolveUrl = new URL('https://api-widget.soundcloud.com/resolve')
      resolveUrl.search = new URLSearchParams({
        url: widgetSourceUrl,
        format: 'json',
        client_id: clientId,
        app_version: APP_VERSION
      }).toString()
      const resolved = await this.http.get({ url: resolveUrl })
      const track = responseObject(resolved.status, resolved.body)
      if (track === null) return
      this.title = typeof track.title === 'string' ? track.title : ''
      this.image = typeof track.artwork_url === 'string'
        ? safeHttpUrl(track.artwork_url.replace('-large.', '-original.'))
        : ''

      const media = objectValue(track.media)
      const transcodings = Array.isArray(media?.transcodings) ? media.transcodings : []
      const transcoding = objectValue(transcodings[0])
      const format = objectValue(transcoding?.format)
      if (typeof format?.protocol !== 'string' || format.protocol.includes('encrypted')) return
      if (typeof transcoding?.url !== 'string') return
      const transcodingUrl = safeHttpUrl(transcoding.url)
      if (transcodingUrl === '') return
      const endpoint = new URL(transcodingUrl)
      endpoint.searchParams.set('client_id', clientId)

      const stream = await this.http.get({ url: endpoint })
      const streamData = responseObject(stream.status, stream.body)
      const file = typeof streamData?.url === 'string' ? safeHttpUrl(streamData.url) : ''
      if (file === '') return
      this.sources.push({ file, type: 'hls', label: 'Original' })
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
    }
  }
}

function lastSourceUrl(input: string, base: URL): string {
  let result = ''
  for (const match of input.matchAll(/\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    const value = safeRemoteUrl(decodeHtml(match[1] ?? ''), base)
    if (value !== '') result = value
  }
  return result
}

function soundcloudClientId(input: string): string {
  const candidates = [
    input.match(/client_id\s*:\s*[^?]+\?\s*["'][^"']+["']\s*:\s*["']([^"']+)["']/)?.[1],
    input.match(/["']client_id["']\s*:\s*["']([^"']+)["']/)?.[1]
  ]
  for (const value of candidates) {
    const token = value?.trim() ?? ''
    if (token.length > 0 && token.length <= 256 && /^[A-Za-z0-9_-]+$/.test(token)) return token
  }
  return ''
}

function metaValue(input: string, property: string): string {
  for (const tag of input.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!new RegExp(`(?:property|name)\\s*=\\s*["']${escapeRegExp(property)}["']`, 'i').test(tag)) continue
    return decodeHtml(tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? '').trim()
  }
  return ''
}

function responseObject(status: number, value: string): JsonObject | null {
  if (status < 200 || status >= 300) return null
  try {
    return objectValue(JSON.parse(value))
  } catch {
    return null
  }
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
}

function safeRemoteUrl(value: string, base: URL): string {
  try {
    const url = new URL(value, base)
    return safeUrl(url)
  } catch {
    return ''
  }
}

function safeHttpUrl(value: string): string {
  try {
    return safeUrl(new URL(value))
  } catch {
    return ''
  }
}

function safeUrl(url: URL): string {
  return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    ? url.toString()
    : ''
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
