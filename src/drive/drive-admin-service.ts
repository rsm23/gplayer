import { createHmac } from 'node:crypto'
import { buildPlayerQuery } from '../core/player-query.js'
import type { ProviderHttpPostRequest, ProviderHttpRequest, ProviderHttpResponse } from '../hosting/provider-http.js'
import type { Security } from '../security/security.js'
import type { VideoAccess, VideoAdminService } from '../videos/video-admin-service.js'
import { parseGoogleDriveId, type DriveAccount, type DriveMirror } from './drive-sharer-service.js'

const GOOGLE_API_ROOT = 'https://www.googleapis.com'
const GOOGLE_TOKEN_URL = `${GOOGLE_API_ROOT}/oauth2/v4/token`
const REQUEST_TIMEOUT_MS = 15_000
const MAX_JSON_BYTES = 5 * 1_024 * 1_024
const TOKEN_CACHE_SECONDS = 3_500
const FILE_COLUMNS = ['id', 'title', 'description', 'shared', 'modifiedDate'] as const
const BACKUP_COLUMNS = ['id', 'gdrive_id', 'mirror_id', 'mirror_email', 'created'] as const
const QUEUE_COLUMNS = ['id', 'gdrive_id'] as const

export type DriveApiHttpClient = Readonly<{
  get(request: ProviderHttpRequest): Promise<ProviderHttpResponse>
  post(request: ProviderHttpPostRequest): Promise<ProviderHttpResponse>
  put(request: ProviderHttpPostRequest): Promise<ProviderHttpResponse>
  delete(request: ProviderHttpRequest): Promise<ProviderHttpResponse>
}>

export type DriveBackupRecord = Readonly<{
  id: string
  gdrive_id: string
  mirror_id: string
  mirror_email: string
  created: number
}>

export type DriveQueueRecord = Readonly<{ id: string; gdrive_id: string }>

export type DriveTableQuery = Readonly<{
  draw: number
  start: number
  length: number
  search: string
  orderBy: string
  orderDir: 'asc' | 'desc'
}>

export type DriveTableResult<T> = Readonly<{
  data: readonly T[]
  recordsTotal: number
  recordsFiltered: number
}>

export type DriveFingerprint = Readonly<{
  gdriveId: string
  email: string
  title: string
  description: string
  fileSize: string
  md5Checksum: string
  sha1Checksum: string
  sha256Checksum: string
}>

export interface DriveAdminStore {
  listActiveAccounts(bypassOnly: boolean): Promise<readonly DriveAccount[]>
  listMirrors(fileId: string, limit: number): Promise<readonly DriveMirror[]>
  saveMirror(sourceId: string, mirrorId: string, email: string, created: number): Promise<boolean>
  deleteMirrorsForFile(fileId: string): Promise<boolean>
  deleteMirrorRecord(id: string): Promise<boolean>
  listBackups(query: DriveTableQuery): Promise<DriveTableResult<DriveBackupRecord>>
  getBackup(id: string): Promise<DriveBackupRecord | null>
  deleteBackupsByMirrorId(mirrorId: string): Promise<boolean>
  listQueue(query: DriveTableQuery): Promise<DriveTableResult<DriveQueueRecord>>
  deleteQueue(id: string): Promise<boolean>
  listPendingQueue(limit: number): Promise<readonly DriveQueueRecord[]>
  enqueueQueue(fileId: string, delayed?: boolean): Promise<boolean>
  deleteQueueByFileIds(fileIds: readonly string[]): Promise<number>
  duplicateExists(fingerprint: DriveFingerprint): Promise<boolean>
  saveFingerprint(fingerprint: DriveFingerprint): Promise<boolean>
}

export type DriveLocatedFile = Readonly<{ file: DriveFile; email: string }>
export type DriveCopyOutcome = Readonly<{
  status: 'existing' | 'copied' | 'missing' | 'failed'
  located: DriveLocatedFile | null
}>
export type DriveMediaRequest = Readonly<{ target: URL; authorization: string }>

export type DriveFile = Readonly<{
  id: string
  title: string
  description: string
  originalFilename: string
  mimeType: string
  iconLink: string
  shared: boolean
  modifiedDate: string
  webContentLink: string
  embedLink: string
  alternateLink: string
  fileExtension: string
  fileSize: string
  md5Checksum: string
  sha1Checksum: string
  sha256Checksum: string
}>

