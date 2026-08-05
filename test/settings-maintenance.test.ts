import os from 'node:os'
import path from 'node:path'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { loadConfig } from '../src/config.js'
import { SettingsAdminService, type SettingEntry, type SettingsAdminStore } from '../src/settings/settings-admin-service.js'
import { FileSystemSettingsMaintenanceFiles } from '../src/settings/settings-maintenance-files.js'
import { MySqlSettingsMaintenanceStore } from '../src/settings/mysql-settings-maintenance-store.js'
import {
  DEFAULT_BYPASS_HOSTS,
  RuntimeNodeDependencyStatus,
  SettingsMaintenanceService,
  type NodeDependencyStatus,
  type SettingsMaintenanceFiles,
  type SettingsMaintenanceStore
} from '../src/settings/settings-maintenance-service.js'

const token = 'settings-maintenance-token-123456'
const userAgent = 'GPlayer settings maintenance test'
const admin: AuthUser = Object.freeze({ id: 1, username: 'admin', email: 'admin@gplayer.local', name: 'Admin', role: 0, status: 1, created: 0, updated: 0 })

class MemoryMaintenanceStore implements SettingsMaintenanceStore {
  public clearAllCalls = 0
  public loadBalancerIds: string[] = []
  public blacklists: string[][] = []
  public settings = new Map<string, string>()

  public async clearAllSourceCaches() {
    this.clearAllCalls += 1
    return Object.freeze({ temporarySourcesCleared: true, videoSourcesCleared: true })
  }
  public async clearLoadBalancerSources(id: string): Promise<boolean> { this.loadBalancerIds.push(id); return true }
  public async disableBlacklistedVideos(prefixes: readonly string[]): Promise<boolean> { this.blacklists.push([...prefixes]); return true }
  public async loadSetting(key: 'node_hide_ext_dialog_until'): Promise<string | null> { return this.settings.get(key) ?? null }
  public async saveSetting(key: 'bypass_host' | 'gdplayer_license' | 'node_hide_ext_dialog_until', value: string): Promise<boolean> { this.settings.set(key, value); return true }
}

class MemoryMaintenanceFiles implements SettingsMaintenanceFiles {
  public all = 0
  public temporary = 0
  public videoCache = 0
  public videoFiles = 0
  public async clearAll(): Promise<boolean> { this.all += 1; return true }
  public async clearSettingsTemporary(): Promise<boolean> { this.temporary += 1; return true }
  public async clearVideoCache(): Promise<boolean> { this.videoCache += 1; return true }
  public async clearVideoFiles() { this.videoFiles += 1; return Object.freeze({ imageFilesCleared: true, subtitleFilesCleared: true, cacheFilesCleared: true }) }
}

const dependencies: NodeDependencyStatus = {
  inspect: async () => Object.freeze({ node: 'v24.7.0', php: false, chrome: false })
}

function service(
  store = new MemoryMaintenanceStore(),
  files = new MemoryMaintenanceFiles(),
  blacklist = 'Forbidden\r\nBlocked\nforbidden'
): SettingsMaintenanceService {
  return new SettingsMaintenanceService(store, files, dependencies, {
    clearRuntimeCache: () => true,
    loadBlacklist: () => blacklist,
    supportedHosts: new Set(DEFAULT_BYPASS_HOSTS),
    now: () => 1_000
  })
}

