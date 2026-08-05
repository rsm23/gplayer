import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const FILEMAIL_REFERER = 'https://www.filemail.com/'
const MEDIA_EXTENSIONS = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'wav'])

type JsonObject = Record<string, unknown>

export class FilemailExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || !isSafeTrackId(this.id)) return
    this.#loaded = true
    this.referer = FILEMAIL_REFERER
    try {
      const endpoint = new URL('https://api.filemail.com/transfer')
      endpoint.search = new URLSearchParams({
        trackid: this.id,
        fprops: 'fileid,filesize,filename,downloadurl',
        fileslimit: '-1'
      }).toString()
      const response = await this.http.get({
        url: endpoint,
        headers: {
          'x-api-version': '2.0',
          filemaillogintokencheck: 'true',
          referer: this.referer
        }
      })
      if (response.status < 200 || response.status >= 300) return
      const payload = parseObject(response.body)
      const data = objectValue(payload?.data)
      if (data === null || data.isexpired === true || data.blockdownloads === true) return

      const files = Array.isArray(data.files) ? data.files : []
      const filenames: string[] = []
      const seen = new Set<string>()
      for (const value of files) {
        const file = objectValue(value)
        const filename = stringValue(file?.filename)
        const type = mediaType(filename)
        const source = filemailDownloadUrl(stringValue(file?.downloadurl))
        if (type === '' || source === '' || seen.has(source)) continue
        seen.add(source)
        filenames.push(filename)
        this.sources.push({ file: source, type, label: filename || 'Original' })
      }
      this.title = filenames.length === 1
        ? filenames[0] ?? ''
        : firstString([data.subject, data.message, data.trackid, data.id])
    } catch {
      // Invalid or unavailable provider responses produce an empty result.
    }
  }
}

function mediaType(filename: string): '' | 'hls' | 'mpd' | 'video/mp4' {
  const extension = extensionOf(filename)
  if (extension === 'm3u8') return 'hls'
  if (extension === 'mpd') return 'mpd'
  return MEDIA_EXTENSIONS.has(extension) ? 'video/mp4' : ''
}

function filemailDownloadUrl(value: string): string {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return ''
    url.searchParams.set('skipcheck', 'true')
    url.searchParams.set('skipreg', 'true')
    return url.toString()
  } catch {
    return ''
  }
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index < 0 ? '' : name.slice(index + 1).toLowerCase()
}

function firstString(values: readonly unknown[]): string {
  for (const value of values) {
    const result = stringValue(value)
    if (result !== '') return result
  }
  return ''
}

function isSafeTrackId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value)
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
