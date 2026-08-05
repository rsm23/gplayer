import { randomBytes } from 'node:crypto'
import { Hosting } from '../core/hosting.js'
import type { PlayerMediaQuery } from '../core/player-query.js'
import type { MediaResult } from '../core/source-resolver.js'
import type { VideoPosterAssetManager } from './video-assets-service.js'

const VIDEO_COLUMNS = ['id', 'title', 'host', 'slug', 'status', 'dmca', 'id', 'views', 'name', 'created', 'updated', 'poster', 'host_id'] as const
const MAX_ALTERNATIVES = 20
const MAX_SUBTITLES = 50

export type VideoOrderColumn = typeof VIDEO_COLUMNS[number]

export type VideoAccess = Readonly<{
  userId: string
  isAdmin: boolean
}>

export type StoredVideoAlternative = Readonly<{
  id: string
  host: string
  hostId: string
  order: number
}>

export type StoredVideoSubtitle = Readonly<{
  id: string
  link: string
  language: string
  order: number
}>

export type StoredVideoRecord = Readonly<{
  id: string
  title: string
  host: string
  hostId: string
  userId: string
  userName: string
  slug: string
  status: number
  dmca: number
  views: number
  poster: string
  created: number
  updated: number
  hasAlternatives: boolean
  hasSubtitles: boolean
}>

export type StoredVideoDetail = StoredVideoRecord & Readonly<{
  alternatives: readonly StoredVideoAlternative[]
  subtitles: readonly StoredVideoSubtitle[]
}>

export type VideoListQuery = Readonly<{
  draw: number
  start: number
  length: number
  search: string
  orderBy: VideoOrderColumn
  orderDir: 'asc' | 'desc'
  status: number | null
  dmca: number | null
  userId: string | null
}>

export type VideoListResult = Readonly<{
  data: readonly StoredVideoRecord[]
  recordsTotal: number
  recordsFiltered: number
}>

export type VideoAlternativeWrite = Readonly<{ host: string; hostId: string; order: number }>
export type VideoSubtitleWrite = Readonly<{ link: string; language: string; order: number; userId: string; created: number; updated: number }>

export type VideoCreateWrite = Readonly<{
  title: string
  host: string
  hostId: string
  userId: string
  slug: string
  status: number
  dmca: number
  views: number
  poster: string
  created: number
  updated: number
  alternatives: readonly VideoAlternativeWrite[]
  subtitles: readonly VideoSubtitleWrite[]
}>

export type VideoUpdateWrite = Readonly<{
  title: string
  host: string
  hostId: string
  slug: string
  poster: string
  updated: number
  alternatives: readonly VideoAlternativeWrite[]
  subtitles: readonly VideoSubtitleWrite[]
}>

export interface VideoAdminStore {
  listVideos(query: VideoListQuery, access: VideoAccess): Promise<VideoListResult>
  getVideo(id: string, access: VideoAccess): Promise<StoredVideoDetail | null>
  getPublicVideo(idOrSlug: string): Promise<StoredVideoDetail | null>
  findVideoBySource?(host: string, hostId: string, userId: string): Promise<string | null>
  slugExists(slug: string, excludeId?: string): Promise<boolean>
  createVideo(value: VideoCreateWrite): Promise<string | null>
  updateVideo(id: string, access: VideoAccess, value: VideoUpdateWrite): Promise<boolean>
  deleteVideo(id: string, access: VideoAccess): Promise<boolean>
  renameVideo(id: string, access: VideoAccess, title: string, updated: number): Promise<boolean>
  renameVideos(ids: readonly string[], access: VideoAccess, transform: Readonly<{ prefix: string; postfix: string; search: string; replacement: string }>, updated: number): Promise<boolean>
  updateVideoStatus(id: string, access: VideoAccess, status: number): Promise<boolean>
  updateVideoDmca(id: string, takedown: number, updated: number): Promise<boolean>
  updateVideoPoster(id: string, access: VideoAccess, poster: string, updated: number): Promise<boolean>
  deleteVideoSubtitle(id: string, access: VideoAccess): Promise<boolean>
  updateVideoSubtitle(id: string, access: VideoAccess, link: string, language: string, updated: number): Promise<boolean>
  deleteVideosByHosts(hosts: readonly string[]): Promise<readonly string[]>
}

