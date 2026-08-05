import { PLAYER_LANGUAGE_OPTIONS } from '../settings/player-settings.js'
import { InvalidSubtitleAssetError, type SubtitleAssetManager, validSubtitleName } from './subtitle-assets-service.js'

const SUBTITLE_COLUMNS = ['id', 'file_name', 'language', 'name', 'host', 'created', 'updated'] as const
const LANGUAGE_VALUES = new Set(['Unknown CC', ...PLAYER_LANGUAGE_OPTIONS.map((item) => item.value)])

export type SubtitleOrderColumn = typeof SUBTITLE_COLUMNS[number]

export type SubtitleAccess = Readonly<{
  userId: string
  isAdmin: boolean
}>

export type StoredSubtitleRecord = Readonly<{
  id: string
  fileName: string
  language: string
  userName: string
  userId: string
  host: string
  created: number
  updated: number
}>

export type SubtitleAdminRecord = StoredSubtitleRecord & Readonly<{ link: string }>

export type LegacySubtitleRecord = Readonly<{
  id: string
  file_name: string
  language: string
  name: string
  uid: string
  host: string
  created: number
  updated: number
  link: string
  actions: string
}>

export type SubtitleListQuery = Readonly<{
  draw: number
  start: number
  length: number
  search: string
  orderBy: SubtitleOrderColumn
  orderDir: 'asc' | 'desc'
}>

export type SubtitleListResult = Readonly<{
  data: readonly StoredSubtitleRecord[]
  recordsTotal: number
  recordsFiltered: number
}>

export type SubtitleWrite = Readonly<{
  fileName: string
  fileSize: number
  fileType: string
  language: string
  created: number
  userId: string
  host: string
  updated: number
}>

export interface SubtitleAdminStore {
  listSubtitles(query: SubtitleListQuery, access: SubtitleAccess): Promise<SubtitleListResult>
  getSubtitle(id: string, access: SubtitleAccess): Promise<StoredSubtitleRecord | null>
  insertSubtitle(value: SubtitleWrite): Promise<string | null>
  deleteSubtitle(id: string, access: SubtitleAccess, links: readonly [string, string]): Promise<boolean>
  renameSubtitle(id: string, access: SubtitleAccess, fileName: string, oldSuffix: string, link: string, updated: number): Promise<boolean>
  listSubtitleHosts(): Promise<readonly string[]>
  migrateSubtitleHost(oldHost: string, newHost: string, updated: number): Promise<void>
}

export type SubtitleDataTablesResponse = Readonly<{
  draw: number
  data: readonly LegacySubtitleRecord[]
  recordsTotal: number
  recordsFiltered: number
}>

export type SubtitleMutationResult = Readonly<{
  status: 'ok' | 'fail'
  message: string
  data?: Readonly<Record<string, string>>
}>

export type SubtitleAdminServiceOptions = Readonly<{ now?: () => number }>

export class SubtitleAdminService {
  private readonly now: () => number
  private readonly baseUrl: URL

  public constructor(
    private readonly store: SubtitleAdminStore,
    private readonly assets: SubtitleAssetManager,
    baseUrl: URL,
    options: SubtitleAdminServiceOptions = {}
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.baseUrl = ensureTrailingSlash(baseUrl)
  }

  public async records(input: Record<string, unknown>, access: SubtitleAccess): Promise<Readonly<{
    draw: number
    data: readonly SubtitleAdminRecord[]
    recordsTotal: number
    recordsFiltered: number
  }>> {
    const query = subtitleListQuery(input)
    const result = await this.store.listSubtitles(query, access)
    return Object.freeze({
      draw: query.draw,
      data: Object.freeze(result.data.map((record) => Object.freeze({ ...record, link: this.link(record.host, record.fileName) }))),
      recordsTotal: result.recordsTotal,
      recordsFiltered: result.recordsFiltered
    })
  }

  public async list(input: Record<string, unknown>, access: SubtitleAccess): Promise<SubtitleDataTablesResponse> {
    const result = await this.records(input, access)
    return Object.freeze({
      draw: result.draw,
      data: Object.freeze(result.data.map((record) => Object.freeze({
        id: record.id,
        file_name: record.fileName,
        language: record.language,
        name: record.userName,
        uid: record.userId,
        host: record.host,
        created: record.created,
        updated: record.updated,
        link: record.link,
        actions: record.id
      }))),
      recordsTotal: result.recordsTotal,
      recordsFiltered: result.recordsFiltered
    })
  }

  public async upload(input: Readonly<{
    originalName: string
    content: Buffer
    language: unknown
  }>, access: SubtitleAccess): Promise<SubtitleMutationResult> {
    const language = subtitleLanguage(input.language)
    let asset: Awaited<ReturnType<SubtitleAssetManager['create']>>
    try {
      asset = await this.assets.create(input.originalName, input.content)
    } catch (error) {
      return fail(error instanceof InvalidSubtitleAssetError ? error.message : 'The subtitle file failed to upload')
    }

    const now = this.now()
    try {
      const id = await this.store.insertSubtitle({
        fileName: asset.name,
        fileSize: asset.size,
        fileType: asset.mimeType.slice(0, 25),
        language,
        created: now,
        userId: access.userId,
        host: this.baseUrl.href,
        updated: now
      })
      if (id === null) {
        await this.assets.delete(asset.name).catch(() => false)
        return fail('The subtitle file failed to upload')
      }
      return Object.freeze({
        status: 'ok',
        message: 'The subtitle file has been uploaded successfully',
        data: Object.freeze({ id, lang: language, sub: asset.url })
      })
    } catch {
      await this.assets.delete(asset.name).catch(() => false)
      return fail('The subtitle file failed to upload')
    }
  }

