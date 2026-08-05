import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

export type XFileSharingConfig = Readonly<{
  embedUrl: (id: string) => string | URL
  titleUrl?: (id: string) => string | URL
  referer?: string
  allowedResponseHosts?: readonly string[]
}>

export class XFileSharingExtractor extends BaseExtractor {
  #loaded = false

  public constructor(
    id: string,
    private readonly http: ProviderHttpClient,
    private readonly config: XFileSharingConfig
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
      const embedUrl = new URL(this.config.embedUrl(this.id))
      this.referer = this.config.referer ?? embedUrl.toString()
      const response = await this.http.get({ url: embedUrl, headers: { referer: this.config.referer ?? embedUrl.origin } })
      if (response.status < 200 || response.status >= 300 || !this.isAllowedResponse(response.url)) return
      const parsed = parseXFileSharingPage(response.body)
      this.sources.push(...parsed.sources)
      this.tracks.push(...parsed.tracks)
      this.image = parsed.image
      this.title = parsed.title

      if (this.config.titleUrl !== undefined) {
        const titleResponse = await this.http.get({ url: this.config.titleUrl(this.id) })
        if (titleResponse.status >= 200 && titleResponse.status < 300 && this.isAllowedResponse(titleResponse.url)) {
          this.title = extractHtmlTitle(decodeHtml(titleResponse.body)) || this.title
        }
      }
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
    }
  }

  private isAllowedResponse(url: URL): boolean {
    const allowed = this.config.allowedResponseHosts
    return allowed === undefined || allowed.some((hostname) => url.hostname === hostname || url.hostname.endsWith(`.${hostname}`))
  }
}

/**
 * Parses an XVFS/XFileSharing-style player page without evaluating its scripts.
 *
 * The legacy XVFS parser is also used as Direct's final fallback, so this entry
 * point deliberately accepts a complete HTML page instead of a provider ID.
 */
export function parseXFileSharingPage(input: string): ReturnType<typeof parseXFileSharingContent> {
  return parseXFileSharingContent(unpackPackerScripts(decodeHtml(input)))
}

export function parseXFileSharingContent(input: string): Readonly<{
  sources: readonly Readonly<Record<string, unknown>>[]
  tracks: readonly Readonly<Record<string, unknown>>[]
  image: string
  title: string
}> {
  const sources: Record<string, unknown>[] = []
  const tracks: Record<string, unknown>[] = []
  const seenSources = new Set<string>()
  const seenTracks = new Set<string>()

  for (const block of arrayBlocks(input, 'sources')) {
    for (const item of mediaItems(block)) {
      if (!isHttpUrl(item.file) || seenSources.has(item.file)) continue
      seenSources.add(item.file)
      sources.push({
        file: item.file,
        type: mediaType(item.file, item.type),
        label: item.label || 'Original'
      })
    }
  }
  if (sources.length === 0) {
    for (const item of mediaItems(input)) {
      if (!isHttpUrl(item.file) || !looksLikeMediaUrl(item.file) || seenSources.has(item.file)) continue
      seenSources.add(item.file)
      sources.push({ file: item.file, type: mediaType(item.file, item.type), label: item.label || 'Original' })
    }
  }

  for (const block of arrayBlocks(input, 'tracks')) {
    for (const item of mediaItems(block)) {
      if (!isHttpUrl(item.file) || seenTracks.has(item.file)) continue
      seenTracks.add(item.file)
      tracks.push({ file: item.file, label: item.label || '', kind: item.kind || 'captions' })
    }
  }

  return {
    sources,
    tracks,
    image: firstStringField(input, ['poster', 'image']),
    title: firstStringField(input, ['title']) || extractHtmlTitle(input)
  }
}

function looksLikeMediaUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return /\.(?:m3u8|mpd|mp4|m4v|mkv|mov|webm)(?:$|[?#])/i.test(url.pathname + url.search)
  } catch {
    return false
  }
}

export function unpackPackerScripts(input: string): string {
  let content = input
  const pattern = /eval\(function\(p,a,c,k,e,[A-Za-z_$][\w$]*\)\{[\s\S]*?\}\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\.split\(\s*['"]\|['"]\s*\)/g
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false
    content = content.replace(pattern, (match, payloadLiteral: string, radixText: string, countText: string, keywordsLiteral: string) => {
      const radix = Number(radixText)
      const count = Number(countText)
      if (!Number.isInteger(radix) || radix < 2 || radix > 62 || !Number.isInteger(count) || count < 0 || count > 100_000) return match
      const payload = decodeJavascriptString(payloadLiteral)
      const decodedKeywords = decodeJavascriptString(keywordsLiteral)
      if (payload === null || decodedKeywords === null) return match
      const keywords = decodedKeywords.split('|')
      let output = payload
      for (let index = count - 1; index >= 0; index -= 1) {
        const replacement = keywords[index]
        if (!replacement) continue
        const token = packerToken(index, radix)
        output = output.replace(new RegExp(`\\b${escapeRegExp(token)}\\b`, 'g'), replacement)
      }
      changed = true
      return output
    })
    if (!changed) break
  }
  return content
}

function arrayBlocks(input: string, field: string): string[] {
  const result: string[] = []
  const pattern = new RegExp(`(?:["']?${escapeRegExp(field)}["']?)\\s*[:=]\\s*\\[`, 'gi')
  for (const match of input.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].lastIndexOf('[')
    const end = matchingBracket(input, start)
    if (end > start) result.push(input.slice(start + 1, end))
  }
  return result
}

function matchingBracket(input: string, start: number): number {
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
    else if (character === '[') depth += 1
    else if (character === ']' && --depth === 0) return index
  }
  return -1
}

