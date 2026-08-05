import type { MediaSource } from '../core/source-resolver.js'
import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

export class VidyardExtractor extends BaseExtractor {
  readonly #mp4Sources: MediaSource[] = []
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.split('?', 1)[0]?.trim() ?? '')
    this.referer = `https://share.vidyard.com/watch/${this.id}`
  }

  public override async getSources() {
    await this.load()
    if (this.downloadable && this.#mp4Sources.length > 0) return this.#mp4Sources
    return this.sources.length > 0 ? this.sources : this.#mp4Sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || this.id.length === 0) return
    this.#loaded = true
    const url = new URL(`https://play.vidyard.com/player/${encodeURIComponent(this.id)}.json`)
    url.search = new URLSearchParams({
      disable_popouts: '1',
      disable_analytics: '0',
      preload: 'auto',
      disable_larger_player: 'false',
      controller: 'hubs',
      action: 'show',
      type: 'inline',
      v: '4.3.14'
    }).toString()

    try {
      const response = await this.http.get({ url })
      if (response.status < 200 || response.status >= 300) return
      const chapter = firstChapter(response.body)
      if (chapter === null) return
      if (typeof chapter.name === 'string') this.title = chapter.name
      const thumbnails = objectValue(chapter.thumbnailUrls)
      if (typeof thumbnails?.normal === 'string') this.image = thumbnails.normal

      const sources = objectValue(chapter.sources)
      if (sources === null) return
      for (const source of arrayValue(sources.mp4)) {
        const item = objectValue(source)
        if (typeof item?.url !== 'string' || item.url.length === 0) continue
        this.#mp4Sources.push({
          file: item.url,
          type: typeof item.mimeType === 'string' ? item.mimeType : 'video/mp4',
          label: typeof item.profile === 'string' ? item.profile : 'Original'
        })
      }
      const hls = arrayValue(sources.hls).map(objectValue).filter((value): value is Record<string, unknown> => value !== null)
      const original = hls.at(-1)
      if (typeof original?.url === 'string' && original.url.length > 0) {
        this.sources.push({ file: original.url, type: 'hls', label: 'Original' })
      }
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
    }
  }
}

function firstChapter(value: string): Record<string, unknown> | null {
  try {
    const root = objectValue(JSON.parse(value))
    const payload = objectValue(root?.payload)
    return objectValue(arrayValue(payload?.chapters)[0])
  } catch {
    return null
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
