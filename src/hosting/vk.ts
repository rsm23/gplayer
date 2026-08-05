import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient, ProviderHttpPostRequest, ProviderHttpResponse } from './provider-http.js'

const VK_ORIGIN = 'https://vk.com/'
const VK_PLAYER_ENDPOINT = 'https://vk.com/al_video.php?act=show'

type JsonObject = Record<string, unknown>

export type VkPage = Readonly<{
  playbackSources: readonly Readonly<Record<string, unknown>>[]
  downloadSources: readonly Readonly<Record<string, unknown>>[]
  image: string
  title: string
}>

export class VkExtractor extends BaseExtractor {
  #loaded = false

  public constructor(
    id: string,
    private readonly http: ProviderHttpClient,
    private readonly proxyHttp?: ProviderHttpClient
  ) {
    super(normalizeVkId(id))
    this.referer = VK_ORIGIN
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || !isSafeVkId(this.id)) return
    this.#loaded = true
    const body = new URLSearchParams({
      al: '1', autoplay: '1', claim: '', force_no_repeat: 'true', is_video_page: 'true',
      list: '', module: 'direct', show_next: '1', video: this.id
    }).toString()
    const request: ProviderHttpPostRequest = {
        url: VK_PLAYER_ENDPOINT,
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          referer: VK_ORIGIN,
          'x-requested-with': 'XMLHttpRequest'
        },
        body
    }
    const direct = await this.http.post(request).catch(() => null)
    if (direct !== null && direct.status >= 200 && direct.status < 300) {
      this.useResponse(direct)
      return
    }
    if (direct?.status === 404 || this.proxyHttp === undefined) return
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const proxied = await this.proxyHttp.post(request).catch(() => null)
      if (proxied?.status === 404) return
      if (proxied !== null && proxied.status >= 200 && proxied.status < 300) {
        this.useResponse(proxied)
        return
      }
    }
  }

  private useResponse(response: ProviderHttpResponse): void {
    if (response.url.hostname !== 'vk.com') return
    const page = parseVkResponse(response.body)
    if (page === null) return
    this.sources.push(...(this.downloadable ? page.downloadSources : page.playbackSources))
    this.image = page.image
    this.title = page.title
  }
}

export function parseVkResponse(input: string): VkPage | null {
  try {
    const data = objectValue(JSON.parse(input))
    const payload = Array.isArray(data?.payload) ? data.payload : []
    const entries = Array.isArray(payload[1]) ? payload[1] : []
    const title = typeof entries[0] === 'string' ? stripMarkup(entries[0]) : ''
    for (const entry of entries) {
      if (typeof entry === 'string' && entry.includes('<video')) {
        const html = parseVkHtml(entry, title)
        if (html.playbackSources.length > 0) return html
      }
      const player = parseVkPlayer(entry, title)
      if (player !== null) return player
    }
    return null
  } catch {
    return null
  }
}

function parseVkPlayer(value: unknown, fallbackTitle: string): VkPage | null {
  const data = objectValue(value)
  const player = objectValue(data?.player)
  const params = Array.isArray(player?.params) ? objectValue(player.params[0]) : null
  if (params === null) return null
  const title = stringValue(params.md_title) || fallbackTitle
  const image = safeHttpUrl(stringValue(params.jpg))
  const downloadSources: Record<string, unknown>[] = []
  for (const [key, raw] of Object.entries(params)) {
    const match = /^url(\d+)$/.exec(key)
    const file = stringValue(raw)
    if (match === null || !isHttpUrl(file)) continue
    downloadSources.push({ file, type: 'video/mp4', label: `${match[1]}p` })
  }

  const keys = Object.keys(params).sort().reverse()
  const hlsKey = keys.find((key) => key === 'hls' || key === 'hls_ondemand')
  const dashKey = keys.find((key) => key === 'dash_sep' || key === 'dash_uni')
  const playbackSources: Record<string, unknown>[] = []
  if (hlsKey !== undefined && isHttpUrl(stringValue(params[hlsKey]))) {
    playbackSources.push({ file: stringValue(params[hlsKey]), type: 'hls', label: 'Original' })
  } else if (dashKey !== undefined && isHttpUrl(stringValue(params[dashKey]))) {
    playbackSources.push({ file: stringValue(params[dashKey]), type: 'mpd', label: 'Original' })
  } else {
    const fallback = downloadSources.at(-1)
    if (fallback !== undefined) playbackSources.push(fallback)
  }
  if (playbackSources.length === 0 && downloadSources.length === 0) return null
  return Object.freeze({
    playbackSources: Object.freeze(playbackSources),
    downloadSources: Object.freeze(downloadSources),
    image,
    title
  })
}

function parseVkHtml(input: string, title: string): VkPage {
  const sources: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (const match of input.matchAll(/<source\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    const file = decodeHtml(match[1] ?? '')
    if (!isHttpUrl(file) || seen.has(file)) continue
    const type = Number.parseInt(new URL(file).searchParams.get('type') ?? '', 10)
    const label = ['240p', '360p', '480p', '720p', '1080p'][type]
    if (label === undefined) continue
    seen.add(file)
    sources.push({ file, type: 'video/mp4', label })
  }
  const poster = decodeHtml(input.match(/<video\b[^>]*\bposter=["']([^"']+)["'][^>]*>/i)?.[1] ?? '')
  return Object.freeze({
    playbackSources: Object.freeze(sources.slice(-1)),
    downloadSources: Object.freeze(sources),
    image: safeHttpUrl(poster),
    title
  })
}

function normalizeVkId(value: string): string {
  const trimmed = value.trim()
  try {
    const url = new URL(trimmed)
    return (url.searchParams.get('z') ?? url.pathname.replace(/^\/+/, '')).replace(/^video/, '')
  } catch {
    return trimmed.replace(/^video/, '')
  }
}

function isSafeVkId(value: string): boolean {
  return /^-?\d{1,32}_\d{1,32}$/.test(value)
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}

function safeHttpUrl(value: string): string {
  return isHttpUrl(value) ? value : ''
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? decodeHtml(value.trim()) : ''
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
}

function stripMarkup(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function decodeHtml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
}