export type VideoAdminRecord = StoredVideoRecord & Readonly<{
  mainUrl: string
  posterUrl: string
  embedUrl: string
  downloadUrl: string
  embedCode: string
}>

export type LegacyVideoRecord = Readonly<Record<string, unknown>>

export type VideoMutationResult = Readonly<{
  status: 'ok' | 'fail'
  message: string
  id?: string
}>

export type VideoFormSubmission = Readonly<{
  title: unknown
  mainUrl: unknown
  slug: unknown
  posterUrl: unknown
  alternatives: readonly unknown[]
  subtitles: readonly Readonly<{ url: unknown; language: unknown }>[]
  posterFile?: Readonly<{ originalName: string; content: Buffer }>
}>

export type VideoAdminServiceOptions = Readonly<{
  now?: () => number
  randomSlug?: () => string
  embedSlug?: string
  downloadSlug?: string
}>

export type VideoLinkSlugs = Readonly<{ embed: string; download: string }>

export class VideoAdminService {
  private readonly now: () => number
  private readonly randomSlug: () => string
  private readonly embedSlug: string
  private readonly downloadSlug: string

  public constructor(
    private readonly store: VideoAdminStore,
    private readonly posters: VideoPosterAssetManager,
    private readonly baseUrl: URL,
    options: VideoAdminServiceOptions = {}
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.randomSlug = options.randomSlug ?? (() => randomBytes(6).toString('hex'))
    this.embedSlug = options.embedSlug ?? 'e'
    this.downloadSlug = options.downloadSlug ?? 'd'
  }

  public async records(input: Record<string, unknown>, access: VideoAccess, slugs?: VideoLinkSlugs): Promise<Readonly<{
    draw: number
    data: readonly VideoAdminRecord[]
    recordsTotal: number
    recordsFiltered: number
  }>> {
    const query = videoListQuery(input, access)
    const result = await this.store.listVideos(query, access)
    return Object.freeze({
      draw: query.draw,
      data: Object.freeze(result.data.map((record) => this.adminRecord(record, slugs))),
      recordsTotal: result.recordsTotal,
      recordsFiltered: result.recordsFiltered
    })
  }

  public async list(input: Record<string, unknown>, access: VideoAccess, slugs?: VideoLinkSlugs): Promise<Readonly<{
    draw: number
    data: readonly LegacyVideoRecord[]
    recordsTotal: number
    recordsFiltered: number
  }>> {
    const result = await this.records(input, access, slugs)
    return Object.freeze({
      draw: result.draw,
      data: Object.freeze(result.data.map((record) => Object.freeze({
        id: record.id,
        title: record.title,
        host: record.host,
        host_id: record.hostId,
        slug: record.slug,
        status: record.status,
        dmca: record.dmca,
        views: record.views,
        name: record.userName,
        uid: record.userId,
        created: record.created,
        updated: record.updated,
        poster: record.poster,
        poster_url: record.posterUrl,
        has_alt: record.hasAlternatives ? 1 : 0,
        has_sub: record.hasSubtitles ? 1 : 0,
        link: record.mainUrl,
        DT_RowId: record.id,
        actions: Object.freeze({
          embed: record.embedUrl,
          download: record.downloadUrl,
          embed_code: record.embedCode
        })
      }))),
      recordsTotal: result.recordsTotal,
      recordsFiltered: result.recordsFiltered
    })
  }

  public async get(id: unknown, access: VideoAccess): Promise<StoredVideoDetail | null> {
    const normalized = videoId(id)
    return normalized === null ? null : await this.store.getVideo(normalized, access)
  }

  public async create(input: VideoFormSubmission, access: VideoAccess): Promise<VideoMutationResult> {
    return await this.createWithStatus(input, access, 1, false)
  }

  public async createImported(input: VideoFormSubmission, access: VideoAccess): Promise<VideoMutationResult> {
    return await this.createWithStatus(input, access, 0, true)
  }

