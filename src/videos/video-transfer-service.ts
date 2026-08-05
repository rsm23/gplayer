import { Hosting } from '../core/hosting.js'
import { RemoteProviderHttpClient, type ProviderHttpClient } from '../hosting/provider-http.js'
import type { StoredVideoDetail, VideoAccess, VideoAdminService, VideoLinkSlugs } from './video-admin-service.js'

export const VIDEO_IMPORT_FAIL = 'New video list failed to import'
export const VIDEO_IMPORT_SUCCESS = 'The new video list has been successfully imported'
export const VIDEO_EXPORT_FAIL = 'Video list failed to export'
export const VIDEO_EXPORT_SUCCESS = 'The video list has been exported successfully'
export const VIDEO_TRANSFER_BATCH_SIZE = 250

const MAX_CSV_COLUMNS = 500
const MAX_SUBTITLE_JSON_ITEMS = 50

export type ParsedVideoImportRow = Readonly<{
  title: string
  slug: string
  poster: string
  subtitleJson: string
  videos: readonly string[]
  subtitles: readonly Readonly<{ url: string; language: string }>[]
}>

export type VideoImportRecord = Readonly<{
  title: string
  host: string
  has_alt: boolean
  has_sub: boolean
  link: string
  id: string
  created: number
  status: 0
  actions: Readonly<{ embed: string; download: string; embed_code: string }>
}>

export type VideoImportResult = Readonly<{
  status: 'ok' | 'fail'
  message: string
  result: readonly VideoImportRecord[]
}>

export type VideoExportResult = Readonly<{
  status: 'ok' | 'fail'
  message: string
  csv: string
  count: number
}>

export type VideoTransferServiceOptions = Readonly<{
  http?: ProviderHttpClient
  now?: () => number
}>

export class VideoTransferService {
  private readonly http: ProviderHttpClient
  private readonly now: () => number

  public constructor(
    private readonly videos: VideoAdminService,
    private readonly baseUrl: URL,
    options: VideoTransferServiceOptions = {}
  ) {
    this.http = options.http ?? new RemoteProviderHttpClient()
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  }

  public async importCsv(
    input: string | Buffer,
    access: VideoAccess,
    slugs: VideoLinkSlugs = { embed: 'e', download: 'd' }
  ): Promise<VideoImportResult> {
    let rows: readonly ParsedVideoImportRow[]
    try {
      rows = parseVideoImportCsv(input)
    } catch {
      return Object.freeze({ status: 'fail', message: VIDEO_IMPORT_FAIL, result: Object.freeze([]) })
    }

    const imported: VideoImportRecord[] = []
    for (let offset = 0; offset < rows.length; offset += VIDEO_TRANSFER_BATCH_SIZE) {
      for (const row of rows.slice(offset, offset + VIDEO_TRANSFER_BATCH_SIZE)) {
        try {
          const remoteSubtitles = await this.subtitleJson(row.subtitleJson)
          const result = await this.videos.createImported({
            title: row.title,
            mainUrl: row.videos[0] ?? '',
            slug: row.slug,
            posterUrl: row.poster,
            alternatives: row.videos.slice(1),
            subtitles: Object.freeze([...row.subtitles, ...remoteSubtitles])
          }, access)
          if (result.status !== 'ok' || result.id === undefined) continue
          const stored = await this.videos.get(result.id, access)
          if (stored === null) continue
          imported.push(this.importRecord(stored, row.videos[0] ?? '', slugs))
        } catch {
          continue
        }
      }
    }

    return imported.length === 0
      ? Object.freeze({ status: 'fail', message: VIDEO_IMPORT_FAIL, result: Object.freeze([]) })
      : Object.freeze({ status: 'ok', message: VIDEO_IMPORT_SUCCESS, result: Object.freeze(imported) })
  }

