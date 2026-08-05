import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const ARCHIVE_REFERER = 'https://archive.org/'
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'wav'])
const TRACK_EXTENSIONS = new Set(['vtt', 'srt'])

type JsonObject = Record<string, unknown>

export class ArchiveExtractor extends BaseExtractor {
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
    if (this.#loaded || !isSafeIdentifier(this.id)) return
    this.#loaded = true
    this.referer = ARCHIVE_REFERER
    try {
      const response = await this.http.get({
        url: `https://archive.org/metadata/${encodeURIComponent(this.id)}`,
        headers: { referer: this.referer }
      })
      if (response.status < 200 || response.status >= 300) return
      const payload = parseObject(response.body)
      if (payload === null) return
      const metadata = objectValue(payload.metadata)
      this.title = firstString(metadata?.title) || firstString(metadata?.description)

      const files = Array.isArray(payload.files) ? payload.files : []
      const seenSources = new Set<string>()
      for (const value of files) {
        const file = objectValue(value)
        if (file === null || file.private === true || file.hidden === true) continue
        const name = stringValue(file.name)
        const url = archiveDownloadUrl(this.id, name)
        if (url === '') continue
        const extension = extensionOf(name)
        if (TRACK_EXTENSIONS.has(extension)) {
          this.tracks.push({ file: url, label: trackLabel(file, name) })
          continue
        }
        const type = mediaType(extension)
        if (type === '' || seenSources.has(url)) continue
        seenSources.add(url)
        this.sources.push({
          file: url,
          type,
          label: sourceLabel(file)
        })
      }

      const thumbnail = files
        .map(objectValue)
        .find((file) => stringValue(file?.name) === '__ia_thumb.jpg')
      this.image = thumbnail === undefined ? '' : archiveDownloadUrl(this.id, '__ia_thumb.jpg')
    } catch {
      // Invalid or unavailable provider responses produce an empty result.
    }
  }
}

function mediaType(extension: string): '' | 'hls' | 'mpd' | 'video/mp4' {
  if (extension === 'm3u8') return 'hls'
  if (extension === 'mpd') return 'mpd'
  if (VIDEO_EXTENSIONS.has(extension) || AUDIO_EXTENSIONS.has(extension)) return 'video/mp4'
  return ''
}

function sourceLabel(file: JsonObject): string {
  const height = positiveInteger(file.height)
  if (height > 0) return `${height}p`
  return stringValue(file.format) || (stringValue(file.source) === 'original' ? 'Original' : 'Archive')
}

function trackLabel(file: JsonObject, name: string): string {
  return firstString(file.title) || firstString(file.language) || basenameWithoutExtension(name) || 'Unknown'
}

function archiveDownloadUrl(identifier: string, name: string): string {
  if (name.length === 0 || name.length > 2_048 || name.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    return ''
  }
  const filePath = name.split('/').map(encodeURIComponent).join('/')
  return `https://archive.org/download/${encodeURIComponent(identifier)}/${filePath}`
}

function extensionOf(name: string): string {
  const filename = name.split('/').at(-1) ?? ''
  const index = filename.lastIndexOf('.')
  return index < 0 ? '' : filename.slice(index + 1).toLowerCase()
}

function basenameWithoutExtension(name: string): string {
  const filename = name.split('/').at(-1) ?? ''
  const index = filename.lastIndexOf('.')
  return (index < 0 ? filename : filename.slice(0, index)).trim()
}

function firstString(value: unknown): string {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = stringValue(item)
      if (result !== '') return result
    }
    return ''
  }
  return stringValue(value)
}

function positiveInteger(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(stringValue(value), 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

function isSafeIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9._-]+$/.test(value)
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
