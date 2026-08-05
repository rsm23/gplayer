import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

type JsonObject = Record<string, unknown>

type StreamableSource = Readonly<{
  file: string
  type: 'video/mp4'
  label: string
  height: number
}>

export class StreamableExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || !isSafeId(this.id)) return
    this.#loaded = true
    try {
      const pageUrl = new URL(`https://streamable.com/e/${encodeURIComponent(this.id)}`)
      const response = await this.http.get({ url: pageUrl })
      if (response.status < 200 || response.status >= 300) return
      const video = parseStreamableVideoObject(response.body)
      if (video === null) return

      this.title = stringValue(video.title) || stringValue(video.original_name)
      this.image = remoteUrl(stringValue(video.poster_url) || stringValue(video.thumbnail_url), response.url)

      const files = objectValue(video.files)
      const candidates: StreamableSource[] = []
      for (const value of Object.values(files ?? {})) {
        const file = objectValue(value)
        if (file === null || (typeof file.status === 'number' && file.status !== 2)) continue
        const url = remoteUrl(stringValue(file.url), response.url)
        if (url === '') continue
        const height = positiveInteger(file.height)
        candidates.push({
          file: url,
          type: 'video/mp4',
          label: height > 0 ? `${height}p` : 'Original',
          height
        })
      }
      candidates.sort((left, right) => right.height - left.height)
      const selected = this.downloadable ? candidates : candidates.slice(0, 1)
      this.sources.push(...selected.map(({ height: _height, ...source }) => source))
    } catch {
      // Invalid or unavailable provider responses produce an empty result.
    }
  }
}

export function parseStreamableVideoObject(input: string): JsonObject | null {
  const match = /\b(?:var|let|const)\s+videoObject\s*=\s*/g.exec(input)
  if (match === null) return null
  const start = match.index + match[0].length
  const value = balancedJsonObject(input, start)
  if (value === '') return null
  try {
    return objectValue(JSON.parse(value))
  } catch {
    return null
  }
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

function isSafeId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[/?#\\\s]/.test(value)
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
