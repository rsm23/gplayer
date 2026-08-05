import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { loadConfig } from '../src/config.js'
import { buildPlayerQuery, type PlayerMediaQuery } from '../src/core/player-query.js'
import type { MediaResult } from '../src/core/source-resolver.js'
import type { Database } from '../src/database/database.js'
import { MySqlVideoAdminStore } from '../src/videos/mysql-video-admin-store.js'
import {
  VideoAdminService,
  parseBulkSubtitleLines,
  videoListQuery,
  type StoredVideoDetail,
  type StoredVideoRecord,
  type VideoAccess,
  type VideoAdminStore,
  type VideoCreateWrite,
  type VideoListQuery,
  type VideoUpdateWrite
} from '../src/videos/video-admin-service.js'
import {
  FileSystemVideoPosterAssetManager,
  VIDEO_POSTER_MAX_BYTES,
  type VideoPosterAsset,
  type VideoPosterAssetManager
} from '../src/videos/video-assets-service.js'
import { Security } from '../src/security/security.js'
import type { SubtitleAdminService } from '../src/subtitles/subtitle-admin-service.js'

const baseUrl = new URL('https://player.example/')
const secureSalt = '1234567890123456'
const token = 'video-admin-token-1234567890'
const userAgent = 'GPlayer video test'
const admin: AuthUser = Object.freeze({ id: 1, username: 'admin', email: 'admin@example.test', name: 'Admin', role: 0, status: 1, created: 1, updated: 1 })
const member: AuthUser = Object.freeze({ id: 2, username: 'member', email: 'member@example.test', name: 'Member', role: 1, status: 1, created: 1, updated: 1 })
const adminAccess: VideoAccess = Object.freeze({ userId: '1', isAdmin: true })
const memberAccess: VideoAccess = Object.freeze({ userId: '2', isAdmin: false })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

function video(overrides: Partial<StoredVideoDetail> = {}): StoredVideoDetail {
  return Object.freeze({
    id: '1',
    title: 'Database movie',
    host: 'direct',
    hostId: 'https://cdn.example/movie.mp4',
    userId: '1',
    userName: 'Admin',
    slug: 'database-movie',
    status: 0,
    dmca: 0,
    views: 42,
    poster: '',
    created: 1_700_000_000,
    updated: 1_700_000_100,
    hasAlternatives: true,
    hasSubtitles: true,
    alternatives: Object.freeze([
      Object.freeze({ id: '11', host: 'youtube', hostId: 'fallback-one', order: 0 }),
      Object.freeze({ id: '12', host: 'vimeo', hostId: '1234', order: 1 })
    ]),
    subtitles: Object.freeze([
      Object.freeze({ id: '21', link: 'https://captions.example/movie.en.vtt', language: 'English', order: 0 })
    ]),
    ...overrides
  })
}

class MemoryVideoStore implements VideoAdminStore {
  public readonly videos: StoredVideoDetail[] = [
    video(),
    video({ id: '2', title: 'Member movie', slug: 'member-movie', userId: '2', userName: 'Member', alternatives: [], subtitles: [], hasAlternatives: false, hasSubtitles: false })
  ]
  public readonly listQueries: VideoListQuery[] = []
  public lastCreate: VideoCreateWrite | undefined
  public lastUpdate: VideoUpdateWrite | undefined

  public async listVideos(query: VideoListQuery, access: VideoAccess) {
    this.listQueries.push(query)
    const allowed = this.videos.filter((item) => access.isAdmin || item.userId === access.userId)
    const search = query.search.toLowerCase()
    const filtered = allowed.filter((item) =>
      (query.status === null || item.status === query.status) &&
      (query.dmca === null || item.dmca === query.dmca) &&
      (search === '' || [item.title, item.host, item.hostId, item.slug, item.userName].some((value) => value.toLowerCase().includes(search))))
    return { data: filtered.slice(query.start, query.start + query.length), recordsTotal: allowed.length, recordsFiltered: filtered.length }
  }

  public async getVideo(id: string, access: VideoAccess): Promise<StoredVideoDetail | null> {
    return this.videos.find((item) => item.id === id && (access.isAdmin || item.userId === access.userId)) ?? null
  }

