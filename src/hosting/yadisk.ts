import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const YANDEX_DISK_ORIGIN = 'https://disk.yandex.com/'
const YANDEX_DOWNLOAD_API = 'https://cloud-api.yandex.net/v1/disk/public/resources/download'
const MAX_PREFETCH_BYTES = 4 * 1_024 * 1_024

type JsonObject = Record<string, unknown>

export type YandexDiskPage = Readonly<{
  title: string
  image: string
  hls: string
}>

export class YandexDiskExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim().replace(/^\/+/, ''))
    this.referer = YANDEX_DISK_ORIGIN
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    const pageUrl = yandexDiskPageUrl(this.id)
    if (pageUrl === null) return
    try {
      const response = await this.http.get({ url: pageUrl })
      if (response.status < 200 || response.status >= 300 || !isYandexDiskPageUrl(response.url)) return
      const page = parseYandexDiskPage(response.body)
      if (page !== null) {
        this.title = page.title
        this.image = page.image
      }

      if (this.downloadable || page === null || page.hls === '') {
        const download = new URL(YANDEX_DOWNLOAD_API)
        download.searchParams.set('public_key', response.url.toString())
        const downloadResponse = await this.http.get({ url: download })
        if (downloadResponse.status >= 200 && downloadResponse.status < 300 &&
          downloadResponse.url.hostname === 'cloud-api.yandex.net') {
          const file = yandexDownloadUrl(downloadResponse.body)
          if (file !== '') this.sources.push({ file, type: 'video/mp4', label: 'Original' })
        }
        return
      }

      this.sources.push({ file: page.hls, type: 'hls', label: 'Original' })
    } catch {
      // Invalid or unavailable provider responses produce an empty result.
    }
  }
}

export function parseYandexDiskPage(input: string): YandexDiskPage | null {
  const json = scriptJson(input, 'store-prefetch')
  if (json === '') return null
  try {
    const data = objectValue(JSON.parse(json))
    const rootId = stringValue(data?.rootResourceId)
    const resources = objectValue(data?.resources)
    const resource = objectValue(resources?.[rootId])
    if (rootId === '' || resource === null || stringValue(resource.type) !== 'file') return null
    const meta = objectValue(resource.meta)
    const streams = objectValue(resource.videoStreams)
    const videos = Array.isArray(streams?.videos) ? streams.videos : []
    const adaptive = videos.find((item) => stringValue(objectValue(item)?.dimension) === 'adaptive')
    const hlsValue = stringValue(objectValue(adaptive)?.url)
    const preview = stringValue(meta?.defaultPreview)
    return Object.freeze({
      title: stringValue(resource.name),
      image: isYandexMediaUrl(preview) ? appendImageSize(preview) : '',
      hls: isYandexMediaUrl(hlsValue) ? hlsValue : ''
    })
  } catch {
    return null
  }
}

function scriptJson(input: string, id: string): string {
  const escaped = escapeRegExp(id)
  const patterns = [
    new RegExp(`<script\\b(?=[^>]*\\bid=["']${escaped}["'])[^>]*>([\\s\\S]*?)<\\/script>`, 'i'),
    new RegExp(`<script\\b(?=[^>]*>)(?=[^>]*\\bid=["']${escaped}["'])[^>]*>([\\s\\S]*?)<\\/script>`, 'i')
  ]
  for (const pattern of patterns) {
    const value = pattern.exec(input)?.[1]?.trim() ?? ''
    if (value.length > 0 && value.length <= MAX_PREFETCH_BYTES) return value
  }
  return ''
}

function yandexDownloadUrl(input: string): string {
  try {
    const data = objectValue(JSON.parse(input))
    const href = stringValue(data?.href)
    return isYandexMediaUrl(href) ? href : ''
  } catch {
    return ''
  }
}

function yandexDiskPageUrl(id: string): URL | null {
  const path = /^(?:i\/)?[A-Za-z0-9_-]{1,512}$/.test(id)
    ? (id.startsWith('i/') ? id : `i/${id}`)
    : /^d\/[A-Za-z0-9_.~%+-]{1,512}$/.test(id) ? id : ''
  if (path === '') return null
  return new URL(path, YANDEX_DISK_ORIGIN)
}

function isYandexDiskPageUrl(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && (
    url.hostname === 'disk.yandex.com' || url.hostname === 'disk.yandex.ru' || url.hostname === 'yadi.sk'
  )
}

function isYandexMediaUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    return url.protocol === 'https:' && !url.username && !url.password && (
      hostname === 'yandex.net' || hostname.endsWith('.yandex.net') ||
      hostname === 'yandex.com' || hostname.endsWith('.yandex.com') ||
      hostname === 'yandex.ru' || hostname.endsWith('.yandex.ru')
    )
  } catch {
    return false
  }
}

function appendImageSize(value: string): string {
  return `${value}${value.includes('?') ? '&' : '?'}crop=1&size=640x320`
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
