import type { MediaSource } from '../core/source-resolver.js'
import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

export class RumbleExtractor extends BaseExtractor {
  readonly #mp4Sources: MediaSource[] = []
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
  }

  public override async getSources() {
    await this.load()
    if (this.downloadable && this.#mp4Sources.length > 0) return this.#mp4Sources
    return this.sources.length > 0 ? this.sources : this.#mp4Sources
  }

  public override async getTracks() {
    await this.load()
    return this.tracks
  }

  private async load(): Promise<void> {
    if (this.#loaded || this.id.length === 0) return
    this.#loaded = true
    try {
      const videoId = await this.resolveVideoId()
      if (videoId.length === 0) return
      const endpoint = new URL('https://rumble.com/embedJS/u3/')
      endpoint.search = new URLSearchParams({
        request: 'video',
        ver: '2',
        v: videoId,
        ext: '{"ad_count":null}',
        ad_wt: '78'
      }).toString()
      const response = await this.http.get({ url: endpoint })
      if (response.status < 200 || response.status >= 300) return
      this.parsePayload(response.body)
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
    }
  }

  private async resolveVideoId(): Promise<string> {
    if (this.id.includes('embed/')) {
      return this.id.replace('embed/', '').replace(/^\/+|\/+$/g, '').split('-', 1)[0]?.trim() ?? ''
    }
    const slug = this.id.replace(/\.html$/i, '').replace(/^\/+/, '')
    const response = await this.http.get({ url: `https://rumble.com/${slug}.html` })
    if (response.status < 200 || response.status >= 300) return ''
    return between(response.body, '"video":"', '"')
  }

  private parsePayload(value: string): void {
    let root: Record<string, unknown> | null = null
    try {
      root = objectValue(JSON.parse(value))
    } catch {
      return
    }
    if (root === null) return
    if (typeof root.i === 'string') this.image = root.i
    if (typeof root.title === 'string') this.title = root.title

    const userAssets = objectValue(root.ua)
    const hls = objectValue(objectValue(userAssets?.hls)?.auto)
    if (typeof hls?.url === 'string' && hls.url.length > 0) {
      this.sources.push({ file: hls.url, type: 'hls', label: 'Original' })
    }
    const mp4 = objectValue(userAssets?.mp4)
    if (mp4 !== null) {
      for (const [quality, value] of Object.entries(mp4)) {
        const source = objectValue(value)
        if (typeof source?.url !== 'string' || source.url.length === 0) continue
        this.#mp4Sources.push({ file: source.url, type: 'video/mp4', label: `${quality}p` })
      }
    }
    const captions = objectValue(root.c)
    if (captions !== null) {
      for (const value of Object.values(captions)) {
        const track = objectValue(value)
        if (typeof track?.path !== 'string' || track.path.length === 0) continue
        this.tracks.push({ file: track.path, label: typeof track.language === 'string' ? track.language : '' })
      }
    }
  }
}

function between(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start)
  if (startIndex < 0) return ''
  const contentStart = startIndex + start.length
  const endIndex = value.indexOf(end, contentStart)
  return endIndex < 0 ? '' : value.slice(contentStart, endIndex).trim()
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