  public async getPublicVideo(idOrSlug: string): Promise<StoredVideoDetail | null> {
    return this.videos.find((item) => (item.id === idOrSlug || item.slug === idOrSlug) && item.dmca === 0) ?? null
  }

  public async slugExists(slug: string, excludeId?: string): Promise<boolean> {
    return this.videos.some((item) => item.slug === slug && item.id !== excludeId)
  }

  public async createVideo(value: VideoCreateWrite): Promise<string> {
    this.lastCreate = value
    const id = String(this.videos.length + 1)
    this.videos.push(detailFromWrite(id, value, value.alternatives, value.subtitles))
    return id
  }

  public async updateVideo(id: string, access: VideoAccess, value: VideoUpdateWrite): Promise<boolean> {
    const index = this.videos.findIndex((item) => item.id === id && (access.isAdmin || item.userId === access.userId))
    const current = this.videos[index]
    if (index < 0 || current === undefined) return false
    this.lastUpdate = value
    this.videos[index] = Object.freeze({
      ...current,
      ...value,
      alternatives: Object.freeze(value.alternatives.map((item, relationIndex) => Object.freeze({ id: String(100 + relationIndex), ...item }))),
      subtitles: Object.freeze(value.subtitles.map((item, relationIndex) => Object.freeze({ id: String(200 + relationIndex), link: item.link, language: item.language, order: item.order }))),
      hasAlternatives: value.alternatives.length > 0,
      hasSubtitles: value.subtitles.length > 0
    })
    return true
  }

  public async deleteVideo(id: string, access: VideoAccess): Promise<boolean> {
    const index = this.videos.findIndex((item) => item.id === id && (access.isAdmin || item.userId === access.userId))
    if (index < 0) return false
    this.videos.splice(index, 1)
    return true
  }

  public async renameVideo(id: string, access: VideoAccess, title: string, updated: number): Promise<boolean> {
    const item = await this.getVideo(id, access)
    if (item === null) return false
    const index = this.videos.indexOf(item)
    this.videos[index] = Object.freeze({ ...item, title, updated })
    return true
  }

  public async renameVideos(ids: readonly string[], access: VideoAccess, transform: Readonly<{ prefix: string; postfix: string; search: string; replacement: string }>, updated: number): Promise<boolean> {
    let changed = false
    for (const id of ids) {
      const item = await this.getVideo(id, access)
      if (item === null) continue
      let title = `${transform.prefix}${item.title}${transform.postfix}`
      if (transform.search !== '') title = title.replaceAll(transform.search, transform.replacement)
      changed = await this.renameVideo(id, access, title, updated) || changed
    }
    return changed
  }

  public async updateVideoStatus(id: string, access: VideoAccess, status: number): Promise<boolean> {
    return await this.patch(id, access, { status })
  }

  public async updateVideoDmca(id: string, takedown: number, updated: number): Promise<boolean> {
    return await this.patch(id, adminAccess, { dmca: takedown, updated })
  }

  public async updateVideoPoster(id: string, access: VideoAccess, poster: string, updated: number): Promise<boolean> {
    return await this.patch(id, access, { poster, updated })
  }

  public async deleteVideoSubtitle(id: string, access: VideoAccess): Promise<boolean> {
    const owner = this.videos.find((item) => item.subtitles.some((subtitle) => subtitle.id === id) && (access.isAdmin || item.userId === access.userId))
    if (owner === undefined) return false
    const index = this.videos.indexOf(owner)
    const subtitles = owner.subtitles.filter((item) => item.id !== id)
    this.videos[index] = Object.freeze({ ...owner, subtitles, hasSubtitles: subtitles.length > 0 })
    return true
  }

  public async updateVideoSubtitle(id: string, access: VideoAccess, link: string, language: string): Promise<boolean> {
    const owner = this.videos.find((item) => item.subtitles.some((subtitle) => subtitle.id === id) && (access.isAdmin || item.userId === access.userId))
    if (owner === undefined) return false
    const index = this.videos.indexOf(owner)
    this.videos[index] = Object.freeze({ ...owner, subtitles: owner.subtitles.map((item) => item.id === id ? Object.freeze({ ...item, link, language }) : item) })
    return true
  }

