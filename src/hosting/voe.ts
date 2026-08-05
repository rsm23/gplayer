import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient, ProviderHttpResponse } from './provider-http.js'

const VOE_ORIGIN = 'https://voe.sx'
const MAX_PAYLOAD_LENGTH = 1_024 * 1_024
const MAX_MEDIA_URL_LENGTH = 16_384
const PAYLOAD_MARKERS = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'] as const
const VOE_PAGE_HOSTS = new Set([
  'voe.sx',
  'www.voe.sx',
  'jessicachoosemake.com',
  'boonlessbestselling244.com',
  'josephseveralconcern.com',
  'phenomenalityuniform.com'
])

type JsonObject = Record<string, unknown>

export type VoePage = Readonly<{
  source: string
  title: string
  image: string
  tracks: readonly Readonly<{
    file: string
    label: string
    kind?: string
    default?: boolean
  }>[]
}>

export class VoeExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(normalizeVoeId(id))
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
    if (this.#loaded || !isSafeVoeId(this.id)) return
    this.#loaded = true

    const embedUrl = new URL(`/e/${encodeURIComponent(this.id)}`, VOE_ORIGIN)
    this.referer = embedUrl.toString()
    try {
      let response = await this.http.get({ url: embedUrl, headers: { referer: this.referer } })
      if (!isSuccessfulVoeResponse(response)) return

      if (isVoeOrigin(response.url)) {
        const redirect = parseVoeRedirect(response.body, this.id)
        if (redirect !== null) {
          response = await this.http.get({ url: redirect, headers: { referer: this.referer } })
          if (!isSuccessfulVoeResponse(response) || response.url.hostname !== redirect.hostname) return
        }
      }

      const page = parseVoePage(response.body, response.url)
      if (page === null || page.source === '') return
      this.sources.push({ file: page.source, type: 'hls', label: 'Original' })
      this.tracks.push(...page.tracks)
      this.title = page.title
      this.image = page.image
    } catch {
      // Invalid, expired, restricted, or unavailable provider responses produce an empty result.
    }
  }
}

