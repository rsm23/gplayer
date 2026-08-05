import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const VIMEO_REFERER = 'https://vimeo.com/'

type JsonObject = Record<string, unknown>

export class VimeoExtractor extends BaseExtractor {
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
    const pageUrl = playerUrl(this.id)
    if (pageUrl === null) return
    this.referer = VIMEO_REFERER
    try {
      const response = await this.http.get({
        url: pageUrl,
        headers: { referer: this.referer }
      })
      if (response.status < 200 || response.status >= 300) return
      const config = parseVimeoPlayerConfig(response.body)
      if (config === null) return
      const video = objectValue(config.video)
      this.title = stringValue(video?.title)
      this.image = remoteUrl(stringValue(video?.thumbnail_url))

      const request = objectValue(config.request)
      const files = objectValue(request?.files)
      const progressive = progressiveSources(files)
      if (this.downloadable) {
        this.sources.push(...progressive)
      } else {
        const hls = adaptiveUrl(objectValue(files?.hls))
        if (hls !== '') this.sources.push({ file: hls, type: 'hls', label: 'Original' })
        else this.sources.push(...progressive.slice(-1))
      }

      const textTracks = Array.isArray(request?.text_tracks)
        ? request.text_tracks
        : Array.isArray(config.text_tracks) ? config.text_tracks : []
      for (const value of textTracks) {
        const track = objectValue(value)
        const file = remoteUrl(stringValue(track?.url))
        if (file === '') continue
        const label = stringValue(track?.label) || stringValue(track?.lang) || 'Unknown'
        this.tracks.push({ file, label })
      }
    } catch {
      // Invalid or unavailable provider responses produce an empty result.
    }
  }
}

export function parseVimeoPlayerConfig(input: string): JsonObject | null {
  const match = /\bwindow\.playerConfig\s*=\s*/g.exec(input)
  if (match === null) return null
  const value = balancedJsonObject(input, match.index + match[0].length)
  if (value === '') return null
  try {
    return objectValue(JSON.parse(value))
  } catch {
    return null
  }
}

function progressiveSources(files: JsonObject | null) {
  const values = Array.isArray(files?.progressive) ? files.progressive : []
  const sources: Array<{ file: string; type: 'video/mp4'; label: string; height: number }> = []
  for (const value of values) {
    const source = objectValue(value)
    const file = remoteUrl(stringValue(source?.url))
    if (file === '') continue
    const height = positiveInteger(source?.height)
    sources.push({
      file,
      type: 'video/mp4',
      label: stringValue(source?.quality) || (height > 0 ? `${height}p` : 'Original'),
      height
    })
  }
  sources.sort((left, right) => left.height - right.height)
  return sources.map(({ height: _height, ...source }) => source)
}

function adaptiveUrl(adaptive: JsonObject | null): string {
  const cdns = objectValue(adaptive?.cdns)
  const preferredName = stringValue(adaptive?.default_cdn)
  const preferred = objectValue(cdns?.[preferredName])
  const preferredUrl = remoteUrl(stringValue(preferred?.url) || stringValue(preferred?.avc_url))
  if (preferredUrl !== '') return preferredUrl
  for (const value of Object.values(cdns ?? {})) {
    const cdn = objectValue(value)
    const url = remoteUrl(stringValue(cdn?.url) || stringValue(cdn?.avc_url))
    if (url !== '') return url
  }
  return ''
}

function playerUrl(id: string): URL | null {
  const match = id.match(/^(\d+)(?:\?h=([A-Za-z0-9_-]+))?$/)
  if (match === null) return null
  const url = new URL(`https://player.vimeo.com/video/${match[1] ?? ''}`)
  if (match[2] !== undefined) url.searchParams.set('h', match[2])
  return url
}

function balancedJsonObject(input: string, from: number): string {
  let start = from
  while (/\s/.test(input[start] ?? '')) start += 1
  if (input[start] !== '{') return ''
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < input.length; index += 1) {
    const character = input[index] ?? ''
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) return input.slice(start, index + 1)
  }
  return ''
}

function remoteUrl(value: string): string {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.toString()
      : ''
  } catch {
    return ''
  }
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
}