  public async deleteVideosByHosts(hosts: readonly string[]): Promise<readonly string[]> {
    const deleted = this.videos.filter((item) => hosts.includes(item.host))
    for (const item of deleted) this.videos.splice(this.videos.indexOf(item), 1)
    return Object.freeze(deleted.map((item) => item.poster))
  }

  private async patch(id: string, access: VideoAccess, value: Partial<StoredVideoDetail>): Promise<boolean> {
    const item = await this.getVideo(id, access)
    if (item === null) return false
    this.videos[this.videos.indexOf(item)] = Object.freeze({ ...item, ...value })
    return true
  }
}

class MemoryPosters implements VideoPosterAssetManager {
  public readonly files = new Map<string, Buffer>()
  private sequence = 0

  public async create(_originalName: string, content: Buffer): Promise<VideoPosterAsset> {
    const name = `poster-${++this.sequence}.png`
    this.files.set(name, Buffer.from(content))
    return { name, size: content.length, mimeType: 'image/png', url: new URL(`uploads/images/${name}`, baseUrl).href }
  }

  public async delete(name: string): Promise<boolean> {
    return this.files.delete(name)
  }

  public url(name: string): string {
    return name === '' ? '' : new URL(`uploads/images/${name}`, baseUrl).href
  }
}

function service(store = new MemoryVideoStore(), posters = new MemoryPosters()): VideoAdminService {
  return new VideoAdminService(store, posters, baseUrl, {
    now: () => 1_800_000_000,
    randomSlug: () => 'generated-slug',
    embedSlug: 'e',
    downloadSlug: 'd'
  })
}

describe('filesystem video poster assets', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })))
  })

  async function manager() {
    const directory = await mkdtemp(path.join(tmpdir(), 'gplayer-posters-'))
    directories.push(directory)
    return { directory, posters: new FileSystemVideoPosterAssetManager(directory, baseUrl, { randomSuffix: () => 'fixed' }) }
  }

  it('validates image bytes, stores without overwriting, and deletes only safe regular files', async () => {
    const { directory, posters } = await manager()
    const created = await posters.create('Movie poster.png', png)
    expect(created).toEqual({ name: 'Movie-poster-fixed.png', size: png.length, mimeType: 'image/png', url: 'https://player.example/uploads/images/Movie-poster-fixed.png' })
    await expect(readFile(path.join(directory, created.name))).resolves.toEqual(png)
    await expect(posters.create('not-image.png', Buffer.from('plain text'))).rejects.toThrow('valid image')
    await expect(posters.create('large.png', Buffer.alloc(VIDEO_POSTER_MAX_BYTES + 1))).rejects.toThrow('5 MiB')
    const external = path.join(directory, 'external.png')
    await writeFile(external, png)
    await symlink(external, path.join(directory, 'linked.png'))
    await expect(posters.delete('linked.png')).resolves.toBe(false)
    await expect(posters.delete('../external.png')).resolves.toBe(false)
    await expect(posters.delete(created.name)).resolves.toBe(true)
  })
})