type ParsedMediaItem = Readonly<{ file: string, type: string, label: string, kind: string }>

function mediaItems(input: string): ParsedMediaItem[] {
  const objects = objectBlocks(input)
  const result = objects.flatMap((object) => {
    const file = firstStringField(object, ['file', 'src', 'url'])
    if (file.length === 0) return []
    return [{
      file: normalizeJavascriptUrl(file),
      type: firstStringField(object, ['type']),
      label: firstStringField(object, ['label', 'res', 'height']),
      kind: firstStringField(object, ['kind'])
    }]
  })
  if (result.length > 0) return result

  return [...input.matchAll(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)].flatMap((match) => {
    const value = decodeJavascriptString(match[1] ?? '')
    if (value === null || !isHttpUrl(normalizeJavascriptUrl(value))) return []
    return [{ file: normalizeJavascriptUrl(value), type: '', label: '', kind: '' }]
  })
}

function objectBlocks(input: string): string[] {
  const result: string[] = []
  let quote = ''
  let escaped = false
  let start = -1
  let depth = 0
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? ''
    if (quote !== '') {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (character === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) result.push(input.slice(start + 1, index))
    }
  }
  return result
}

function firstStringField(input: string, fields: readonly string[]): string {
  const names = fields.map(escapeRegExp).join('|')
  const pattern = new RegExp(`(?:["']?(?:${names})["']?)\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`, 'i')
  const literal = input.match(pattern)?.[1]
  return literal === undefined ? '' : normalizeJavascriptUrl(decodeJavascriptString(literal) ?? '')
}

function extractHtmlTitle(input: string): string {
  const meta = input.match(/<meta\b(?=[^>]*(?:property|name)=["'](?:og:)?title["'])[^>]*content=["']([^"']+)["'][^>]*>/i)?.[1]
  if (meta !== undefined) return stripMarkup(meta)
  for (const tag of ['h1', 'h4', 'title']) {
    const match = input.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1]
    if (match !== undefined) return stripMarkup(match)
  }
  return ''
}

function stripMarkup(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function mediaType(file: string, explicit: string): 'hls' | 'mpd' | 'video/mp4' {
  const normalizedType = explicit.toLowerCase()
  const pathname = new URL(file).pathname.toLowerCase()
  if (normalizedType.includes('hls') || normalizedType.includes('mpegurl') || pathname.endsWith('.m3u8')) return 'hls'
  if (normalizedType.includes('dash') || normalizedType.includes('mpd') || pathname.endsWith('.mpd')) return 'mpd'
  return 'video/mp4'
}

function normalizeJavascriptUrl(value: string): string {
  return decodeHtml(value.replaceAll('\\/', '/').trim())
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}

function packerToken(value: number, radix: number): string {
  if (value < radix) return value > 35 ? String.fromCodePoint(value + 29) : value.toString(36)
  return `${packerToken(Math.floor(value / radix), radix)}${packerToken(value % radix, radix)}`
}

function decodeJavascriptString(literal: string): string | null {
  const quote = literal[0]
  if ((quote !== '"' && quote !== "'") || literal.at(-1) !== quote) return null
  let result = ''
  for (let index = 1; index < literal.length - 1; index += 1) {
    const character = literal[index] ?? ''
    if (character !== '\\') { result += character; continue }
    const escape = literal[++index] ?? ''
    if (escape === 'x' && /^[\dA-Fa-f]{2}$/.test(literal.slice(index + 1, index + 3))) {
      result += String.fromCodePoint(Number.parseInt(literal.slice(index + 1, index + 3), 16))
      index += 2
    } else if (escape === 'u' && /^[\dA-Fa-f]{4}$/.test(literal.slice(index + 1, index + 5))) {
      result += String.fromCodePoint(Number.parseInt(literal.slice(index + 1, index + 5), 16))
      index += 4
    } else {
      result += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' } as Record<string, string>)[escape] ?? escape
    }
  }
  return result
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