export type DriveFileAdminRecord = DriveFile & Readonly<{
  email: string
  modifiedTimestamp: number
  actions: Readonly<{
    id: string
    shared: boolean
    download: string
    preview: string
    view: string
    request_url: string
    download_url: string
    embed_url: string
    embed_code: string
  }>
  mime: Readonly<{ type: string; icon: string }>
}>

export type DriveSharedDrive = Readonly<{ id: string; name: string }>
export type DriveFilesResponse = Readonly<{ draw: number; data: readonly DriveFileAdminRecord[]; recordsTotal: number; recordsFiltered: number; token: string }>
export type DriveDataTablesResponse<T> = Readonly<{ draw: number; data: readonly T[]; recordsTotal: number; recordsFiltered: number }>
export type DriveMutationResult =
  | Readonly<{ status: 'ok'; message: string; result?: unknown }>
  | Readonly<{ status: 'invalid'; message: string }>

type Token = Readonly<{ value: string; type: string; expiresAt: number }>
type FilePage = Readonly<{ files: readonly DriveFile[]; nextPageToken: string }>

export class DriveApiClient {
  private readonly tokenCache = new Map<string, Token>()
  private readonly now: () => number
  private readonly requestTimeoutMs: number

  public constructor(
    private readonly store: DriveAdminStore,
    private readonly http: DriveApiHttpClient,
    options: Readonly<{ now?: () => number; requestTimeoutMs?: number }> = {}
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  }

  public async accountEmails(): Promise<readonly string[]> {
    return Object.freeze((await this.store.listActiveAccounts(false)).map((account) => account.email))
  }

  public async fileInfo(email: string, fileId: string): Promise<DriveFile | null> {
    const account = await this.account(email)
    const id = parseGoogleDriveId(fileId)
    return account === null || id === null ? null : await this.fileInfoFor(account, id)
  }

  public async listFiles(email: string, input: Readonly<{
    parentId: string
    pageToken: string
    privateOnly: boolean
    folderOnly: boolean
    search: string
    length: number
    orderBy: string
    orderDir: 'asc' | 'desc'
  }>): Promise<FilePage | null> {
    const account = await this.account(email)
    if (account === null) return null
    const parentId = input.parentId === 'root' ? 'root' : parseGoogleDriveId(input.parentId)
    if (parentId === null) return null
    const query = new URLSearchParams({
      corpora: 'allDrives',
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
      fields: 'nextPageToken,items(*)',
      maxResults: String(Math.max(1, Math.min(100, Math.trunc(input.length))))
    })
    const conditions = [`trashed=false`, `'${driveQueryLiteral(parentId)}' in parents`]
    if (input.search !== '') conditions.push(`title contains '${driveQueryLiteral(input.search)}'`)
    if (input.privateOnly) conditions.push("visibility = 'limited'")
    conditions.push(input.folderOnly
      ? "mimeType contains '/vnd.google-apps.folder'"
      : "(mimeType contains 'video/' or mimeType contains 'audio/' or mimeType contains '/octet-stream' or mimeType contains '/vnd.google-apps.folder')")
    query.set('q', conditions.join(' and '))
    query.set('orderBy', `${driveOrderBy(input.orderBy)} ${input.orderDir}`)
    if (input.pageToken !== '' && validPageToken(input.pageToken)) query.set('pageToken', input.pageToken)
    const json = await this.authorizedJson(account, 'get', `${GOOGLE_API_ROOT}/drive/v2/files?${query.toString()}`)
    if (json === null) return null
    return Object.freeze({
      files: Object.freeze(arrayField(json, 'items').map(driveFile).filter((file): file is DriveFile => file !== null)),
      nextPageToken: boundedString(json.nextPageToken, 2_048)
    })
  }

  public async sharedDrives(email: string): Promise<readonly DriveSharedDrive[]> {
    const account = await this.account(email)
    if (account === null) return Object.freeze([])
    const json = await this.authorizedJson(account, 'get', `${GOOGLE_API_ROOT}/drive/v2/drives?maxResults=100`)
    if (json === null) return Object.freeze([])
    return Object.freeze(arrayField(json, 'items').map((item) => {
      const id = parseGoogleDriveId(boundedString(item.id, 50))
      const name = boundedString(item.name ?? item.title, 255)
      return id === null || name === '' ? null : Object.freeze({ id, name })
    }).filter((item): item is DriveSharedDrive => item !== null))
  }

