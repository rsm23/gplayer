import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { loadConfig } from '../src/config.js'
import type { Database } from '../src/database/database.js'
import { MySqlSubtitleAdminStore } from '../src/subtitles/mysql-subtitle-admin-store.js'
import {
  SubtitleAdminService,
  subtitleId,
  subtitleLanguage,
  subtitleListQuery,
  type StoredSubtitleRecord,
  type SubtitleAccess,
  type SubtitleAdminStore,
  type SubtitleListQuery,
  type SubtitleWrite
} from '../src/subtitles/subtitle-admin-service.js'
import {
  FileSystemSubtitleAssetManager,
  InvalidSubtitleAssetError,
  SUBTITLE_MAX_BYTES,
  type SubtitleAsset,
  type SubtitleAssetManager
} from '../src/subtitles/subtitle-assets-service.js'

const token = 'subtitle-admin-token-1234567890'
const userAgent = 'GPlayer subtitle test'
const baseUrl = new URL('https://player.example/')
const admin: AuthUser = Object.freeze({ id: 1, username: 'admin', email: 'admin@example.test', name: 'Admin', role: 0, status: 1, created: 1, updated: 1 })
const member: AuthUser = Object.freeze({ id: 2, username: 'member', email: 'member@example.test', name: 'Member', role: 1, status: 1, created: 1, updated: 1 })
const adminAccess: SubtitleAccess = Object.freeze({ userId: '1', isAdmin: true })
const memberAccess: SubtitleAccess = Object.freeze({ userId: '2', isAdmin: false })

function record(overrides: Partial<StoredSubtitleRecord> = {}): StoredSubtitleRecord {
  return Object.freeze({
    id: '1',
    fileName: 'captions-one.srt',
    language: 'English',
    userName: 'Admin',
    userId: '1',
    host: baseUrl.href,
    created: 1_700_000_000,
    updated: 1_700_000_000,
    ...overrides
  })
}

class MemorySubtitleStore implements SubtitleAdminStore {
  public readonly records: StoredSubtitleRecord[] = [
    record(),
    record({ id: '2', fileName: 'captions-two.vtt', language: 'French', userName: 'Member', userId: '2' })
  ]
  public readonly queries: SubtitleListQuery[] = []
  public readonly deletedLinks: Array<readonly [string, string]> = []
  public migrations: Array<readonly [string, string, number]> = []

  public async listSubtitles(query: SubtitleListQuery, accessValue: SubtitleAccess) {
    this.queries.push(query)
    const allowed = this.records.filter((item) => accessValue.isAdmin || item.userId === accessValue.userId)
    const search = query.search.toLowerCase()
    const filtered = allowed.filter((item) => search === '' || [item.fileName, item.language, item.userName, item.host].some((value) => value.toLowerCase().startsWith(search)))
    return { data: filtered.slice(query.start, query.start + query.length), recordsTotal: allowed.length, recordsFiltered: filtered.length }
  }

  public async getSubtitle(id: string, accessValue: SubtitleAccess): Promise<StoredSubtitleRecord | null> {
    return this.records.find((item) => item.id === id && (accessValue.isAdmin || item.userId === accessValue.userId)) ?? null
  }

  public async insertSubtitle(value: SubtitleWrite): Promise<string> {
    const id = String(Math.max(0, ...this.records.map((item) => Number(item.id))) + 1)
    this.records.push(record({
      id,
      fileName: value.fileName,
      language: value.language,
      userName: value.userId === '1' ? 'Admin' : 'Member',
      userId: value.userId,
      host: value.host,
      created: value.created,
      updated: value.updated
    }))
    return id
  }

  public async deleteSubtitle(id: string, accessValue: SubtitleAccess, links: readonly [string, string]): Promise<boolean> {
    const index = this.records.findIndex((item) => item.id === id && (accessValue.isAdmin || item.userId === accessValue.userId))
    if (index < 0) return false
    this.deletedLinks.push(links)
    this.records.splice(index, 1)
    return true
  }