describe('settings maintenance service', () => {
  it('reproduces the five scoped cache result contracts', async () => {
    const store = new MemoryMaintenanceStore()
    const files = new MemoryMaintenanceFiles()
    const runtime = service(store, files)
    await expect(runtime.action('clearAllCache', {})).resolves.toEqual({
      status: 'ok', message: 'The cache has been cleared successfully', result: {
        kill_background_process: true,
        clear_tmp_video_sources: true,
        clear_video_sources: true,
        clear_cache_files: true,
        clear_cache_driver: true
      }
    })
    await expect(runtime.action('clearSettingsCache', {})).resolves.toEqual({
      status: 'ok', message: 'The cache has been cleared successfully', result: { clear_settings: true, clear_tmp_files: true }
    })
    await expect(runtime.action('clearVideosCache', {})).resolves.toEqual({
      status: 'ok', message: 'The cache has been cleared successfully', result: {
        kill_background_process: true,
        clear_tmp_video_sources: true,
        clear_video_sources: true,
        clear_video_player: true,
        clear_cache_files: true
      }
    })
    await expect(runtime.action('clearVideosFiles', {})).resolves.toEqual({
      status: 'ok', message: 'The cache has been cleared successfully', result: {
        kill_background_process: true,
        clear_images_files: true,
        clear_subtitles_files: true,
        clear_cache_files: true
      }
    })
    await expect(runtime.action('clearLoadBalancer', {})).resolves.toEqual({ status: 'fail', message: 'The cache failed to clear', result: null })
    await expect(runtime.action('clearLoadBalancer', { id: '17' })).resolves.toEqual({
      status: 'ok', message: 'The cache has been cleared successfully', result: { kill_background_process: true, clear_video_sources: true }
    })
    expect(store.clearAllCalls).toBe(2)
    expect(store.loadBalancerIds).toEqual(['17'])
    expect(files).toEqual(expect.objectContaining({ all: 1, temporary: 1, videoCache: 1, videoFiles: 1 }))
  })

  it('normalizes title prefixes, restores supported defaults, and keeps licenses write-only', async () => {
    const store = new MemoryMaintenanceStore()
    const runtime = service(store)
    await expect(runtime.action('disableBlacklistedVideos', {})).resolves.toEqual({ status: 'ok', message: 'The blacklisted videos have been successfully deactivated', result: null })
    expect(store.blacklists).toEqual([['forbidden', 'blocked']])

    const reset = await runtime.action('resetHosts', {})
    expect(reset).toEqual({ status: 'ok', message: 'The bypassed hosts have been successfully reset', result: DEFAULT_BYPASS_HOSTS })
    expect(JSON.parse(store.settings.get('bypass_host') ?? '')).toEqual(DEFAULT_BYPASS_HOSTS)

    const secret = 'private-license-value'
    const saved = await runtime.action('saveLicense', { gdplayer_license: secret })
    expect(saved).toEqual({ status: 'ok', message: 'The legacy license value has been successfully saved', result: null })
    expect(JSON.stringify(saved)).not.toContain(secret)
    expect(store.settings.get('gdplayer_license')).toBe(secret)
    await expect(runtime.action('saveLicense', { gdplayer_license: ' ' })).resolves.toEqual({ status: 'fail', message: 'The legacy license value failed to save', result: null })
  })

  it('reports Node-native dependencies and retains the 30-day dialog preference', async () => {
    const runtime = service()
    await expect(runtime.action('getDependencies', {})).resolves.toEqual({
      status: 'ok', message: 'Node.js runtime dependencies are available', result: { node: 'v24.7.0', php: false, chrome: false }
    })
    await expect(runtime.extensionDialogHidden()).resolves.toBe(false)
    await expect(runtime.action('hideExtDialog', {})).resolves.toEqual({ status: 'ok', message: 'Node.js runtime dependencies are available', result: null })
    await expect(runtime.extensionDialogHidden()).resolves.toBe(true)
    await expect(service((() => { const store = new MemoryMaintenanceStore(); store.settings.set('node_hide_ext_dialog_until', String(2_000)); return store })()).extensionDialogHidden()).resolves.toBe(true)
    await expect(new RuntimeNodeDependencyStatus([]).inspect()).resolves.toEqual(expect.objectContaining({ node: process.version, php: false, ioncube: false, shell_exec: false, chrome: false }))
  })
})