  public async createFolder(email: string, name: string, parentId: string): Promise<DriveFile | null> {
    const account = await this.account(email)
    const parent = parentId === 'root' ? 'root' : parseGoogleDriveId(parentId)
    if (account === null || parent === null) return null
    const json = await this.authorizedJson(account, 'post', `${GOOGLE_API_ROOT}/drive/v2/files?supportsAllDrives=true&key=${encodeURIComponent(account.apiKey)}`, {
      title: name,
      parents: [{ id: parent }],
      mimeType: 'application/vnd.google-apps.folder'
    })
    return json === null ? null : driveFile(json)
  }

  public async rename(email: string, fileId: string, name: string): Promise<boolean> {
    const account = await this.account(email)
    const id = parseGoogleDriveId(fileId)
    if (account === null || id === null) return false
    return await this.authorizedJson(account, 'put', `${GOOGLE_API_ROOT}/drive/v2/files/${encodeURIComponent(id)}?supportsAllDrives=true`, { title: name, name }) !== null
  }

  public async deleteFile(email: string, fileId: string, cleanupMirrors = true): Promise<boolean> {
    const account = await this.account(email)
    const id = parseGoogleDriveId(fileId)
    if (account === null || id === null) return false
    const response = await this.authorizedRequest(account, 'delete', `${GOOGLE_API_ROOT}/drive/v2/files/${encodeURIComponent(id)}?supportsAllDrives=true`)
    if (response === null || response.status < 200 || response.status >= 300) return false
    if (cleanupMirrors) await this.store.deleteMirrorsForFile(id).catch(() => false)
    return true
  }

  public async setPublic(email: string, fileId: string, makePublic: boolean): Promise<boolean> {
    const account = await this.account(email)
    const id = parseGoogleDriveId(fileId)
    if (account === null || id === null) return false
    const url = makePublic
      ? `${GOOGLE_API_ROOT}/drive/v2/files/${encodeURIComponent(id)}/permissions?supportsAllDrives=true&alt=json`
      : `${GOOGLE_API_ROOT}/drive/v2/files/${encodeURIComponent(id)}/permissions/anyone?supportsAllDrives=true`
    const response = makePublic
      ? await this.authorizedRequest(account, 'post', url, { role: 'reader', type: 'anyone' })
      : await this.authorizedRequest(account, 'delete', url)
    return response !== null && response.status >= 200 && response.status < 300
  }

  public async copyFromAny(fileId: string, encryptTitle: boolean): Promise<DriveFile | null> {
    return (await this.copyFromAnyOutcome(fileId, encryptTitle)).located?.file ?? null
  }

  public async locateFile(fileId: string, preferredEmail = ''): Promise<DriveLocatedFile | null> {
    const id = parseGoogleDriveId(fileId)
    if (id === null) return null
    const accounts = await this.store.listActiveAccounts(false)
    const accountMap = new Map(accounts.map((account) => [account.email.toLowerCase(), account]))
    const attempted = new Set<string>()
    const preferred = accountMap.get(preferredEmail.trim().toLowerCase())
    if (preferred !== undefined) {
      attempted.add(preferred.email.toLowerCase())
      const file = await this.fileInfoFor(preferred, id)
      if (file !== null) return Object.freeze({ file, email: preferred.email })
    }
    for (const mirror of await this.store.listMirrors(id, 5).catch(() => Object.freeze([]) as readonly DriveMirror[])) {
      const account = accountMap.get(mirror.mirrorEmail.toLowerCase())
      if (account === undefined) continue
      const candidateId = mirror.sourceId === id ? mirror.mirrorId : id
      const existing = await this.fileInfoFor(account, candidateId)
      attempted.add(account.email.toLowerCase())
      if (existing !== null) return Object.freeze({ file: existing, email: account.email })
    }
    for (const account of accounts) {
      if (attempted.has(account.email.toLowerCase())) continue
      const source = await this.fileInfoFor(account, id)
      if (source !== null) return Object.freeze({ file: source, email: account.email })
    }
    return null
  }

