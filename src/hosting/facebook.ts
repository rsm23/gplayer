import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const FACEBOOK_ORIGIN = 'https://www.facebook.com'
const FACEBOOK_REFERER = `${FACEBOOK_ORIGIN}/`
const FACEBOOK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'

type ParsedFacebookPage = Readonly<{
  sources: readonly Readonly<{ file: string, type: 'hls' | 'mpd' | 'video/mp4', label: string }>[]
  tracks: readonly Readonly<{ file: string, label: string, kind: string }>[]
  title: string
  image: string
}>

export class FacebookExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
    this.referer = FACEBOOK_REFERER
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
    if (this.#loaded) return
    this.#loaded = true
    const pageUrl = facebookPageUrl(this.id)
    if (pageUrl === null) return

    try {
      const page = await this.http.get({ url: pageUrl, headers: facebookHeaders() })
      if (!isFacebookResponse(page.url) || page.status < 200 || page.status >= 300) return
      const direct = parseFacebookPage(page.body)
      this.applyMetadata(direct)
      this.addMedia(direct)
      if (this.sources.length > 0) return

      // Public video embeds still expose VideoConfig when the normal page only
      // returns shell metadata or a login interstitial.
      const pluginUrl = new URL('/plugins/video.php', FACEBOOK_ORIGIN)
      pluginUrl.searchParams.set('href', pageUrl.toString())
      pluginUrl.searchParams.set('show_text', '0')
      pluginUrl.searchParams.set('width', '560')
      const plugin = await this.http.get({
        url: pluginUrl,
        headers: { ...facebookHeaders(), referer: pageUrl.toString() }
      })
      if (!isFacebookResponse(plugin.url) || plugin.status < 200 || plugin.status >= 300) return
      const embedded = parseFacebookPage(plugin.body)
      this.applyMetadata(embedded)
      this.addMedia(embedded)
    } catch {
      // Login-gated, deleted, private, and failed pages preserve the empty contract.
    }
  }

  private applyMetadata(page: ParsedFacebookPage): void {
    if (this.title.length === 0) this.title = page.title
    if (this.image.length === 0 && isFacebookAssetUrl(page.image)) this.image = page.image
  }

  private addMedia(page: ParsedFacebookPage): void {
    const seenSources = new Set(this.sources.map((source) => String(source.file ?? '')))
    for (const source of page.sources) {
      if (!isFacebookAssetUrl(source.file) || seenSources.has(source.file)) continue
      seenSources.add(source.file)
      this.sources.push(source)
    }
    const seenTracks = new Set(this.tracks.map((track) => String(track.file ?? '')))
    for (const track of page.tracks) {
      if (!isFacebookAssetUrl(track.file) || seenTracks.has(track.file)) continue
      seenTracks.add(track.file)
      this.tracks.push(track)
    }
  }
}

export function parseFacebookPage(input: string): ParsedFacebookPage {
  const sources: Array<{ file: string, type: 'hls' | 'mpd' | 'video/mp4', label: string }> = []
  const seen = new Set<string>()
  const sourceFields: ReadonlyArray<readonly [string, string]> = [
    ['dash_manifest_url', 'Original'],
    ['playable_url_dash', 'Original'],
    ['hls_playlist_url', 'Original'],
    ['playable_url_quality_hd', 'HD'],
    ['browser_native_hd_url', 'HD'],
    ['hd_src', 'HD'],
    ['playable_url', 'SD'],
    ['browser_native_sd_url', 'SD'],
    ['sd_src', 'SD']
  ]
  for (const [field, label] of sourceFields) {
    for (const file of jsonStringFields(input, field)) {
      if (!isFacebookAssetUrl(file) || seen.has(file)) continue
      seen.add(file)
      sources.push({ file, type: facebookMediaType(file, field), label })
    }
  }

  const tracks: Array<{ file: string, label: string, kind: string }> = []
  const seenTracks = new Set<string>()
  for (const field of ['captions_url', 'subtitles_src']) {
    for (const file of jsonStringFields(input, field)) {
      if (!isFacebookAssetUrl(file) || seenTracks.has(file)) continue
      seenTracks.add(file)
      tracks.push({ file, label: 'Default', kind: 'captions' })
    }
  }

  const metadata = metaValues(input)
  const title = cleanTitle(metadata.get('twitter:title') ?? metadata.get('og:title') ?? '')
  const image = metadata.get('twitter:image') ?? metadata.get('og:image') ?? ''
  return Object.freeze({ sources, tracks, title, image: isFacebookAssetUrl(image) ? image : '' })
}

function facebookPageUrl(id: string): URL | null {
  const normalized = id.replace(/^\/+|\/+$/g, '')
  if (normalized.length === 0 || normalized.length > 2_048 || /[\\\u0000-\u001f\u007f]/.test(normalized)) return null
  if (normalized.split('/').some((part) => part === '..') || normalized.startsWith('//')) return null
  try {
    const url = new URL(`/${normalized}`, FACEBOOK_ORIGIN)
    return url.origin === FACEBOOK_ORIGIN ? url : null
  } catch {
    return null
  }
}

function facebookHeaders(): Record<string, string> {
  return {
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': FACEBOOK_USER_AGENT
  }
}

function isFacebookResponse(url: URL): boolean {
  return url.protocol === 'https:' && (url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com'))
}

function isFacebookAssetUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && [
      'facebook.com', 'fbcdn.net', 'fbsbx.com'
    ].some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
  } catch {
    return false
  }
}

function facebookMediaType(file: string, field: string): 'hls' | 'mpd' | 'video/mp4' {
  const pathname = new URL(file).pathname.toLowerCase()
  if (field.includes('hls') || pathname.endsWith('.m3u8')) return 'hls'
  if (field.includes('dash') || pathname.endsWith('.mpd')) return 'mpd'
  return 'video/mp4'
}

function jsonStringFields(input: string, field: string): string[] {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?:"${escaped}"|'${escaped}')\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`, 'gi')
  const values: string[] = []
  for (const match of input.matchAll(pattern)) {
    const literal = match[1] ?? ''
    const decoded = decodeJavascriptString(literal)
    if (decoded !== null) values.push(decodeHtml(decoded))
  }
  return values
}

function decodeJavascriptString(literal: string): string | null {
  if (literal.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(literal)
      return typeof parsed === 'string' ? parsed : null
    } catch {
      return null
    }
  }
  if (!literal.startsWith("'") || !literal.endsWith("'")) return null
  try {
    return JSON.parse(`"${literal.slice(1, -1).replaceAll('"', '\\"')}"`) as string
  } catch {
    return null
  }
}

function metaValues(input: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const tag of input.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = new Map<string, string>()
    for (const attribute of (tag[0] ?? '').matchAll(/([\w:-]+)\s*=\s*("[^"]*"|'[^']*')/g)) {
      attributes.set((attribute[1] ?? '').toLowerCase(), decodeHtml((attribute[2] ?? '').slice(1, -1)))
    }
    const name = (attributes.get('name') ?? attributes.get('property') ?? '').toLowerCase()
    const content = attributes.get('content') ?? ''
    if (name.length > 0 && content.length > 0 && !result.has(name)) result.set(name, content)
  }
  return result
}

function cleanTitle(value: string): string {
  return value.replace(/\s*\|\s*Facebook\s*$/i, '').replace(/\s+/g, ' ').trim()
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([\da-f]+);/gi, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#(\d+);/g, (_match, digits: string) => String.fromCodePoint(Number(digits)))
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}
