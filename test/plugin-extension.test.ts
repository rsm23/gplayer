import path from 'node:path'
import { createHmac } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { loadConfig } from '../src/config.js'
import { PluginAdminService, type PluginAdminRecord, type PluginAdminStore, type PluginListQuery, type PluginWrite } from '../src/plugins/plugin-admin-service.js'
import { parsePluginManifest } from '../src/plugins/plugin-archive.js'
import { PluginExtensionRuntime } from '../src/plugins/plugin-extension-runtime.js'
import type { PluginRecord } from '../src/plugins/plugin-maintenance-worker.js'
import { SettingsAdminService } from '../src/settings/settings-admin-service.js'

const secureSalt = '1234567890123456'
const token = 'plugin-extension-token-1234567890'
const userAgent = 'GPlayer plugin extension test'
const admin: AuthUser = Object.freeze({ id: 1, username: 'admin', email: 'admin@gplayer.local', name: 'Admin', role: 0, status: 1, created: 1, updated: 1 })

class MemoryStore implements PluginAdminStore {
  public plugins: PluginAdminRecord[] = []
  public async listPlugins(query: PluginListQuery) { return { data: this.plugins.slice(query.start, query.start + query.length), recordsTotal: this.plugins.length, recordsFiltered: this.plugins.length } }
  public async listPluginRecords(): Promise<readonly PluginRecord[]> { return this.plugins.map((plugin) => ({ id: plugin.id, name: plugin.name, folder: plugin.folder, active: plugin.status === 1 })) }
  public async getPlugin(id: string): Promise<PluginAdminRecord | null> { return this.plugins.find((plugin) => plugin.id === id) ?? null }
  public async findPlugin(name: string, folder: string): Promise<PluginAdminRecord | null> { return this.plugins.find((plugin) => plugin.name === name && plugin.folder === folder) ?? null }
  public async createPlugin(value: PluginWrite): Promise<string> { const id = String(this.plugins.length + 1); this.plugins.push(record(id, value)); return id }
  public async updatePlugin(id: string, value: PluginWrite): Promise<boolean> { const index = this.plugins.findIndex((plugin) => plugin.id === id); if (index < 0) return false; this.plugins[index] = record(id, value); return true }
  public async updateStatus(id: string, status: number, updated: number): Promise<boolean> { const plugin = await this.getPlugin(id); if (plugin === null) return false; return await this.updatePlugin(id, { ...plugin, status, updated }) }
  public async deletePlugin(id: string): Promise<boolean> { const index = this.plugins.findIndex((plugin) => plugin.id === id); if (index < 0) return false; this.plugins.splice(index, 1); return true }
}

class RouteAuthStore implements AuthStore {
  public async findUserByIdentifier(): Promise<StoredAuthUser | null> { return null }
  public async createSession(_session: SessionWrite): Promise<void> {}
  public async recordFailedLogin(_session: Omit<SessionWrite, 'expires' | 'state'>): Promise<void> {}
  public async findActiveSession(requestedToken: string, requestedUserAgent: string): Promise<AuthUser | null> { return requestedToken === token && requestedUserAgent === userAgent ? admin : null }
  public async revokeSession(): Promise<boolean> { return true }
}