  public async createResolved(input: VideoFormSubmission, access: VideoAccess, status: 0 | 1): Promise<VideoMutationResult> {
    return await this.createWithStatus(input, access, status, true)
  }

  public async capturePublicVideo(media: PlayerMediaQuery, ownerId: string, resolved?: MediaResult): Promise<VideoMutationResult> {
    const userId = publicOwnerId(ownerId)
    const host = stringValue(media.host).trim().toLowerCase()
    const hostId = stringValue(media.id).trim()
    if (userId === null || !/^[a-z0-9_-]{1,50}$/u.test(host) || hostId === '' || hostId.length > 2_048) return fail('The public video is invalid')

    try {
      const existing = await this.store.findVideoBySource?.(host, hostId, userId) ?? null
      if (existing !== null) return Object.freeze({ status: 'ok', message: 'The public video is already saved', id: existing })

      const now = this.now()
      const title = publicVideoTitle(media, resolved)
      const slug = await this.uniqueImportedSlug(title)
      if (slug === null) return fail('The public video failed to save')
      const poster = publicVideoPoster(media, resolved)
      const value: VideoCreateWrite = Object.freeze({
        title,
        host,
        hostId,
        userId,
        slug,
        status: resolved !== undefined && resolved.sources.length === 0 ? 1 : 0,
        dmca: 0,
        views: 0,
        poster,
        created: now,
        updated: now,
        alternatives: publicVideoAlternatives(media, host, hostId),
        subtitles: publicVideoSubtitles(media, resolved, userId, now)
      })
      const id = await this.store.createVideo(value)
      return id === null
        ? fail('The public video failed to save')
        : Object.freeze({ status: 'ok', message: 'The public video has been saved', id })
    } catch {
      return fail('The public video failed to save')
    }
  }

  public async record(id: unknown, access: VideoAccess, slugs?: VideoLinkSlugs): Promise<VideoAdminRecord | null> {
    const detail = await this.get(id, access)
    return detail === null ? null : this.adminRecord(detail, slugs)
  }

