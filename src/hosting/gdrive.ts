import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'
import type { DrivePrivateSourceResolver, DriveRuntimeSettingsLoader } from '../drive/drive-media-service.js'

const GDRIVE_INFO_ORIGIN = 'https://docs.google.com'
const GDRIVE_REFERER = 'https://youtube.googleapis.com/'
const MAX_VIDEO_INFO_LENGTH = 5 * 1_024 * 1_024

export type GdriveVideoInfo = Readonly<{
  sources: readonly Readonly<{ file: string, type: 'video/mp4', label: string }>[]
  hls?: Readonly<{ file: string, type: 'hls', label: 'Original' }>
  image: string
  title: string
}>

export class GdriveExtractor extends BaseExtractor {
  #loaded = false

  public constructor(
    id: string,
    private readonly http: ProviderHttpClient,
    private readonly options: Readonly<{
      privateSources?: DrivePrivateSourceResolver
      loadSettings?: DriveRuntimeSettingsLoader
    }> = {}
  ) {
    super(normalizeGdriveId(id))
    this.referer = GDRIVE_REFERER
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || !isSafeGdriveId(this.id)) return
    this.#loaded = true
    const settings = await this.loadSettings()
    if (settings.copy) await this.options.privateSources?.enqueue(this.id).catch(() => undefined)

    if (this.downloadable && this.options.privateSources !== undefined) {
      await this.loadPrivate(false)
      if (this.sources.length > 0) return
    }

    const url = new URL('/u/0/get_video_info', GDRIVE_INFO_ORIGIN)
    url.searchParams.set('docid', this.id)
    try {
      const response = await this.http.get({ url, headers: { referer: GDRIVE_REFERER } })
      if (response.status >= 200 && response.status < 300 && response.url.hostname === 'docs.google.com') {
        const info = parseGdriveVideoInfo(response.body)
        if (info !== null) {
          if (this.hlsMode && !this.downloadable && info.hls !== undefined) {
            this.sources.push(info.hls)
            this.image = info.image
            this.title = info.title
            return
          }
          if (info.sources.length === 0) {
            if (!this.downloadable && info.hls !== undefined) {
              this.sources.push(info.hls)
              this.image = info.image
              this.title = info.title
              return
            }
            await this.loadPrivate(settings.copy)
            return
          }
          this.sources.push(...info.sources)
          if (!this.downloadable) {
            const first = info.sources[0]
            const last = info.sources.at(-1)
            if (first !== undefined) this.sources.push({ ...first, label: 'Default' })
            if (last !== undefined) this.sources.push({ ...last, label: 'Original' })
          }
          this.image = info.image
          this.title = info.title
          return
        }
      }
    } catch {
      // Permission errors, invalid identities, and unavailable public files produce an empty result.
    }
    await this.loadPrivate(settings.copy)
  }

  private async loadPrivate(allowCopy: boolean): Promise<void> {
    const source = await this.options.privateSources?.resolve(this.id, this.email, allowCopy).catch(() => null)
    if (source === undefined || source === null) return
    this.sources.push(source)
    this.title = source.title
    this.image = source.image
  }

  private async loadSettings(): Promise<Readonly<{ copy: boolean; copyAll: boolean }>> {
    try {
      return await this.options.loadSettings?.() ?? { copy: false, copyAll: false }
    } catch {
      return { copy: false, copyAll: false }
    }
  }
}