describe('video administration service', () => {
  it('normalizes DataTables queries and preserves the legacy list contract with ownership', async () => {
    const store = new MemoryVideoStore()
    const videos = service(store)
    const result = await videos.list({ draw: '7', 'search[value]': 'member', 'order[0][column]': '1', 'order[0][dir]': 'asc' }, memberAccess)
    expect(result).toEqual({
      draw: 7,
      data: [expect.objectContaining({ id: '2', title: 'Member movie', host_id: 'https://cdn.example/movie.mp4', DT_RowId: '2', has_alt: 0, has_sub: 0 })],
      recordsTotal: 1,
      recordsFiltered: 1
    })
    expect(result.data[0]?.actions).toEqual(expect.objectContaining({ embed: 'https://player.example/e/member-movie', download: 'https://player.example/d/member-movie' }))
    const configured = await videos.records({}, adminAccess, { embed: 'watch', download: 'save' })
    expect(configured.data[0]).toEqual(expect.objectContaining({ embedUrl: 'https://player.example/watch/database-movie', downloadUrl: 'https://player.example/save/database-movie' }))
    expect(videoListQuery({ length: 999, start: -1, status: '2', dmca: '1' }, adminAccess)).toEqual(expect.objectContaining({ length: 25, start: 0, status: 2, dmca: 1, orderBy: 'updated' }))
  })

  it('creates and updates normalized videos, ordered alternatives, subtitles, slugs, and posters', async () => {
    const store = new MemoryVideoStore()
    const posters = new MemoryPosters()
    const videos = service(store, posters)
    const created = await videos.create({
      title: 'New movie',
      mainUrl: 'https://youtu.be/main-id',
      slug: '',
      posterUrl: '',
      alternatives: ['https://youtu.be/main-id', 'https://vimeo.com/9876', 'not-a-url'],
      subtitles: [{ url: 'https://captions.example/new.en.vtt', language: 'English' }],
      posterFile: { originalName: 'poster.png', content: png }
    }, memberAccess)
    expect(created).toEqual({ status: 'ok', message: 'The new video has been saved successfully', id: '3' })
    expect(store.lastCreate).toEqual(expect.objectContaining({ host: 'youtube', hostId: 'main-id', userId: '2', slug: 'generated-slug', poster: 'poster-1.png' }))
    expect(store.lastCreate?.alternatives).toEqual([{ host: 'vimeo', hostId: '9876', order: 0 }])
    expect(store.lastCreate?.subtitles).toEqual([expect.objectContaining({ link: 'https://captions.example/new.en.vtt', language: 'English', userId: '2', order: 0 })])

    await expect(videos.update('1', { title: 'Stolen', mainUrl: 'https://youtu.be/x', slug: '', posterUrl: '', alternatives: [], subtitles: [] }, memberAccess)).resolves.toEqual({ status: 'fail', message: 'The video was not found' })
    await expect(videos.create({ title: '', mainUrl: 'javascript:alert(1)', slug: '', posterUrl: '', alternatives: [], subtitles: [] }, memberAccess)).resolves.toEqual({ status: 'fail', message: 'The main video URL is invalid' })
    await expect(videos.create({ title: '', mainUrl: 'https://youtu.be/x', slug: 'database movie', posterUrl: '', alternatives: [], subtitles: [] }, memberAccess)).resolves.toEqual({ status: 'fail', message: 'The custom slug is already in use' })
  })

  it('hydrates saved videos with database title, every fallback, captions, and public poster', async () => {
    const store = new MemoryVideoStore()
    store.videos[0] = video({ poster: 'poster.png' })
    const query = await service(store).savedQuery('database-movie')
    expect(query).toEqual({
      host: 'direct',
      id: 'https://cdn.example/movie.mp4',
      title: 'Database movie',
      ahost: 'youtube',
      aid: 'fallback-one',
      alternatives: [{ host: 'youtube', id: 'fallback-one' }, { host: 'vimeo', id: '1234' }],
      poster: 'https://player.example/uploads/images/poster.png',
      sub: ['https://captions.example/movie.en.vtt'],
      lang: ['English'],
      uid: '1'
    })
    expect(parseBulkSubtitleLines('French|https://captions.example/movie.fr.vtt\nhttps://captions.example/movie.en.srt|English\ninvalid')).toEqual([
      { url: 'https://captions.example/movie.fr.vtt', language: 'French' },
      { url: 'https://captions.example/movie.en.srt', language: 'English' }
    ])
  })

  it('applies scoped mutations and admin-only hostname deletion with exact legacy messages', async () => {
    const store = new MemoryVideoStore()
    const videos = service(store)
    await expect(videos.rename('2', 'Renamed', memberAccess)).resolves.toEqual({ status: 'ok', message: 'The video has been successfully updated', id: '2' })
    await expect(videos.status('2', '', memberAccess)).resolves.toEqual({ status: 'ok', message: 'The new video has been saved successfully', id: '2' })
    await expect(videos.dmca('2', 1, memberAccess)).resolves.toEqual({ status: 'fail', message: 'The video failed to update' })
    await expect(videos.deleteSubtitle('21', memberAccess)).resolves.toEqual({ status: 'fail', message: 'The subtitle failed to remove' })
    await expect(videos.deleteByHostnames(['direct'], memberAccess)).resolves.toEqual({ status: 'fail', message: 'The video failed to delete' })
    await expect(videos.deleteByHostnames(['direct'], adminAccess)).resolves.toEqual({ status: 'ok', message: 'The video has been successfully deleted' })
    expect(store.videos).toHaveLength(0)
  })
})

