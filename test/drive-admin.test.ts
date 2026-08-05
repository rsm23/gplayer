import { describe, expect, it, vi } from 'vitest'
import {
  DriveAdminService,
  DriveApiClient,
  type DriveAdminStore,
  type DriveApiHttpClient,
  type DriveBackupRecord,
  type DriveFingerprint,
  type DriveQueueRecord,
  type DriveTableQuery
} from '../src/drive/drive-admin-service.js'
import type { DriveAccount, DriveMirror } from '../src/drive/drive-sharer-service.js'
import { MySqlDriveAdminStore } from '../src/drive/mysql-drive-admin-store.js'
import type { ProviderHttpPostRequest, ProviderHttpRequest, ProviderHttpResponse } from '../src/hosting/provider-http.js'
import { Security } from '../src/security/security.js'

const account: DriveAccount = Object.freeze({
  email: 'drive@example.test',
  apiKey: 'api-key',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  refreshToken: 'refresh-token'
})

const sourceId = 'sourceFileABC'
const mirrorId = 'copiedFileXYZ'

class MemoryDriveAdminStore implements DriveAdminStore {
  public accounts: DriveAccount[] = [account]
  public mirrors: DriveMirror[] = []
  public backups: DriveBackupRecord[] = [{ id: '1', gdrive_id: sourceId, mirror_id: mirrorId, mirror_email: account.email, created: 123 }]
  public queueItems: DriveQueueRecord[] = [{ id: '1', gdrive_id: sourceId }]
  public fingerprints: DriveFingerprint[] = []

  public async listActiveAccounts(bypassOnly: boolean): Promise<readonly DriveAccount[]> {
    return bypassOnly ? this.accounts : this.accounts
  }
  public async listMirrors(): Promise<readonly DriveMirror[]> { return this.mirrors }
  public async saveMirror(source: string, mirror: string, email: string): Promise<boolean> {
    this.mirrors.push({ sourceId: source, mirrorId: mirror, mirrorEmail: email })
    return true
  }
  public async deleteMirrorsForFile(fileId: string): Promise<boolean> {
    const before = this.mirrors.length + this.backups.length
    this.mirrors = this.mirrors.filter((mirror) => mirror.sourceId !== fileId && mirror.mirrorId !== fileId)
    this.backups = this.backups.filter((backup) => backup.gdrive_id !== fileId && backup.mirror_id !== fileId)
    return before !== this.mirrors.length + this.backups.length
  }
  public async deleteMirrorRecord(id: string): Promise<boolean> {
    const index = this.backups.findIndex((backup) => backup.id === id)
    if (index < 0) return false
    this.backups.splice(index, 1)
    return true
  }
  public async listBackups(query: DriveTableQuery) { return table(this.backups, query) }
  public async getBackup(id: string): Promise<DriveBackupRecord | null> { return this.backups.find((backup) => backup.id === id) ?? null }
  public async deleteBackupsByMirrorId(id: string): Promise<boolean> {
    const before = this.backups.length
    this.backups = this.backups.filter((backup) => backup.mirror_id !== id)
    return before !== this.backups.length
  }
  public async listQueue(query: DriveTableQuery) { return table(this.queueItems, query) }
  public async deleteQueue(id: string): Promise<boolean> {
    const before = this.queueItems.length
    this.queueItems = this.queueItems.filter((item) => item.id !== id)
    return before !== this.queueItems.length
  }
  public async listPendingQueue(limit: number): Promise<readonly DriveQueueRecord[]> {
    return this.queueItems.slice(0, limit)
  }
  public async enqueueQueue(fileId: string): Promise<boolean> {
    if (this.queueItems.some((item) => item.gdrive_id === fileId)) return false
    this.queueItems.push({ id: String(this.queueItems.length + 1), gdrive_id: fileId })
    return true
  }
  public async deleteQueueByFileIds(fileIds: readonly string[]): Promise<number> {
    const before = this.queueItems.length
    this.queueItems = this.queueItems.filter((item) => !fileIds.includes(item.gdrive_id))
    return before - this.queueItems.length
  }
  public async duplicateExists(fingerprint: DriveFingerprint): Promise<boolean> {
    return this.fingerprints.some((item) => item.gdriveId !== fingerprint.gdriveId && item.fileSize === fingerprint.fileSize && item.md5Checksum === fingerprint.md5Checksum)
  }
  public async saveFingerprint(fingerprint: DriveFingerprint): Promise<boolean> {
    this.fingerprints.push(fingerprint)
    return true
  }
}

