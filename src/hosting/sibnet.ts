import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient, ProviderHttpResponse } from './provider-http.js'

const BASE_URL = new URL('https://video.sibnet.ru/')

export class SibnetExtractor extends BaseExtractor {
  #loaded = false

  public constructor(
    id: string,
    private readonly http: ProviderHttpClient,
    private readonly proxyHttp?: ProviderHttpClient
  ) {
    super(normalizeSibnetId(id))
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || this.id.length === 0) return
    this.#loaded = true
    const pageUrl = new URL('shell.php', BASE_URL)
    pageUrl.searchParams.set('videoid', this.id)
    const direct = await this.http.get({ url: pageUrl }).catch(() => null)
    if (direct !== null && this.useResponse(direct, pageUrl)) return
    if (this.proxyHttp === undefined) return
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const proxied = await this.proxyHttp.get({ url: pageUrl }).catch(() => null)
      if (proxied !== null && this.useResponse(proxied, pageUrl)) return
    }
  }

  private useResponse(response: ProviderHttpResponse, pageUrl: URL): boolean {
    if (response.status < 200 || response.status >= 300) return false
    const rawFile = response.body.match(/player\.src\(\s*\[\s*\{\s*src\s*:\s*["']([^"']+)["']/i)?.[1] ?? ''
    const file = safeRemoteUrl(rawFile.replaceAll('\\/', '/'), BASE_URL)
    if (file === '') return false

    this.referer = pageUrl.toString()
    this.title = openGraphValue(response.body, 'og:title')
    this.image = safeRemoteUrl(openGraphValue(response.body, 'og:image'), BASE_URL)
    this.sources.push({ file, type: 'video/mp4', label: 'Original' })
    return true
  }
}

export function normalizeSibnetId(value: string): string {
  const trimmed = value.trim()
  if (!/^video/i.test(trimmed)) return trimmed
  return (trimmed.split('-', 1)[0] ?? '').replace(/^video/i, '').trim()
}

function openGraphValue(input: string, property: string): string {
  const tags = input.match(/<meta\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    if (!new RegExp(`(?:property|name)\\s*=\\s*["']${escapeRegExp(property)}["']`, 'i').test(tag)) continue
    return decodeHtml(tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? '').trim()
  }
  return ''
}

function safeRemoteUrl(value: string, baseUrl: URL): string {
  if (value.trim() === '') return ''
  try {
    const url = new URL(decodeHtml(value).trim(), baseUrl)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.toString()
      : ''
  } catch {
    return ''
  }
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
