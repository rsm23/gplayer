import path from 'node:path'
import os from 'node:os'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { mediaCachePaths } from '../src/background/media-cache-path.js'
import { loadConfig } from '../src/config.js'
import { FileSystemPrivateCacheManager, type PrivateCacheManager } from '../src/system/private-cache-manager.js'
import {
  PrivateAdminService,
  type PrivateAdminStore,
  type PrivateCacheIdentity,
  type PrivateLoadBalancerCacheClear,
  type PrivateVideoCacheClear
} from '../src/system/private-admin-service.js'
import { MySqlPrivateAdminStore } from '../src/system/mysql-private-admin-store.js'
import { NodeSystemInspector, type SystemInspector, type SystemServicesStatus, type UsageStatus } from '../src/system/system-inspector.js'

const token = 'private-admin-token-1234567890'
const userAgent = 'GPlayer private administration test'
const admin: AuthUser = Object.freeze({ id: 1, username: 'admin', email: 'admin@gplayer.local', name: 'Admin', role: 0, status: 1, created: 0, updated: 0 })
const member: AuthUser = Object.freeze({ ...admin, id: 2, username: 'member', role: 1 })
const identities = Object.freeze([
  Object.freeze({ host: 'youtube', hostId: 'primary-id' }),
  Object.freeze({ host: 'vimeo', hostId: 'alternative-id' })
])

class RouteAuthStore implements AuthStore {
  public constructor(private readonly user: AuthUser | null) {}
  public async findUserByIdentifier(): Promise<StoredAuthUser | null> { return null }
  public async createSession(_session: SessionWrite): Promise<void> {}
  public async recordFailedLogin(_session: Omit<SessionWrite, 'expires' | 'state'>): Promise<void> {}
  public async findActiveSession(requestedToken: string, requestedUserAgent: string): Promise<AuthUser | null> { return requestedToken === token && requestedUserAgent === userAgent ? this.user : null }
  public async revokeSession(): Promise<boolean> { return true }
}

class MemoryPrivateStore implements PrivateAdminStore {
  public readonly videoIds: string[] = []
  public readonly links: string[] = []

  public async clearVideoSources(id: string): Promise<PrivateVideoCacheClear> {
    this.videoIds.push(id)
    return id === '404'
      ? Object.freeze({ found: false, identities: Object.freeze([]), primarySourcesCleared: false, alternativeSourcesCleared: false })
      : Object.freeze({ found: true, identities, primarySourcesCleared: true, alternativeSourcesCleared: true })
  }

  public async clearLoadBalancerSources(link: string): Promise<PrivateLoadBalancerCacheClear> {
    this.links.push(link)
    return Object.freeze({ found: true, sourcesCleared: true })
  }
}

class MemoryCacheManager implements PrivateCacheManager {
  public readonly videos: Array<readonly PrivateCacheIdentity[]> = []
  public loadBalancerClears = 0
  public async clearVideos(value: readonly PrivateCacheIdentity[]): Promise<boolean> { this.videos.push(value); return true }
  public async clearLoadBalancerFiles(): Promise<boolean> { this.loadBalancerClears += 1; return true }
}

const ram = Object.freeze({ total: 1_000, used: 600, free: 400, percent: 60 })
const disk = Object.freeze({ total: 2_000, used: 500, free: 1_500, percent: 25 })
const services: SystemServicesStatus = Object.freeze({
  php: Object.freeze({ status: false, name: 'PHP', version: 'Not used' }),
  node: Object.freeze({ status: true, name: 'Node.js', version: '24.7.0' })
})

function memoryInspector() {
  return {
    operatingSystem: vi.fn(async () => Object.freeze({ cpu: 12.5, os: 'Test Linux', uptime: 9_000 })),
    ramUsage: vi.fn(async () => ram),
    diskUsage: vi.fn(async () => disk),
    services: vi.fn(async () => services)
  } satisfies SystemInspector
}

function service(
  store = new MemoryPrivateStore(),
  cache = new MemoryCacheManager(),
  inspector: SystemInspector = memoryInspector(),
  mainSite = new URL('https://main.example/')
): PrivateAdminService {
  return new PrivateAdminService(store, inspector, cache, {
    baseUrl: new URL('https://player.example/'),
    loadMainSite: async () => mainSite,
    clearRuntimeCache: () => true,
    now: () => 10_000,
    cacheTtl: 30_000
  })
}