class FixtureDriveHttp implements DriveApiHttpClient {
  public readonly requests: Array<Readonly<{ method: string; request: ProviderHttpPostRequest }>> = []
  public constructor(private readonly responses: ProviderHttpResponse[]) {}
  public async get(request: ProviderHttpRequest) { return await this.next('GET', request) }
  public async post(request: ProviderHttpPostRequest) { return await this.next('POST', request) }
  public async put(request: ProviderHttpPostRequest) { return await this.next('PUT', request) }
  public async delete(request: ProviderHttpRequest) { return await this.next('DELETE', request) }
  private async next(method: string, request: ProviderHttpPostRequest): Promise<ProviderHttpResponse> {
    this.requests.push({ method, request })
    const response = this.responses.shift()
    if (response === undefined) throw new Error(`Unexpected ${method} Drive request`)
    return response
  }
}

class FixtureVideos {
  public readonly creates: unknown[] = []
  public async createImported(input: unknown) {
    this.creates.push(input)
    return { status: 'ok' as const, message: 'saved', id: '41' }
  }
  public async record() { return { slug: 'abc12' } as never }
}

function driveService(store: MemoryDriveAdminStore, http: FixtureDriveHttp, videos = new FixtureVideos()) {
  const security = new Security('1234567890123456', { randomBytes: (size) => Buffer.alloc(size, 7) })
  const api = new DriveApiClient(store, http, { now: () => 1_700_000_000 })
  return {
    service: new DriveAdminService(store, api, security, videos as never, {
      baseUrl: new URL('https://player.example/'), embedSlug: 'e', downloadSlug: 'd', requestSlug: 'r'
    }),
    api,
    security,
    videos
  }
}

