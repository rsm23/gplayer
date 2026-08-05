import { normalizeLegacyHost } from './player-query.js'

export type MediaSource = Readonly<Record<string, unknown>>
export type MediaTrack = Readonly<Record<string, unknown>>

export type MediaResult = Readonly<{
  sources: readonly MediaSource[]
  tracks: readonly MediaTrack[]
  referer: string
  title: string
  email: string
  image: string
  cookies: readonly unknown[]
  filmstrip: string
  clientip: string
}>

export type SourceCacheCriteria = Readonly<{
  host: string
  hostId: string
  expiresAfter: number
  downloadable: boolean
  userAgent: string
  language: string
  serverId: number | null
  clientIp: string | null
}>

export type SourceCacheRecord = Readonly<{
  data: string
  language: string
  userAgent: string
  created: number
  expired: number
}>

export type SourceCacheInsert = Readonly<{
  host: string
  hostId: string
  data: string
  downloadable: boolean
  serverId: number | null
  created: number
  expired: number
  userAgent: string
  language: string
  clientIp: string
  serverIp: string
}>

export interface SourceCacheRepository {
  find(criteria: SourceCacheCriteria): Promise<SourceCacheRecord | null>
  delete(criteria: SourceCacheCriteria): Promise<void>
  insert(record: SourceCacheInsert): Promise<void>
}

export interface HostingExtractor {
  setHost(host: string): this
  setDownloadable(downloadable: boolean): this
  setEmail(email: string): this
  getSources(): Promise<readonly MediaSource[]> | readonly MediaSource[]
  getTracks(): Promise<readonly MediaTrack[]> | readonly MediaTrack[]
  getReferer(): string
  getTitle(): string
  getEmail(): string
  getImage(): string
  getCookies(): readonly unknown[]
  getFilmstrip(): string
  getNetworkInterface(): string
}

export interface HostingExtractorFactory {
  create(host: string, id: string): HostingExtractor | null
}

export type SourceResolverOptions = Readonly<{
  cache: SourceCacheRepository
  extractors: HostingExtractorFactory
  clientIp: string
  serverId?: number | null
  defaultUserAgent: string
  defaultLanguage: string
  requestUserAgent?: string
  requestLanguage?: string
  directHosts: ReadonlySet<string>
  downloadableHosts: ReadonlySet<string>
  googleHlsHosts?: ReadonlySet<string>
  timeoutHosts?: Readonly<Record<string, number>>
  now?: () => number
}>

export class SourceResolver {
  #host = ''
  #id = ''
  #email = ''
  #downloadable = false

  public constructor(private readonly options: SourceResolverOptions) {}

  public setQuery(query: Readonly<{ host?: string; id?: string; email?: string }>): this {
    if (query.host === undefined || query.host.length === 0 || query.id === undefined || query.id.length === 0) {
      return this
    }
    this.#host = normalizeLegacyHost(query.host)
    this.#id = query.id
    this.#email = sanitizeEmail(query.email ?? '')
    return this
  }

  public setDownload(downloadable = true): this {
    this.#downloadable = downloadable && this.options.downloadableHosts.has(this.#host)
    return this
  }

  public async getDataSources(): Promise<SourceCacheRecord | null> {
    return await this.options.cache.find(this.criteria())
  }