  public async copyFromAnyOutcome(fileId: string, encryptTitle: boolean): Promise<DriveCopyOutcome> {
    const id = parseGoogleDriveId(fileId)
    if (id === null) return copyOutcome('missing')
    const accounts = await this.store.listActiveAccounts(true)
    const accountMap = new Map(accounts.map((account) => [account.email.toLowerCase(), account]))
    for (const mirror of await this.store.listMirrors(id, 5).catch(() => Object.freeze([]) as readonly DriveMirror[])) {
      const account = accountMap.get(mirror.mirrorEmail.toLowerCase())
      if (account === undefined) continue
      const candidateId = mirror.sourceId === id ? mirror.mirrorId : id
      const existing = await this.fileInfoFor(account, candidateId)
      if (existing !== null) return copyOutcome('existing', { file: existing, email: account.email })
    }
    let found = false
    for (const account of accounts) {
      const source = await this.fileInfoFor(account, id)
      if (source === null) continue
      found = true
      const copied = await this.copyFile(account, source, id, encryptTitle)
      if (copied !== null) return copyOutcome('copied', { file: copied, email: account.email })
    }
    return copyOutcome(found ? 'failed' : 'missing')
  }

  public async copyToAccount(fileId: string, email: string, encryptTitle: boolean): Promise<DriveCopyOutcome> {
    const id = parseGoogleDriveId(fileId)
    const account = id === null ? null : await this.account(email, true)
    if (id === null || account === null) return copyOutcome('missing')
    for (const mirror of await this.store.listMirrors(id, 5).catch(() => Object.freeze([]) as readonly DriveMirror[])) {
      if (mirror.mirrorEmail.toLowerCase() !== account.email.toLowerCase()) continue
      const existing = await this.fileInfoFor(account, mirror.sourceId === id ? mirror.mirrorId : id)
      if (existing !== null) return copyOutcome('existing', { file: existing, email: account.email })
    }
    const source = await this.fileInfoFor(account, id)
    if (source === null) return copyOutcome('missing')
    const copied = await this.copyFile(account, source, id, encryptTitle)
    return copied === null
      ? copyOutcome('failed')
      : copyOutcome('copied', { file: copied, email: account.email })
  }

  public async mediaRequest(email: string, fileId: string): Promise<DriveMediaRequest | null> {
    const id = parseGoogleDriveId(fileId)
    const account = id === null ? null : await this.account(email)
    if (id === null || account === null) return null
    const token = await this.accessToken(account)
    if (token === null) return null
    const target = new URL(`${GOOGLE_API_ROOT}/drive/v3/files/${encodeURIComponent(id)}`)
    target.searchParams.set('alt', 'media')
    if (account.apiKey !== '') target.searchParams.set('key', account.apiKey)
    return Object.freeze({ target, authorization: `${token.type} ${token.value}` })
  }

  private async account(email: string, bypassOnly = false): Promise<DriveAccount | null> {
    const normalized = email.trim().toLowerCase()
    if (!validEmail(normalized)) return null
    const accounts = await this.store.listActiveAccounts(bypassOnly)
    return accounts.find((account) => account.email.toLowerCase() === normalized) ?? null
  }

  private async copyFile(account: DriveAccount, source: DriveFile, sourceId: string, encryptTitle: boolean): Promise<DriveFile | null> {
    const title = encryptTitle ? encryptedTitle(source.title, source.fileExtension) : source.title
    const copiedJson = await this.authorizedJson(account, 'post', `${GOOGLE_API_ROOT}/drive/v2/files/${encodeURIComponent(sourceId)}/copy?supportsAllDrives=true&key=${encodeURIComponent(account.apiKey)}`, {
      copyable: true,
      parents: [{ id: 'root' }],
      title,
      description: encryptTitle ? source.title : 'Copy created by the GPlayer Drive administration tool.',
      originalFilename: title
    })
    const copiedId = copiedJson === null ? null : parseGoogleDriveId(boundedString(copiedJson.id, 50))
    if (copiedId === null) return null
    await this.setPublic(account.email, copiedId, true).catch(() => false)
    await this.store.saveMirror(sourceId, copiedId, account.email, this.now()).catch(() => false)
    return await this.fileInfoFor(account, copiedId)
  }

