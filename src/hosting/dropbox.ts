import path from 'node:path'
import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

export class DropboxExtractor extends BaseExtractor {
  #loaded = false
  readonly #pageUrl: URL | null

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
    this.#pageUrl = parseHttpUrl(this.id) ?? parseHttpUrl(`https://www.dropbox.com/s/${this.id.replace(/^\/+/, '')}`)
    this.title = this.#pageUrl === null ? '' : path.posix.basename(this.#pageUrl.pathname)
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || this.#pageUrl === null) return
    this.#loaded = true
    try {
      const response = await this.http.get({ url: this.#pageUrl })
      if (response.status < 200 || response.status >= 400) return
      const fullInput = parseHttpUrl(this.id)
      const file = fullInput !== null && this.id.includes('dl=')
        ? safelyDecodeUrl(this.id).replaceAll('dl=0', 'dl=1')
        : `${this.#pageUrl.toString()}?dl=1`
      if (parseHttpUrl(file) !== null) this.sources.push({ file, type: 'video/mp4', label: 'Original' })
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
    }
  }
}

function safelyDecodeUrl(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}