describe('MySqlVideoAdminStore', () => {
  it('uses allowlisted ordering, parameterized ownership/search, and transactional hostname deletion', async () => {
    const transaction = {
      execute: vi.fn()
        .mockResolvedValueOnce([{ id: 1, host: 'direct', host_id: 'https://cdn.example/movie.mp4', poster: 'poster.png' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({ affectedRows: 1 })
        .mockResolvedValueOnce({ affectedRows: 1 })
        .mockResolvedValueOnce({ affectedRows: 1 })
        .mockResolvedValueOnce({ affectedRows: 1 })
    }
    const database = {
      read: vi.fn()
        .mockResolvedValueOnce([{ id: 2, title: 'Member', host: 'direct', host_id: 'https://cdn.example/m.mp4', uid: 2, name: 'Member', slug: 'member', status: 0, dmca: 0, views: 2, poster: '', created: 1, updated: 2, has_alt: 0, has_sub: 0 }])
        .mockResolvedValueOnce([{ count: '4' }])
        .mockResolvedValueOnce([{ count: '1' }]),
      transaction: vi.fn(async (work: (target: typeof transaction) => Promise<unknown>) => await work(transaction))
    }
    const store = new MySqlVideoAdminStore(database as unknown as Database)
    const query: VideoListQuery = { draw: 1, start: 0, length: 25, search: "x' OR 1=1", orderBy: 'updated', orderDir: 'desc', status: null, dmca: null, userId: null }
    await expect(store.listVideos(query, memberAccess)).resolves.toEqual({ data: [expect.objectContaining({ id: '2', userId: '2' })], recordsTotal: 4, recordsFiltered: 1 })
    expect(database.read.mock.calls[0]?.[0]).toContain('ORDER BY v.`updated` DESC LIMIT ?, ?')
    expect(database.read.mock.calls[0]?.[0]).not.toContain("x' OR 1=1")
    expect(database.read.mock.calls[0]?.[1]).toEqual(['2', "%x' OR 1=1%", "%x' OR 1=1%", "%x' OR 1=1%", "%x' OR 1=1%", "%x' OR 1=1%", "%x' OR 1=1%", "x' OR 1=1", 0, 25])
    await expect(store.deleteVideosByHosts(['direct'])).resolves.toEqual(['poster.png'])
    expect(transaction.execute.mock.calls[0]?.[0]).toContain('WHERE `host` IN (?) FOR UPDATE')
    for (const call of [...database.read.mock.calls, ...transaction.execute.mock.calls]) expect(String(call[0])).not.toContain("x' OR 1=1")
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

describe('video administration and saved-video routes', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function createApp(user: AuthUser, store = new MemoryVideoStore(), posters = new MemoryPosters()) {
    const videos = service(store, posters)
    const subtitleUploads: Array<{ originalName: string; content: Buffer }> = []
    const subtitles = {
      upload: async (input: { originalName: string; content: Buffer }) => {
        subtitleUploads.push(input)
        return { status: 'ok', message: 'The subtitle file has been uploaded successfully', data: { id: '99', lang: 'English', sub: `https://player.example/uploads/subtitles/${encodeURIComponent(input.originalName)}` } }
      },
      records: async () => ({ draw: 0, data: [], recordsTotal: 0, recordsFiltered: 0 })
    } as unknown as SubtitleAdminService
    const resolver = vi.fn(async (_query: PlayerMediaQuery): Promise<MediaResult> => Object.freeze({
      sources: Object.freeze([{ file: 'https://cdn.example/movie.mp4', type: 'mp4', label: '1080' }]),
      tracks: Object.freeze([]),
      referer: '',
      title: '',
      email: '',
      image: '',
      cookies: Object.freeze([]),
      filmstrip: '',
      clientip: '127.0.0.1'
    }))
    const built = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: baseUrl.href, SECURE_SALT: secureSalt }), {
      auth: new AuthService(new RouteAuthStore(user)),
      videos,
      subtitles,
      sourceApi: { resolve: resolver, supportedHosts: new Set(['direct', 'youtube', 'vimeo']) }
    })
    app = built
    return { app: built, store, posters, videos, subtitleUploads, resolver }
  }

  const headers = Object.freeze({ cookie: `${AUTH_COOKIE_NAME}=${token}`, 'user-agent': userAgent })

  it('renders ownership-scoped responsive manager and repeatable editor controls', async () => {
    const context = await createApp(member)
    const list = await context.app.inject({ method: 'GET', url: '/administrator/videos/list/', headers })
    expect(list.statusCode).toBe(200)
    expect(list.body).toContain('Video Manager.')
    expect(list.body).toContain('Member movie')
    expect(list.body).not.toContain('Database movie')
    expect(list.body).not.toContain('>Settings</a>')
    expect(list.body).not.toContain(token)
    expect(list.headers['cache-control']).toBe('no-store')
    const editor = await context.app.inject({ method: 'GET', url: '/administrator/videos/new/', headers })
    expect(editor.body).toContain('data-video-editor')
    expect(editor.body).toContain('data-add-video-alternative')
    expect(editor.body).toContain('name="multiAltUrls"')
    expect(editor.body).toContain('name="multiSubFiles"')
  })

  it('creates a video through a signed multipart form with real poster and subtitle bytes', async () => {
    const context = await createApp(member)
    const page = await context.app.inject({ method: 'GET', url: '/administrator/videos/new/', headers })
    const csrf = csrfFor(page.body, '/administrator/videos/new/')
    const multipart = multipartBody({
      csrf,
      title: 'Route movie',
      host_id: 'https://youtu.be/route-main',
      slug: 'route-movie',
      multiAltUrls: 'https://vimeo.com/7788',
      multiSubUrls: 'French|https://captions.example/route.fr.vtt'
    }, [
      { field: 'poster-file', filename: 'route.png', type: 'image/png', content: png },
      { field: 'multiSubFiles', filename: 'route.en.vtt', type: 'text/vtt', content: Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nRoute') }
    ])
    const response = await context.app.inject({
      method: 'POST',
      url: '/administrator/videos/new/',
      headers: { ...headers, origin: baseUrl.origin, 'content-type': `multipart/form-data; boundary=${multipart.boundary}` },
      payload: multipart.payload
    })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/administrator/videos/edit/?id=3&created=1')
    expect(context.store.lastCreate).toEqual(expect.objectContaining({ title: 'Route movie', host: 'youtube', hostId: 'route-main', slug: 'route-movie', poster: 'poster-1.png' }))
    expect(context.store.lastCreate?.alternatives).toEqual([{ host: 'vimeo', hostId: '7788', order: 0 }])
    expect(context.store.lastCreate?.subtitles).toHaveLength(2)
    expect(context.subtitleUploads).toEqual([expect.objectContaining({ originalName: 'route.en.vtt' })])
  })

  it('preserves legacy list and mutation contracts while rejecting unauthorized and cross-origin writes', async () => {
    const context = await createApp(admin)
    const listed = await context.app.inject({ method: 'GET', url: '/administrator/ajax/videos-list/?draw=5', headers })
    expect(listed.json()).toEqual({ draw: 5, data: expect.arrayContaining([expect.objectContaining({ id: '1', has_alt: 1, has_sub: 1, DT_RowId: '1' })]), recordsTotal: 2, recordsFiltered: 2 })
    const alternatives = await context.app.inject({ method: 'GET', url: '/administrator/ajax/videos/?action=getAlternatives&id=1', headers })
    expect(alternatives.json()).toEqual({ status: 'ok', message: 'OK', result: expect.arrayContaining([expect.objectContaining({ host: 'direct' }), expect.objectContaining({ host: 'youtube' }), expect.objectContaining({ host: 'vimeo' })]) })
    const server = await context.app.inject({ method: 'GET', url: '/administrator/ajax/videos/?action=getServer&id=1&useTitleAsSlug=true', headers })
    const serverUrl = new URL(String(server.json().result))
    const checked = await context.app.inject({ method: 'GET', url: `${serverUrl.pathname}${serverUrl.search}` })
    const checkedBody = new Security(secureSalt).decryptResponseStrict(checked.body, '127.0.0.1')
    expect(JSON.parse(checkedBody ?? '{}')).toEqual(expect.objectContaining({ status: 'ok', title: 'Database movie' }))
    const crossOrigin = await context.app.inject({ method: 'POST', url: '/administrator/ajax/videos/', headers: { ...headers, origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded' }, payload: 'action=delete&id=1' })
    expect(crossOrigin.statusCode).toBe(403)
    expect(context.store.videos).toHaveLength(2)
    const deleted = await context.app.inject({ method: 'POST', url: '/administrator/ajax/videos/', headers: { ...headers, origin: baseUrl.origin, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'action=deleteByHostnames&hostnames%5B%5D=direct' })
    expect(deleted.json()).toEqual({ status: 'ok', message: 'The video has been successfully deleted', result: null })
    expect(context.store.videos).toHaveLength(0)
    const anonymous = await context.app.inject({ method: 'GET', url: '/administrator/ajax/videos-list/?draw=8', headers: { 'user-agent': userAgent } })
    expect(anonymous.json()).toEqual({ draw: 8, data: [], recordsTotal: 0, recordsFiltered: 0 })
  })

  it('resolves stable slug routes and hydrates encrypted player/source API requests from the database', async () => {
    const context = await createApp(admin)
    const redirect = await context.app.inject({ method: 'GET', url: '/e/database-movie' })
    expect(redirect.statusCode).toBe(302)
    expect(redirect.headers.location).toMatch(/^\/e\/\?/u)
    const embed = await context.app.inject({ method: 'GET', url: redirect.headers.location ?? '' })
    expect(embed.statusCode).toBe(200)
    expect(embed.body).toContain('Database movie')
    expect(embed.body).toContain('English')

    const security = new Security(secureSalt)
    const queryToken = security.encryptURL(buildPlayerQuery({ source: 'db', id: 'database-movie' }))
    const password = 'source-password'
    const passwordToken = security.encryptURL(password)
    const configuration = await context.app.inject({ method: 'GET', url: `/api-config/${queryToken}?p=${passwordToken}` })
    const configurationBody = security.decryptResponseStrict(configuration.body, password)
    expect(JSON.parse(configurationBody ?? '{}')).toEqual(expect.objectContaining({ hosts: ['direct', 'youtube', 'vimeo'], message: '' }))

    const source = await context.app.inject({ method: 'POST', url: `/api/?p=${passwordToken}`, headers: { 'content-type': 'text/plain' }, payload: `${queryToken}-,${security.encryptApiSalt()}` })
    const sourceBody = security.decryptResponseStrict(source.body, password)
    expect(JSON.parse(sourceBody ?? '{}')).toEqual(expect.objectContaining({ status: 'ok', title: 'Database movie' }))
    expect(context.resolver).toHaveBeenCalledWith(expect.objectContaining({ host: 'direct', title: 'Database movie', alternatives: [{ host: 'youtube', id: 'fallback-one' }, { host: 'vimeo', id: '1234' }] }), expect.any(Object))
  })
})

function detailFromWrite(id: string, value: VideoCreateWrite, alternatives: VideoCreateWrite['alternatives'], subtitles: VideoCreateWrite['subtitles']): StoredVideoDetail {
  return Object.freeze({
    id,
    title: value.title,
    host: value.host,
    hostId: value.hostId,
    userId: value.userId,
    userName: value.userId === '1' ? 'Admin' : 'Member',
    slug: value.slug,
    status: value.status,
    dmca: value.dmca,
    views: value.views,
    poster: value.poster,
    created: value.created,
    updated: value.updated,
    hasAlternatives: alternatives.length > 0,
    hasSubtitles: subtitles.length > 0,
    alternatives: Object.freeze(alternatives.map((item, index) => Object.freeze({ id: String(100 + index), ...item }))),
    subtitles: Object.freeze(subtitles.map((item, index) => Object.freeze({ id: String(200 + index), link: item.link, language: item.language, order: item.order })))
  })
}

function csrfFor(body: string, action: string): string {
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const value = body.match(new RegExp(`<form[^>]+action="${escaped}"[\\s\\S]*?name="csrf" value="([^"]+)"`))?.[1]
  if (value === undefined) throw new Error(`CSRF token not found for ${action}`)
  return value
}

function multipartBody(
  fields: Readonly<Record<string, string>>,
  files: readonly Readonly<{ field: string; filename: string; type: string; content: Buffer }>[]
): Readonly<{ boundary: string; payload: Buffer }> {
  const boundary = '----gplayer-video-test-boundary'
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`))
    chunks.push(file.content)
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Object.freeze({ boundary, payload: Buffer.concat(chunks) })
}
