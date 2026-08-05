import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const CLOUD_MAIL_ORIGIN = 'https://cloud.mail.ru/'
const SETTINGS_MARKER = 'window.cloudSettings='
const MAX_SETTINGS_LENGTH = 1_024 * 1_024
const MAX_OBJECT_LENGTH = 64 * 1_024

type JsonObject = Record<string, unknown>

export type CloudMailPage = Readonly<{
  weblink: string
  title: string
  hlsBaseUrl: string
}>

export class CloudMailRuExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || !isSafeCloudMailId(this.id)) return
    this.#loaded = true
    const pageUrl = new URL(this.id, CLOUD_MAIL_ORIGIN)
    this.referer = CLOUD_MAIL_ORIGIN
    try {
      const response = await this.http.get({ url: pageUrl })
      if (response.status < 200 || response.status >= 300 || response.url.hostname !== 'cloud.mail.ru') return
      const page = parseCloudMailPage(response.body)
      const expectedWeblink = this.id.replace(/^public\//, '')
      if (page === null || page.weblink !== expectedWeblink) return

      const base = safeVideoBaseUrl(page.hlsBaseUrl)
      if (base === null) return
      const encodedWeblink = Buffer.from(page.weblink, 'utf8').toString('base64')
      base.pathname = `${base.pathname.replace(/\/+$/, '')}/0p/${encodedWeblink}.m3u8`
      base.search = 'double_encode=1'

      this.title = page.title
      this.image = `https://thumb.cloud.mail.ru/weblink/thumb/vxw0/${page.weblink}`
      this.sources.push({ file: base.toString(), type: 'hls', label: 'Original' })
    } catch {
      // Invalid or unavailable provider responses produce an empty result.
    }
  }
}

export function parseCloudMailPage(input: string): CloudMailPage | null {
  const markerIndex = input.indexOf(SETTINGS_MARKER)
  if (markerIndex < 0) return null
  const settings = input.slice(markerIndex + SETTINGS_MARKER.length, markerIndex + SETTINGS_MARKER.length + MAX_SETTINGS_LENGTH)
  const request = objectAfterKey(settings, 'request')
  const dispatcher = objectAfterKey(settings, 'dispatcher')
  const file = objectAfterKey(settings, 'serverSideFolders')
  const videoDispatcher = objectValue(dispatcher?.videowl_view)
  const weblink = safeWeblink(request?.weblink)
  const hlsBaseUrl = stringValue(videoDispatcher?.url)
  if (weblink === '' || hlsBaseUrl === '' || file === null || stringValue(file.kind) !== 'file') return null
  return Object.freeze({
    weblink,
    title: stringValue(file.name),
    hlsBaseUrl
  })
}

function objectAfterKey(input: string, key: string): JsonObject | null {
  const keyIndex = input.indexOf(`"${key}"`)
  if (keyIndex < 0) return null
  const colonIndex = input.indexOf(':', keyIndex + key.length + 2)
  if (colonIndex < 0) return null
  let start = colonIndex + 1
  while (/\s/.test(input[start] ?? '')) start++
  if (input[start] !== '{') return null
  const value = balancedObject(input, start)
  if (value === '') return null
  try {
    return objectValue(JSON.parse(value))
  } catch {
    return null
  }
}

function balancedObject(input: string, start: number): string {
  let depth = 0
  let quote = ''
  let escaped = false
  const limit = Math.min(input.length, start + MAX_OBJECT_LENGTH)
  for (let index = start; index < limit; index++) {
    const character = input[index] ?? ''
    if (quote !== '') {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"') {
      quote = character
      continue
    }
    if (character === '{') depth++
    else if (character === '}' && --depth === 0) return input.slice(start, index + 1)
  }
  return ''
}

function safeVideoBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    const providerHost = url.hostname === 'cloud.mail.ru' || url.hostname.endsWith('.cloud.mail.ru')
    return url.protocol === 'https:' && providerHost && !url.username && !url.password &&
      url.pathname.startsWith('/videowl/view/') ? url : null
  } catch {
    return null
  }
}

function isSafeCloudMailId(value: string): boolean {
  return value.length <= 1_024 && /^public\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){0,7}$/.test(value)
}

function safeWeblink(value: unknown): string {
  const weblink = stringValue(value)
  return weblink.length <= 1_000 && /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){0,7}$/.test(weblink) ? weblink : ''
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
}