  private async fileInfoFor(account: DriveAccount, fileId: string): Promise<DriveFile | null> {
    const json = await this.authorizedJson(account, 'get', `${GOOGLE_API_ROOT}/drive/v2/files/${encodeURIComponent(fileId)}?acknowledgeAbuse=true&supportsAllDrives=true&key=${encodeURIComponent(account.apiKey)}`)
    return json === null ? null : driveFile(json)
  }

  private async authorizedJson(account: DriveAccount, method: 'get' | 'post' | 'put', url: string, body?: unknown): Promise<Record<string, unknown> | null> {
    const response = await this.authorizedRequest(account, method, url, body)
    if (response === null || response.status < 200 || response.status >= 300 || Buffer.byteLength(response.body) > MAX_JSON_BYTES) return null
    try {
      const value: unknown = JSON.parse(response.body)
      return recordValue(value)
    } catch {
      return null
    }
  }

  private async authorizedRequest(account: DriveAccount, method: 'get' | 'post' | 'put' | 'delete', url: string, body?: unknown): Promise<ProviderHttpResponse | null> {
    const token = await this.accessToken(account)
    if (token === null) return null
    const request = {
      url,
      headers: {
        authorization: `${token.type} ${token.value}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    }
    try {
      if (method === 'get') return await this.http.get(request)
      if (method === 'post') return await this.http.post(request)
      if (method === 'put') return await this.http.put(request)
      return await this.http.delete(request)
    } catch {
      return null
    }
  }

  private async accessToken(account: DriveAccount): Promise<Token | null> {
    const cached = this.tokenCache.get(account.email)
    if (cached !== undefined && cached.expiresAt > this.now() + 15) return cached
    try {
      const response = await this.http.post({
        url: GOOGLE_TOKEN_URL,
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ client_id: account.clientId, client_secret: account.clientSecret, refresh_token: account.refreshToken, grant_type: 'refresh_token' }).toString(),
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      })
      if (response.status < 200 || response.status >= 300 || Buffer.byteLength(response.body) > MAX_JSON_BYTES) return null
      const json = recordValue(JSON.parse(response.body) as unknown)
      const value = boundedString(json.access_token, 8_192)
      if (value.length < 8 || /[\u0000-\u0020\u007f]/.test(value)) return null
      const typeValue = boundedString(json.token_type, 50)
      const type = /^[A-Za-z]{1,50}$/.test(typeValue) ? typeValue : 'Bearer'
      const stated = integerValue(json.expires_in)
      const lifetime = Math.max(60, Math.min(TOKEN_CACHE_SECONDS, stated > 0 ? stated : TOKEN_CACHE_SECONDS))
      const token = Object.freeze({ value, type, expiresAt: this.now() + lifetime })
      this.tokenCache.set(account.email, token)
      return token
    } catch {
      return null
    }
  }
}

export class DriveAdminService {
  public constructor(
    private readonly store: DriveAdminStore,
    private readonly api: DriveApiClient,
    private readonly security: Security,
    private readonly videos: Pick<VideoAdminService, 'createImported' | 'record'>,
    private readonly options: Readonly<{ baseUrl: URL; embedSlug: string; downloadSlug: string; requestSlug: string }>
  ) {}

  public async accountEmails(): Promise<readonly string[]> {
    return await this.api.accountEmails()
  }

  public async files(input: Record<string, unknown>): Promise<DriveFilesResponse> {
    const query = tableQuery(input, FILE_COLUMNS, 'modifiedDate')
    const email = boundedString(input.email, 100).trim().toLowerCase()
    const page = await this.api.listFiles(email, {
      parentId: boundedString(input.folder_id, 50) || 'root',
      pageToken: boundedString(input.token, 2_048),
      privateOnly: booleanValue(input.private),
      folderOnly: booleanValue(input.onlyFolder),
      search: query.search,
      length: query.length,
      orderBy: query.orderBy,
      orderDir: query.orderDir
    })
    if (page === null) return emptyFiles(query.draw)
    const data = Object.freeze(page.files.map((file) => this.adminFile(file, email)))
    const recordsTotal = (query.start + query.length) * 2
    return Object.freeze({ draw: query.draw, data, recordsTotal, recordsFiltered: recordsTotal, token: page.nextPageToken })
  }

  public async sharedDrives(email: unknown): Promise<DriveMutationResult> {
    const result = await this.sharedDriveRecords(email)
    return { status: 'ok', message: '', result }
  }

  public async sharedDriveRecords(email: unknown): Promise<readonly DriveSharedDrive[]> {
    return await this.api.sharedDrives(boundedString(email, 100))
  }

  public async createFolder(input: Record<string, unknown>): Promise<DriveMutationResult> {
    const email = boundedString(input.email, 100)
    const name = cleanName(input.name)
    const parentId = boundedString(input.parent_id, 50) || 'root'
    if (!validEmail(email) || name === '') return invalid('The new file/folder failed to create')
    const created = await this.api.createFolder(email, name, parentId)
    return created === null ? invalid('The new file/folder failed to create') : ok('The new file/folder has been created successfully', created)
  }

  public async rename(input: Record<string, unknown>): Promise<DriveMutationResult> {
    const email = boundedString(input.email, 100)
    const id = boundedString(input.id, 50)
    const name = cleanName(input.name)
    if (!validEmail(email) || parseGoogleDriveId(id) === null || name === '') return invalid('The file/folder failed to update')
    return await this.api.rename(email, id, name) ? ok('The file/folder has been successfully updated') : invalid('The file/folder failed to update')
  }

  public async deleteFile(input: Record<string, unknown>): Promise<DriveMutationResult> {
    const email = boundedString(input.email, 100)
    const id = boundedString(input.id, 50)
    if (!validEmail(email) || parseGoogleDriveId(id) === null) return invalid('The file/folder failed to delete')
    return await this.api.deleteFile(email, id) ? ok('The file/folder has been successfully deleted') : invalid('The file/folder failed to delete')
  }

  public async deleteMirrorRecord(id: unknown): Promise<DriveMutationResult> {
    const normalized = databaseId(id)
    const deleted = normalized !== null && await this.store.deleteMirrorRecord(normalized)
    return deleted ? ok('The mirror file has been successfully deleted') : invalid('The mirror file failed to delete')
  }

  public async setPublic(input: Record<string, unknown>): Promise<DriveMutationResult> {
    const email = boundedString(input.email, 100)
    const id = boundedString(input.id, 50)
    if (!validEmail(email) || parseGoogleDriveId(id) === null) return invalid('The file/folder failed to update')
    return await this.api.setPublic(email, id, booleanValue(input.public)) ? ok('The file/folder has been successfully updated') : invalid('The file/folder failed to update')
  }

  public async importFile(input: Record<string, unknown>, access: VideoAccess): Promise<DriveMutationResult> {
    const email = boundedString(input.email, 100)
    const id = boundedString(input.id, 50)
    if (!validEmail(email) || parseGoogleDriveId(id) === null) return invalid('The file failed to import')
    const file = await this.api.fileInfo(email, id)
    if (file === null) return invalid('The file failed to import')
    const title = file.originalFilename || file.title || file.description
    if (title === '') return invalid('The file failed to import')
    const created = await this.videos.createImported({
      title,
      mainUrl: `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`,
      slug: '',
      posterUrl: `https://lh3.googleusercontent.com/d/${encodeURIComponent(id)}=w9999`,
      alternatives: [],
      subtitles: []
    }, access)
    if (created.status !== 'ok' || created.id === undefined) return invalid('The file failed to import')
    const record = await this.videos.record(created.id, access)
    return ok('The file has been successfully imported', { title, slug: record?.slug ?? '', id: created.id })
  }

