import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const FIRELOAD_ORIGIN = 'https://www.fireload.com/'
const MAX_PLAYER_OBJECT_BYTES = 16 * 1_024

type JsonObject = Record<string, unknown>

export type FireloadPage = Readonly<{
  file: string
  title: string
  image: string
}>

export class FireloadExtractor extends BaseExtractor {
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
    const pageUrl = new URL(encodeURIComponent(this.id), FIRELOAD_ORIGIN)
    this.referer = pageUrl.toString()
    try {
      const response = await this.http.get({ url: pageUrl })
      if (response.status < 200 || response.status >= 300 || !isFireloadUrl(response.url)) return
      const page = parseFireloadPage(response.body)
      if (page === null || !isExpectedMediaUrl(page.file, this.id)) return
      this.title = page.title
      this.image = page.image
      this.sources.push({ file: page.file, type: 'video/mp4', label: 'Original' })
    } catch {
      // Invalid or unavailable provider responses produce an empty result.
    }
  }
}

export function parseFireloadPage(input: string): FireloadPage | null {
  const player = jsonAssignment(input, 'window.Fl')
  const file = stringValue(player?.dlink)
  if (!isHttpUrl(file)) return null
  return Object.freeze({
    file: decodeHtml(file),
    title: openGraphValue(input, 'title').replace(/\s*[|-]\s*Fireload\s*$/i, '').trim(),
    image: openGraphValue(input, 'image')
  })
}

function jsonAssignment(input: string, name: string): JsonObject | null {
  const pattern = new RegExp(`${escapeRegExp(name)}\\s*=\\s*\\{`, 'g')
  const match = pattern.exec(input)
  if (match === null) return null
  const start = match.index + match[0].lastIndexOf('{')
  const json = balancedObject(input, start)
  if (json === '') return null
  try {
    const value: unknown = JSON.parse(json)
    return objectValue(value)
  } catch {
    return null
  }
}

function balancedObject(input: string, start: number): string {
  let depth = 0
  let escaped = false
  let quoted = false
  const limit = Math.min(input.length, start + MAX_PLAYER_OBJECT_BYTES)
  for (let index = start; index < limit; index++) {
    const character = input[index] ?? ''
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === '{') depth++
    else if (character === '}' && --depth === 0) return input.slice(start, index + 1)
  }
  return ''
}

function openGraphValue(input: string, property: 'title' | 'image'): string {
  const name = `og:${property}`
  const patterns = [
    new RegExp(`<meta\\b(?=[^>]*\\bproperty=["']${name}["'])[^>]*\\bcontent=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta\\b(?=[^>]*\\bcontent=["']([^"']*)["'])[^>]*\\bproperty=["']${name}["'][^>]*>`, 'i')
  ]
  for (const pattern of patterns) {
    const value = pattern.exec(input)?.[1]
    if (value !== undefined) return decodeHtml(value.trim())
  }
  return ''
}

function isExpectedMediaUrl(value: string, id: string): boolean {
  try {
    const url = new URL(value)
    return isFireloadUrl(url) && url.pathname.startsWith(`/${id}/`) && url.pathname.length > id.length + 2
  } catch {
    return false
  }
}

function isFireloadUrl(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password &&
    (url.hostname === 'fireload.com' || url.hostname === 'www.fireload.com')
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,256}$/.test(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
}

function decodeHtml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
