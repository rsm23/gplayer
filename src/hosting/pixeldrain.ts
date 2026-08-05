import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

export class PixeldrainExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
    const encodedId = encodeURIComponent(this.id)
    const apiUrl = `https://pixeldrain.com/api/file/${encodedId}`
    this.image = `${apiUrl}/thumbnail`
    if (this.id.length > 0) this.sources.push({ file: apiUrl, type: 'video/mp4', label: 'Original' })
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || this.id.length === 0) return
    this.#loaded = true
    try {
      const response = await this.http.get({ url: `https://pixeldrain.com/api/file/${encodeURIComponent(this.id)}/info` })
      if (response.status < 200 || response.status >= 300) return
      const parsed = parseObject(response.body)
      if (typeof parsed?.name === 'string') this.title = parsed.name
    } catch {
      // The legacy adapter still returns the media URL when the optional info request fails.
    }
  }
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}