  public async delete(id: unknown, access: SubtitleAccess): Promise<SubtitleMutationResult> {
    const normalized = subtitleId(id)
    if (normalized === null) return fail('The subtitle was not found')
    const record = await this.store.getSubtitle(normalized, access)
    if (record === null) return fail('The subtitle was not found')

    const links = this.legacyLinks(record.host, record.fileName)
    try {
      await this.assets.delete(record.fileName).catch(() => false)
      const deleted = await this.store.deleteSubtitle(normalized, access, links)
      return deleted
        ? ok('The subtitle file has been successfully deleted')
        : fail('The subtitle file failed to delete')
    } catch {
      return fail('The subtitle file failed to delete')
    }
  }

  public async rename(id: unknown, name: unknown, access: SubtitleAccess): Promise<SubtitleMutationResult> {
    const normalized = subtitleId(id)
    const requestedName = stringValue(name).trim()
    if (normalized === null || requestedName === '') return fail('The subtitle was not found')
    if (!validSubtitleName(requestedName)) return fail('The subtitle filename is invalid')
    const record = await this.store.getSubtitle(normalized, access)
    if (record === null) return fail('The subtitle was not found')
    if (record.fileName === requestedName) return ok('The subtitle has been successfully renamed')

    try {
      await this.assets.rename(record.fileName, requestedName)
    } catch (error) {
      return fail(error instanceof InvalidSubtitleAssetError ? error.message : 'The subtitle failed to be renamed')
    }

    try {
      const updated = await this.store.renameSubtitle(
        normalized,
        access,
        requestedName,
        `/${record.fileName}`,
        this.link(this.baseUrl.href, requestedName),
        this.now()
      )
      if (updated) return ok('The subtitle has been successfully renamed')
    } catch {
      // The filesystem rollback below keeps the manager and public asset consistent.
    }
    await this.assets.rename(requestedName, record.fileName).catch(() => undefined)
    return fail('The subtitle failed to be renamed')
  }

  public async hosts(access: SubtitleAccess): Promise<readonly string[]> {
    if (!access.isAdmin) return Object.freeze([])
    return Object.freeze([...(await this.store.listSubtitleHosts())])
  }

  public async migrate(oldLocation: unknown, newLocation: unknown, access: SubtitleAccess): Promise<SubtitleMutationResult> {
    if (!access.isAdmin) return fail('You are not authorized to access this feature')
    const oldHost = stringValue(oldLocation).trim()
    if (oldHost === '') return fail('Old location required')
    const newHost = normalizedHttpUrl(stringValue(newLocation).trim())
    if (newHost === null) return fail('The new location is invalid')
    try {
      await this.store.migrateSubtitleHost(oldHost, newHost, this.now())
      return ok('Migration of the subtitle files has been successful')
    } catch {
      return fail('Migration of those subtitle files failed')
    }
  }

  private link(host: string, fileName: string): string {
    const base = normalizedHttpUrl(host) ?? this.baseUrl.href
    return new URL(`uploads/subtitles/${encodeURIComponent(fileName)}`, base).href
  }

  private legacyLinks(host: string, fileName: string): readonly [string, string] {
    const base = normalizedHttpUrl(host) ?? this.baseUrl.href
    return Object.freeze([
      new URL(`subtitles/${encodeURIComponent(fileName)}`, base).href,
      new URL(`uploads/subtitles/${encodeURIComponent(fileName)}`, base).href
    ])
  }
}

export function subtitleListQuery(input: Record<string, unknown>): SubtitleListQuery {
  const searchRecord = recordValue(input.search)
  const orderRecord = recordValue(arrayValue(input.order)[0])
  const orderIndex = boundedInteger(orderRecord.column ?? input['order[0][column]'], 6, 0, SUBTITLE_COLUMNS.length - 1)
  const direction = stringValue(orderRecord.dir ?? input['order[0][dir]']).toLowerCase()
  return Object.freeze({
    draw: boundedInteger(input.draw, 0, 0, Number.MAX_SAFE_INTEGER),
    start: boundedInteger(input.start, 0, 0, 1_000_000),
    length: boundedInteger(input.length, 10, 1, 100),
    search: stringValue(searchRecord.value ?? input['search[value]']).trim().slice(0, 254),
    orderBy: SUBTITLE_COLUMNS[orderIndex] ?? 'updated',
    orderDir: direction === 'asc' ? 'asc' : 'desc'
  })
}

export function subtitleId(value: unknown): string | null {
  const normalized = stringValue(value).trim()
  if (!/^[1-9]\d{0,19}$/u.test(normalized)) return null
  try {
    return BigInt(normalized) <= 18_446_744_073_709_551_615n ? normalized : null
  } catch {
    return null
  }
}

export function subtitleLanguage(value: unknown): string {
  const normalized = stringValue(value).trim().slice(0, 50)
  return LANGUAGE_VALUES.has(normalized) ? normalized : 'Unknown CC'
}

function ok(message: string): SubtitleMutationResult {
  return Object.freeze({ status: 'ok', message })
}

function fail(message: string): SubtitleMutationResult {
  return Object.freeze({ status: 'fail', message })
}

function normalizedHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') return null
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

function ensureTrailingSlash(url: URL): URL {
  return new URL(normalizedHttpUrl(url.href) ?? url.href)
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(stringValue(value), 10)
  return Number.isSafeInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 4_096) : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}
