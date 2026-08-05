import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const TIKTOK_REFERER = 'https://www.tiktok.com/'

type JsonObject = Record<string, unknown>

export class TiktokExtractor extends BaseExtractor {
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
    if (this.#loaded) return
    this.#loaded = true
    const pageUrl = tiktokPageUrl(this.id)
    if (pageUrl === null) return
    this.referer = TIKTOK_REFERER
    try {
      const response = await this.http.get({
        url: pageUrl,
        headers: { referer: this.referer }
      })
      if (response.status < 200 || response.status >= 300) return
      const item = parseTiktokItem(response.body)
      const video = objectValue(item?.video)
      if (item === null || video === null) return

      const file = legacyDecodedUrl(stringValue(video.playAddr))
      if (file === '') return
      this.sources.push({
        file,
        type: 'video/mp4',
        label: stringValue(video.definition) || stringValue(video.ratio) || 'Original'
      })
      this.title = stringValue(item.desc)
      this.image = firstLegacyDecodedUrl([video.cover, video.originCover, video.dynamicCover])

      const subtitles = Array.isArray(video.subtitleInfos) ? video.subtitleInfos : []
      for (const value of subtitles) {
        const subtitle = objectValue(value)
        const track = firstLegacyDecodedUrl([
          subtitle?.Url,
          subtitle?.url,
          subtitle?.UrlList,
          subtitle?.urlList
        ])
        if (track === '') continue
        const label = stringValue(subtitle?.LanguageName) ||
          stringValue(subtitle?.languageName) ||
          stringValue(subtitle?.LanguageCodeName) ||
          stringValue(subtitle?.languageCodeName) ||
          'Unknown'
        this.tracks.push({ file: track, label })
      }
    } catch {
      // Invalid or unavailable provider responses produce an empty result.
    }
  }
}

export function parseTiktokItem(input: string): JsonObject | null {
  const script = scriptById(input, '__UNIVERSAL_DATA_FOR_REHYDRATION__')
  if (script === '') return null
  try {
    const root = objectValue(JSON.parse(script))
    const scope = objectValue(root?.__DEFAULT_SCOPE__)
    const detail = objectValue(scope?.['webapp.video-detail'])
    const itemInfo = objectValue(detail?.itemInfo)
    return objectValue(itemInfo?.itemStruct)
  } catch {
    return null
  }
}

function scriptById(input: string, id: string): string {
  for (const match of input.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = match[1] ?? ''
    const scriptId = attributes.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1] ?? ''
    if (scriptId === id) return match[2]?.trim() ?? ''
  }
  return ''
}

function tiktokPageUrl(id: string): URL | null {
  try {
    if (/^https?:\/\//i.test(id)) {
      const url = new URL(id)
      if (!isTiktokHost(url.hostname) || url.username || url.password) return null
      return url
    }
    const path = id.replace(/^\/+/, '')
    if (!/^@[A-Za-z0-9._-]+\/video\/\d+$/.test(path) && !/^t\/[A-Za-z0-9_-]+\/?$/.test(path)) return null
    return new URL(`https://www.tiktok.com/${path}`)
  } catch {
    return null
  }
}

function isTiktokHost(hostname: string): boolean {
  const value = hostname.toLowerCase()
  return value === 'tiktok.com' || value === 'www.tiktok.com'
}

function firstLegacyDecodedUrl(values: readonly unknown[]): string {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstLegacyDecodedUrl(value)
      if (nested !== '') return nested
      continue
    }
    const url = legacyDecodedUrl(stringValue(value))
    if (url !== '') return url
  }
  return ''
}

function legacyDecodedUrl(value: string): string {
  let decoded = value.replaceAll('\\u002F', '/')
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // Preserve the original value when it contains a non-URI percent sequence.
  }
  try {
    const url = new URL(decoded)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? decoded
      : ''
  } catch {
    return ''
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
}