describe('Google Drive v2 administration client and service', () => {
  it('lists remote files with the legacy query contract and encrypted GPlayer actions', async () => {
    const store = new MemoryDriveAdminStore()
    const http = new FixtureDriveHttp([
      json({ access_token: 'access-token-value', token_type: 'Bearer', expires_in: 3600 }),
      json({ nextPageToken: 'next_page-1', items: [driveFile()] })
    ])
    const { service, security } = driveService(store, http)
    const result = await service.files({
      draw: '4', start: '0', length: '25', email: account.email, folder_id: 'root', private: '1', onlyFolder: '0',
      'search[value]': "movie'\\name", 'order[0][column]': '1', 'order[0][dir]': 'asc'
    })

    expect(result.draw).toBe(4)
    expect(result.recordsTotal).toBe(50)
    expect(result.token).toBe('next_page-1')
    expect(result.data[0]).toEqual(expect.objectContaining({ id: sourceId, title: 'Movie.mp4', email: account.email, modifiedTimestamp: 1_700_000_000 }))
    const token = result.data[0]?.actions.embed_url.split('?')[1] ?? ''
    expect(security.decryptURLStrict(token)).toBe(`host=gdrive&id=${sourceId}&email=drive%40example.test`)
    expect(JSON.stringify(result)).not.toContain('client-secret')
    const listUrl = new URL(String(http.requests[1]?.request.url))
    expect(listUrl.origin + listUrl.pathname).toBe('https://www.googleapis.com/drive/v2/files')
    expect(listUrl.searchParams.get('q')).toContain("title contains 'movie\\'\\\\name'")
    expect(listUrl.searchParams.get('q')).toContain("visibility = 'limited'")
    expect(listUrl.searchParams.get('orderBy')).toBe('title asc')
  })

  it('creates, renames, changes permissions, and deletes through fixed Google endpoints', async () => {
    const store = new MemoryDriveAdminStore()
    const http = new FixtureDriveHttp([
      json({ access_token: 'access-token-value', token_type: 'Bearer' }),
      json(driveFile({ id: 'folderFileABC', title: 'New folder', mimeType: 'application/vnd.google-apps.folder' })),
      json({ id: sourceId, title: 'Renamed' }),
      json({ id: 'permission-id' }),
      empty(204)
    ])
    const { service } = driveService(store, http)
    await expect(service.createFolder({ email: account.email, name: 'New folder', parent_id: 'root' })).resolves.toEqual(expect.objectContaining({ status: 'ok', message: 'The new file/folder has been created successfully' }))
    await expect(service.rename({ email: account.email, id: sourceId, name: 'Renamed' })).resolves.toEqual({ status: 'ok', message: 'The file/folder has been successfully updated' })
    await expect(service.setPublic({ email: account.email, id: sourceId, public: '1' })).resolves.toEqual({ status: 'ok', message: 'The file/folder has been successfully updated' })
    await expect(service.deleteFile({ email: account.email, id: sourceId })).resolves.toEqual({ status: 'ok', message: 'The file/folder has been successfully deleted' })
    expect(http.requests.map(({ method }) => method)).toEqual(['POST', 'POST', 'PUT', 'POST', 'DELETE'])
    expect(String(http.requests[2]?.request.url)).toBe(`https://www.googleapis.com/drive/v2/files/${sourceId}?supportsAllDrives=true`)
    expect(JSON.parse(String(http.requests[3]?.request.body))).toEqual({ role: 'reader', type: 'anyone' })
  })

  it('imports a remote Drive file as a saved video with the supplied legacy poster', async () => {
    const store = new MemoryDriveAdminStore()
    const http = new FixtureDriveHttp([
      json({ access_token: 'access-token-value', token_type: 'Bearer' }),
      json(driveFile())
    ])
    const { service, videos } = driveService(store, http)
    await expect(service.importFile({ email: account.email, id: sourceId }, { userId: '8', isAdmin: true })).resolves.toEqual({
      status: 'ok', message: 'The file has been successfully imported', result: { title: 'Movie.mp4', slug: 'abc12', id: '41' }
    })
    expect(videos.creates[0]).toEqual(expect.objectContaining({
      title: 'Movie.mp4',
      mainUrl: `https://drive.google.com/file/d/${sourceId}/view`,
      posterUrl: `https://lh3.googleusercontent.com/d/${sourceId}=w9999`
    }))
  })

  it('copies queue files with encrypted titles, public permission, and mirror persistence', async () => {
    const store = new MemoryDriveAdminStore()
    const http = new FixtureDriveHttp([
      json({ access_token: 'access-token-value', token_type: 'Bearer' }),
      json(driveFile()),
      json({ id: mirrorId }),
      json({ id: 'permission-id' }),
      json(driveFile({ id: mirrorId, title: 'encrypted.mp4' }))
    ])
    const { service } = driveService(store, http)
    await expect(service.copyQueueFile(sourceId)).resolves.toEqual({
      status: 'ok', message: '', result: { link: `https://drive.google.com/file/d/${mirrorId}/view`, id: mirrorId }
    })
    const copy = JSON.parse(String(http.requests[2]?.request.body))
    expect(copy.title).toMatch(/^[a-f0-9]{64}\.mp4$/)
    expect(copy.description).toBe('Movie.mp4')
    expect(JSON.stringify(copy)).not.toMatch(/gdplayer\.(?:to|io)/i)
    expect(store.mirrors).toEqual([{ sourceId, mirrorId, mirrorEmail: account.email }])
  })

  it('builds the fixed Drive v3 media request with refreshed credentials only on the server', async () => {
    const store = new MemoryDriveAdminStore()
    const http = new FixtureDriveHttp([
      json({ access_token: 'access-token-value', token_type: 'Bearer', expires_in: 3600 })
    ])
    const { api } = driveService(store, http)
    const media = await api.mediaRequest(account.email, sourceId)
    expect(media?.target.toString()).toBe(`https://www.googleapis.com/drive/v3/files/${sourceId}?alt=media&key=api-key`)
    expect(media?.authorization).toBe('Bearer access-token-value')
    expect(http.requests).toHaveLength(1)
    expect(JSON.stringify({ publicSource: `/gdrive-media/encrypted` })).not.toContain(media?.authorization ?? '')
    await expect(api.mediaRequest('unknown@example.test', sourceId)).resolves.toBeNull()
    await expect(api.mediaRequest(account.email, '../unsafe')).resolves.toBeNull()
  })

  it('maintains backup, queue, and duplicate contracts with exact messages', async () => {
    const store = new MemoryDriveAdminStore()
    store.fingerprints.push({ gdriveId: 'olderFileABC', email: 'other@example.test', title: 'Movie.mp4', description: '', fileSize: '1024', md5Checksum: 'a'.repeat(32), sha1Checksum: 'b'.repeat(40), sha256Checksum: 'c'.repeat(64) })
    const http = new FixtureDriveHttp([
      json({ access_token: 'access-token-value', token_type: 'Bearer' }),
      empty(204),
      json({ items: [driveFile()], nextPageToken: '' }),
      empty(204)
    ])
    const { service } = driveService(store, http)
    await expect(service.deleteBackup('1')).resolves.toEqual({ status: 'ok', message: 'The backup file has been successfully deleted' })
    await expect(service.removeDuplicates({ email: account.email })).resolves.toEqual({ status: 'ok', message: 'Duplicate files have been successfully removed', result: { nextPageToken: '' } })
    await expect(service.deleteQueue('1')).resolves.toEqual({ status: 'ok', message: 'The backup queue has been successfully deleted' })
    expect(store.backups).toEqual([])
    expect(store.queueItems).toEqual([])
    expect(http.requests.filter(({ method }) => method === 'DELETE')).toHaveLength(2)
  })
})