describe('MySqlSettingsMaintenanceStore', () => {
  it('parameterizes identifiers, blacklist prefixes, identities, and compatibility settings', async () => {
    const execute = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.startsWith('SELECT')) return [{ host: 'youtube', host_id: 'video-id' }]
      return { affectedRows: 1 }
    })
    const write = vi.fn(async () => ({ affectedRows: 1 }))
    const read = vi.fn(async () => [{ value: '1234' }])
    const database = {
      read,
      write,
      transaction: async <T>(work: (transaction: { execute: typeof execute }) => Promise<T>): Promise<T> => await work({ execute })
    }
    const store = new MySqlSettingsMaintenanceStore(database as never)
    await expect(store.clearAllSourceCaches()).resolves.toEqual({ temporarySourcesCleared: true, videoSourcesCleared: true })
    await store.clearLoadBalancerSources('9')
    await store.disableBlacklistedVideos(['blocked', '100%'])
    await store.saveSetting('bypass_host', '["youtube"]')
    await expect(store.loadSetting('node_hide_ext_dialog_until')).resolves.toBe('1234')

    expect(execute).toHaveBeenCalledWith('DELETE FROM `tmp_videos_sources`')
    expect(execute).toHaveBeenCalledWith('DELETE FROM `tb_videos_sources`')
    expect(write).toHaveBeenCalledWith('DELETE FROM `tb_videos_sources` WHERE `sid` = ?', ['9'])
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE `tb_videos`'), [1, 1, 'blocked%', '100=%%'])
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('SELECT `host`, `host_id`'), ['blocked%', '100=%%'])
    expect(execute).toHaveBeenCalledWith('DELETE FROM `tb_videos_sources` WHERE `host` = ? AND `host_id` = ?', ['youtube', 'video-id'])
    expect(write).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO `tb_settings`'), ['bypass_host', '["youtube"]'])
    expect(read).toHaveBeenCalledWith(expect.stringContaining('WHERE `key` = ?'), ['node_hide_ext_dialog_until'])
    expect(execute.mock.calls.every(([sql]) => !String(sql).includes('blocked') && !String(sql).includes('video-id'))).toBe(true)
  })
})

describe('filesystem settings maintenance', () => {
  const roots: string[] = []
  afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))))

  it('clears and recreates only the explicit temporary, cache, and upload-temp directories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gplayer-settings-maintenance-'))
    roots.push(root)
    const temporaryRoot = path.join(root, 'runtime-tmp')
    const cacheRoot = path.join(root, 'runtime-cache')
    const uploadsRoot = path.join(root, 'public', 'uploads')
    const survivor = path.join(root, 'survivor.txt')
    const permanentUpload = path.join(uploadsRoot, 'images', 'poster.jpg')
    await Promise.all([
      mkdir(temporaryRoot, { recursive: true }),
      mkdir(path.join(cacheRoot, 'files'), { recursive: true }),
      mkdir(path.dirname(permanentUpload), { recursive: true }),
      mkdir(path.join(uploadsRoot, 'images', 'tmp'), { recursive: true }),
      mkdir(path.join(uploadsRoot, 'subtitles', 'tmp'), { recursive: true })
    ])
    await Promise.all([
      writeFile(path.join(temporaryRoot, 'runtime.log'), 'temp'),
      writeFile(path.join(cacheRoot, 'files', 'video.mp4'), 'cache'),
      writeFile(path.join(uploadsRoot, 'images', 'tmp', 'image.tmp'), 'temp'),
      writeFile(path.join(uploadsRoot, 'subtitles', 'tmp', 'caption.tmp'), 'temp'),
      writeFile(permanentUpload, 'keep'),
      writeFile(survivor, 'keep')
    ])
    const files = new FileSystemSettingsMaintenanceFiles({ temporaryRoot, cacheRoot, uploadsRoot })
    await files.clearAll()
    await expect(readdir(temporaryRoot)).resolves.toEqual([])
    await expect(readdir(cacheRoot)).resolves.toEqual([])
    await expect(readdir(path.join(uploadsRoot, 'images', 'tmp'))).resolves.toEqual([])
    await expect(readdir(path.join(uploadsRoot, 'subtitles', 'tmp'))).resolves.toEqual([])
    await expect(readFile(permanentUpload, 'utf8')).resolves.toBe('keep')
    await expect(readFile(survivor, 'utf8')).resolves.toBe('keep')
    await expect(access(path.join(root, 'outside'))).rejects.toThrow()
  })

  it('rejects filesystem roots and child paths that are too broad', () => {
    expect(() => new FileSystemSettingsMaintenanceFiles({ temporaryRoot: path.parse(process.cwd()).root, cacheRoot: '/safe/cache', uploadsRoot: '/safe/uploads' })).toThrow('too broad')
  })
})