  public async renameSubtitle(id: string, accessValue: SubtitleAccess, fileName: string, _oldSuffix: string, _link: string, updated: number): Promise<boolean> {
    const index = this.records.findIndex((item) => item.id === id && (accessValue.isAdmin || item.userId === accessValue.userId))
    const current = this.records[index]
    if (index < 0 || current === undefined) return false
    this.records[index] = Object.freeze({ ...current, fileName, updated })
    return true
  }

  public async listSubtitleHosts(): Promise<readonly string[]> {
    return Object.freeze([...new Set(this.records.map((item) => item.host))].sort())
  }

  public async migrateSubtitleHost(oldHost: string, newHost: string, updated: number): Promise<void> {
    this.migrations.push([oldHost, newHost, updated])
    for (let index = 0; index < this.records.length; index += 1) {
      const current = this.records[index]
      if (current?.host === oldHost) this.records[index] = Object.freeze({ ...current, host: newHost, updated })
    }
  }
}

class MemorySubtitleAssets implements SubtitleAssetManager {
  public readonly files = new Map<string, Buffer>([
    ['captions-one.srt', Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nOne')],
    ['captions-two.vtt', Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nTwo')]
  ])
  private sequence = 0

  public async create(originalName: string, content: Buffer): Promise<SubtitleAsset> {
    const extension = originalName.split('.').pop()?.toLowerCase() ?? ''
    if (!['srt', 'vtt', 'ass', 'sub', 'stl', 'dfxp', 'ttml', 'sbv', 'txt'].includes(extension)) throw new InvalidSubtitleAssetError('The subtitle file extension is not supported')
    const name = `uploaded-${++this.sequence}.${extension}`
    this.files.set(name, Buffer.from(content))
    return { name, size: content.length, mimeType: extension === 'vtt' ? 'text/vtt' : 'text/plain', url: new URL(`uploads/subtitles/${name}`, baseUrl).href }
  }

  public async rename(currentName: string, requestedName: string): Promise<string> {
    if (this.files.has(requestedName)) throw new InvalidSubtitleAssetError('The filename is already in use')
    const content = this.files.get(currentName)
    if (content === undefined) throw new InvalidSubtitleAssetError('The subtitle file was not found')
    this.files.set(requestedName, content)
    this.files.delete(currentName)
    return requestedName
  }

  public async delete(name: string): Promise<boolean> {
    return this.files.delete(name)
  }
}

function service(store = new MemorySubtitleStore(), assets = new MemorySubtitleAssets()): SubtitleAdminService {
  return new SubtitleAdminService(store, assets, baseUrl, { now: () => 1_800_000_000 })
}

describe('filesystem subtitle assets', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })))
  })

  async function manager() {
    const directory = await mkdtemp(path.join(tmpdir(), 'gplayer-subtitles-'))
    directories.push(directory)
    return {
      directory,
      assets: new FileSystemSubtitleAssetManager(directory, baseUrl, { randomSuffix: () => 'fixedsuffix' })
    }
  }

  it('creates, renames, and deletes a safe public subtitle without overwriting files', async () => {
    const { directory, assets } = await manager()
    const content = Buffer.from('1\n00:00:00,000 --> 00:00:02,000\nHello')
    const created = await assets.create('My captions.srt', content)
    expect(created).toEqual({
      name: 'My-captions-fixedsuffix.srt',
      size: content.length,
      mimeType: 'application/x-subrip',
      url: 'https://player.example/uploads/subtitles/My-captions-fixedsuffix.srt'
    })
    await expect(readFile(path.join(directory, created.name))).resolves.toEqual(content)
    await expect(assets.rename(created.name, 'renamed captions.srt')).resolves.toBe('renamed captions.srt')
    await expect(access(path.join(directory, created.name))).rejects.toThrow()
    await expect(readFile(path.join(directory, 'renamed captions.srt'))).resolves.toEqual(content)
    await expect(assets.delete('renamed captions.srt')).resolves.toBe(true)
  })

  it('rejects empty, oversized, executable, unsupported, traversal, collision, and symlink inputs', async () => {
    const { directory, assets } = await manager()
    await expect(assets.create('empty.srt', Buffer.alloc(0))).rejects.toThrow('empty')
    await expect(assets.create('huge.srt', Buffer.alloc(SUBTITLE_MAX_BYTES + 1))).rejects.toThrow('2 MiB')
    await expect(assets.create('shell.srt', Buffer.from('<?php echo 1;'))).rejects.toThrow('PHP')
    await expect(assets.create('video.exe', Buffer.from('x'))).rejects.toThrow('extension')
    const created = await assets.create('safe.srt', Buffer.from('caption'))
    await expect(assets.rename(created.name, '../outside.srt')).rejects.toThrow('invalid')
    await writeFile(path.join(directory, 'used.srt'), 'used')
    await expect(assets.rename(created.name, 'used.srt')).rejects.toThrow('already in use')
    const external = path.join(directory, 'external.srt')
    await writeFile(external, 'external')
    await symlink(external, path.join(directory, 'linked.srt'))
    await expect(assets.delete('linked.srt')).resolves.toBe(false)
    await expect(readFile(external, 'utf8')).resolves.toBe('external')
  })
})