  private async createWithStatus(input: VideoFormSubmission, access: VideoAccess, status: 0 | 1, resolveSlugConflict: boolean): Promise<VideoMutationResult> {
    const parsed = parseSubmission(input, access, this.now(), status)
    if (parsed.status === 'fail') return parsed
    const slug = resolveSlugConflict ? await this.uniqueImportedSlug(input.slug) : await this.uniqueSlug(input.slug)
    if (slug === null) return fail('The custom slug is already in use')

    let uploadedPoster = ''
    if (input.posterFile !== undefined) {
      try {
        uploadedPoster = (await this.posters.create(input.posterFile.originalName, input.posterFile.content)).name
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'The poster file failed to upload')
      }
    }
    const poster = uploadedPoster || parsed.poster
    try {
      const id = await this.store.createVideo({ ...parsed.value, slug, poster })
      if (id === null) {
        if (uploadedPoster !== '') await this.posters.delete(uploadedPoster).catch(() => false)
        return fail('The new video failed to save')
      }
      return Object.freeze({ status: 'ok', message: 'The new video has been saved successfully', id })
    } catch {
      if (uploadedPoster !== '') await this.posters.delete(uploadedPoster).catch(() => false)
      return fail('The new video failed to save')
    }
  }

  public async update(id: unknown, input: VideoFormSubmission, access: VideoAccess): Promise<VideoMutationResult> {
    const normalized = videoId(id)
    if (normalized === null) return fail('The video was not found')
    const current = await this.store.getVideo(normalized, access)
    if (current === null) return fail('The video was not found')
    if (!access.isAdmin && current.dmca > 0) return fail('The video failed to update')

    const parsed = parseSubmission(input, access, this.now())
    if (parsed.status === 'fail') return parsed
    const slug = await this.uniqueSlug(input.slug, normalized, current.slug)
    if (slug === null) return fail('The custom slug is already in use')

    let uploadedPoster = ''
    if (input.posterFile !== undefined) {
      try {
        uploadedPoster = (await this.posters.create(input.posterFile.originalName, input.posterFile.content)).name
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'The poster file failed to upload')
      }
    }
    const poster = uploadedPoster || parsed.poster || current.poster
    try {
      const updated = await this.store.updateVideo(normalized, access, {
        title: parsed.value.title,
        host: parsed.value.host,
        hostId: parsed.value.hostId,
        slug,
        poster,
        updated: parsed.value.updated,
        alternatives: parsed.value.alternatives,
        subtitles: parsed.value.subtitles
      })
      if (!updated) {
        if (uploadedPoster !== '') await this.posters.delete(uploadedPoster).catch(() => false)
        return fail('The video failed to update')
      }
      if (uploadedPoster !== '' && current.poster !== '' && current.poster !== uploadedPoster) {
        await this.posters.delete(current.poster).catch(() => false)
      }
      return Object.freeze({ status: 'ok', message: 'The video has been successfully updated', id: normalized })
    } catch {
      if (uploadedPoster !== '') await this.posters.delete(uploadedPoster).catch(() => false)
      return fail('The video failed to update')
    }
  }

  public async delete(id: unknown, access: VideoAccess): Promise<VideoMutationResult> {
    const normalized = videoId(id)
    if (normalized === null) return fail('The video was not found')
    const current = await this.store.getVideo(normalized, access)
    if (current === null) return fail('The video was not found')
    const deleted = await this.store.deleteVideo(normalized, access)
    if (!deleted) return fail('The video failed to delete')
    if (current.poster !== '') await this.posters.delete(current.poster).catch(() => false)
    return Object.freeze({ status: 'ok', message: 'The video has been successfully deleted', id: normalized })
  }

  public async rename(id: unknown, title: unknown, access: VideoAccess): Promise<VideoMutationResult> {
    const normalized = videoId(id)
    const name = boundedString(title, 255)
    if (name.trim() === '') return fail('The video title is invalid')
    if (normalized === null) return fail('The video was not found')
    const updated = await this.store.renameVideo(normalized, access, name, this.now())
    return updated ? Object.freeze({ status: 'ok', message: 'The video has been successfully updated', id: normalized }) : fail('The video failed to update')
  }

  public async renameMany(input: Record<string, unknown>, access: VideoAccess): Promise<VideoMutationResult> {
    const ids = stringValue(input.ids).split(',').map((value) => videoId(value)).filter((value): value is string => value !== null).slice(0, 500)
    if (ids.length === 0) return fail('The video title is invalid')
    const transform = Object.freeze({
      prefix: boundedString(input.renamePrefix, 255),
      postfix: boundedString(input.renamePostfix, 255),
      search: boundedString(input.renameReplaceX, 255),
      replacement: boundedString(input.renameReplaceY, 255)
    })
    const updated = await this.store.renameVideos(ids, access, transform, this.now())
    return updated ? Object.freeze({ status: 'ok', message: 'The video has been successfully updated' }) : fail('The video failed to update')
  }

  public async status(id: unknown, sources: unknown, access: VideoAccess): Promise<VideoMutationResult> {
    const normalized = videoId(id)
    if (normalized === null) return fail('The video was not found')
    const updated = await this.store.updateVideoStatus(normalized, access, emptyValue(sources) ? 1 : 0)
    return updated ? Object.freeze({ status: 'ok', message: 'The new video has been saved successfully', id: normalized }) : fail('The new video failed to save')
  }

  public async dmca(id: unknown, takedown: unknown, access: VideoAccess): Promise<VideoMutationResult> {
    const normalized = videoId(id)
    const value = strictInteger(takedown)
    if (!access.isAdmin || normalized === null || value === null || value < 0 || value > 1) return fail('The video failed to update')
    const updated = await this.store.updateVideoDmca(normalized, value, this.now())
    return updated ? Object.freeze({ status: 'ok', message: 'The video has been successfully updated', id: normalized }) : fail('The video failed to update')
  }

  public async removePoster(id: unknown, access: VideoAccess): Promise<VideoMutationResult> {
    const normalized = videoId(id)
    if (normalized === null) return fail('The video was not found')
    const current = await this.store.getVideo(normalized, access)
    if (current === null) return fail('The video was not found')
    const updated = await this.store.updateVideoPoster(normalized, access, '', this.now())
    if (!updated) return fail('The poster failed to remove')
    if (current.poster !== '') await this.posters.delete(current.poster).catch(() => false)
    return Object.freeze({ status: 'ok', message: 'The poster has been successfully removed', id: normalized })
  }

  public async deleteSubtitle(id: unknown, access: VideoAccess): Promise<VideoMutationResult> {
    const normalized = videoId(id)
    if (normalized === null) return fail('The subtitle failed to remove')
    const deleted = await this.store.deleteVideoSubtitle(normalized, access)
    return deleted ? Object.freeze({ status: 'ok', message: 'The subtitle has been successfully removed', id: normalized }) : fail('The subtitle failed to remove')
  }

  public async deleteByHostnames(input: unknown, access: VideoAccess): Promise<VideoMutationResult> {
    if (!access.isAdmin) return fail('The video failed to delete')
    const values = Array.isArray(input) ? input : stringValue(input).split(',')
    const hosts = [...new Set(values
      .map((value) => stringValue(value).trim().toLowerCase())
      .filter((value) => /^[a-z0-9_-]{1,50}$/u.test(value)))]
      .slice(0, 100)
    if (hosts.length === 0) return fail('The video failed to delete')
    const posters = await this.store.deleteVideosByHosts(hosts)
    for (const poster of posters) {
      if (poster !== '') await this.posters.delete(poster).catch(() => false)
    }
    return posters.length > 0
      ? Object.freeze({ status: 'ok', message: 'The video has been successfully deleted' })
      : fail('The video failed to delete')
  }

  public async editSubtitle(id: unknown, link: unknown, language: unknown, access: VideoAccess): Promise<VideoMutationResult> {
    const normalized = videoId(id)
    const url = safeHttpUrl(boundedString(link, 2048))
    const label = boundedString(language, 50).trim() || 'Unknown CC'
    if (normalized === null) return fail('The subtitle was not found')
    if (url === null) return fail('The subtitle URL is invalid')
    const updated = await this.store.updateVideoSubtitle(normalized, access, url.href, label, this.now())
    return updated ? Object.freeze({ status: 'ok', message: 'The subtitle file has been successfully updated', id: normalized }) : fail('The subtitle file failed to update')
  }

  public async alternatives(id: unknown, access: VideoAccess): Promise<readonly Readonly<{ host: string; url: string }>[] | null> {
    const record = await this.get(id, access)
    if (record === null) return null
    return Object.freeze([
      Object.freeze({ host: record.host, url: videoUrl(record.host, record.hostId) }),
      ...record.alternatives.map((item) => Object.freeze({ host: item.host, url: videoUrl(item.host, item.hostId) }))
    ])
  }

  public async savedQuery(idOrSlug: unknown): Promise<PlayerMediaQuery | null> {
    const identity = boundedString(idOrSlug, 150).trim()
    if (identity === '') return null
    const record = await this.store.getPublicVideo(identity)
    if (record === null || record.dmca > 0) return null
    return this.playerQuery(record)
  }

  public async sourceQuery(id: unknown, access: VideoAccess): Promise<PlayerMediaQuery | null> {
    const record = await this.get(id, access)
    return record === null ? null : this.playerQuery(record)
  }

  private playerQuery(record: StoredVideoDetail): PlayerMediaQuery {
    const firstAlternative = record.alternatives[0]
    const subtitles = record.subtitles.map((item) => item.link).filter((value) => safeHttpUrl(value) !== null)
    return Object.freeze({
      host: record.host,
      id: record.hostId,
      title: record.title,
      ...(firstAlternative === undefined ? {} : { ahost: firstAlternative.host, aid: firstAlternative.hostId }),
      ...(record.alternatives.length === 0 ? {} : {
        alternatives: Object.freeze(record.alternatives.map((item) => Object.freeze({ host: item.host, id: item.hostId })))
      }),
      ...(record.poster === '' ? {} : { poster: this.posterUrl(record.poster) }),
      ...(subtitles.length === 0 ? {} : {
        sub: Object.freeze(subtitles),
        lang: Object.freeze(record.subtitles.filter((item) => safeHttpUrl(item.link) !== null).map((item) => item.language))
      }),
      uid: record.userId
    })
  }

  public posterUrl(value: string): string {
    return safeHttpUrl(value)?.href ?? this.posters.url(value)
  }

  private async uniqueSlug(input: unknown, excludeId?: string, fallback = ''): Promise<string | null> {
    const submitted = stringValue(input).trim()
    if (submitted !== '') {
      const slug = slugify(submitted)
      if (slug === '' || slug.length > 50 || await this.store.slugExists(slug, excludeId)) return null
      return slug
    }
    if (fallback !== '' && !await this.store.slugExists(fallback, excludeId)) return fallback
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const slug = slugify(this.randomSlug()).slice(0, 50)
      if (slug !== '' && !await this.store.slugExists(slug, excludeId)) return slug
    }
    return null
  }

  private async uniqueImportedSlug(input: unknown): Promise<string | null> {
    const base = slugify(stringValue(input).trim()).slice(0, 50)
    if (base === '') return await this.uniqueSlug('')
    if (!await this.store.slugExists(base)) return base
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const suffix = slugify(this.randomSlug()).slice(0, 5)
      const slug = `${base.slice(0, Math.max(1, 49 - suffix.length))}-${suffix}`.slice(0, 50)
      if (suffix !== '' && !await this.store.slugExists(slug)) return slug
    }
    return null
  }

  private adminRecord(record: StoredVideoRecord, slugs?: VideoLinkSlugs): VideoAdminRecord {
    const embedSlug = slugs?.embed ?? this.embedSlug
    const downloadSlug = slugs?.download ?? this.downloadSlug
    const embedUrl = new URL(`${record.slug.replace(/^\/+|\/+$/g, '')}`, new URL(`${embedSlug}/`, ensureTrailingSlash(this.baseUrl))).href
    const downloadUrl = new URL(`${record.slug.replace(/^\/+|\/+$/g, '')}`, new URL(`${downloadSlug}/`, ensureTrailingSlash(this.baseUrl))).href
    return Object.freeze({
      ...record,
      mainUrl: videoUrl(record.host, record.hostId),
      posterUrl: this.posterUrl(record.poster),
      embedUrl,
      downloadUrl,
      embedCode: `<iframe title="${escapeHtmlAttribute(record.title)}" src="${escapeHtmlAttribute(embedUrl)}" loading="lazy" frameborder="0" width="640" height="320" allowfullscreen></iframe>`
    })
  }
}

