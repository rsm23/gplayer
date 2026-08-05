import { randomBytes } from 'node:crypto'
import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

export type DailymotionExtractorOptions = Readonly<{
  uniqueId?: () => string
}>

export class DailymotionExtractor extends BaseExtractor {
  #loaded = false
  readonly #uniqueId: () => string

  public constructor(
    id: string,
    private readonly http: ProviderHttpClient,
    options: DailymotionExtractorOptions = {}
  ) {
    super(id.trim())
    this.referer = 'https://geo.dailymotion.com/'
    this.#uniqueId = options.uniqueId ?? generateUniqueId
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
      const pageUrl = `https://www.dailymotion.com/video/${encodeURIComponent(this.id)}`
      const page = await this.http.get({ url: pageUrl })
      if (page.status < 200 || page.status >= 400) return
      const firstVisit = cookieValue(page.headers, 'v1st')
      const timestamp = cookieValue(page.headers, 'ts')
      if (firstVisit === '' || timestamp === '') return
      this.cookies = [`v1st=${firstVisit}`, `ts=${timestamp}`]

      const metadataUrl = new URL(`https://www.dailymotion.com/player/metadata/video/${encodeURIComponent(this.id)}`)
      metadataUrl.search = new URLSearchParams({
        embedder: pageUrl,
        geo: '1',
        'player-id': 'xtv3w',
        locale: 'en',
        dmV1st: firstVisit,
        dmTs: timestamp,
        is_native_app: '0',
        app: 'com.dailymotion.neon',
        client_type: 'website',
        dmViewId: this.#uniqueId(),
        section_type: 'player',
        component_style: '_',
        parallelCalls: '1'
      }).toString()
      const metadata = await this.http.get({
        url: metadataUrl,
        headers: {
          cookie: this.cookies.join('; '),
          referer: this.referer
        }
      })
      if (metadata.status < 200 || metadata.status >= 300) return
      this.parseMetadata(metadata.body)
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
    }
  }

  private parseMetadata(value: string): void {
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = objectValue(JSON.parse(value))
    } catch {
      return
    }
    if (parsed === null) return

    const qualities = objectValue(parsed.qualities)
    const automatic = arrayValue(qualities?.auto).map(objectValue).filter((item): item is Record<string, unknown> => item !== null)
    const sourceUrl = automatic.find((item) => typeof item.url === 'string')?.url
    if (typeof sourceUrl !== 'string' || sourceUrl.length === 0) return
    this.sources.push({ file: sourceUrl, type: 'hls', label: 'Original' })
    if (typeof parsed.title === 'string') this.title = parsed.title

    const thumbnails = objectValue(parsed.thumbnails)
    const posters = objectValue(parsed.posters)
    this.image = lastStringValue(thumbnails) || lastStringValue(posters)

    const subtitles = objectValue(objectValue(parsed.subtitles)?.data)
    if (subtitles !== null) {
      for (const item of Object.values(subtitles)) this.addTrack(item)
    } else {
      for (const item of arrayValue(objectValue(parsed.subtitles)?.data)) this.addTrack(item)
    }
  }

  private addTrack(value: unknown): void {
    const subtitle = objectValue(value)
    const file = arrayValue(subtitle?.urls).find((url): url is string => typeof url === 'string' && url.length > 0)
    if (file === undefined) return
    this.tracks.push({ file, label: typeof subtitle?.label === 'string' ? subtitle.label : '' })
  }
}

function cookieValue(headers: Headers, name: string): string {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const values = typeof getSetCookie === 'function' ? getSetCookie.call(headers) : [headers.get('set-cookie') ?? '']
  for (const value of values) {
    const match = value.match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;,]+)`))
    if (match?.[1]) return match[1]
  }
  return ''
}

function generateUniqueId(): string {
  return `${Date.now().toString(32)}${randomBytes(5).toString('hex').padStart(10, '0')}`
}

function lastStringValue(value: Record<string, unknown> | null): string {
  if (value === null) return ''
  return Object.values(value).filter((item): item is string => typeof item === 'string' && item.length > 0).at(-1) ?? ''
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