describe('subtitle administration service', () => {
  it('normalizes the seven-column DataTables contract and scopes non-admin lists', async () => {
    const store = new MemorySubtitleStore()
    const subtitles = service(store)
    const list = await subtitles.list({ draw: '7', 'search[value]': 'capt', 'order[0][column]': '1', 'order[0][dir]': 'asc' }, memberAccess)
    expect(list).toEqual({
      draw: 7,
      data: [expect.objectContaining({ id: '2', file_name: 'captions-two.vtt', name: 'Member', actions: '2' })],
      recordsTotal: 1,
      recordsFiltered: 1
    })
    expect(list.data[0]?.link).toBe('https://player.example/uploads/subtitles/captions-two.vtt')
    expect(store.queries[0]).toEqual(expect.objectContaining({ search: 'capt', orderBy: 'file_name', orderDir: 'asc' }))
    expect(subtitleListQuery({ length: 999, start: -2 })).toEqual(expect.objectContaining({ length: 100, start: 0, orderBy: 'updated' }))
    expect(subtitleId('18446744073709551615')).toBe('18446744073709551615')
    expect(subtitleId('18446744073709551616')).toBeNull()
    expect(subtitleLanguage('not-a-language')).toBe('Unknown CC')
  })

  it('uploads, renames, deletes, and migrates while preserving ownership and exact messages', async () => {
    const store = new MemorySubtitleStore()
    const assets = new MemorySubtitleAssets()
    const subtitles = service(store, assets)
    const uploaded = await subtitles.upload({ originalName: 'demo.srt', content: Buffer.from('caption'), language: 'Spanish' }, memberAccess)
    expect(uploaded).toEqual({
      status: 'ok',
      message: 'The subtitle file has been uploaded successfully',
      data: { id: '3', lang: 'Spanish', sub: 'https://player.example/uploads/subtitles/uploaded-1.srt' }
    })
    await expect(subtitles.rename('1', 'stolen.srt', memberAccess)).resolves.toEqual({ status: 'fail', message: 'The subtitle was not found' })
    await expect(subtitles.rename('3', 'member-renamed.srt', memberAccess)).resolves.toEqual({ status: 'ok', message: 'The subtitle has been successfully renamed' })
    await expect(subtitles.delete('3', memberAccess)).resolves.toEqual({ status: 'ok', message: 'The subtitle file has been successfully deleted' })
    expect(store.deletedLinks[0]).toEqual([
      'https://player.example/subtitles/member-renamed.srt',
      'https://player.example/uploads/subtitles/member-renamed.srt'
    ])
    await expect(subtitles.migrate(baseUrl.href, 'https://captions.example/new', memberAccess)).resolves.toEqual({ status: 'fail', message: 'You are not authorized to access this feature' })
    await expect(subtitles.migrate(baseUrl.href, 'https://captions.example/new', adminAccess)).resolves.toEqual({ status: 'ok', message: 'Migration of the subtitle files has been successful' })
    expect(store.migrations).toEqual([[baseUrl.href, 'https://captions.example/new/', 1_800_000_000]])
  })
})

