import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

type JsonObject = Record<string, unknown>

export class MyMailRuExtractor extends BaseExtractor {
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
    if (this.#loaded || !/^\d{1,40}$/.test(this.id)) return
    this.#loaded = true
    this.referer = `https://my.mail.ru/video/embed/${this.id}`
    try {
      const response = await this.http.get({
        url: `https://my.mail.ru/+/video/meta/${this.id}`,
        headers: { referer: this.referer }
      })
      if (response.status < 200 || response.status >= 300) return
      const payload = parseObject(response.body)
      if (payload === null || payload.isPrivate === true) return
      const meta = objectValue(payload.meta)
      this.title = stringValue(meta?.title)
      this.image = remoteUrl(stringValue(meta?.poster), response.url)

      const videos = Array.isArray(payload.videos) ? payload.videos : []
      for (const value of videos) {
        const video = objectValue(value)
        const file = remoteUrl(stringValue(video?.url), response.url)
        if (file === '') continue
        this.sources.push({
          file,
          type: mediaType(file),
          label: stringValue(video?.key) || 'Original'
        })
      }

      const tracks = Array.isArray(payload.subtitles)
        ? payload.subtitles
        : Array.isArray(payload.tracks) ? payload.tracks : []
      for (const value of tracks) {
        const track = objectValue(value)
        const file = remoteUrl(stringValue(track?.url) || stringValue(track?.file), response.url)
        if (file === '') continue
        this.tracks.push({
          file,
          label: stringValue(track?.label) || stringValue(track?.language) || 'Unknown'
        })
      }
    } catch {
      // Invalid or unavailable provider responses produce an empty result.
    }
  }
}

function mediaType(file: string): 'hls' | 'mpd' | 'video/mp4' {
  const pathname = new URL(file).pathname.toLowerCase()
  if (pathname.endsWith('.m3u8')) return 'hls'
  if (pathname.endsWith('.mpd')) return 'mpd'
  return 'video/mp4'
}

function remoteUrl(value: string, base: URL): string {
  try {
    const url = new URL(value, base)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.toString()
      : ''
  } catch {
    return ''
  }
}

function parseObject(value: string): JsonObject | null {
  try {
    return objectValue(JSON.parse(value))
  } catch {
    return null
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
}