class MemorySettingsStore implements SettingsAdminStore {
  public readonly values: Record<string, string> = {}
  public async getAll() { return Object.freeze({ ...this.values }) }
  public async upsertMany(entries: readonly SettingEntry[]) { for (const entry of entries) this.values[entry.key] = entry.value }
  public async deleteAll() { return 0 }
}

class RouteAuthStore implements AuthStore {
  public constructor(private readonly user: AuthUser | null = admin) {}
  public async findUserByIdentifier(): Promise<StoredAuthUser | null> { return null }
  public async createSession(_session: SessionWrite): Promise<void> {}
  public async recordFailedLogin(_session: Omit<SessionWrite, 'expires' | 'state'>): Promise<void> {}
  public async findActiveSession(requestedToken: string, requestedUserAgent: string): Promise<AuthUser | null> { return requestedToken === token && requestedUserAgent === userAgent ? this.user : null }
  public async revokeSession(): Promise<boolean> { return true }
}

describe('settings maintenance routes', () => {
  let app: FastifyInstance | undefined
  afterEach(async () => { await app?.close(); app = undefined })
  const headers = Object.freeze({ cookie: `${AUTH_COOKIE_NAME}=${token}`, 'user-agent': userAgent })

  async function createApp(runtime: SettingsMaintenanceService, user: AuthUser | null = admin): Promise<FastifyInstance> {
    return await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: '1234567890123456' }), {
      auth: new AuthService(new RouteAuthStore(user)),
      settings: new SettingsAdminService(new MemorySettingsStore()),
      settingsMaintenance: runtime
    })
  }

  it('renders signed maintenance controls and executes the selected action', async () => {
    const store = new MemoryMaintenanceStore()
    app = await createApp(service(store))
    const page = await app.inject({ method: 'GET', url: '/administrator/settings/reset/', headers })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Runtime cleanup')
    expect(page.body).toContain('value="clearAllCache"')
    expect(page.body).not.toContain(token)
    const form = page.body.match(/<form class="settings-maintenance-card"[\s\S]*?<\/form>/)?.[0] ?? ''
    const csrf = form.match(/name="csrf" value="([^"]+)"/)?.[1] ?? ''
    const action = form.match(/name="action" value="([^"]+)"/)?.[1] ?? ''
    const result = await app.inject({
      method: 'POST',
      url: '/administrator/settings/reset/maintenance/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ csrf, action }).toString()
    })
    expect(result.statusCode).toBe(303)
    expect(result.headers.location).toBe(`/administrator/settings/reset/?maintenance=${action}&status=ok#runtime-maintenance`)
  })

  it('preserves the legacy AJAX actions while enforcing admin and same-origin access', async () => {
    const store = new MemoryMaintenanceStore()
    app = await createApp(service(store))
    const dependenciesResponse = await app.inject({
      method: 'POST', url: '/administrator/ajax/settings/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=getDependencies'
    })
    expect(dependenciesResponse.statusCode).toBe(200)
    expect(dependenciesResponse.json()).toEqual({ status: 'ok', message: 'Node.js runtime dependencies are available', result: { node: 'v24.7.0', php: false, chrome: false } })

    const license = await app.inject({
      method: 'POST', url: '/administrator/ajax/settings/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=saveLicense&gdplayer_license=private-value'
    })
    expect(license.json()).toEqual({ status: 'ok', message: 'The legacy license value has been successfully saved' })
    expect(license.body).not.toContain('private-value')

    const crossOrigin = await app.inject({
      method: 'POST', url: '/administrator/ajax/settings/',
      headers: { ...headers, origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=clearAllCache'
    })
    expect(crossOrigin.statusCode).toBe(403)
    expect(store.clearAllCalls).toBe(0)

    await app.close()
    app = await createApp(service(), { ...admin, role: 1 })
    const member = await app.inject({
      method: 'POST', url: '/administrator/ajax/settings/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=clearAllCache'
    })
    expect(member.statusCode).toBe(302)
  })
})