function parseSubmission(input: VideoFormSubmission, access: VideoAccess, now: number, status: 0 | 1 = 1): Readonly<{ status: 'fail'; message: string }> | Readonly<{
  status: 'parsed'
  poster: string
  value: Omit<VideoCreateWrite, 'slug' | 'poster'>
}> {
  const title = boundedString(input.title, 255)
  const mainUrl = safeHttpUrl(boundedString(input.mainUrl, 2048))
  if (mainUrl === null) return validationFail('The main video URL is invalid')
  const main = new Hosting(mainUrl.href)
  if (main.getHost() === '' || main.getID() === '') return validationFail('The main video URL is invalid')

  const posterInput = boundedString(input.posterUrl, 2048).trim()
  const poster = posterInput === '' ? '' : safeHttpUrl(posterInput)?.href
  if (poster === undefined) return validationFail('The poster URL is invalid')

  const alternatives: VideoAlternativeWrite[] = []
  const seen = new Set([`${main.getHost()}\u0000${main.getID()}`])
  for (const raw of input.alternatives.slice(0, MAX_ALTERNATIVES)) {
    const parsed = safeHttpUrl(boundedString(raw, 2048))
    if (parsed === null) continue
    const hosting = new Hosting(parsed.href)
    const key = `${hosting.getHost()}\u0000${hosting.getID()}`
    if (hosting.getID() === '' || seen.has(key)) continue
    seen.add(key)
    alternatives.push(Object.freeze({ host: hosting.getHost(), hostId: hosting.getID(), order: alternatives.length }))
  }

  const subtitles: VideoSubtitleWrite[] = []
  for (const raw of input.subtitles.slice(0, MAX_SUBTITLES)) {
    const url = safeHttpUrl(boundedString(raw.url, 2048))
    if (url === null) continue
    const language = boundedString(raw.language, 50).trim() || 'Unknown CC'
    subtitles.push(Object.freeze({
      link: url.href,
      language,
      order: subtitles.length,
      userId: access.userId,
      created: now,
      updated: now
    }))
  }

  return Object.freeze({
    status: 'parsed',
    poster,
    value: Object.freeze({
      title,
      host: main.getHost(),
      hostId: main.getID(),
      userId: access.userId,
      status,
      dmca: 0,
      views: 0,
      created: now,
      updated: now,
      alternatives: Object.freeze(alternatives),
      subtitles: Object.freeze(subtitles)
    })
  })
}