  public async exportCsv(ids: unknown, access: VideoAccess): Promise<VideoExportResult> {
    const normalized = videoIds(ids)
    const records: StoredVideoDetail[] = []
    try {
      for (const id of normalized) {
        const record = await this.videos.get(id, access)
        if (record !== null) records.push(record)
      }
    } catch {
      return Object.freeze({ status: 'fail', message: VIDEO_EXPORT_FAIL, csv: '', count: 0 })
    }
    if (records.length === 0) return Object.freeze({ status: 'fail', message: VIDEO_EXPORT_FAIL, csv: '', count: 0 })
    return Object.freeze({
      status: 'ok',
      message: VIDEO_EXPORT_SUCCESS,
      csv: serializeVideoExportCsv(records),
      count: records.length
    })
  }

  private async subtitleJson(value: string): Promise<readonly Readonly<{ url: string; language: string }>[]> {
    const url = safeHttpUrl(value)
    if (url === null) return Object.freeze([])
    try {
      const response = await this.http.get({ url, signal: AbortSignal.timeout(10_000) })
      if (response.status < 200 || response.status >= 400) return Object.freeze([])
      const decoded: unknown = JSON.parse(response.body)
      if (!Array.isArray(decoded)) return Object.freeze([])
      const subtitles: Array<Readonly<{ url: string; language: string }>> = []
      for (const item of decoded.slice(0, MAX_SUBTITLE_JSON_ITEMS)) {
        const entry = objectValue(item)
        const file = safeHttpUrl(stringValue(entry.file))
        if (file === null) continue
        subtitles.push(Object.freeze({ url: file.href, language: stringValue(entry.label).slice(0, 50).trim() || 'Unknown CC' }))
      }
      return Object.freeze(subtitles)
    } catch {
      return Object.freeze([])
    }
  }

  private importRecord(record: StoredVideoDetail, link: string, slugs: VideoLinkSlugs): VideoImportRecord {
    const embed = playerUrl(this.baseUrl, slugs.embed, record.slug)
    const download = playerUrl(this.baseUrl, slugs.download, record.slug)
    const embedCode = `<iframe title="${escapeHtmlAttribute(record.title)}" src="${escapeHtmlAttribute(embed)}" loading="lazy" frameborder="0" width="640" height="320" allowfullscreen></iframe>`
    return Object.freeze({
      title: record.title,
      host: record.host,
      has_alt: record.alternatives.length > 0,
      has_sub: record.subtitles.length > 0,
      link,
      id: record.id,
      created: record.created || this.now(),
      status: 0,
      actions: Object.freeze({
        embed,
        download,
        embed_code: escapeHtml(embedCode)
      })
    })
  }
}

export function parseVideoImportCsv(input: string | Buffer): readonly ParsedVideoImportRow[] {
  const source = Buffer.isBuffer(input) ? new TextDecoder('utf-8', { fatal: true }).decode(input) : input
  const records = csvRecords(source.replace(/^\uFEFF/u, ''))
  const headers = records[0]?.map((value) => value.trim()) ?? []
  if (headers.length === 0 || headers.length > MAX_CSV_COLUMNS) throw new Error('Invalid CSV headers')
  const videoIndexes = indexesOf(headers, 'video_url')
  if (videoIndexes.length === 0) throw new Error('A video_url column is required')
  const subtitleUrlIndexes = indexesOf(headers, 'subtitle_url')
  const subtitleLabelIndexes = indexesOf(headers, 'subtitle_label')
  const scalarIndex = (name: string): number => headers.findIndex((header) => header === name)
  const titleIndex = scalarIndex('title')
  const slugIndex = scalarIndex('slug')
  const posterIndex = scalarIndex('poster')
  const subtitleJsonIndex = scalarIndex('subtitle_json')
  const result: ParsedVideoImportRow[] = []

  for (const sourceRow of records.slice(1)) {
    const row = [...sourceRow.slice(0, headers.length)]
    while (row.length < headers.length) row.push('')
    const videos = videoIndexes.map((index) => row[index]?.trim() ?? '').filter(Boolean)
    if (videos.length === 0) continue
    const subtitles: Array<Readonly<{ url: string; language: string }>> = []
    for (let index = 0; index < subtitleUrlIndexes.length; index += 1) {
      const urlIndex = subtitleUrlIndexes[index]
      const labelIndex = subtitleLabelIndexes[index]
      const url = urlIndex === undefined ? '' : row[urlIndex]?.trim() ?? ''
      if (url === '') continue
      const language = labelIndex === undefined ? '' : row[labelIndex]?.trim() ?? ''
      subtitles.push(Object.freeze({ url, language: language || 'Unknown CC' }))
    }
    result.push(Object.freeze({
      title: titleIndex < 0 ? '' : row[titleIndex] ?? '',
      slug: slugIndex < 0 ? '' : row[slugIndex] ?? '',
      poster: posterIndex < 0 ? '' : row[posterIndex] ?? '',
      subtitleJson: subtitleJsonIndex < 0 ? '' : row[subtitleJsonIndex] ?? '',
      videos: Object.freeze(videos),
      subtitles: Object.freeze(subtitles)
    }))
  }
  return Object.freeze(result)
}

