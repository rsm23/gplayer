import { randomInt } from 'node:crypto'
import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const BASE_URL = new URL('https://playmogo.com/')
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export type DoodExtractorOptions = Readonly<{
  randomToken?: () => string
  now?: () => number
}>

export class DoodExtractor extends BaseExtractor {
  #loaded = false

  public constructor(
    id: string,
    private readonly http: ProviderHttpClient,
    private readonly options: DoodExtractorOptions = {}
  ) {
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
      const embedUrl = new URL(`e/${encodeURIComponent(this.id)}`, BASE_URL)
      const page = await this.http.get({ url: embedUrl })
      if (page.status < 200 || page.status >= 300) return

      this.referer = BASE_URL.toString()
      this.cookies = responseCookies(page.headers)
      this.image = safeHttpUrl(openGraphValue(page.body, 'og:image'))
      this.title = htmlTitle(page.body).replace(/-\s*DoodStream\s*$/i, '').trim()
      this.filmstrip = filmstripUrl(page.body)

      const passPath = page.body.match(/([/]pass_md5[/][^'"\s,)]+)/i)?.[1] ?? ''
      const providerToken = page.body.match(/\breturn\s+[A-Za-z_$][\w$]*\s*\+\s*["']([^"']+)["']/)?.[1] ?? ''
      if (passPath === '' || providerToken === '' || hasControlCharacters(providerToken)) return
      const passUrl = safeRemoteUrl(decodeHtml(passPath), page.url)
      if (passUrl === '') return

      const passResponse = await this.http.get({
        url: passUrl,
        headers: {
          referer: this.referer,
          ...(this.cookies.length > 0 ? { cookie: this.cookies.join('; ') } : {})
        }
      })
      if (passResponse.status < 200 || passResponse.status >= 300) return
      const base = passResponse.body.trim()
      const randomToken = this.options.randomToken?.() ?? createRandomToken()
      if (!/^[A-Za-z0-9]{10}$/.test(randomToken) || hasControlCharacters(base)) return
      const timestamp = Math.floor((this.options.now?.() ?? Date.now()) / 1_000)
      const file = safeHttpUrl(`${base}${randomToken}${providerToken}${timestamp}`)
      if (file === '') return

      this.sources.push({ file, type: 'video/mp4', label: 'Original' })
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
    }
  }
}

function createRandomToken(): string {
  let result = ''
  for (let index = 0; index < 10; index += 1) result += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)]
  return result
}

function filmstripUrl(input: string): string {
  const value = decodeHtml(input.match(/\bthumbnails\s*:\s*\{\s*vtt\s*:\s*["']([^"']+)["']/i)?.[1] ?? '')
    .replaceAll('\\/', '/')
    .trim()
  if (!value.includes('/get_slides/')) return ''
  return safeHttpUrl(value.startsWith('//') ? `https:${value}` : value)
}

function openGraphValue(input: string, property: string): string {
  const tags = input.match(/<meta\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    if (!new RegExp(`(?:property|name)\\s*=\\s*["']${escapeRegExp(property)}["']`, 'i').test(tag)) continue
    return decodeHtml(tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? '').trim()
  }
  return ''
}

function htmlTitle(input: string): string {
  const value = input.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''
  return decodeHtml(value.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function responseCookies(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const values = typeof getSetCookie === 'function'
    ? getSetCookie.call(headers)
    : [headers.get('set-cookie') ?? '']
  return values.flatMap((header) => {
    const pair = header.split(';', 1)[0]?.trim() ?? ''
    return /^[^=;,\s]+=[^;,]*$/.test(pair) ? [pair] : []
  })
}

function safeRemoteUrl(value: string, base: URL): string {
  if (hasControlCharacters(value)) return ''
  try {
    const url = new URL(value, base)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.toString()
      : ''
  } catch {
    return ''
  }
}

function safeHttpUrl(value: string): string {
  if (hasControlCharacters(value)) return ''
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.toString()
      : ''
  } catch {
    return ''
  }
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
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
