import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const API_BASE = 'https://www.aparat.com/api/fa/v1/video/video/show/videohash/'
const APARAT_REFERER = 'https://www.aparat.com/'
const MAX_LOOKUPS = 3

type JsonObject = Record<string, unknown>

export class AparatExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || !isSafeId(this.id)) return
    this.#loaded = true
    this.referer = APARAT_REFERER
    try {
      const attributes = await this.resolveAttributes()
      if (attributes === null) return
      this.title = stringValue(attributes.title)
      this.image = firstRemoteUrl([
        attributes.big_poster,
        attributes.medium_poster,
        attributes.small_poster
      ])

      const mp4Sources = aparatMp4Sources(attributes)
      if (this.downloadable) {
        this.sources.push(...mp4Sources)
        return
      }
      const hls = remoteUrl(stringValue(attributes.hls_link))
      if (hls !== '') {
        this.sources.push({ file: hls, type: 'hls', label: 'Original' })
        return
      }
      this.sources.push(...mp4Sources.slice(-1))
    } catch {
      // Invalid or unavailable provider responses produce an empty result.
    }
  }

  private async resolveAttributes(): Promise<JsonObject | null> {
    let candidate = this.id
    const visited = new Set<string>()
    for (let attempt = 0; attempt < MAX_LOOKUPS && isSafeId(candidate) && !visited.has(candidate); attempt += 1) {
      visited.add(candidate)
      const response = await this.http.get({
        url: `${API_BASE}${encodeURIComponent(candidate)}`,
        headers: { referer: APARAT_REFERER }
      })
      const payload = parseObject(response.body)
      if (payload === null) return null
      const attributes = responseAttributes(payload)
      if (attributes !== null && hasMedia(attributes)) return attributes
      const next = redirectId(payload, attributes)
      if (next === '') return attributes
      candidate = next
    }
    return null
  }
}

function aparatMp4Sources(attributes: JsonObject) {
  const links = Array.isArray(attributes.file_link_all) ? attributes.file_link_all : []
  const sources: Array<{ file: string; type: 'video/mp4'; label: string; height: number }> = []
  for (const value of links) {
    const link = objectValue(value)
    if (link === null) continue
    const urls = Array.isArray(link.urls) ? link.urls : []
    const file = firstRemoteUrl(urls)
    if (file === '') continue
    const profile = stringValue(link.profile)
    const height = Number.parseInt(profile, 10)
    sources.push({
      file,
      type: 'video/mp4',
      label: profile || 'Original',
      height: Number.isFinite(height) ? height : 0
    })
  }
  sources.sort((left, right) => left.height - right.height)
  return sources.map(({ height: _height, ...source }) => source)
}

function responseAttributes(payload: JsonObject): JsonObject | null {
  const data = payload.data
  if (Array.isArray(data)) return objectValue(objectValue(data[0])?.attributes)
  return objectValue(objectValue(data)?.attributes)
}

function redirectId(payload: JsonObject, attributes: JsonObject | null): string {
  const redirect = stringValue(objectValue(payload.meta)?.redirectUid)
  if (isSafeId(redirect)) return redirect
  const uid = stringValue(attributes?.uid)
  return isSafeId(uid) ? uid : ''
}

function hasMedia(attributes: JsonObject): boolean {
  return remoteUrl(stringValue(attributes.hls_link)) !== '' ||
    (Array.isArray(attributes.file_link_all) && attributes.file_link_all.length > 0)
}

function firstRemoteUrl(values: readonly unknown[]): string {
  for (const value of values) {
    const url = remoteUrl(stringValue(value))
    if (url !== '') return url
  }
  return ''
}

function remoteUrl(value: string): string {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.toString()
      : ''
  } catch {
    return ''
  }
}

function parseObject(value: string): JsonObject | null {
  try {
    return objectValue(JSON.parse(value))
  } catch {
    return null
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
}

function isSafeId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value)
}
