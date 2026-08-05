import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

export type YetiShareConfig = Readonly<{
  pageUrl: (id: string) => string | URL
}>

type ParsedYetiSharePage = Readonly<{
  sources: readonly Readonly<Record<string, unknown>>[]
  tracks: readonly Readonly<Record<string, unknown>>[]
  image: string
  title: string
}>

/**
 * Conservative compatibility parser for YetiShare-backed hosts.
 *
 * The legacy shared YetiShare class is ionCube-protected, so this adapter only
 * consumes media metadata that is already present in the public file page. It
 * deliberately does not execute scripts, submit countdown forms, or solve
 * CAPTCHA challenges.
 */
export class YetiShareExtractor extends BaseExtractor {
  #loaded = false

  public constructor(
    id: string,
    private readonly http: ProviderHttpClient,
    private readonly config: YetiShareConfig
  ) {
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
    if (this.#loaded || this.id.length === 0) return
    this.#loaded = true
    try {
      const requestedUrl = new URL(this.config.pageUrl(this.id))
      const response = await this.http.get({
        url: requestedUrl,
        headers: { referer: requestedUrl.origin }
      })
      if (response.status < 200 || response.status >= 300) return

      const parsed = parseYetiSharePage(response.body, response.url)
      this.sources.push(...parsed.sources)
      this.tracks.push(...parsed.tracks)
      this.image = parsed.image
      this.title = parsed.title
      this.referer = response.url.toString()
      this.cookies = responseCookies(response.headers)
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
    }
  }
}

export function parseYetiSharePage(input: string, pageUrl: string | URL): ParsedYetiSharePage {
  const baseUrl = new URL(pageUrl)
  const sources: Record<string, unknown>[] = []
  const tracks: Record<string, unknown>[] = []
  const seenSources = new Set<string>()
  const seenTracks = new Set<string>()

  const appendSource = (value: string, explicitType = '', label = ''): void => {
    const file = safeRemoteUrl(value, baseUrl)
    if (file === '' || seenSources.has(file)) return
    seenSources.add(file)
    sources.push({ file, type: mediaType(file, explicitType), label: cleanText(label) || 'Original' })
  }

  for (const attributes of tagAttributes(input, 'video')) {
    appendSource(attributes.src ?? '', attributes.type, attributes.label ?? attributes['data-label'])
  }
  for (const attributes of tagAttributes(input, 'source')) {
    appendSource(
      attributes.src ?? '',
      attributes.type,
      attributes.label ?? attributes['data-label'] ?? attributes.res ?? attributes['data-res']
    )
  }

  for (const block of arrayBlocks(input, 'sources')) {
    for (const object of objectBlocks(block)) {
      appendSource(
        stringField(object, ['file', 'src', 'url']),
        stringField(object, ['type']),
        stringField(object, ['label', 'res', 'height'])
      )
    }
  }

  if (sources.length === 0 && /jwplayer|videojs|video-js/i.test(input)) {
    appendSource(
      stringField(input, ['file']),
      stringField(input, ['type']),
      stringField(input, ['label'])
    )
  }

  for (const attributes of tagAttributes(input, 'meta')) {
    const name = (attributes.property ?? attributes.name ?? '').toLowerCase()
    if (name === 'og:video' || name === 'og:video:url' || name === 'og:video:secure_url') {
      appendSource(attributes.content ?? '', attributes.type)
    }
  }

  for (const attributes of tagAttributes(input, 'a')) {
    if (!isDirectDownloadAnchor(attributes)) continue
    appendSource(attributes['data-download-url'] ?? attributes['data-url'] ?? attributes.href ?? '')
  }

  for (const attributes of tagAttributes(input, 'track')) {
    const file = safeRemoteUrl(attributes.src ?? '', baseUrl)
    if (file === '' || seenTracks.has(file)) continue
    seenTracks.add(file)
    tracks.push({
      file,
      label: cleanText(attributes.label ?? attributes.srclang ?? ''),
      kind: cleanText(attributes.kind ?? '') || 'captions'
    })
  }

  const image = firstSafeUrl([
    ...tagAttributes(input, 'video').map((attributes) => attributes.poster ?? ''),
    ...metaValues(input, ['og:image', 'twitter:image'])
  ], baseUrl)

  return Object.freeze({
    sources,
    tracks,
    image,
    title: firstText([
      ...metaValues(input, ['og:title', 'twitter:title']),
      tagText(input, 'h1'),
      tagText(input, 'title')
    ])
  })
}

type HtmlAttributes = Readonly<Record<string, string>>

function tagAttributes(input: string, tag: string): HtmlAttributes[] {
  const pattern = new RegExp(`<${escapeRegExp(tag)}\\b([^>]*)>`, 'gi')
  return [...input.matchAll(pattern)].map((match) => parseAttributes(match[1] ?? ''))
}

function parseAttributes(input: string): HtmlAttributes {
  const result: Record<string, string> = {}
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
  for (const match of input.matchAll(pattern)) {
    const name = (match[1] ?? '').toLowerCase()
    if (name.length === 0) continue
    result[name] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return result
}

function metaValues(input: string, names: readonly string[]): string[] {
  const accepted = new Set(names.map((name) => name.toLowerCase()))
  return tagAttributes(input, 'meta').flatMap((attributes) => {
    const name = (attributes.property ?? attributes.name ?? '').toLowerCase()
    return accepted.has(name) && attributes.content !== undefined ? [attributes.content] : []
  })
}

function tagText(input: string, tag: string): string {
  const value = input.match(new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tag)}>`, 'i'))?.[1]
  return value === undefined ? '' : cleanText(value)
}

function isDirectDownloadAnchor(attributes: HtmlAttributes): boolean {
  const candidate = attributes['data-download-url'] ?? attributes['data-url'] ?? attributes.href ?? ''
  if (candidate.length === 0) return false
  const markers = `${attributes.id ?? ''} ${attributes.class ?? ''}`.toLowerCase().split(/\s+/)
  if ('download' in attributes) return true
  if (markers.some((marker) => ['download-file', 'download-btn', 'download-button', 'file-download'].includes(marker))) return true
  return /(?:\?|&)download_token=[^&]+/i.test(decodeHtml(candidate)) && hasMediaExtension(candidate)
}

function hasMediaExtension(value: string): boolean {
  try {
    return /\.(?:avi|flv|m2ts|m3u8|mkv|mov|mp4|mpd|mpeg|mpg|ogv|ts|webm)$/i.test(new URL(value, 'https://example.invalid').pathname)
  } catch {
    return false
  }
}

function arrayBlocks(input: string, field: string): string[] {
  const result: string[] = []
  const pattern = new RegExp(`(?:["']?${escapeRegExp(field)}["']?)\\s*[:=]\\s*\\[`, 'gi')
  for (const match of input.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].lastIndexOf('[')
    const end = matchingBracket(input, start, '[', ']')
    if (end > start) result.push(input.slice(start + 1, end))
  }
  return result
}

function objectBlocks(input: string): string[] {
  const result: string[] = []
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== '{') continue
    const end = matchingBracket(input, index, '{', '}')
    if (end <= index) continue
    result.push(input.slice(index + 1, end))
    index = end
  }
  return result
}