export function parseVoeRedirect(input: string, expectedId: string): URL | null {
  if (!isSafeVoeId(expectedId) || input.length > MAX_PAYLOAD_LENGTH) return null
  const pattern = /\bwindow\s*\.\s*location\s*\.\s*href\s*=\s*(["'])(https:\/\/[^"']+)\1/gi
  for (const match of input.matchAll(pattern)) {
    try {
      const url = new URL(decodeHtml(match[2] ?? ''))
      if (isAllowedVoePageUrl(url, expectedId)) return url
    } catch {
      // Continue looking for another literal redirect in the trusted VOE shell.
    }
  }
  return null
}

export function parseVoePage(input: string, pageUrl: URL): VoePage | null {
  if (!isAllowedVoePageUrl(pageUrl) || input.length > 5 * MAX_PAYLOAD_LENGTH) return null
  const config = decodeVoeConfig(input)
  if (config === null) return null

  const candidates: unknown[] = [config.source]
  if (Array.isArray(config.fallback)) candidates.push(...config.fallback)
  let source = ''
  for (const candidate of candidates) {
    const value = typeof candidate === 'string'
      ? candidate
      : stringValue(objectValue(candidate)?.file) || stringValue(objectValue(candidate)?.url)
    const url = safeRemoteUrl(value, pageUrl)
    if (url !== '' && isHlsUrl(url)) {
      source = url
      break
    }
  }
  if (source === '') return null

  const tracks = Array.isArray(config.captions)
    ? config.captions.flatMap((value) => {
        const caption = objectValue(value)
        const file = safeRemoteUrl(stringValue(caption?.file) || stringValue(caption?.id), pageUrl)
        const label = stringValue(caption?.label)
        if (file === '' || file === 'off' || label.toLowerCase() === 'off') return []
        const kind = stringValue(caption?.kind)
        return [{
          file,
          label: label || 'Subtitles',
          ...(kind === '' ? {} : { kind }),
          ...(caption?.default === true ? { default: true } : {})
        }]
      })
    : []

  const payloadTitle = stringValue(config.title)
  const payloadImage = safeRemoteUrl(stringValue(config.thumbnail), pageUrl)
  return Object.freeze({
    source,
    title: payloadTitle || metaValue(input, 'og:title'),
    image: payloadImage || safeRemoteUrl(metaValue(input, 'og:image'), pageUrl),
    tracks: Object.freeze(tracks)
  })
}

export function decodeVoeConfig(input: string): JsonObject | null {
  if (input.length > 5 * MAX_PAYLOAD_LENGTH) return null
  const scripts = input.matchAll(
    /<script\b(?=[^>]*\btype\s*=\s*["']application\/json["'])[^>]*>([\s\S]*?)<\/script\s*>/gi
  )
  for (const match of scripts) {
    const content = match[1] ?? ''
    if (content.length > MAX_PAYLOAD_LENGTH) continue
    try {
      const envelope: unknown = JSON.parse(content)
      if (!Array.isArray(envelope) || typeof envelope[0] !== 'string') continue
      const decoded = decodeVoePayload(envelope[0])
      if (decoded !== null) return decoded
    } catch {
      // Ignore unrelated JSON data blocks and continue to the provider payload.
    }
  }
  return null
}

export function decodeVoePayload(input: string): JsonObject | null {
  if (input.length < 64 || input.length > MAX_PAYLOAD_LENGTH) return null
  try {
    let normalized = rot13(input)
    for (const marker of PAYLOAD_MARKERS) normalized = normalized.replaceAll(marker, '_')
    const firstLayer = decodeBase64Binary(normalized.replaceAll('_', ''))
    if (firstLayer === null) return null

    let shifted = ''
    for (let index = 0; index < firstLayer.length; index++) {
      const code = firstLayer.charCodeAt(index)
      if (code < 3) return null
      shifted += String.fromCharCode(code - 3)
    }
    const json = decodeBase64Binary([...shifted].reverse().join(''))
    if (json === null || json.length > MAX_PAYLOAD_LENGTH) return null
    return objectValue(JSON.parse(json))
  } catch {
    return null
  }
}

function decodeBase64Binary(value: string): string | null {
  if (value.length === 0 || value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null
  try {
    return Buffer.from(value, 'base64').toString('latin1')
  } catch {
    return null
  }
}

function normalizeVoeId(value: string): string {
  const trimmed = value.trim()
  const parts = trimmed.split('/').filter(Boolean)
  return parts.at(-1) ?? ''
}

function isSafeVoeId(value: string): boolean {
  return /^[A-Za-z0-9]{6,64}$/.test(value)
}

function isSuccessfulVoeResponse(response: ProviderHttpResponse): boolean {
  return response.status >= 200 && response.status < 300 && isAllowedVoePageUrl(response.url)
}

function isAllowedVoePageUrl(url: URL, expectedId = ''): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !VOE_PAGE_HOSTS.has(url.hostname)) return false
  if (expectedId === '') return true
  return url.pathname === `/e/${expectedId}` && url.hash === ''
}

function isVoeOrigin(url: URL): boolean {
  return url.hostname === 'voe.sx' || url.hostname === 'www.voe.sx'
}

function isHlsUrl(value: string): boolean {
  try {
    return new URL(value).pathname.toLowerCase().includes('.m3u8')
  } catch {
    return false
  }
}

function safeRemoteUrl(value: string, base: URL): string {
  if (value.length === 0 || value.length > MAX_MEDIA_URL_LENGTH) return ''
  try {
    const url = new URL(decodeHtml(value), base)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.toString()
      : ''
  } catch {
    return ''
  }
}

function metaValue(input: string, property: string): string {
  const escaped = escapeRegExp(property)
  const patterns = [
    new RegExp(`<meta\\b(?=[^>]*\\b(?:property|name)=["']${escaped}["'])[^>]*\\bcontent=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta\\b(?=[^>]*\\bcontent=["']([^"']*)["'])[^>]*\\b(?:property|name)=["']${escaped}["'][^>]*>`, 'i')
  ]
  for (const pattern of patterns) {
    const value = pattern.exec(input)?.[1]
    if (value !== undefined) return decodeHtml(value.trim())
  }
  return ''
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
}

function rot13(value: string): string {
  return value.replace(/[A-Za-z]/g, (character) => {
    const base = character <= 'Z' ? 65 : 97
    return String.fromCharCode(base + (character.charCodeAt(0) - base + 13) % 26)
  })
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