describe('Node system inspector', () => {
  it('reports normalized resource usage and exposes Node without executing or claiming PHP', async () => {
    const inspector = new NodeSystemInspector('/unused', {
      loadAverage: () => [2, 1, 0.5],
      cpuCount: () => 4,
      uptime: () => 9_001,
      totalMemory: () => 1_000,
      freeMemory: () => 250,
      operatingSystem: async () => 'Fixture OS',
      diskUsage: async () => disk,
      processNames: async () => new Set(['nginx', 'redis-server']),
      nodeVersion: '24.7.0',
      opensslVersion: '3.5.2',
      brotliVersion: '1.1.0',
      heapLimit: () => 2_147_483_648
    })
    await expect(inspector.operatingSystem()).resolves.toEqual({ cpu: 50, os: 'Fixture OS', uptime: 9_001 })
    await expect(inspector.ramUsage()).resolves.toEqual({ total: 1_000, used: 750, free: 250, percent: 75 })
    const result = await inspector.services()
    expect(result.nginx?.status).toBe(true)
    expect(result.redis?.status).toBe(true)
    expect(result.php).toEqual(expect.objectContaining({ status: false, version: 'Not used', sapi: 'Node.js' }))
    expect(result.node).toEqual(expect.objectContaining({ status: true, version: '24.7.0', limit: '2 GiB' }))
    expect(result.node?.curl).toEqual({ version: 'Node.js fetch', ssl_version: 'OpenSSL/3.5.2', brotli: '1.1.0' })
  })
})

describe('private administration service', () => {
  it('preserves all four server-status group shapes and caches repeated group reads', async () => {
    const inspector = memoryInspector()
    const runtime = service(new MemoryPrivateStore(), new MemoryCacheManager(), inspector)
    await expect(runtime.serverStatus('1')).resolves.toEqual({ cpu: 12.5, os: 'Test Linux', uptime: 9_000 })
    await expect(runtime.serverStatus('2')).resolves.toEqual({ ram })
    await expect(runtime.serverStatus('3')).resolves.toEqual({ disk })
    await expect(runtime.serverStatus('4')).resolves.toEqual({ services })
    await expect(runtime.serverStatus('4')).resolves.toEqual({ services })
    await expect(runtime.serverStatus('9')).resolves.toEqual({})
    expect(inspector.services).toHaveBeenCalledTimes(1)
  })

  it('clears primary, alternative, runtime, and file caches while preserving legacy messages', async () => {
    const store = new MemoryPrivateStore()
    const cache = new MemoryCacheManager()
    const runtime = service(store, cache)
    await expect(runtime.clearVideoCache('')).resolves.toEqual({ status: 'fail', message: 'The cache failed to clear or does not exist', result: null })
    await expect(runtime.clearVideoCache('404')).resolves.toEqual({ status: 'ok', message: 'The cache has been cleared successfully', result: null })
    await expect(runtime.clearVideoCache('7')).resolves.toEqual({
      status: 'ok',
      message: 'The cache has been cleared successfully',
      result: { clear_video_sources: true, clear_video_player: true, clear_alternative_sources: true, clear_video_files: true }
    })
    expect(store.videoIds).toEqual(['404', '7'])
    expect(cache.videos).toEqual([identities])
  })

  it('limits whole-file-cache clearing to registered load-balancer instances', async () => {
    const mainStore = new MemoryPrivateStore()
    const mainCache = new MemoryCacheManager()
    await expect(service(mainStore, mainCache, memoryInspector(), new URL('https://player.example')).clearLoadBalancer()).resolves.toEqual({
      status: 'fail', message: 'The cache failed to clear or does not exist', result: {}
    })
    expect(mainStore.links).toEqual([])
    const edgeStore = new MemoryPrivateStore()
    const edgeCache = new MemoryCacheManager()
    await expect(service(edgeStore, edgeCache).clearLoadBalancer()).resolves.toEqual({
      status: 'ok', message: 'The cache has been cleared successfully', result: { clear_video_sources: true, clear_video_files: true }
    })
    expect(edgeStore.links).toEqual(['https://player.example/'])
    expect(edgeCache.loadBalancerClears).toBe(1)
  })
})

