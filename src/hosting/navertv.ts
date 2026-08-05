import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

type JsonObject = Record<string, unknown>

export class NaverTvExtractor extends BaseExtractor {
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
    if (this.#loaded || !isSafeNaverPath(this.id)) return
    this.#loaded = true
    const pageUrl = new URL(`https://tv.naver.com/${this.id}`)
    this.referer = pageUrl.toString()
    try {
      const page = await this.http.get({ url: pageUrl })
      if (page.status < 200 || page.status >= 300) return
      const pageProps = parseNaverPageProps(page.body)
      if (pageProps === null) return

      const vodInfo = objectValue(pageProps.vodInfo)
      if (vodInfo !== null) {
        const clip = objectValue(vodInfo.clip)
        const play = objectValue(vodInfo.play)
        this.title = stringValue(clip?.title)
        this.image = remoteUrl(stringValue(clip?.thumbnailImageUrl))
        const videoId = safeToken(clip?.videoId)
        const inKey = safeToken(play?.inKey)
        if (videoId === '' || inKey === '' || stringValue(play?.playable) !== 'PLAYABLE') return
        const endpoint = new URL(`https://apis.naver.com/rmcnmv/rmcnmv/vod/play/v2.0/${videoId}`)
        endpoint.searchParams.set('key', inKey)
        const playback = await this.http.get({ url: endpoint, headers: { referer: this.referer } })
        if (playback.status < 200 || playback.status >= 300) return
        const payload = parseObject(playback.body)
        if (payload !== null) this.parsePlayback(payload)
        return
      }

      const liveInfo = objectValue(pageProps.liveInfo)
      const live = objectValue(liveInfo?.live)
      this.title = stringValue(live?.title)
      this.image = remoteUrl(stringValue(live?.thumbnailImageUrl))
      const playbackBody = parseObjectValue(liveInfo?.playbackBody)
      if (playbackBody !== null && stringValue(liveInfo?.playable) === 'PLAYABLE') this.parsePlayback(playbackBody)
    } catch {
      // Invalid or unavailable provider responses produce an empty result.
    }
  }

  private parsePlayback(payload: JsonObject): void {
    const meta = objectValue(payload.meta)
    this.title ||= stringValue(meta?.subject)
    this.image ||= remoteUrl(stringValue(objectValue(meta?.cover)?.source))

    const videos = objectValue(payload.videos)
    const videoList = Array.isArray(videos?.list) ? videos.list : []
    const mp4Sources: Array<{ file: string; type: 'video/mp4'; label: string; height: number }> = []
    for (const value of videoList) {
      const video = objectValue(value)
      const file = remoteUrl(stringValue(video?.source))
      if (file === '') continue
      const encoding = objectValue(video?.encodingOption)
      const height = positiveInteger(encoding?.height)
      mp4Sources.push({
        file,
        type: 'video/mp4',
        label: stringValue(encoding?.name) || (height > 0 ? `${height}p` : 'Original'),
        height
      })
    }
    mp4Sources.sort((left, right) => left.height - right.height)

    if (this.downloadable) {
      this.sources.push(...mp4Sources.map(({ height: _height, ...source }) => source))
    } else {
      const hls = hlsSource(payload.streams)
      if (hls !== '') this.sources.push({ file: hls, type: 'hls', label: 'Original' })
      else this.sources.push(...mp4Sources.slice(-1).map(({ height: _height, ...source }) => source))
    }

    const captions = objectValue(payload.captions)
    const list = Array.isArray(captions?.list) ? captions.list : []
    for (const value of list) {
      const caption = objectValue(value)
      const file = remoteUrl(stringValue(caption?.source))
      if (file === '') continue
      this.tracks.push({
        file,
        label: stringValue(caption?.label) || stringValue(caption?.locale) || 'Unknown'
      })
    }
  }
}

export function parseNaverPageProps(input: string): JsonObject | null {
  const value = scriptById(input, '__NEXT_DATA__')
  const root = parseObject(value)
  return objectValue(objectValue(objectValue(root?.props)?.pageProps))
}

function hlsSource(value: unknown): string {
  const streams = Array.isArray(value) ? value : []
  for (const item of streams) {
    const stream = objectValue(item)
    if (stringValue(stream?.type).toUpperCase() !== 'HLS') continue
    const source = remoteUrl(stringValue(stream?.source))
    if (source === '') continue
    const url = new URL(source)
    const keys = Array.isArray(stream?.keys) ? stream.keys : []
    for (const entry of keys) {
      const key = objectValue(entry)
      const name = safeQueryName(key?.name)
      const parameter = stringValue(key?.value)
      if (name !== '' && parameter !== '') url.searchParams.set(name, parameter)
    }
    return url.toString()
  }
  return ''
}

function scriptById(input: string, id: string): string {
  for (const match of input.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const scriptId = (match[1] ?? '').match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1] ?? ''
    if (scriptId === id) return match[2]?.trim() ?? ''
  }
  return ''
}

function parseObjectValue(value: unknown): JsonObject | null {
  if (typeof value === 'string') return parseObject(value)
  return objectValue(value)
}

function parseObject(value: string): JsonObject | null {
  try {
    return objectValue(JSON.parse(value))
  } catch {
    return null
  }
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

function safeToken(value: unknown): string {
  const token = stringValue(value)
  return token.length > 0 && token.length <= 512 && /^[A-Za-z0-9_-]+$/.test(token) ? token : ''
}

function safeQueryName(value: unknown): string {
  const name = stringValue(value)
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : ''
}

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function isSafeNaverPath(value: string): boolean {
  return /^v\/\d+(?:\/list\/\d+)?$/.test(value) || /^l\/\d+$/.test(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
}