export function serializeVideoExportCsv(records: readonly StoredVideoDetail[]): string {
  const videoColumns = Math.max(1, ...records.map((record) => 1 + record.alternatives.length))
  const subtitleColumns = Math.max(0, ...records.map((record) => record.subtitles.length))
  const headers = [
    'title', 'slug', 'poster',
    ...Array.from({ length: videoColumns }, () => 'video_url'),
    ...Array.from({ length: subtitleColumns }, () => ['subtitle_url', 'subtitle_label']).flat()
  ]
  const rows = records.map((record) => {
    const videoUrls = [hostingUrl(record.host, record.hostId), ...record.alternatives.map((item) => hostingUrl(item.host, item.hostId))]
    return [
      record.title,
      record.slug,
      record.poster,
      ...padded(videoUrls, videoColumns),
      ...padded(record.subtitles.flatMap((item) => [item.link, item.language]), subtitleColumns * 2)
    ]
  })
  return `${[headers, ...rows].map((row) => row.map(csvField).join(',')).join('\n')}\n`
}

function csvRecords(source: string): string[][] {
  const records: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? ''
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else quoted = false
      } else field += character
      continue
    }
    if (character === '"' && field === '') quoted = true
    else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1
      row.push(field)
      field = ''
      if (row.some((value) => value !== '')) records.push(row)
      row = []
    } else field += character
  }
  if (quoted) throw new Error('Unterminated CSV field')
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.some((value) => value !== '')) records.push(row)
  }
  return records
}

function indexesOf(headers: readonly string[], expected: string): number[] {
  const result: number[] = []
  headers.forEach((header, index) => {
    if (header === expected) result.push(index)
  })
  return result
}

function videoIds(value: unknown): readonly string[] {
  const values = Array.isArray(value) ? value : stringValue(value).split(',')
  return Object.freeze([...new Set(values
    .map((item) => stringValue(item).trim())
    .filter((item) => /^(?:0|[1-9]\d{0,19})$/u.test(item)))]
    .slice(0, 500))
}

function hostingUrl(host: string, hostId: string): string {
  return new Hosting().setHost(host).setID(hostId).getDownloadLink()
}

function playerUrl(baseUrl: URL, slug: string, videoSlug: string): string {
  const base = new URL(`${slug.replace(/^\/+|\/+$/gu, '')}/`, ensureTrailingSlash(baseUrl))
  return new URL(videoSlug.replace(/^\/+|\/+$/gu, ''), base).href
}

function ensureTrailingSlash(url: URL): URL {
  const result = new URL(url)
  if (!result.pathname.endsWith('/')) result.pathname += '/'
  return result
}

function padded(values: readonly string[], size: number): string[] {
  return [...values, ...Array.from({ length: Math.max(0, size - values.length) }, () => '')].slice(0, size)
}

function csvField(value: string): string {
  return /[",\s]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

function safeHttpUrl(value: string): URL | null {
  if (value.trim() === '') return null
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' ? url : null
  } catch {
    return null
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeHtml(value: string): string {
  return escapeHtmlAttribute(value).replaceAll("'", '&#039;')
}