describe('MySqlPrivateAdminStore', () => {
  it('locks identities and parameterizes every source-cache deletion', async () => {
    const execute = vi.fn(async (sql: string, _values: readonly unknown[] = []) => {
      if (sql.includes('FROM `tb_videos`')) return [{ host: 'youtube', host_id: 'primary-id' }]
      if (sql.includes('FROM `tb_videos_alternatives`')) return [{ host: 'vimeo', host_id: 'alternative-id' }]
      if (sql.includes('FROM `tb_loadbalancers`')) return [{ id: '3' }]
      return { affectedRows: 1 }
    })
    const database = { transaction: async <T>(work: (transaction: { execute: typeof execute }) => Promise<T>): Promise<T> => await work({ execute }) }
    const store = new MySqlPrivateAdminStore(database as never)
    await expect(store.clearVideoSources('7')).resolves.toEqual({ found: true, identities, primarySourcesCleared: true, alternativeSourcesCleared: true })
    await expect(store.clearLoadBalancerSources('https://player.example/')).resolves.toEqual({ found: true, sourcesCleared: true })
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('WHERE `id` = ?'), ['7'])
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('WHERE `vid` = ?'), ['7'])
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('WHERE `host` = ? AND `host_id` = ?'), ['youtube', 'primary-id'])
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('WHERE `host` = ? AND `host_id` = ?'), ['vimeo', 'alternative-id'])
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('WHERE `link` = ?'), ['https://player.example/'])
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('WHERE `sid` = ?'), ['3'])
    expect(execute.mock.calls.every(([sql]) => !sql.includes('primary-id') && !sql.includes('player.example'))).toBe(true)
  })
})

describe('filesystem private cache manager', () => {
  const temporaryRoots: string[] = []
  afterEach(async () => await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))))

  it('deletes only derived video directories and recreates the explicit files root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gplayer-private-cache-'))
    temporaryRoots.push(root)
    const manager = new FileSystemPrivateCacheManager(root)
    const target = mediaCachePaths(root, 'youtube', 'primary-id', 'Original')
    await mkdir(target.directory, { recursive: true })
    await writeFile(target.complete, 'cached')
    await manager.clearVideos([identities[0] as PrivateCacheIdentity])
    await expect(access(target.directory)).rejects.toThrow()

    const survivor = path.join(root, 'outside-files.txt')
    await writeFile(survivor, 'keep')
    await mkdir(path.join(root, 'files', 'nested'), { recursive: true })
    await writeFile(path.join(root, 'files', 'nested', 'cache.bin'), 'cached')
    await manager.clearLoadBalancerFiles()
    await expect(readdir(path.join(root, 'files'))).resolves.toEqual([])
    await expect(access(survivor)).resolves.toBeUndefined()
  })
})

describe('private administration routes', () => {
  let app: FastifyInstance | undefined
  const headers = Object.freeze({ cookie: `${AUTH_COOKIE_NAME}=${token}`, 'user-agent': userAgent })
  afterEach(async () => { await app?.close(); app = undefined })

  async function createApp(user: AuthUser): Promise<{ app: FastifyInstance; store: MemoryPrivateStore; cache: MemoryCacheManager }> {
    const store = new MemoryPrivateStore()
    const cache = new MemoryCacheManager()
    const privateAdmin = service(store, cache)
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: '1234567890123456' }), {
      auth: new AuthService(new RouteAuthStore(user)),
      privateAdmin
    })
    return { app, store, cache }
  }

  it('serves legacy status envelopes and renders the Node-only dashboard monitor for admins', async () => {
    const runtime = await createApp(admin)
    app = runtime.app
    const response = await app.inject({ method: 'GET', url: '/administrator/ajax/private/?action=serverStatus&group=2', headers })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok', message: '', result: { ram } })
    const page = await app.inject({ method: 'GET', url: '/administrator/dashboard/', headers })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('System status')
    expect(page.body).toContain('Node.js 24.7.0')
    expect(page.body).toContain('PHP not used')
  })

  it('requires an active administrator and POST plus same origin for destructive actions', async () => {
    const runtime = await createApp(admin)
    app = runtime.app
    const getMutation = await app.inject({ method: 'GET', url: '/administrator/ajax/private/?action=clearVideoCache&id=7', headers })
    expect(getMutation.statusCode).toBe(405)
    expect(runtime.store.videoIds).toEqual([])
    const foreign = await app.inject({ method: 'POST', url: '/administrator/ajax/private/', headers: { ...headers, origin: 'https://foreign.example' }, payload: { action: 'clearVideoCache', id: '7' } })
    expect(foreign.statusCode).toBe(403)
    expect(runtime.store.videoIds).toEqual([])
    const valid = await app.inject({ method: 'POST', url: '/administrator/ajax/private/', headers: { ...headers, origin: 'https://player.example' }, payload: { action: 'clearVideoCache', id: '7' } })
    expect(valid.statusCode).toBe(200)
    expect(valid.json()).toEqual(expect.objectContaining({ status: 'ok', message: 'The cache has been cleared successfully' }))
    expect(runtime.store.videoIds).toEqual(['7'])

    await app.close()
    app = undefined
    const memberRuntime = await createApp(member)
    app = memberRuntime.app
    const denied = await app.inject({ method: 'GET', url: '/administrator/ajax/private/?action=serverStatus&group=1', headers })
    expect(denied.json()).toEqual({ status: 'fail', message: 'You are not authorized to access this feature', result: null })
  })
})