describe('MySqlSubtitleAdminStore', () => {
  it('uses allowlisted ordering, parameterized ownership/search, and transactional mutations', async () => {
    const executor = { execute: vi.fn().mockResolvedValue({ affectedRows: 1 }) }
    const database = {
      read: vi.fn()
        .mockResolvedValueOnce([{ id: 2, file_name: 'member.vtt', language: 'French', name: 'Member', uid: 2, host: baseUrl.href, created: 10, updated: 20 }])
        .mockResolvedValueOnce([{ total: '4' }])
        .mockResolvedValueOnce([{ total: '1' }])
        .mockResolvedValueOnce([{ id: 2, file_name: 'member.vtt', language: 'French', name: 'Member', uid: 2, host: baseUrl.href, created: 10, updated: 20 }])
        .mockResolvedValueOnce([{ host: baseUrl.href }]),
      write: vi.fn().mockResolvedValue({ insertId: 9 }),
      transaction: vi.fn(async (work: (target: typeof executor) => Promise<unknown>) => await work(executor))
    }
    const store = new MySqlSubtitleAdminStore(database as unknown as Pick<Database, 'read' | 'write' | 'transaction'>)
    const query: SubtitleListQuery = { draw: 1, start: 5, length: 25, search: "x' OR 1=1", orderBy: 'updated', orderDir: 'desc' }
    await expect(store.listSubtitles(query, memberAccess)).resolves.toEqual({
      data: [record({ id: '2', fileName: 'member.vtt', language: 'French', userName: 'Member', userId: '2', created: 10, updated: 20 })],
      recordsTotal: 4,
      recordsFiltered: 1
    })
    expect(database.read.mock.calls[0]?.[0]).toContain('FROM `vw_subtitle_manager`')
    expect(database.read.mock.calls[0]?.[0]).toContain('ORDER BY `updated` DESC LIMIT ? OFFSET ?')
    expect(database.read.mock.calls[0]?.[0]).not.toContain("x' OR 1=1")
    expect(database.read.mock.calls[0]?.[1]).toEqual(['2', "x' OR 1=1%", "x' OR 1=1%", "x' OR 1=1%", "x' OR 1=1%", 25, 5])
    await expect(store.getSubtitle('2', memberAccess)).resolves.toEqual(expect.objectContaining({ id: '2', userId: '2' }))
    await expect(store.insertSubtitle({ fileName: 'new.srt', fileSize: 2, fileType: 'text/plain', language: 'English', created: 1, userId: '2', host: baseUrl.href, updated: 1 })).resolves.toBe('9')
    await expect(store.deleteSubtitle('2', memberAccess, ['a', 'b'])).resolves.toBe(true)
    await expect(store.renameSubtitle('2', memberAccess, 'new.vtt', '/member.vtt', 'https://player.example/uploads/subtitles/new.vtt', 30)).resolves.toBe(true)
    await expect(store.listSubtitleHosts()).resolves.toEqual([baseUrl.href])
    await store.migrateSubtitleHost(baseUrl.href, 'https://new.example/', 40)
    expect(executor.execute).toHaveBeenCalledWith(expect.stringContaining('RIGHT(`link`, CHAR_LENGTH(?))'), expect.arrayContaining(['/member.vtt']))
    expect(executor.execute).toHaveBeenCalledWith(expect.stringContaining('LEFT(`link`, CHAR_LENGTH(?))'), expect.arrayContaining([baseUrl.href, 'https://new.example/']))
    for (const call of [...database.read.mock.calls, ...database.write.mock.calls, ...executor.execute.mock.calls]) {
      expect(String(call[0])).not.toContain('member.vtt')
    }
  })
})

class RouteAuthStore implements AuthStore {
  public constructor(private readonly user: AuthUser | null) {}
  public async findUserByIdentifier(): Promise<StoredAuthUser | null> { return null }
  public async createSession(_session: SessionWrite): Promise<void> {}
  public async recordFailedLogin(_session: Omit<SessionWrite, 'expires' | 'state'>): Promise<void> {}
  public async findActiveSession(requestedToken: string, requestedUserAgent: string): Promise<AuthUser | null> {
    return requestedToken === token && requestedUserAgent === userAgent ? this.user : null
  }
  public async revokeSession(): Promise<boolean> { return true }
}

