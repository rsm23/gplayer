import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'
import { parseXFileSharingContent, unpackPackerScripts } from './xfile-sharing.js'

const HXFILE_ORIGIN = 'https://hxfile.co/'
const MAX_ENCODED_PAYLOAD_LENGTH = 1_024 * 1_024
const MIN_ENCODED_PAYLOAD_LENGTH = 128

export type HxFileEmbed = Readonly<{
  sources: readonly Readonly<{ file: string, type: 'video/mp4', label: string }>[]
  image: string
}>

export class HxFileExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || !/^[A-Za-z0-9]{6,64}$/.test(this.id)) return
    this.#loaded = true
    this.referer = `${HXFILE_ORIGIN}${this.id}`
    try {
      const embedUrl = new URL(`embed-${this.id}.html`, HXFILE_ORIGIN)
      const response = await this.http.get({ url: embedUrl, headers: { referer: this.referer } })
      if (!successfulHxFileResponse(response.status, response.url)) return
      const embed = parseHxFileEmbed(response.body)
      if (embed === null || embed.sources.length === 0) return
      this.sources.push(...embed.sources)

      const page = await this.http.get({ url: this.referer })
      if (!successfulHxFileResponse(page.status, page.url)) return
      const metadata = parseHxFileMetadata(page.body)
      this.title = metadata.title
      this.image = metadata.image || embed.image
    } catch {
      // Invalid or unavailable provider responses produce an empty result.
    }
  }
}

export function parseHxFileEmbed(input: string): HxFileEmbed | null {
  const unpacked = unpackPackerScripts(input)
  const encodedMatch = unpacked.match(
    /var\s+[A-Za-z_$][\w$]*\s*=\s*["']([A-Za-z0-9+/=]{128,})["']/
  )
  const encoded = encodedMatch?.[1] ?? ''
  if (encoded.length < MIN_ENCODED_PAYLOAD_LENGTH || encoded.length > MAX_ENCODED_PAYLOAD_LENGTH) return null
  const tail = unpacked.slice((encodedMatch?.index ?? 0) + (encodedMatch?.[0].length ?? 0))
  const key = tail.match(/var\s+(_0x[A-Fa-f0-9]+)\s*=\s*[A-Za-z_$][\w$]*\(\s*\)/)?.[1] ?? ''
  if (key === '') return null
  const encrypted = decodeBase64Utf8(encoded)
  if (encrypted === null || encrypted.length > MAX_ENCODED_PAYLOAD_LENGTH) return null

  let decoded = ''
  for (let index = 0; index < encrypted.length; index++) {
    decoded += String.fromCharCode(encrypted.charCodeAt(index) ^ key.charCodeAt(index % key.length))
  }
  if (!/\b(?:jwplayer|player)\.setup\s*\(/.test(decoded)) return null
  const parsed = parseXFileSharingContent(unpackPackerScripts(decoded))
  const sources = parsed.sources.flatMap((value) => {
    const file = safeRemoteUrl(value.file)
    return file === '' ? [] : [{ file, type: 'video/mp4' as const, label: 'Original' }]
  })
  return Object.freeze({ sources: Object.freeze(sources), image: safeRemoteUrl(parsed.image) })
}

export function parseHxFileMetadata(input: string): Readonly<{ title: string, image: string }> {
  const title = stripMarkup(input.match(
    /<[^>]*\bclass\s*=\s*["'][^"']*\bdfilename\b[^"']*["'][^>]*>([\s\S]*?)<\//i
  )?.[1] ?? '')
  const image = safeRemoteUrl(input.match(
    /<img\b(?=[^>]*\bclass\s*=\s*["'][^"']*\brounded\b[^"']*["'])[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/i
  )?.[1] ?? '')
  return Object.freeze({ title, image })
}

function decodeBase64Utf8(value: string): string | null {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'base64'))
  } catch {
    return null
  }
}

function successfulHxFileResponse(status: number, url: URL): boolean {
  return status >= 200 && status < 300 && (url.hostname === 'hxfile.co' || url.hostname === 'www.hxfile.co')
}

function safeRemoteUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16_384) return ''
  try {
    const url = new URL(decodeHtml(value.trim()))
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.toString()
      : ''
  } catch {
    return ''
  }
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
}