export function parseBulkSubtitleLines(value: unknown): readonly Readonly<{ url: string; language: string }>[] {
  const result: Array<Readonly<{ url: string; language: string }>> = []
  for (const rawLine of stringValue(value).replaceAll('\r', '').replaceAll('\t', '').split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const parts = line.split('|').map((item) => item.trim())
    let url = line
    let language = ''
    if (parts.length === 2) {
      const firstUrl = safeHttpUrl(parts[0] ?? '')
      const secondUrl = safeHttpUrl(parts[1] ?? '')
      if (firstUrl !== null && secondUrl === null) {
        url = firstUrl.href
        language = boundedString(parts[1], 50)
      } else if (secondUrl !== null && firstUrl === null) {
        url = secondUrl.href
        language = boundedString(parts[0], 50)
      }
    }
    const parsed = safeHttpUrl(url)
    if (parsed === null) continue
    result.push(Object.freeze({ url: parsed.href, language: language || inferredSubtitleLanguage(parsed) }))
  }
  return Object.freeze(result.slice(0, MAX_SUBTITLES))
}

export function videoListQuery(input: Record<string, unknown>, access: VideoAccess): VideoListQuery {
  const orderIndex = boundedInteger(firstValue(input['order[0][column]']) ?? objectValue(arrayValue(input.order)[0]).column, 0, VIDEO_COLUMNS.length - 1, 10)
  const orderDir = stringValue(firstValue(input['order[0][dir]']) ?? objectValue(arrayValue(input.order)[0]).dir).toLowerCase() === 'asc' ? 'asc' : 'desc'
  return Object.freeze({
    draw: boundedInteger(input.draw, 0, 1_000_000_000, 0),
    start: boundedInteger(input.start, 0, 1_000_000, 0),
    length: boundedInteger(input.length, 1, 500, 25),
    search: boundedString(firstValue(input['search[value]']) ?? objectValue(input.search).value ?? input.search, 254).trim(),
    orderBy: VIDEO_COLUMNS[orderIndex] ?? 'updated',
    orderDir,
    status: nullableFilter(input.status, 0, 2),
    dmca: nullableFilter(input.dmca, 0, 1),
    userId: access.isAdmin ? videoId(input.uid) : null
  })
}