describe('subtitle administration routes', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function createApp(user: AuthUser, store = new MemorySubtitleStore(), assets = new MemorySubtitleAssets()): Promise<{ app: FastifyInstance; store: MemorySubtitleStore; assets: MemorySubtitleAssets }> {
    const subtitles = service(store, assets)
    const built = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: baseUrl.href, SECURE_SALT: '1234567890123456' }), {
      auth: new AuthService(new RouteAuthStore(user)),
      subtitles
    })
    app = built
    return { app: built, store, assets }
  }

  const headers = Object.freeze({ cookie: `${AUTH_COOKIE_NAME}=${token}`, 'user-agent': userAgent })

  it('renders an ownership-scoped, noindex manager and admin-only migration UI', async () => {
    const memberApp = await createApp(member)
    const memberPage = await memberApp.app.inject({ method: 'GET', url: '/administrator/videos/subtitles/', headers })
    expect(memberPage.statusCode).toBe(200)
    expect(memberPage.body).toContain('Subtitle Manager.')
    expect(memberPage.body).toContain('captions-two.vtt')
    expect(memberPage.body).not.toContain('captions-one.srt')
    expect(memberPage.body).not.toContain('Migrate location')
    expect(memberPage.body).not.toContain('>Settings</a>')
    expect(memberPage.body).not.toContain(token)
    expect(memberPage.headers['cache-control']).toBe('no-store')
    expect(memberPage.headers['x-robots-tag']).toBe('noindex, nofollow')

    await memberApp.app.close()
    app = undefined
    const adminApp = await createApp(admin)
    const adminPage = await adminApp.app.inject({ method: 'GET', url: '/administrator/videos/subtitles/', headers })
    expect(adminPage.body).toContain('captions-one.srt')
    expect(adminPage.body).toContain('captions-two.vtt')
    expect(adminPage.body).toContain('Migrate location')
  })

  it('uploads, renames, deletes, and migrates through signed same-origin forms', async () => {
    const context = await createApp(admin)
    const page = await context.app.inject({ method: 'GET', url: '/administrator/videos/subtitles/', headers })
    const uploadCsrf = csrfFor(page.body, '/administrator/videos/subtitles/upload/')
    const uploadBody = multipartBody({ csrf: uploadCsrf, uploadSubLang: 'German' }, 'uploadSubFile', 'route.srt', Buffer.from('route caption'))
    const uploaded = await context.app.inject({
      method: 'POST',
      url: '/administrator/videos/subtitles/upload/',
      headers: { ...headers, origin: baseUrl.origin, 'content-type': `multipart/form-data; boundary=${uploadBody.boundary}` },
      payload: uploadBody.payload
    })
    expect(uploaded.statusCode).toBe(303)
    expect(uploaded.headers.location).toBe('/administrator/videos/subtitles/?uploaded=1')
    expect(context.store.records).toContainEqual(expect.objectContaining({ id: '3', language: 'German', fileName: 'uploaded-1.srt' }))

    const refreshed = await context.app.inject({ method: 'GET', url: '/administrator/videos/subtitles/', headers })
    const renamed = await context.app.inject({
      method: 'POST',
      url: '/administrator/videos/subtitles/rename/',
      headers: { ...headers, origin: baseUrl.origin, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${encodeURIComponent(csrfFor(refreshed.body, '/administrator/videos/subtitles/rename/'))}&id=3&name=route-renamed.srt`
    })
    expect(renamed.statusCode).toBe(303)
    expect(context.assets.files.has('route-renamed.srt')).toBe(true)

    const afterRename = await context.app.inject({ method: 'GET', url: '/administrator/videos/subtitles/', headers })
    const deleted = await context.app.inject({
      method: 'POST',
      url: '/administrator/videos/subtitles/delete/',
      headers: { ...headers, origin: baseUrl.origin, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${encodeURIComponent(csrfFor(afterRename.body, '/administrator/videos/subtitles/delete/'))}&id=3`
    })
    expect(deleted.statusCode).toBe(303)
    expect(context.store.records.some((item) => item.id === '3')).toBe(false)

    const migratePage = await context.app.inject({ method: 'GET', url: '/administrator/videos/subtitles/', headers })
    const migrated = await context.app.inject({
      method: 'POST',
      url: '/administrator/videos/subtitles/migrate/',
      headers: { ...headers, origin: baseUrl.origin, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${encodeURIComponent(csrfFor(migratePage.body, '/administrator/videos/subtitles/migrate/'))}&oldLocation=${encodeURIComponent(baseUrl.href)}&newLocation=${encodeURIComponent('https://new.example/captions')}`
    })
    expect(migrated.statusCode).toBe(303)
    expect(context.store.migrations.at(-1)).toEqual([baseUrl.href, 'https://new.example/captions/', 1_800_000_000])
  })

  it('preserves legacy list, upload, host, and ownership response contracts', async () => {
    const context = await createApp(member)
    const listed = await context.app.inject({ method: 'GET', url: '/administrator/ajax/subtitles-list/?draw=5', headers })
    expect(listed.json()).toEqual({
      draw: 5,
      data: [expect.objectContaining({ id: '2', file_name: 'captions-two.vtt', actions: '2' })],
      recordsTotal: 1,
      recordsFiltered: 1
    })
    const forbiddenHosts = await context.app.inject({
      method: 'POST', url: '/administrator/ajax/subtitles/', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'action=getHosts'
    })
    expect(forbiddenHosts.json()).toEqual({ status: 'fail', message: 'You are not authorized to access this feature', result: null })
    const forbiddenDelete = await context.app.inject({
      method: 'POST', url: '/administrator/ajax/subtitles/', headers: { ...headers, origin: baseUrl.origin, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'action=delete&id=1'
    })
    expect(forbiddenDelete.json()).toEqual({ status: 'fail', message: 'The subtitle was not found', result: null })

    const upload = multipartBody({ action: 'uploadSubtitle', uploadSubLang: 'Italian' }, 'uploadSubFile', 'legacy.vtt', Buffer.from('WEBVTT'))
    const uploaded = await context.app.inject({
      method: 'POST',
      url: '/administrator/ajax/subtitles/',
      headers: { ...headers, origin: baseUrl.origin, 'content-type': `multipart/form-data; boundary=${upload.boundary}` },
      payload: upload.payload
    })
    expect(uploaded.json()).toEqual({
      status: 'ok',
      message: 'The subtitle file has been uploaded successfully',
      result: { id: '3', lang: 'Italian', sub: 'https://player.example/uploads/subtitles/uploaded-1.vtt' },
      data: { id: '3', lang: 'Italian', sub: 'https://player.example/uploads/subtitles/uploaded-1.vtt' }
    })
  })

  it('rejects cross-origin writes, invalid form signatures, and unauthenticated lists without mutation', async () => {
    const context = await createApp(admin)
    const crossOrigin = await context.app.inject({
      method: 'POST', url: '/administrator/ajax/subtitles/', headers: { ...headers, origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded' }, payload: 'action=delete&id=1'
    })
    const badCsrf = await context.app.inject({
      method: 'POST', url: '/administrator/videos/subtitles/delete/', headers: { ...headers, origin: baseUrl.origin, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'csrf=invalid&id=1'
    })
    const getDelete = await context.app.inject({ method: 'GET', url: '/administrator/ajax/subtitles/?action=delete&id=1', headers })
    const anonymous = await context.app.inject({ method: 'GET', url: '/administrator/ajax/subtitles-list/?draw=8', headers: { 'user-agent': userAgent } })
    expect(crossOrigin.statusCode).toBe(403)
    expect(badCsrf.statusCode).toBe(403)
    expect(getDelete.statusCode).toBe(405)
    expect(anonymous.json()).toEqual({ draw: 8, data: [], recordsTotal: 0, recordsFiltered: 0 })
    expect(context.store.records).toHaveLength(2)
  })
})

function csrfFor(body: string, action: string): string {
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const value = body.match(new RegExp(`<form[^>]+action="${escaped}"[\\s\\S]*?name="csrf" value="([^"]+)"`))?.[1]
  if (value === undefined) throw new Error(`CSRF token not found for ${action}`)
  return value
}

function multipartBody(
  fields: Readonly<Record<string, string>>,
  fileField: string,
  filename: string,
  content: Buffer
): Readonly<{ boundary: string; payload: Buffer }> {
  const boundary = '----gplayer-subtitle-test-boundary'
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`))
  chunks.push(content)
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  return Object.freeze({ boundary, payload: Buffer.concat(chunks) })
}