describe('Node plugin extension runtime', () => {
  let root = ''
  afterEach(async () => { if (root !== '') await rm(root, { recursive: true, force: true }); root = '' })

  it('normalizes legacy overrides, hooks, widgets, priority, and declarative configuration fields', () => {
    const manifest = parsePluginManifest(Buffer.from(JSON.stringify({
      name: 'Extension', folder: 'extension', version: '1', priority: '8',
      overrides: { frontend: { index: 'views/frontend/home.html', '../bad': '../bad' }, backend: { dashboard: 'views/backend/dashboard.mjs' } },
      hooks: { 'video.save': [{ file: 'hooks/save.mjs', priority: 20 }], 'api.response.filter': { file: 'hooks/filter.php' } },
      widgets: { 'backend.dashboard.bottom': [{ template: 'widgets/status.html', priority: -2, admin_only: true }] },
      config_fields: [{ name: 'endpoint', label: 'Endpoint', type: 'url', required: true }, { name: 'mode', type: 'select', options: [{ value: 'safe', label: 'Safe' }] }]
    })))
    expect(manifest.priority).toBe(8)
    expect(manifest.overrides.frontend).toEqual({ index: 'views/frontend/home.html' })
    expect(manifest.hooks['video.save']).toEqual([{ file: 'hooks/save.mjs', priority: 20 }])
    expect(manifest.widgets['backend.dashboard.bottom']).toEqual([{ file: 'widgets/status.html', priority: -2, adminOnly: true }])
    expect(manifest.configFields).toEqual([expect.objectContaining({ name: 'endpoint', type: 'url', required: true }), expect.objectContaining({ name: 'mode', type: 'select', options: [{ value: 'safe', label: 'Safe' }] })])
  })

  it('selects the highest-priority override, dispatches conventional pages, and never executes PHP', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-extension-pages-'))
    const store = new MemoryStore()
    await installFixture(root, store, 'low', 1, { priority: 1, overrides: { frontend: { index: 'views/frontend/override.html' } } }, { 'views/frontend/override.html': 'low' })
    await installFixture(root, store, 'high', 2, { priority: 10, overrides: { frontend: { index: 'views/frontend/override.html' } } }, {
      'views/frontend/override.html': '<h1>high {{config.label}}</h1>',
      'views/frontend/report.mjs': 'export function render({ config }) { return { status: 201, body: `<p>${config.label}</p>`, headers: { "cache-control": "private" } } }',
      'views/backend/legacy.php': '<?php throw new Exception("must never run");'
    }, { label: 'priority' })
    const runtime = new PluginExtensionRuntime(store, root)
    await expect(runtime.overridePage('index', false, {})).resolves.toEqual(expect.objectContaining({ status: 200, body: '<h1>high priority</h1>', plugin: 'high' }))
    await expect(runtime.pluginPage('high', 'report', false, {})).resolves.toEqual(expect.objectContaining({ status: 201, body: '<p>priority</p>', headers: { 'cache-control': 'private' } }))
    await expect(runtime.pluginPage('high', 'legacy', true, {})).resolves.toEqual(expect.objectContaining({ status: 501, unsupportedPhp: true }))
  })

  it('runs ordered Node hooks and filters in bounded workers and isolates PHP entries', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-extension-hooks-'))
    const store = new MemoryStore()
    await installFixture(root, store, 'hooks', 1, {
      hooks: {
        'video.save': [{ file: 'hooks/late.mjs', priority: 20 }, { file: 'hooks/php.php', priority: 5 }, { file: 'hooks/early.mjs', priority: 10 }],
        'api.response.filter': [{ file: 'hooks/filter.mjs', priority: 0 }]
      }
    }, {
      'hooks/early.mjs': 'export default ({ data }) => ({ order: `${data.order ?? ""}early,`, early: true })',
      'hooks/late.mjs': 'export function handle({ data }) { return { order: `${data.order}late` } }',
      'hooks/filter.mjs': 'export function filter({ data }) { return { ...data, filtered: true } }',
      'hooks/php.php': '<?php file_put_contents("/tmp/forbidden", "bad");'
    })
    const runtime = new PluginExtensionRuntime(store, root)
    await expect(runtime.executeHook('video.save', { order: '' })).resolves.toEqual({ order: 'early,late', early: true })
    await expect(runtime.filterApiResponse({ sources: [1] }, { route: 'api' })).resolves.toEqual({ sources: [1], filtered: true })
  })

  it('terminates a non-returning request worker without suppressing the base hook data', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-extension-timeout-'))
    const store = new MemoryStore()
    await installFixture(root, store, 'timeout', 1, { hooks: { 'video.save': [{ file: 'hooks/wait.mjs' }] } }, { 'hooks/wait.mjs': 'export default async function () { await new Promise(() => {}) }' })
    const runtime = new PluginExtensionRuntime(store, root, { timeoutMs: 100 })
    const started = Date.now()
    await expect(runtime.executeHook('video.save', { retained: true })).resolves.toEqual({ retained: true })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('renders ordered static and Node widgets, honors admin_only, and rejects symlinked assets', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-extension-widgets-'))
    const store = new MemoryStore()
    await installFixture(root, store, 'widgets', 1, {
      widgets: { slot: [{ template: 'widgets/admin.html', priority: 20, admin_only: true }, { template: 'widgets/public.mjs', priority: 10 }] }
    }, {
      'widgets/admin.html': '<b>{{config.label}}</b>',
      'widgets/public.mjs': 'export function render({ data }) { return `<i>${data.slot}</i>` }',
      'assets/app.css': '.widget{}'
    }, { label: 'Admin' })
    const runtime = new PluginExtensionRuntime(store, root)
    await expect(runtime.renderWidgets('slot', false)).resolves.toBe('<i>slot</i>')
    await expect(runtime.renderWidgets('slot', true)).resolves.toBe('<i>slot</i><b>Admin</b>')
    await expect(runtime.asset('widgets', 'assets/app.css')).resolves.toEqual(expect.objectContaining({ type: 'text/css; charset=utf-8' }))
    await symlink('/etc/passwd', path.join(root, 'widgets/assets/leak.txt'))
    await expect(runtime.asset('widgets', 'assets/leak.txt')).resolves.toBeNull()
  })

  it('validates declared configuration while preserving secrets and undeclared state', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-extension-config-'))
    const store = new MemoryStore()
    await installFixture(root, store, 'config', 1, {
      config_fields: [
        { name: 'endpoint', label: 'Endpoint', type: 'url', required: true },
        { name: 'limit', label: 'Limit', type: 'number', min: 1, max: 10 },
        { name: 'secret', label: 'Secret', type: 'password' },
        { name: 'enabled', label: 'Enabled', type: 'checkbox' }
      ]
    }, {}, { endpoint: 'https://old.example/', limit: 2, secret: 'retained', internal: 'state' })
    const runtime = new PluginExtensionRuntime(store, root)
    await expect(runtime.saveConfiguration('1', { endpoint: 'file:///bad', limit: '99' })).resolves.toEqual(expect.objectContaining({ status: 'invalid', errors: { endpoint: expect.any(String), limit: expect.any(String) } }))
    await expect(runtime.saveConfiguration('1', { endpoint: 'https://new.example/base', limit: '5', secret: '', enabled: '1' }, 500)).resolves.toEqual({ status: 'ok', message: 'Plugin configuration saved successfully.' })
    expect(store.plugins[0]).toEqual(expect.objectContaining({ config: { endpoint: 'https://new.example/base', limit: 5, secret: 'retained', internal: 'state', enabled: true }, updated: 500 }))
  })
})