function publicOwnerId(value: unknown): string | null {
  const normalized = stringValue(value).trim()
  if (!/^[1-9]\d{0,9}$/u.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed <= 4_294_967_295 ? normalized : null
}

function publicVideoTitle(media: PlayerMediaQuery, resolved?: MediaResult): string {
  const supplied = boundedString(resolved?.title || media.title, 255).trim()
  if (supplied !== '') return supplied
  if (media.host === 'direct' && media.id !== undefined) {
    try {
      const filename = decodeURIComponent(new URL(media.id).pathname.split('/').filter(Boolean).at(-1) ?? '').replace(/\.[a-z0-9]{1,8}$/iu, '').trim()
      if (filename !== '') return boundedString(filename, 255)
    } catch {
      // Fall through to a stable provider label.
    }
  }
  const provider = boundedString(media.host, 50).replaceAll(/[-_]+/gu, ' ').replace(/\b\w/gu, (letter) => letter.toUpperCase()).trim()
  return `${provider || 'Public'} video`.slice(0, 255)
}

function publicVideoPoster(media: PlayerMediaQuery, resolved?: MediaResult): string {
  for (const candidate of [resolved?.image, media.poster]) {
    const url = safeHttpUrl(stringValue(candidate))
    if (url !== null && url.href.length <= 2_048) return url.href
  }
  return ''
}

function publicVideoAlternatives(media: PlayerMediaQuery, mainHost: string, mainId: string): readonly VideoAlternativeWrite[] {
  const result: VideoAlternativeWrite[] = []
  const seen = new Set([`${mainHost}\u0000${mainId}`])
  const candidates = [
    ...(media.ahost !== undefined && media.aid !== undefined ? [{ host: media.ahost, id: media.aid }] : []),
    ...(media.alternatives ?? [])
  ]
  for (const candidate of candidates) {
    const host = stringValue(candidate.host).trim().toLowerCase()
    const hostId = stringValue(candidate.id).trim()
    const key = `${host}\u0000${hostId}`
    if (!/^[a-z0-9_-]{1,50}$/u.test(host) || hostId === '' || hostId.length > 2_048 || seen.has(key)) continue
    seen.add(key)
    result.push(Object.freeze({ host, hostId, order: result.length }))
    if (result.length >= MAX_ALTERNATIVES) break
  }
  return Object.freeze(result)
}

function publicVideoSubtitles(media: PlayerMediaQuery, resolved: MediaResult | undefined, userId: string, now: number): readonly VideoSubtitleWrite[] {
  const result: VideoSubtitleWrite[] = []
  const seen = new Set<string>()
  const candidates = [
    ...(resolved?.tracks ?? []).map((track) => ({ url: objectValue(track).file, language: objectValue(track).label })),
    ...(media.sub ?? []).map((url, index) => ({ url, language: media.lang?.[index] }))
  ]
  for (const candidate of candidates) {
    const url = safeHttpUrl(stringValue(candidate.url))
    if (url === null || url.href.length > 2_048 || seen.has(url.href)) continue
    seen.add(url.href)
    result.push(Object.freeze({
      link: url.href,
      language: boundedString(candidate.language, 50).trim() || inferredSubtitleLanguage(url),
      order: result.length,
      userId,
      created: now,
      updated: now
    }))
    if (result.length >= MAX_SUBTITLES) break
  }
  return Object.freeze(result)
}

function inferredSubtitleLanguage(url: URL): string {
  const name = decodeURIComponent(url.pathname.split('/').at(-1) ?? '').toLowerCase()
  const code = name.split('.').find((part) => /^[a-z]{2}$/i.test(part)) ?? ''
  return ({ en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', nl: 'Dutch', pt: 'Portuguese', ar: 'Arabic', ja: 'Japanese', ko: 'Korean', ru: 'Russian', tr: 'Turkish', zh: 'Chinese' } as Readonly<Record<string, string>>)[code] ?? 'Unknown CC'
}

function videoUrl(host: string, hostId: string): string {
  return new Hosting().setHost(host).setID(hostId).getDownloadLink()
}

function videoId(value: unknown): string | null {
  const normalized = stringValue(value).trim()
  return /^(?:0|[1-9]\d{0,19})$/.test(normalized) ? normalized : null
}

function nullableFilter(value: unknown, minimum: number, maximum: number): number | null {
  if (value === undefined || value === null || stringValue(value) === 'null' || stringValue(value) === '') return null
  const parsed = strictInteger(value)
  return parsed !== null && parsed >= minimum && parsed <= maximum ? parsed : null
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = strictInteger(value)
  return parsed !== null && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

function strictInteger(value: unknown): number | null {
  const normalized = typeof value === 'number' ? String(value) : stringValue(value)
  if (!/^-?\d+$/.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) ? parsed : null
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

function slugify(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
}

function boundedString(value: unknown, maximum: number): string {
  return stringValue(value).slice(0, maximum)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

function emptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0
}

function firstValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function ensureTrailingSlash(url: URL): URL {
  const result = new URL(url.href)
  if (!result.pathname.endsWith('/')) result.pathname += '/'
  return result
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function fail(message: string): VideoMutationResult {
  return Object.freeze({ status: 'fail', message })
}

function validationFail(message: string): Readonly<{ status: 'fail'; message: string }> {
  return Object.freeze({ status: 'fail', message })
}