function matchingBracket(input: string, start: number, open: string, close: string): number {
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = start; index < input.length; index += 1) {
    const character = input[index] ?? ''
    if (quote !== '') {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === open) depth += 1
    else if (character === close && --depth === 0) return index
  }
  return -1
}

function stringField(input: string, fields: readonly string[]): string {
  const names = fields.map(escapeRegExp).join('|')
  const match = input.match(new RegExp(`(?:["']?(?:${names})["']?)\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`, 'i'))
  const literal = match?.[1]
  if (literal === undefined) return ''
  return decodeJavascriptString(literal)
}

function decodeJavascriptString(literal: string): string {
  const quote = literal[0]
  if ((quote !== '"' && quote !== "'") || literal.at(-1) !== quote) return ''
  let result = ''
  for (let index = 1; index < literal.length - 1; index += 1) {
    const character = literal[index] ?? ''
    if (character !== '\\') {
      result += character
      continue
    }
    const escaped = literal[++index] ?? ''
    if (escaped === 'x' && /^[\dA-Fa-f]{2}$/.test(literal.slice(index + 1, index + 3))) {
      result += String.fromCodePoint(Number.parseInt(literal.slice(index + 1, index + 3), 16))
      index += 2
    } else if (escaped === 'u' && /^[\dA-Fa-f]{4}$/.test(literal.slice(index + 1, index + 5))) {
      result += String.fromCodePoint(Number.parseInt(literal.slice(index + 1, index + 5), 16))
      index += 4
    } else {
      result += ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[escaped] ?? escaped
    }
  }
  return decodeHtml(result.replaceAll('\\/', '/'))
}

function safeRemoteUrl(value: string, baseUrl: URL): string {
  const normalized = decodeHtml(value).trim()
  if (normalized.length === 0) return ''
  try {
    const url = new URL(normalized, baseUrl)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return ''
    return url.toString()
  } catch {
    return ''
  }
}

function firstSafeUrl(values: readonly string[], baseUrl: URL): string {
  for (const value of values) {
    const url = safeRemoteUrl(value, baseUrl)
    if (url !== '') return url
  }
  return ''
}

function mediaType(file: string, explicit: string | undefined): 'hls' | 'mpd' | 'video/mp4' {
  const normalizedType = (explicit ?? '').toLowerCase()
  const pathname = new URL(file).pathname.toLowerCase()
  if (normalizedType.includes('hls') || normalizedType.includes('mpegurl') || pathname.endsWith('.m3u8')) return 'hls'
  if (normalizedType.includes('dash') || normalizedType.includes('mpd') || pathname.endsWith('.mpd')) return 'mpd'
  return 'video/mp4'
}

function firstText(values: readonly string[]): string {
  for (const value of values) {
    const text = cleanText(value)
    if (text !== '') return text
  }
  return ''
}

function cleanText(value: string | undefined): string {
  return decodeHtml((value ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function responseCookies(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const values = typeof getSetCookie === 'function'
    ? getSetCookie.call(headers)
    : [headers.get('set-cookie') ?? '']
  return values.flatMap((header) => {
    const pair = header.split(';', 1)[0]?.trim() ?? ''
    return /^[^=;,\s]+=[^;,]*$/.test(pair) ? [pair] : []
  })
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