describe('plugin extension HTTP routes', () => {
  let root = ''
  let app: FastifyInstance | undefined
  const headers = Object.freeze({ cookie: `${AUTH_COOKIE_NAME}=${token}`, 'user-agent': userAgent, origin: 'https://player.example' })
  afterEach(async () => { await app?.close(); app = undefined; if (root !== '') await rm(root, { recursive: true, force: true }); root = '' })

  it('serves plugin pages and assets, injects widgets, and persists signed administrator configuration', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-extension-routes-'))
    const store = new MemoryStore()
    await installFixture(root, store, 'sample', 1, {
      overrides: { frontend: { changelog: 'views/frontend/changelog.html', e: 'views/frontend/player.html', watch: 'views/frontend/player.html' } },
      widgets: { 'backend.dashboard.bottom': [{ template: 'widgets/dashboard.html' }] },
      config_fields: [{ name: 'endpoint', label: 'Endpoint', type: 'url', required: true }]
    }, {
      'views/frontend/index.html': '<h1>Plugin page</h1><link rel="stylesheet" href="{{plugin_asset_base}}app.css">',
      'views/frontend/changelog.html': '<h1>Overridden changelog</h1>',
      'views/frontend/report.html': '<h1>Nested plugin report</h1>',
      'views/backend/report.html': '<h1>Nested admin plugin report</h1>',
      'views/frontend/player.html': '<h1>Must not override player controllers</h1>',
      'widgets/dashboard.html': '<aside data-plugin-widget>Widget</aside>',
      'assets/app.css': 'h1{color:red}'
    }, { endpoint: 'https://old.example/' })
    const runtime = new PluginExtensionRuntime(store, root)
    const adminService = new PluginAdminService(store, root, { reconcile: async () => ({ started: 0, stopped: 0, running: 0, unsupportedPhp: 0, invalid: 0 }) } as never)
    app = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: secureSalt }), {
      auth: new AuthService(new RouteAuthStore()),
      plugins: adminService,
      pluginExtensions: runtime,
      settings: new SettingsAdminService({ getAll: async () => ({ slug_embed: 'watch' }), upsertMany: async () => {} })
    })

    const page = await app.inject({ method: 'GET', url: '/p/sample/' })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Plugin page')
    expect(page.body).toContain('/plugins/sample/assets/app.css')
    const overridden = await app.inject({ method: 'GET', url: '/changelog/' })
    expect(overridden.body).toContain('Overridden changelog')
    const [dottedOverride, customOverride, nestedPage, nestedAdminPage] = await Promise.all([
      app.inject({ method: 'GET', url: '/changelog.php/ignored/path' }),
      app.inject({ method: 'GET', url: '/changelog.custom/ignored/path' }),
      app.inject({ method: 'GET', url: '/p/sample/report/ignored/path' }),
      app.inject({ method: 'GET', url: '/administrator/p/sample/report/ignored/path', headers })
    ])
    expect(dottedOverride.body).toContain('Overridden changelog')
    expect(customOverride.body).toContain('Overridden changelog')
    expect(nestedPage.body).toContain('Nested plugin report')
    expect(nestedAdminPage.body).toContain('Nested admin plugin report')
    const [builtInPlayer, configuredPlayer] = await Promise.all([
      app.inject({ method: 'GET', url: '/e.php/?invalid-player-token' }),
      app.inject({ method: 'GET', url: '/watch.custom/?invalid-player-token' })
    ])
    expect(builtInPlayer.statusCode).toBe(400)
    expect(configuredPlayer.statusCode).toBe(400)
    expect(builtInPlayer.body).not.toContain('Must not override player controllers')
    expect(configuredPlayer.body).not.toContain('Must not override player controllers')
    const asset = await app.inject({ method: 'GET', url: '/plugins/sample/assets/app.css' })
    expect(asset.headers['content-type']).toContain('text/css')
    expect(asset.body).toBe('h1{color:red}')
    const dashboard = await app.inject({ method: 'GET', url: '/administrator/dashboard/', headers })
    expect(dashboard.body).toContain('data-plugin-widget')

    const configPage = await app.inject({ method: 'GET', url: '/administrator/plugins/config/?id=1', headers })
    expect(configPage.statusCode).toBe(200)
    expect(configPage.body).toContain('Configure')
    expect(configPage.body).toContain('Endpoint')
    const csrf = createHmac('sha256', secureSalt).update(`plugin-page\0sample\0${token}`).digest('base64url')
    const saved = await app.inject({ method: 'POST', url: '/administrator/plugins/config/?id=1', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ id: '1', csrf, endpoint: 'https://new.example/' }).toString() })
    expect(saved.statusCode).toBe(303)
    expect(store.plugins[0]?.config.endpoint).toBe('https://new.example/')
    const rejected = await app.inject({ method: 'POST', url: '/administrator/plugins/config/?id=1', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ id: '1', csrf: 'bad', endpoint: 'https://evil.example/' }).toString() })
    expect(rejected.statusCode).toBe(403)
  })
})

async function installFixture(root: string, store: MemoryStore, folder: string, id: number, manifest: Readonly<Record<string, unknown>>, files: Readonly<Record<string, string>>, config: Readonly<Record<string, unknown>> = {}): Promise<void> {
  const directory = path.join(root, folder)
  await mkdir(directory, { recursive: true })
  const fullManifest = { name: folder, folder, version: '1.0.0', config, ...manifest }
  await writeFile(path.join(directory, 'plugin.json'), JSON.stringify(fullManifest))
  for (const [relative, content] of Object.entries(files)) { const target = path.join(directory, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content) }
  store.plugins.push(Object.freeze({ id: String(id), name: folder, folder: `plugins/${folder}/`, config: Object.freeze({ ...config }), status: 1, created: 100, updated: 100 }))
}

function record(id: string, value: PluginWrite): PluginAdminRecord { return Object.freeze({ id, name: value.name, folder: value.folder, config: Object.freeze({ ...value.config }), status: value.status, created: value.created, updated: value.updated }) }