describe('MySqlDriveAdminStore', () => {
  it('uses parameterized account, mirror, queue, and fingerprint SQL', async () => {
    const reads: Array<readonly [string, readonly unknown[]]> = []
    const writes: Array<readonly [string, readonly unknown[]]> = []
    const database = {
      read: async <T>(sql: string, values: readonly unknown[] = []): Promise<T> => {
        reads.push([sql, values])
        if (sql.includes('tb_gdrive_auth')) return [{ email: account.email, api_key: account.apiKey, client_id: account.clientId, client_secret: account.clientSecret, refresh_token: account.refreshToken }] as T
        if (sql.includes('COUNT(*)')) return [{ total: 1 }] as T
        if (sql.includes('tb_gdrive_queue')) return [{ id: 1, gdrive_id: sourceId }] as T
        return [{ id: 1, gdrive_id: sourceId, mirror_id: mirrorId, mirror_email: account.email, created: 123 }] as T
      },
      write: async <T>(sql: string, values: readonly unknown[] = []): Promise<T> => {
        writes.push([sql, values])
        return { affectedRows: 1 } as T
      }
    }
    const store = new MySqlDriveAdminStore(database as never)
    await expect(store.listActiveAccounts(true)).resolves.toEqual([account])
    await expect(store.listBackups({ draw: 0, start: 4, length: 10, search: "x' OR 1=1", orderBy: 'created', orderDir: 'desc' })).resolves.toEqual(expect.objectContaining({ recordsTotal: 1, recordsFiltered: 1 }))
    await expect(store.listQueue({ draw: 0, start: 0, length: 10, search: '', orderBy: 'id', orderDir: 'asc' })).resolves.toEqual(expect.objectContaining({ data: [{ id: '1', gdrive_id: sourceId }] }))
    await expect(store.listPendingQueue(1_000)).resolves.toEqual([{ id: '1', gdrive_id: sourceId }])
    await expect(store.enqueueQueue(sourceId, true)).resolves.toBe(true)
    await expect(store.deleteQueueByFileIds([sourceId, mirrorId, sourceId])).resolves.toBe(1)
    const fingerprint = { gdriveId: sourceId, email: account.email, title: 'Movie', description: '', fileSize: '1', md5Checksum: 'a'.repeat(32), sha1Checksum: 'b'.repeat(40), sha256Checksum: 'c'.repeat(64) }
    await expect(store.duplicateExists(fingerprint)).resolves.toBe(true)
    await expect(store.saveFingerprint(fingerprint)).resolves.toBe(true)
    const listSql = reads.find(([sql]) => sql.includes('tb_gdrive_mirrors') && sql.includes('LIMIT ? OFFSET ?'))
    expect(listSql?.[0]).not.toContain("x' OR 1=1")
    expect(listSql?.[1]).toEqual(["%x' OR 1=1%", "%x' OR 1=1%", "%x' OR 1=1%", 10, 4])
    expect(writes.at(-1)?.[0]).toContain('WHERE NOT EXISTS')
    const duplicateSql = reads.find(([sql]) => sql.includes('tb_gdrive_duplicate'))?.[0] ?? ''
    expect(duplicateSql).toContain('(`gdrive_id` <> ? OR `gdrive_email` <> ?)')
    expect(reads.find(([sql]) => sql.includes('ORDER BY `id` ASC LIMIT ?') && !sql.includes('OFFSET'))?.[1]).toEqual([500])
    expect(writes.find(([sql]) => sql.includes('INSERT IGNORE INTO `tb_gdrive_queue`'))?.[1]).toEqual([sourceId, 1])
    expect(writes.find(([sql]) => sql.includes('DELETE FROM `tb_gdrive_queue` WHERE `gdrive_id` IN'))?.[1]).toEqual([sourceId, mirrorId])
  })
})

function table<T>(values: readonly T[], query: DriveTableQuery) {
  return { data: values.slice(query.start, query.start + query.length), recordsTotal: values.length, recordsFiltered: values.length }
}

function driveFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: sourceId,
    title: 'Movie.mp4',
    originalFilename: 'Movie.mp4',
    description: '',
    mimeType: 'video/mp4',
    iconLink: 'https://ssl.gstatic.com/docs/doclist/images/mediatype/icon_1_video_x16.png',
    shared: true,
    modifiedDate: '2023-11-14T22:13:20.000Z',
    webContentLink: `https://drive.google.com/uc?id=${sourceId}`,
    embedLink: `https://drive.google.com/file/d/${sourceId}/preview`,
    alternateLink: `https://drive.google.com/file/d/${sourceId}/view`,
    fileExtension: 'mp4',
    fileSize: '1024',
    md5Checksum: 'a'.repeat(32),
    sha1Checksum: 'b'.repeat(40),
    sha256Checksum: 'c'.repeat(64),
    ...overrides
  }
}

function json(value: unknown, status = 200): ProviderHttpResponse {
  return Object.freeze({ url: new URL('https://www.googleapis.com/fixture'), status, headers: new Headers({ 'content-type': 'application/json' }), body: JSON.stringify(value) })
}

function empty(status: number): ProviderHttpResponse {
  return Object.freeze({ url: new URL('https://www.googleapis.com/fixture'), status, headers: new Headers(), body: '' })
}
