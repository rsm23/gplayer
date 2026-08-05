import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

export class PCloudExtractor extends BaseExtractor {
  #loaded = false
  readonly #pageUrl: URL | null

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    const trimmed = id.trim()
    const direct = parseHttpUrl(trimmed)
    const code = trimmed.split('?', 1)[0] ?? ''
    super(direct === null ? code : trimmed)
    this.#pageUrl = direct ?? parseHttpUrl(`https://u.pcloud.link/publink/show?code=${encodeURIComponent(code)}`)
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
      if (response.status < 200 || response.status >= 300) return
      const raw = response.body.match(/\bpublinkData\s*=\s*([\s\S]*?);\s*(?:<\/script>|\r?\n)/)?.[1]
      if (raw === undefined) return
      const root = parseObject(raw.trim())
      if (root === null) return
      const metadata = objectValue(root.metadata)
      if (typeof metadata?.name === 'string') this.title = metadata.name
      if (typeof root.code === 'string' && root.code.length > 0) {
        this.image = `https://api.pcloud.com/getpubthumb?code=${encodeURIComponent(root.code)}&crop=0&type=auto&size=600x480`
      }

      const variants = Array.isArray(root.variants) ? root.variants : []
      if (variants.length > 0) this.parseVariants(variants)
      else if (typeof root.downloadlink === 'string' && isHttpUrl(root.downloadlink)) {
        this.sources.push({ file: root.downloadlink.replaceAll('\\/', '/'), type: 'video/mp4', label: 'Original' })
      }
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
    }
  }

  private parseVariants(variants: unknown[]): void {
    for (const value of variants) {
      const variant = objectValue(value)
      const host = Array.isArray(variant?.hosts) && typeof variant.hosts[0] === 'string' ? variant.hosts[0] : ''
      const path = typeof variant?.path === 'string' ? variant.path.replaceAll('\\/', '/') : ''
      const file = safePCloudUrl(host, path)
      if (file === null) continue
      const type = path.includes('.m3u') ? 'hls' : 'video/mp4'
      const label = typeof variant?.height === 'number' || typeof variant?.height === 'string'
        ? `${variant.height}p`
        : 'Original'
      this.sources.push({ file, type, label })
      if (type === 'hls') return
    }
  }
}

function safePCloudUrl(host: string, path: string): string | null {
  try {
    const url = new URL(path, `https://${host}/`)
    if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== host.toLowerCase()) return null
    return url.toString()
  } catch {
    return null
  }
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    return objectValue(JSON.parse(value))
  } catch {
    return null
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}

function isHttpUrl(value: string): boolean {
  return parseHttpUrl(value.replaceAll('\\/', '/')) !== null
}