  public async getResult(): Promise<MediaResult> {
    const criteria = this.criteria()
    const cached = await this.options.cache.find(criteria)
    if (cached !== null) {
      const parsed = parseCachedResult(cached.data)
      if (parsed !== null) {
        const firstType = String(parsed.sources[0]?.type ?? '')
        const invalidGoogleHls = this.options.googleHlsHosts?.has(this.#host) === true &&
          firstType.length > 0 && !firstType.includes('mp4')
        if (!invalidGoogleHls) return parsed
      }
      await this.options.cache.delete(criteria)
    }

    const extracted = await this.extractOriginalSources()
    if (extracted.sources.length > 0) {
      const now = this.now()
      await this.options.cache.insert({
        host: this.#host,
        hostId: this.#id,
        data: JSON.stringify(extracted),
        downloadable: this.#downloadable,
        serverId: this.options.serverId ?? null,
        created: now,
        expired: now + this.getTimeout(this.#host),
        userAgent: this.browserInfo().userAgent,
        language: this.browserInfo().language.slice(0, 50),
        clientIp: this.options.clientIp,
        serverIp: extracted.serverIp
      })
    }
    return extracted.result
  }

  public async getOriginalSources(): Promise<MediaResult> {
    return (await this.extractOriginalSources()).result
  }

  public getTimeout(host = 'gdrive'): number {
    return this.options.timeoutHosts?.[host] ?? 3 * 60 * 60
  }

  private async extractOriginalSources(): Promise<{ result: MediaResult; sources: readonly MediaSource[]; serverIp: string }> {
    const empty = emptyMediaResult()
    if (this.#host.length === 0 || this.#id.length === 0) {
      return { result: empty, sources: empty.sources, serverIp: '' }
    }

    const extractor = this.options.extractors.create(this.#host, this.#id)
    if (extractor === null) return { result: empty, sources: empty.sources, serverIp: '' }

    extractor
      .setHost(capitalize(this.#host))
      .setDownloadable(this.#downloadable)
      .setEmail(this.#email)

    const sources = await extractor.getSources()
    if (sources.length === 0) return { result: empty, sources, serverIp: '' }

    const result: MediaResult = Object.freeze({
      sources,
      tracks: await extractor.getTracks(),
      referer: extractor.getReferer(),
      title: extractor.getTitle(),
      email: extractor.getEmail(),
      image: extractor.getImage(),
      cookies: extractor.getCookies(),
      filmstrip: extractor.getFilmstrip(),
      clientip: this.options.clientIp
    })
    return { result, sources, serverIp: extractor.getNetworkInterface() }
  }

  private criteria(): SourceCacheCriteria {
    const browser = this.browserInfo()
    return Object.freeze({
      host: this.#host,
      hostId: this.#id,
      expiresAfter: this.now(),
      downloadable: this.#downloadable,
      userAgent: browser.userAgent,
      language: browser.language,
      serverId: this.options.serverId ?? null,
      clientIp: this.options.directHosts.has(this.#host) ? this.options.clientIp : null
    })
  }

  private browserInfo(): Readonly<{ userAgent: string; language: string }> {
    if (!this.options.directHosts.has(this.#host)) {
      return { userAgent: this.options.defaultUserAgent, language: this.options.defaultLanguage }
    }
    return {
      userAgent: this.options.requestUserAgent ?? this.options.defaultUserAgent,
      language: this.options.requestLanguage ?? this.options.defaultLanguage
    }
  }

  private now(): number {
    return Math.floor((this.options.now?.() ?? Date.now()) / 1_000)
  }
}

export function emptyMediaResult(): MediaResult {
  return Object.freeze({
    sources: [],
    tracks: [],
    referer: '',
    title: '',
    email: '',
    image: '',
    cookies: [],
    filmstrip: '',
    clientip: ''
  })
}

function parseCachedResult(value: string): MediaResult | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isObject(parsed) || !Array.isArray(parsed.sources) || parsed.sources.length === 0) return null
    return Object.freeze({
      sources: parsed.sources.filter(isObject),
      tracks: Array.isArray(parsed.tracks) ? parsed.tracks.filter(isObject) : [],
      referer: stringValue(parsed.referer),
      title: stringValue(parsed.title),
      email: stringValue(parsed.email),
      image: stringValue(parsed.image),
      cookies: Array.isArray(parsed.cookies) ? parsed.cookies : [],
      filmstrip: stringValue(parsed.filmstrip),
      clientip: stringValue(parsed.clientip)
    })
  } catch {
    return null
  }
}

function sanitizeEmail(value: string): string {
  const trimmed = value.trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : ''
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
