import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

type JsonObject = Record<string, unknown>

export class DzenExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || this.id.length === 0) return
    this.#loaded = true
    const direct = safeHttpUrl(this.id)
    if (direct !== '') {
      this.title = basename(new URL(direct).pathname)
      this.sources.push({ file: direct, type: mediaType(direct, ''), label: 'Original' })
      return
    }

    try {
      const response = await this.http.get({ url: `https://dzen.ru/embed/${encodeURIComponent(this.id)}` })
      if (response.status < 200 || response.status >= 300) return
      const payload = parseParamsObject(response.body)
      const ssrData = objectValue(payload?.ssrData)
      const exportResponse = objectValue(ssrData?.exportResponse)
      const content = objectValue(exportResponse?.content)
      const streams = Array.isArray(content?.streams) ? content.streams : []
      const stream = streams.map(objectValue).find((value) => value !== null)
      if (stream === undefined || stream === null || typeof stream.url !== 'string') return
      const file = safeHttpUrl(stream.url)
      if (file === '') return

      this.title = typeof content?.title === 'string' ? content.title : ''
      this.image = typeof content?.thumbnail === 'string' ? safeHttpUrl(content.thumbnail) : ''
      this.sources.push({
        file,
        type: mediaType(file, typeof stream.type === 'string' ? stream.type : ''),
        label: 'Original'
      })
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
    }
  }
}

export function parseDzenParams(input: string): JsonObject | null {
  return parseParamsObject(input)
}

function parseParamsObject(input: string): JsonObject | null {
  const marker = /\bparams\s*=\s*\(/i.exec(input)
  if (marker === null) return null
  const start = (marker.index ?? 0) + marker[0].length
  const end = matchingParenthesis(input, start)
  if (end < start) return null
  const value = input.slice(start, end).trim()
  try {
    return objectValue(JSON.parse(value))
  } catch {
    return null
  }
}

function matchingParenthesis(input: string, contentStart: number): number {
  let depth = 1
  let quote = ''
  let escaped = false
  for (let index = contentStart; index < input.length; index += 1) {
    const character = input[index] ?? ''
    if (quote !== '') {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') depth += 1
    else if (character === ')' && --depth === 0) return index
  }
  return -1
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
}

function safeHttpUrl(value: string): string {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.toString()
      : ''
  } catch {
    return ''
  }
}

function mediaType(file: string, explicit: string): 'hls' | 'mpd' | 'video/mp4' {
  const type = explicit.toLowerCase()
  const pathname = new URL(file).pathname.toLowerCase()
  if (type.includes('hls') || type.includes('mpegurl') || pathname.includes('.m3u')) return 'hls'
  if (type.includes('dash') || type.includes('mpd') || pathname.includes('.mpd')) return 'mpd'
  return 'video/mp4'
}

function basename(pathname: string): string {
  const value = pathname.split('/').filter(Boolean).at(-1) ?? ''
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