  public async removeDuplicates(input: Record<string, unknown>): Promise<DriveMutationResult> {
    const email = boundedString(input.email, 100)
    if (!validEmail(email)) return invalid('Duplicate files failed to remove')
    const page = await this.api.listFiles(email, {
      parentId: 'root',
      pageToken: boundedString(input.nextPageToken, 2_048),
      privateOnly: false,
      folderOnly: false,
      search: '',
      length: 10,
      orderBy: 'modifiedDate',
      orderDir: 'asc'
    })
    if (page === null) return invalid('Duplicate files failed to remove')
    for (const file of page.files) {
      if (file.mimeType.includes('folder') || file.fileSize === '' || file.md5Checksum === '') continue
      const fingerprint: DriveFingerprint = {
        gdriveId: file.id,
        email,
        title: file.title,
        description: file.description,
        fileSize: file.fileSize,
        md5Checksum: file.md5Checksum,
        sha1Checksum: file.sha1Checksum,
        sha256Checksum: file.sha256Checksum
      }
      if (await this.store.duplicateExists(fingerprint)) await this.api.deleteFile(email, file.id)
      else await this.store.saveFingerprint(fingerprint)
    }
    return ok('Duplicate files have been successfully removed', { nextPageToken: page.nextPageToken })
  }

  public async backups(input: Record<string, unknown>): Promise<DriveDataTablesResponse<DriveBackupRecord>> {
    const query = tableQuery(input, BACKUP_COLUMNS, 'created')
    const result = await this.store.listBackups(query)
    return Object.freeze({ draw: query.draw, ...result })
  }

