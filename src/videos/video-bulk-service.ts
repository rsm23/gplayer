import { Hosting } from '../core/hosting.js'
import type { MediaTrack } from '../core/source-resolver.js'
import type { SourceApiRequestContext, SourceApiResolver } from '../http/source-api-routes.js'
import type { VideoAccess, VideoAdminRecord, VideoAdminService, VideoLinkSlugs } from './video-admin-service.js'

export const VIDEO_BULK_MAX_ITEMS = 1_000

export type VideoBulkProgress = Readonly<{
  offset: number
  next: number
  total: number
  data?: VideoBulkRecord
}>

export type VideoBulkRecord = Readonly<{
  id: string
  has_sub: boolean
  has_alt: false
  title: string
  image: string
  poster: string
  created: number
  status: number
  actions: Readonly<{ embed: string; download: string; embed_code: string }>
  slug: string
  host: string
  host_id: string
  link: string
}>

export type VideoBulkResult = Readonly<{
  status: 'ok' | 'fail'
  message: string
  result: VideoBulkProgress
}>

export class VideoBulkService {
  public constructor(
    private readonly videos: VideoAdminService,
    private readonly resolve: SourceApiResolver
  ) {}

  public async add(
    input: Readonly<Record<string, unknown>>,
    access: VideoAccess,
    context: Omit<SourceApiRequestContext, 'downloadable'>,
    slugs?: VideoLinkSlugs
  ): Promise<VideoBulkResult> {
    const progress = bulkProgress(input.total, input.offset)
    if (progress === null) return failure('The new video failed to save', emptyProgress())

    const sourceUrl = safeHttpUrl(stringValue(input.data).slice(0, 2_048))
    if (sourceUrl === null) return failure('The video URL is invalid', progress)
    const hosting = new Hosting(sourceUrl.href)
    if (hosting.getHost() === '' || hosting.getID() === '') return failure('The video URL is invalid', progress)

    let resolved
    try {
      resolved = await this.resolve(
        Object.freeze({ host: hosting.getHost(), id: hosting.getID(), uid: access.userId }),
        { ...context, downloadable: false }
      )
    } catch {
      return failure('The video source could not be checked', progress)
    }

    const title = resolved.title.slice(0, 255)
    const poster = safeHttpUrl(resolved.image)?.href ?? ''
    const mutation = await this.videos.createResolved({
      title,
      mainUrl: sourceUrl.href,
      slug: legacyBoolean(input.useTitle) && title !== '' ? title : '',
      posterUrl: poster,
      alternatives: Object.freeze([]),
      subtitles: tracks(resolved.tracks)
    }, access, resolved.sources.length > 0 ? 0 : 1)
    if (mutation.status === 'fail' || mutation.id === undefined) return failure(mutation.message, progress)

    const record = await this.videos.record(mutation.id, access, slugs)
    if (record === null) return failure('The new video failed to save', progress)
    return Object.freeze({
      status: 'ok',
      message: 'The new video has been saved successfully',
      result: Object.freeze({ ...progress, data: bulkRecord(record) })
    })
  }
}

function tracks(input: readonly MediaTrack[]): readonly Readonly<{ url: string; language: string }>[] {
  const result: Array<Readonly<{ url: string; language: string }>> = []
  for (const item of input.slice(0, 50)) {
    const url = safeHttpUrl(stringValue(item.file))
    if (url === null) continue
    result.push(Object.freeze({
      url: url.href,
      language: stringValue(item.label).slice(0, 50).trim() || 'Unknown CC'
    }))
  }
  return Object.freeze(result)
}

function bulkRecord(record: VideoAdminRecord): VideoBulkRecord {
  return Object.freeze({
    id: record.id,
    has_sub: record.hasSubtitles,
    has_alt: false,
    title: record.title,
    image: '',
    poster: record.poster,
    created: record.created,
    status: record.status,
    actions: Object.freeze({
      embed: record.embedUrl,
      download: record.downloadUrl,
      embed_code: escapeHtml(record.embedCode)
    }),
    slug: record.slug,
    host: record.host,
    host_id: record.hostId,
    link: record.mainUrl
  })
}

function bulkProgress(totalInput: unknown, offsetInput: unknown): VideoBulkProgress | null {
  const total = strictInteger(totalInput)
  const offset = strictInteger(offsetInput)
  if (total === null || offset === null || total < 1 || total > VIDEO_BULK_MAX_ITEMS || offset < 0 || offset >= total) return null
  return Object.freeze({ offset, next: offset + 1, total })
}

function emptyProgress(): VideoBulkProgress {
  return Object.freeze({ offset: 0, next: 0, total: 0 })
}

function failure(message: string, result: VideoBulkProgress): VideoBulkResult {
  return Object.freeze({ status: 'fail', message, result })
}

function strictInteger(value: unknown): number | null {
  const normalized = typeof value === 'number' ? String(value) : stringValue(value)
  if (!/^(?:0|[1-9]\d*)$/u.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function legacyBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  return ['1', 'true', 'on', 'yes'].includes(stringValue(value).toLowerCase())
}

function safeHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim())
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') return null
    return url
  } catch {
    return null
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')
}
