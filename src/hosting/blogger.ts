import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const BLOGGER_ORIGIN = 'https://www.blogger.com/'
const BLOGGER_PLAYER_PATH = '/video.g'
const BLOGGER_RPC_PATH = '/_/BloggerVideoPlayerUi/data/batchexecute'
const MAX_BOOTSTRAP_OBJECT_BYTES = 256 * 1_024

type JsonObject = Record<string, unknown>

export type BloggerBootstrap = Readonly<{
  sessionId: string
  buildLabel: string
}>

export type BloggerRpcResult = Readonly<{
  sources: readonly Readonly<Record<string, unknown>>[]
  image: string
  title: string
}>

export class BloggerExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
    this.referer = BLOGGER_ORIGIN
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    const requestedPage = bloggerInputUrl(this.id)
    if (requestedPage === null) return
    try {
      let page = await this.http.get({ url: requestedPage })
      if (page.status < 200 || page.status >= 300 || !isBloggerPageUrl(page.url)) return

      let token = bloggerToken(page.url)
      if (token === '') {
        const playerUrl = bloggerPlayerUrl(page.body)
        if (playerUrl === null) return
        page = await this.http.get({ url: playerUrl })
        if (page.status < 200 || page.status >= 300 || !isBloggerPlayerUrl(page.url)) return
        token = bloggerToken(page.url)
      }
      if (!isSafeToken(token)) return

      const bootstrap = parseBloggerBootstrap(page.body)
      if (bootstrap === null) return
      const endpoint = bloggerRpcUrl(bootstrap)
      const body = new URLSearchParams({
        'f.req': JSON.stringify([[['WcwnYd', JSON.stringify([token, null, 0]), null, 'generic']]])
      }).toString()
      const response = await this.http.post({
        url: endpoint,
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          referer: BLOGGER_ORIGIN,
          'x-same-domain': '1'
        },
        body
      })
      if (response.status < 200 || response.status >= 300 || response.url.hostname !== 'www.blogger.com') return
      const result = parseBloggerRpcResponse(response.body)
      if (result === null) return
      this.sources.push(...result.sources)
      this.image = result.image
      this.title = result.title
    } catch {
      // Invalid or unavailable provider responses produce an empty result.
    }
  }
}

export function parseBloggerBootstrap(input: string): BloggerBootstrap | null {
  const marker = /(?:window\.)?WIZ_global_data\s*=\s*\{/.exec(input)
  if (marker === null) return null
  const start = marker.index + marker[0].lastIndexOf('{')
  const json = balancedObject(input, start)
  if (json === '') return null
  try {
    const data = objectValue(JSON.parse(json))
    const sessionId = stringValue(data?.FdrFJe)
    const buildLabel = stringValue(data?.cfb2h)
    if (!/^-?\d{1,32}$/.test(sessionId) || !/^boq_bloggeruiserver_[A-Za-z0-9._-]{1,128}$/.test(buildLabel)) return null
    return Object.freeze({ sessionId, buildLabel })
  } catch {
    return null
  }
}

export function parseBloggerRpcResponse(input: string): BloggerRpcResult | null {
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('[[')) continue
    try {
      const envelopes: unknown = JSON.parse(trimmed)
      if (!Array.isArray(envelopes)) continue
      for (const envelope of envelopes) {
        if (!Array.isArray(envelope) || envelope[0] !== 'wrb.fr' || envelope[1] !== 'WcwnYd' || typeof envelope[2] !== 'string') continue
        const payload: unknown = JSON.parse(envelope[2])
        const result = bloggerPayload(payload)
        if (result !== null) return result
      }
    } catch {
      // Batchexecute responses contain other framed records; ignore invalid lines.
    }
  }
  return null
}