  public async deleteBackup(id: unknown): Promise<DriveMutationResult> {
    const normalized = databaseId(id)
    if (normalized === null) return invalid('The backup file failed to delete')
    const backup = await this.store.getBackup(normalized)
    if (backup === null) return invalid('The backup file failed to delete')
    await this.api.deleteFile(backup.mirror_email, backup.mirror_id, false).catch(() => false)
    return await this.store.deleteBackupsByMirrorId(backup.mirror_id)
      ? ok('The backup file has been successfully deleted')
      : invalid('The backup file failed to delete')
  }

  public async queue(input: Record<string, unknown>): Promise<DriveDataTablesResponse<DriveQueueRecord>> {
    const query = tableQuery(input, QUEUE_COLUMNS, 'id')
    const result = await this.store.listQueue(query)
    return Object.freeze({ draw: query.draw, ...result })
  }

  public async deleteQueue(id: unknown): Promise<DriveMutationResult> {
    const normalized = databaseId(id)
    const deleted = normalized !== null && await this.store.deleteQueue(normalized)
    return deleted ? ok('The backup queue has been successfully deleted') : invalid('The backup queue failed to delete')
  }

  public async copyQueueFile(id: unknown): Promise<DriveMutationResult> {
    const fileId = parseGoogleDriveId(boundedString(id, 50))
    if (fileId === null) return invalid('Cannot copy the file! Try again later')
    const file = await this.api.copyFromAny(fileId, true)
    return file === null
      ? invalid('Cannot copy the file! Try again later')
      : ok('', { link: `https://drive.google.com/file/d/${file.id}/view`, id: file.id })
  }

  private adminFile(file: DriveFile, email: string): DriveFileAdminRecord {
    const token = this.security.encryptURL(buildPlayerQuery({ host: 'gdrive', id: file.id, email }))
    const requestUrl = new URL(`${this.options.requestSlug}/?${token}`, this.options.baseUrl).href
    const downloadUrl = new URL(`${this.options.downloadSlug}/?${token}`, this.options.baseUrl).href
    const embedUrl = new URL(`${this.options.embedSlug}/?${token}`, this.options.baseUrl).href
    return Object.freeze({
      ...file,
      email,
      modifiedTimestamp: timestampValue(file.modifiedDate),
      actions: Object.freeze({
        id: file.id,
        shared: file.shared,
        download: file.webContentLink,
        preview: file.embedLink,
        view: file.alternateLink,
        request_url: requestUrl,
        download_url: downloadUrl,
        embed_url: embedUrl,
        embed_code: `<iframe src="${escapeAttribute(embedUrl)}" title="${escapeAttribute(file.title)}" allowfullscreen></iframe>`
      }),
      mime: Object.freeze({ type: file.mimeType, icon: file.iconLink })
    })
  }
}

export function tableQuery(input: Record<string, unknown>, columns: readonly string[], fallback: string): DriveTableQuery {
  const search = recordValue(input.search)
  const order = recordValue(arrayValue(input.order)[0])
  const index = boundedInteger(order.column ?? input['order[0][column]'], columns.indexOf(fallback), 0, columns.length - 1)
  return Object.freeze({
    draw: boundedInteger(input.draw, 0, 0, Number.MAX_SAFE_INTEGER),
    start: boundedInteger(input.start, 0, 0, 1_000_000),
    length: boundedInteger(input.length, 10, 1, 100),
    search: boundedString(search.value ?? input['search[value]'], 255).trim(),
    orderBy: columns[index] ?? fallback,
    orderDir: boundedString(order.dir ?? input['order[0][dir]'], 4).toLowerCase() === 'asc' ? 'asc' : 'desc'
  })
}

