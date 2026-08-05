import type { MediaSource } from '../core/source-resolver.js'
import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const HLS_KEYS = new Set([
  'hlsMasterPlaylistUrl',
  'hlsPlaybackMasterPlaylistUrl',
  'hlsManifestUrl',
  'ondemandHls',
  'liveCmafUrl'
])
const MPD_KEYS = new Set(['dashSepUrl'])
const RESOLUTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  mobile: '144p',
  lowest: '240p',
  low: '360p',
  sd: '480p',
  hd: '720p',
  full: '1080p',
  quad: '1440p',
  ultra: '2160p'
})

type JsonObject = Record<string, unknown>

export class OkruExtractor extends BaseExtractor {
  readonly #mp4Sources: MediaSource[] = []
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
  }

  public override async getSources() {
    await this.load()
    if (this.downloadable && this.#mp4Sources.length > 0) return this.#mp4Sources
    return this.sources.length > 0 ? this.sources : this.#mp4Sources
  }

  public override async getTracks() {
    await this.load()
    return this.tracks
  }

  private async load(): Promise<void> {
    if (this.#loaded || this.id.length === 0) return
    this.#loaded = true
    try {
      const response = await this.http.get({ url: `https://ok.ru/videoembed/${encodeURIComponent(this.id)}` })
      if (response.status < 200 || response.status >= 300) return
      const dataOptions = attributeValue(response.body, 'data-options')
      const options = parseObject(decodeHtml(dataOptions))
      const flashvars = objectValue(options?.flashvars)
      const metadata = parseObjectValue(flashvars?.metadata)
      if (metadata === null) return

      this.image = typeof options?.poster === 'string' ? safeHttpUrl(options.poster) : ''
      this.parseMetadata(metadata)
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
    }
  }

  private parseMetadata(metadata: JsonObject): void {
    const movie = objectValue(metadata.movie)
    this.title = typeof movie?.title === 'string' ? movie.title : ''

    const subtitleTracks = Array.isArray(movie?.subtitleTracks) ? movie.subtitleTracks : []
    for (const value of subtitleTracks) {
      const track = objectValue(value)
      if (track === null || typeof track.url !== 'string') continue
      const file = safeHttpUrl(track.url.startsWith('//') ? `https:${track.url}` : track.url)
      if (file === '') continue
      const language = typeof track.language === 'string' ? track.language : ''
      this.tracks.push({ file, label: languageLabel(language) })
    }

    const collage = objectValue(movie?.collageInfo)
    if (typeof collage?.url === 'string') {
      const file = safeHttpUrl(collage.url)
      if (file !== '') {
        this.filmstrip = `${file}#count=${scalar(collage.count)}&frequency=${scalar(collage.frequency)}`
      }
    }

    if (Array.isArray(metadata.videos)) {
      for (const value of metadata.videos) {
        const video = objectValue(value)
        if (video === null || typeof video.url !== 'string') continue
        const file = safeHttpUrl(video.url)
        if (file === '') continue
        const name = typeof video.name === 'string' ? video.name : ''
        this.#mp4Sources.push({
          file,
          type: 'video/mp4',
          label: (RESOLUTION_LABELS[name] ?? name) || 'Original'
        })
      }
    }

    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value !== 'string') continue
      const file = safeHttpUrl(value)
      if (file === '') continue
      if (HLS_KEYS.has(key)) this.sources.push({ file, type: 'hls', label: 'Original' })
      else if (MPD_KEYS.has(key)) this.sources.push({ file, type: 'mpd', label: 'Original' })
    }
  }
}

export function parseOkruOptions(input: string): JsonObject | null {
  return parseObject(decodeHtml(attributeValue(input, 'data-options')))
}

function attributeValue(input: string, name: string): string {
  const match = input.match(new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
  return match?.[1] ?? match?.[2] ?? ''
}

function parseObjectValue(value: unknown): JsonObject | null {
  if (typeof value === 'string') return parseObject(value)
  return objectValue(value)
}

function parseObject(value: string): JsonObject | null {
  try {
    return objectValue(JSON.parse(value))
  } catch {
    return null
  }
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
}

function languageLabel(value: string): string {
  if (value === '') return 'Default'
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(value) ?? value
  } catch {
    return value
  }
}

function scalar(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function safeHttpUrl(value: string): string {
  try {
    const url = new URL(decodeHtml(value))
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
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\dA-Fa-f]+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