export function parseGdriveVideoInfo(input: string): GdriveVideoInfo | null {
  if (input.length === 0 || input.length > MAX_VIDEO_INFO_LENGTH) return null
  const data = new URLSearchParams(input)
  if (data.get('status') === 'fail') return null

  const sources: Array<{ file: string, type: 'video/mp4', label: string }> = []
  const seen = new Set<string>()
  for (const entry of (data.get('fmt_stream_map') ?? '').split(',')) {
    const separator = entry.indexOf('|')
    if (separator <= 0) continue
    const itag = entry.slice(0, separator).trim()
    const file = safeGoogleMediaUrl(entry.slice(separator + 1))
    if (file === '' || seen.has(file)) continue
    seen.add(file)
    sources.push({ file, type: 'video/mp4', label: googleVideoLabel(itag) })
  }

  const hlsFile = safeGoogleHlsUrl(
    data.get('hlsvp') ?? data.get('hls_manifest_url') ?? data.get('hlsManifestUrl') ?? ''
  )
  return Object.freeze({
    sources: Object.freeze(sources),
    ...(hlsFile === '' ? {} : { hls: Object.freeze({ file: hlsFile, type: 'hls' as const, label: 'Original' as const }) }),
    image: safeGoogleImageUrl(data.get('iurl') ?? ''),
    title: (data.get('title') ?? '').trim()
  })
}

function safeGoogleHlsUrl(value: string): string {
  if (value.length === 0 || value.length > 16_384) return ''
  try {
    const url = new URL(value.trim())
    const hostname = url.hostname.toLowerCase()
    const allowedHost = hostname === 'googlevideo.com' || hostname.endsWith('.googlevideo.com')
    const manifestPath = url.pathname.toLowerCase()
    return url.protocol === 'https:' && allowedHost && !url.username && !url.password &&
      (manifestPath.endsWith('.m3u8') || manifestPath.includes('/manifest/hls'))
      ? url.toString()
      : ''
  } catch {
    return ''
  }
}

function normalizeGdriveId(value: string): string {
  const trimmed = value.trim()
  try {
    const url = new URL(trimmed)
    const path = url.pathname.match(/\/(?:file\/d|d)\/([^/]+)/)?.[1]
    return path ?? url.searchParams.get('id') ?? url.searchParams.get('fileId') ?? ''
  } catch {
    return trimmed
  }
}

function isSafeGdriveId(value: string): boolean {
  return /^[A-Za-z0-9_-]{10,256}$/.test(value)
}

function safeGoogleMediaUrl(value: string): string {
  if (value.length === 0 || value.length > 16_384) return ''
  try {
    const url = new URL(value.trim())
    const hostname = url.hostname.toLowerCase()
    const allowedHost = hostname === 'googlevideo.com' || hostname.endsWith('.googlevideo.com') ||
      hostname === 'googleusercontent.com' || hostname.endsWith('.googleusercontent.com') ||
      hostname === 'drive.google.com' || hostname === 'docs.google.com'
    return url.protocol === 'https:' && allowedHost && !url.username && !url.password ? url.toString() : ''
  } catch {
    return ''
  }
}

function safeGoogleImageUrl(value: string): string {
  if (value.length === 0 || value.length > 16_384) return ''
  try {
    const url = new URL(value.trim())
    const hostname = url.hostname.toLowerCase()
    const allowedHost = hostname === 'googleusercontent.com' || hostname.endsWith('.googleusercontent.com') ||
      hostname === 'ggpht.com' || hostname.endsWith('.ggpht.com') ||
      hostname === 'google.com' || hostname.endsWith('.google.com')
    return url.protocol === 'https:' && allowedHost && !url.username && !url.password ? url.toString() : ''
  } catch {
    return ''
  }
}

function googleVideoLabel(itag: string): string {
  if (['17', '132', 'small'].includes(itag)) return '144p'
  if (['5', '36', '133'].includes(itag)) return '240p'
  if (['18', '34', '43', '82', '102', '134', 'medium'].includes(itag)) return '360p'
  if (['35', '44', '59', '135'].includes(itag)) return '480p'
  if (['22', '45', '84', '104', '136', 'hd720'].includes(itag)) return '720p'
  if (['37', '46', '137', 'hd1080'].includes(itag)) return '1080p'
  if (['140', '264'].includes(itag)) return '1440p'
  if (itag === '266') return '2160p'
  if (itag === '38') return 'Original'
  return 'Unknown'
}
