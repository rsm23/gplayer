import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

export type MStreamPage = Readonly<{
  file: string
  title: string
  image: string
}>

export class MStreamExtractor extends BaseExtractor {
  #loaded = false
  readonly #pageUrl: URL | null

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
    this.#pageUrl = sharePointUrl(this.id)
    this.referer = this.#pageUrl?.toString() ?? ''
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || this.#pageUrl === null) return
    this.#loaded = true
    try {
      const response = await this.http.get({ url: this.#pageUrl, preserveRedirectCookies: true })
      if (response.status < 200 || response.status >= 300 || !isSharePointUrl(response.url)) return
      const page = parseMStreamPage(response.body)
      if (page === null || !isMicrosoftMediaUrl(page.file)) return
      this.sources.push({ file: page.file, type: 'video/mp4', label: 'Original' })
      this.title = page.title
      this.image = page.image
    } catch {
      // Invalid or unavailable provider responses produce an empty result.
    }
  }
}

export function parseMStreamPage(input: string): MStreamPage | null {
  const file = firstStringField(input, 'downloadUrl')
  if (!isMicrosoftMediaUrl(file)) return null
  const transform = firstStringField(input, 'transformUrl')
  const legacyTitle = input.match(/=\s*\{\s*["']name["']\s*:\s*("(?:\\.|[^"\\])*")/i)?.[1]
  const title = decodeStringLiteral(legacyTitle ?? '') || metaValue(input, 'og:title')
  return Object.freeze({
    file,
    title,
    image: isMicrosoftMediaUrl(transform) ? `${transform}${transform.includes('?') ? '&' : '?'}width=1024&height=720` : ''
  })
}

function firstStringField(input: string, field: string): string {
  const literal = new RegExp(`(?:["']?${escapeRegExp(field)}["']?)\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, 'i').exec(input)?.[1]
  return decodeStringLiteral(literal ?? '')
}

function decodeStringLiteral(value: string): string {
  if (value === '') return ''
  try {
    const decoded: unknown = JSON.parse(value)
    return typeof decoded === 'string' ? decodeHtml(decoded.trim()) : ''
  } catch {
    return ''
  }
}

function metaValue(input: string, property: string): string {
  const escaped = escapeRegExp(property)
  const patterns = [
    new RegExp(`<meta\\b(?=[^>]*\\bproperty=["']${escaped}["'])[^>]*\\bcontent=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta\\b(?=[^>]*\\bcontent=["']([^"']*)["'])[^>]*\\bproperty=["']${escaped}["'][^>]*>`, 'i')
  ]
  for (const pattern of patterns) {
    const value = pattern.exec(input)?.[1]
    if (value !== undefined) return decodeHtml(value.trim())
  }
  return ''
}

function sharePointUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return isSharePointUrl(url) ? url : null
  } catch {
    return null
  }
}

function isSharePointUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase()
  return url.protocol === 'https:' && !url.username && !url.password && (
    hostname === 'sharepoint.com' || hostname.endsWith('.sharepoint.com')
  )
}

function isMicrosoftMediaUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    return url.protocol === 'https:' && !url.username && !url.password && (
      hostname === 'sharepoint.com' || hostname.endsWith('.sharepoint.com') ||
      hostname === 'sharepointonline.com' || hostname.endsWith('.sharepointonline.com') ||
      hostname === 'sharepoint-df.com' || hostname.endsWith('.sharepoint-df.com') ||
      hostname === '1drv.com' || hostname.endsWith('.1drv.com') ||
      hostname === 'onedrive.com' || hostname.endsWith('.onedrive.com')
    )
  } catch {
    return false
  }
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