function driveFile(value: Record<string, unknown>): DriveFile | null {
  const id = parseGoogleDriveId(boundedString(value.id, 50))
  const title = boundedString(value.title ?? value.name, 255)
  const mimeType = boundedString(value.mimeType, 255)
  if (id === null || title === '' || mimeType === '') return null
  return Object.freeze({
    id,
    title,
    description: boundedString(value.description, 10_000),
    originalFilename: boundedString(value.originalFilename, 255) || title,
    mimeType,
    iconLink: safeGoogleUrl(value.iconLink),
    shared: value.shared === true || value.shared === 1,
    modifiedDate: boundedString(value.modifiedDate, 64),
    webContentLink: safeGoogleUrl(value.webContentLink),
    embedLink: safeGoogleUrl(value.embedLink),
    alternateLink: safeGoogleUrl(value.alternateLink),
    fileExtension: boundedString(value.fileExtension, 20).replace(/[^A-Za-z0-9]/g, ''),
    fileSize: unsignedString(value.fileSize),
    md5Checksum: checksum(value.md5Checksum, 32),
    sha1Checksum: checksum(value.sha1Checksum, 40),
    sha256Checksum: checksum(value.sha256Checksum, 64)
  })
}

function driveOrderBy(value: string): string {
  return FILE_COLUMNS.includes(value as typeof FILE_COLUMNS[number]) ? value : 'modifiedDate'
}

function driveQueryLiteral(value: string): string {
  return value.slice(0, 255).replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}

function validPageToken(value: string): boolean {
  return /^[A-Za-z0-9._~+\/-]{1,2048}$/.test(value)
}

function encryptedTitle(title: string, extension: string): string {
  const digest = createHmac('sha256', 'title').update(Buffer.from(title).toString('hex')).digest('hex')
  return extension === '' ? digest : `${digest}.${extension}`
}

function safeGoogleUrl(value: unknown): string {
  const text = boundedString(value, 2_048)
  if (text === '') return ''
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return ''
    const host = url.hostname.toLowerCase()
    return host === 'google.com' || host.endsWith('.google.com') || host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com') || host === 'gstatic.com' || host.endsWith('.gstatic.com') ? url.href : ''
  } catch {
    return ''
  }
}

function checksum(value: unknown, length: number): string {
  const result = boundedString(value, length).toLowerCase()
  return result === '' || new RegExp(`^[a-f0-9]{${length}}$`).test(result) ? result : ''
}

function unsignedString(value: unknown): string {
  const result = boundedString(value, 24)
  return /^\d{1,20}$/.test(result) ? result : ''
}

function cleanName(value: unknown): string {
  const result = boundedString(value, 255).trim()
  return /[\u0000-\u001f\u007f]/.test(result) ? '' : result
}

function databaseId(value: unknown): string | null {
  const result = boundedString(value, 20)
  return /^[1-9]\d{0,19}$/.test(result) ? result : null
}

function validEmail(value: string): boolean {
  return value.length <= 100 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function emptyFiles(draw: number): DriveFilesResponse {
  return Object.freeze({ draw, data: Object.freeze([]), recordsTotal: 0, recordsFiltered: 0, token: '' })
}

function ok(message: string, result?: unknown): DriveMutationResult {
  return Object.freeze({ status: 'ok', message, ...(result === undefined ? {} : { result }) })
}

function invalid(message: string): DriveMutationResult {
  return Object.freeze({ status: 'invalid', message })
}

function timestampValue(value: string): number {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1_000) : 0
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function boundedString(value: unknown, maximum: number): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, maximum) : ''
}

function integerValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(boundedString(value, 24), 10)
  return Number.isSafeInteger(parsed) ? parsed : 0
}

function copyOutcome(status: DriveCopyOutcome['status'], located: DriveLocatedFile | null = null): DriveCopyOutcome {
  return Object.freeze({ status, located: located === null ? null : Object.freeze(located) })
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = integerValue(value)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}

function booleanValue(value: unknown): boolean {
  const scalar = Array.isArray(value) ? value.at(-1) : value
  return scalar === true || scalar === 1 || scalar === '1' || scalar === 'true' || scalar === 'public' || scalar === 'on'
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function arrayField(value: Record<string, unknown>, key: string): readonly Record<string, unknown>[] {
  return arrayValue(value[key]).map(recordValue).filter((item) => Object.keys(item).length > 0)
}