function bloggerPayload(payload: unknown): BloggerRpcResult | null {
  if (!Array.isArray(payload) || !Array.isArray(payload[2])) return null
  const sources: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (const item of payload[2]) {
    if (!Array.isArray(item) || typeof item[0] !== 'string' || !isGoogleVideoUrl(item[0]) || seen.has(item[0])) continue
    const itag = Array.isArray(item[1]) ? numberValue(item[1][0]) : 0
    seen.add(item[0])
    sources.push({ file: item[0], type: 'video/mp4', label: googleVideoLabel(itag) })
  }
  if (sources.length === 0) return null
  const image = stringValue(payload[3])
  return Object.freeze({
    sources: Object.freeze(sources),
    image: isGoogleImageUrl(image) ? image : '',
    title: stringValue(payload[4])
  })
}

function bloggerRpcUrl(bootstrap: BloggerBootstrap): URL {
  const url = new URL(BLOGGER_RPC_PATH, BLOGGER_ORIGIN)
  url.search = new URLSearchParams({
    rpcids: 'WcwnYd',
    'source-path': BLOGGER_PLAYER_PATH,
    'f.sid': bootstrap.sessionId,
    bl: bootstrap.buildLabel,
    hl: 'en-US',
    _reqid: '100000',
    rt: 'c'
  }).toString()
  return url
}

function bloggerInputUrl(id: string): URL | null {
  if (isSafeToken(id)) return new URL(`${BLOGGER_PLAYER_PATH}?token=${encodeURIComponent(id)}`, BLOGGER_ORIGIN)
  try {
    const url = new URL(id)
    return url.protocol === 'https:' && !url.username && !url.password && isBloggerPageUrl(url) ? url : null
  } catch {
    return null
  }
}

function bloggerPlayerUrl(input: string): URL | null {
  const decoded = decodeHtml(input).replaceAll('\\u003d', '=').replaceAll('\\/', '/')
  const match = decoded.match(/https:\/\/www\.blogger\.com\/video\.g\?token=[A-Za-z0-9_-]{16,1024}/i)?.[0]
  if (match === undefined) return null
  try {
    const url = new URL(match)
    return isBloggerPlayerUrl(url) ? url : null
  } catch {
    return null
  }
}

function bloggerToken(url: URL): string {
  return isBloggerPlayerUrl(url) ? url.searchParams.get('token')?.trim() ?? '' : ''
}

function isBloggerPlayerUrl(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password &&
    url.hostname === 'www.blogger.com' && url.pathname === BLOGGER_PLAYER_PATH
}

function isBloggerPageUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase()
  return url.protocol === 'https:' && !url.username && !url.password && (
    hostname === 'blogger.com' || hostname.endsWith('.blogger.com') ||
    hostname === 'blogspot.com' || hostname.endsWith('.blogspot.com')
  )
}

function isGoogleVideoUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password &&
      (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'))
  } catch {
    return false
  }
}

function isGoogleImageUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && (
      url.hostname === 'ytimg.com' || url.hostname.endsWith('.ytimg.com') ||
      url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com')
    )
  } catch {
    return false
  }
}

function googleVideoLabel(itag: number): string {
  return ({
    5: '240p', 6: '270p', 17: '144p', 18: '360p', 22: '720p', 34: '360p',
    35: '480p', 36: '240p', 37: '1080p', 38: '3072p', 43: '360p', 44: '480p',
    45: '720p', 46: '1080p', 59: '480p', 78: '480p'
  } as Record<number, string>)[itag] ?? (itag > 0 ? String(itag) : 'Original')
}

function balancedObject(input: string, start: number): string {
  let depth = 0
  let quote = ''
  let escaped = false
  const limit = Math.min(input.length, start + MAX_BOOTSTRAP_OBJECT_BYTES)
  for (let index = start; index < limit; index++) {
    const character = input[index] ?? ''
    if (quote !== '') {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"') quote = character
    else if (character === '{') depth++
    else if (character === '}' && --depth === 0) return input.slice(start, index + 1)
  }
  return ''
}

function isSafeToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,1024}$/.test(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : Number.parseInt(String(value), 10) || 0
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
