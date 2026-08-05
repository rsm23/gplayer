import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

export class VudeoExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || this.id.length === 0) return
    this.#loaded = true
    try {
      const response = await this.http.get({ url: `https://vudeo.ws/embed-${encodeURIComponent(this.id)}.html` })
      if (response.status < 200 || response.status >= 300) return
      const file = between(response.body, 'sources: ["', '"')
      if (!isHttpUrl(file)) return
      this.image = between(response.body, 'poster: "', '"')
      this.title = between(response.body, 'title: "', '"')
      this.sources.push({ file, type: 'video/mp4', label: 'Original' })
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}
