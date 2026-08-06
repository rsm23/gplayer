import path from 'node:path'
import { createHmac } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { loadConfig } from '../src/config.js'
import { PluginAdminService, pluginId, pluginListQuery, type PluginAdminRecord, type PluginAdminStore, type PluginListQuery, type PluginWrite } from '../src/plugins/plugin-admin-service.js'
import { PluginArchive } from '../src/plugins/plugin-archive.js'
import { MySqlPluginAdminStore } from '../src/plugins/mysql-plugin-admin-store.js'
import type { PluginRecord } from '../src/plugins/plugin-maintenance-worker.js'

const token = 'plugin-admin-token-1234567890'
const userAgent = 'GPlayer plugin admin test'
const secureSalt = '1234567890123456'
const admin: AuthUser = Object.freeze({ id: 1, username: 'admin', email: 'admin@gplayer.local', name: 'Admin', role: 0, status: 1, created: 1_600_000_000, updated: 1_600_000_000 })

class RouteAuthStore implements AuthStore {
  public async findUserByIdentifier(): Promise<StoredAuthUser | null> { return null }
  public async createSession(_session: SessionWrite): Promise<void> {}
  public async recordFailedLogin(_session: Omit<SessionWrite, 'expires' | 'state'>): Promise<void> {}
  public async findActiveSession(requestedToken: string, requestedUserAgent: string): Promise<AuthUser | null> { return requestedToken === token && requestedUserAgent === userAgent ? admin : null }
  public async revokeSession(): Promise<boolean> { return true }
}

class MemoryPluginStore implements PluginAdminStore {
  public readonly plugins: PluginAdminRecord[] = []
  public readonly queries: PluginListQuery[] = []
  public readonly writes: Array<PluginWrite & { id: string }> = []
  public failDelete = false
  public async listPlugins(query: PluginListQuery) { this.queries.push(query); const filtered = this.plugins.filter((item) => query.search === '' || item.name.toLowerCase().startsWith(query.search.toLowerCase())); return { data: filtered.slice(query.start, query.start + query.length), recordsTotal: this.plugins.length, recordsFiltered: filtered.length } }
  public async listPluginRecords(): Promise<readonly PluginRecord[]> { return this.plugins.map((item) => ({ id: item.id, name: item.name, folder: item.folder, active: item.status === 1 })) }
  public async getPlugin(id: string): Promise<PluginAdminRecord | null> { return this.plugins.find((item) => item.id === id) ?? null }
  public async findPlugin(name: string, folder: string): Promise<PluginAdminRecord | null> { return this.plugins.find((item) => item.name === name && item.folder === folder) ?? null }
  public async createPlugin(value: PluginWrite): Promise<string> { const id = String(this.plugins.length + 1); this.writes.push({ ...value, id }); this.plugins.push(recordFromWrite(id, value)); return id }
  public async updatePlugin(id: string, value: PluginWrite): Promise<boolean> { const index = this.plugins.findIndex((item) => item.id === id); if (index < 0) return false; this.writes.push({ ...value, id }); this.plugins[index] = recordFromWrite(id, value); return true }
  public async updateStatus(id: string, status: number, updated: number): Promise<boolean> { const index = this.plugins.findIndex((item) => item.id === id); const current = this.plugins[index]; if (current === undefined) return false; this.plugins[index] = { ...current, status, updated }; return true }
  public async deletePlugin(id: string): Promise<boolean> { if (this.failDelete) return false; const index = this.plugins.findIndex((item) => item.id === id); if (index < 0) return false; this.plugins.splice(index, 1); return true }
}

describe('plugin administration service', () => {
  let root = ''
  afterEach(async () => { if (root !== '') await rm(root, { recursive: true, force: true }); root = '' })

  function setup() {
    const store = new MemoryPluginStore()
    const reconcile = vi.fn(async () => ({ started: 0, stopped: 0, running: 0, unsupportedPhp: 0, invalid: 0 }))
    const plugins = new PluginAdminService(store, root, { reconcile } as never, { now: () => 1_700_000_000 })
    return { store, reconcile, plugins }
  }

  it('installs a validated package disabled, stores its config, archive, and legacy folder', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-plugin-admin-'))
    const { store, reconcile, plugins } = setup()
    const data = pluginZip('1.0.0', { background_node: 'background.mjs', icon_uri: '/plugins/sample/icon.svg', port: 9501 })
    await expect(plugins.install(data)).resolves.toEqual({ status: 'ok', id: '1', name: 'Sample', iconUri: '/plugins/sample/icon.svg', message: 'Plugin installed successfully.' })
    expect(store.plugins[0]).toEqual({ id: '1', name: 'Sample', folder: 'plugins/sample/', config: { background_node: 'background.mjs', icon_uri: '/plugins/sample/icon.svg', port: 9501 }, status: 0, created: 1_700_000_000, updated: 1_700_000_000 })
    await expect(readFile(path.join(root, 'sample/plugin.json'), 'utf8')).resolves.toContain('1.0.0')
    await expect(readFile(path.join(root, 'tmp/sample.zip'))).resolves.toEqual(data)
    expect(reconcile).toHaveBeenCalledWith([{ id: '1', name: 'Sample', folder: 'plugins/sample/', active: false }])
  })

  it('upgrades in place, preserves keep_files and stored configuration, and rejects the same version', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-plugin-upgrade-'))
    const { store, plugins } = setup()
    await plugins.install(pluginZip('1.0.0', { port: 9501, fresh: 'old' }, 'initial-state'))
    await writeFile(path.join(root, 'sample/state.json'), 'locally-configured')
    store.plugins[0] = { ...(store.plugins[0] as PluginAdminRecord), status: 1, config: { port: 9999, retained: true } }
    await expect(plugins.install(pluginZip('2.0.0', { port: 9502, newDefault: true }, 'archive-upgrade'))).resolves.toEqual({ status: 'ok', id: '1', name: 'Sample', message: 'Plugin installed successfully.' })
    await expect(readFile(path.join(root, 'sample/state.json'), 'utf8')).resolves.toBe('locally-configured')
    expect(store.plugins[0]).toEqual(expect.objectContaining({ id: '1', status: 1, created: 1_700_000_000, config: { port: 9999, newDefault: true, retained: true } }))
    await expect(plugins.install(pluginZip('2.0.0', {}))).resolves.toEqual({ status: 'invalid', message: 'Plugin with the same version is already installed.' })
  })

  it('uses a unique safe folder for a different package collision and rejects invalid archives', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-plugin-collision-'))
    const { store, plugins } = setup()
    await plugins.install(pluginZip('1', {}, '', 'First', 'sample'))
    const second = await plugins.install(pluginZip('1', {}, '', 'Second', 'sample'))
    expect(second).toEqual(expect.objectContaining({ status: 'ok', id: '2', name: 'Second' }))
    expect(store.plugins[1]?.folder).toMatch(/^plugins\/sample_[a-f0-9]{8}\/$/)
    await expect(plugins.install(Buffer.from('not a zip'))).resolves.toEqual({ status: 'invalid', message: 'Plugin file is not a valid ZIP archive' })
  })

  it('preserves legacy use_cli storage outside the plugins directory without allowing core-directory targets', async () => {
    const applicationRoot = await mkdtemp(path.join(tmpdir(), 'gplayer-plugin-cli-'))
    root = path.join(applicationRoot, 'plugins')
    try {
      const { store, plugins } = setup()
      await expect(plugins.install(pluginZip('1.0.0', { background_node: 'background.mjs' }, 'cli-state', 'CLI Sample', 'cli-sample', true))).resolves.toEqual({ status: 'ok', id: '1', name: 'CLI Sample', message: 'Plugin installed successfully.' })
      expect(store.plugins[0]?.folder).toBe('cli-sample/')
      await expect(readFile(path.join(applicationRoot, 'cli-sample/plugin.json'), 'utf8')).resolves.toContain('"use_cli":true')
      await expect(plugins.install(pluginZip('1.0.0', {}, '', 'Core', 'src', true))).resolves.toEqual({ status: 'invalid', message: 'Plugin manifest targets a protected application directory' })
    } finally {
      await rm(applicationRoot, { recursive: true, force: true })
      root = ''
    }
  })

  it('adopts an orphaned same-name installation as an upgrade and still rejects its current version', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-plugin-orphan-'))
    const { store, plugins } = setup()
    const first = pluginZip('1.0.0', { port: 9501 }, 'retained')
    const archive = PluginArchive.fromBuffer(first)
    await archive.extract(path.join(root, 'sample'), false, root)
    await expect(plugins.install(first)).resolves.toEqual({ status: 'invalid', message: 'Plugin with the same version is already installed.' })
    await expect(plugins.install(pluginZip('2.0.0', { port: 9502 }, 'replacement'))).resolves.toEqual({ status: 'ok', id: '1', name: 'Sample', message: 'Plugin installed successfully.' })
    expect(store.plugins[0]).toEqual(expect.objectContaining({ folder: 'plugins/sample/', config: { port: 9502 } }))
    await expect(readFile(path.join(root, 'sample/state.json'), 'utf8')).resolves.toBe('retained')
  })

  it('reconciles status changes and quarantines uninstall with rollback on database failure', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-plugin-uninstall-'))
    const { store, reconcile, plugins } = setup()
    await plugins.install(pluginZip('1.0.0', {}))
    await expect(plugins.setStatus('1', '1')).resolves.toEqual({ status: 'ok', id: '1', message: 'Plugin status updated successfully.' })
    expect(reconcile).toHaveBeenLastCalledWith([expect.objectContaining({ id: '1', active: true })])
    store.failDelete = true
    await expect(plugins.uninstall('1')).resolves.toEqual({ status: 'invalid', message: 'Uninstall failed!' })
    await expect(readFile(path.join(root, 'sample/plugin.json'))).resolves.toBeInstanceOf(Buffer)
    expect(store.plugins[0]?.status).toBe(1)
    store.failDelete = false
    await expect(plugins.uninstall('1')).resolves.toEqual({ status: 'ok', id: '1', message: 'Plugin uninstalled successfully.' })
    await expect(readFile(path.join(root, 'sample/plugin.json'))).rejects.toThrow()
    expect(store.plugins).toEqual([])
  })

  it('bounds list parsing and plugin identifiers', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-plugin-list-'))
    const { store, plugins } = setup()
    await plugins.install(pluginZip('1', {}))
    const page = await plugins.records({ draw: '4', length: 500, start: -1, 'search[value]': 'Sam', 'order[0][column]': '1', 'order[0][dir]': 'asc' })
    expect(page).toEqual(expect.objectContaining({ draw: 4, recordsTotal: 1 }))
    expect(store.queries[0]).toEqual(expect.objectContaining({ length: 100, start: 0, orderBy: 'status', orderDir: 'asc' }))
    expect(pluginListQuery({})).toEqual(expect.objectContaining({ orderBy: 'updated' }))
    expect(pluginId('4294967295')).toBe('4294967295')
    expect(pluginId('4294967296')).toBeNull()
  })
})

describe('MySqlPluginAdminStore', () => {
  it('uses parameterized legacy table list, lookup, status, install, and delete queries', async () => {
    const read = vi.fn(async (sql: string, _values: readonly unknown[] = []) => sql.includes('COUNT(*)') ? [{ total: 1 }] : [databaseRow()])
    const write = vi.fn().mockResolvedValueOnce({ insertId: 2 }).mockResolvedValue({ affectedRows: 1 })
    const store = new MySqlPluginAdminStore({ read, write } as never)
    await expect(store.listPlugins({ draw: 0, start: 5, length: 10, search: "x'", orderBy: 'updated', orderDir: 'desc' })).resolves.toEqual({ data: [databaseRecord()], recordsTotal: 1, recordsFiltered: 1 })
    const listCall = read.mock.calls.find(([sql]) => sql.includes('LIMIT ? OFFSET ?'))
    expect(listCall?.[0]).not.toContain("x'")
    expect(listCall?.[1]).toEqual(["x'%", 10, 5])
    await expect(store.getPlugin('1')).resolves.toEqual(databaseRecord())
    await expect(store.findPlugin('Sample', 'plugins/sample/')).resolves.toEqual(databaseRecord())
    await expect(store.createPlugin(writeValue())).resolves.toBe('2')
    await expect(store.updatePlugin('1', writeValue())).resolves.toBe(true)
    await expect(store.updateStatus('1', 0, 123)).resolves.toBe(true)
    await expect(store.deletePlugin('1')).resolves.toBe(true)
    expect(write.mock.calls.at(-1)).toEqual(['DELETE FROM `tb_plugins` WHERE `id` = ?', ['1']])
  })
})

describe('plugin administration routes', () => {
  let app: FastifyInstance | undefined
  let root = ''
  const headers = Object.freeze({ cookie: `${AUTH_COOKIE_NAME}=${token}`, 'user-agent': userAgent, origin: 'https://player.example' })
  afterEach(async () => { await app?.close(); app = undefined; if (root !== '') await rm(root, { recursive: true, force: true }); root = '' })

  it('renders the list, installs multipart packages, exposes DataTables, and protects mutations', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-plugin-route-'))
    const store = new MemoryPluginStore()
    const plugins = new PluginAdminService(store, root, { reconcile: async () => ({ started: 0, stopped: 0, running: 0, unsupportedPhp: 0, invalid: 0 }) } as never, { now: () => 1_700_000_000 })
    app = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: secureSalt }), { auth: new AuthService(new RouteAuthStore()), plugins })
    const page = await app.inject({ method: 'GET', url: '/administrator/plugins/list/', headers })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Plugin package')
    const csrf = createHmac('sha256', secureSalt).update(`plugin-mutate\0${token}`).digest('base64url')
    const multipart = multipartBody({ csrf, redirect: '1' }, pluginZip('1.0.0', {}))
    const installed = await app.inject({ method: 'POST', url: '/administrator/plugins/install/', headers: { ...headers, 'content-type': multipart.contentType }, payload: multipart.payload })
    expect(installed.statusCode).toBe(303)
    expect(installed.headers.location).toContain('notice=install&success=1')
    const legacyMultipart = multipartBody({}, pluginZip('1.0.0', { icon_uri: '/plugins/second/icon.svg' }, 'state', 'Second', 'second'))
    const legacyInstalled = await app.inject({ method: 'POST', url: '/administrator/plugins/install/', headers: { ...headers, 'content-type': legacyMultipart.contentType }, payload: legacyMultipart.payload })
    expect(legacyInstalled.json()).toEqual({ status: 'ok', message: 'Plugin installed successfully.', name: 'Second', icon_uri: '/plugins/second/icon.svg' })
    const list = await app.inject({ method: 'GET', url: '/administrator/plugins/list/?draw=2', headers })
    expect(list.json()).toEqual(expect.objectContaining({ draw: 2, recordsTotal: 2 }))
    expect((await app.inject({ method: 'GET', url: '/administrator/plugins/sync/?id=1&secure=wrong&action=ping' })).body).toBe('Invalid request')
    expect((await app.inject({ method: 'GET', url: `/administrator/plugins/sync/?id=1&secure=${secureSalt}&action=other` })).body).toBe('Invalid action')
    expect((await app.inject({ method: 'GET', url: `/administrator/plugins/sync/?id=999&secure=${secureSalt}&action=ping` })).body).toBe('Not found')
    await rm(path.join(root, 'tmp', 'sample.zip'))
    const syncBase = `/administrator/plugins/sync?id=1&secure=${secureSalt}`
    await mkdir(path.join(root, 'sample', 'runtime-cache'))
    await symlink(path.join(root, 'sample', 'plugin.json'), path.join(root, 'sample', 'unsafe-link'))
    expect((await app.inject({ method: 'GET', url: `${syncBase}&action=ping` })).body).toBe('Invalid')
    await rm(path.join(root, 'sample', 'unsafe-link'))
    const ping = await app.inject({ method: 'GET', url: `${syncBase}&action=ping` })
    expect(ping.statusCode).toBe(200)
    expect(ping.body).toBe('ok')
    expect(ping.headers['cache-control']).toBe('no-store')
    const download = await app.inject({ method: 'GET', url: `${syncBase}&action=download` })
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-type']).toBe('application/octet-stream')
    expect(download.headers['content-disposition']).toBe('attachment; filename="sample.zip"')
    expect(PluginArchive.fromBuffer(download.rawPayload).manifest).toEqual(expect.objectContaining({ name: 'Sample', folder: 'sample', version: '1.0.0' }))
    await PluginArchive.fromBuffer(download.rawPayload).extract(path.join(root, 'unpacked'), false, root)
    expect((await lstat(path.join(root, 'unpacked', 'runtime-cache'))).isDirectory()).toBe(true)
    expect(await readFile(path.join(root, 'tmp', 'sample.zip'))).toEqual(download.rawPayload)
    const legacyStatus = await app.inject({ method: 'POST', url: '/administrator/plugins/status/', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'id=1&status=1' })
    expect(legacyStatus.statusCode).toBe(200)
    expect(legacyStatus.json()).toEqual({ status: 'ok', message: 'Plugin status updated successfully.' })
    const status = await app.inject({ method: 'POST', url: '/administrator/plugins/status/', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ csrf, id: '1', status: '1' }).toString() })
    expect(status.statusCode).toBe(303)
    expect(store.plugins[0]?.status).toBe(1)
  })
})

function recordFromWrite(id: string, value: PluginWrite): PluginAdminRecord { return Object.freeze({ id, name: value.name, folder: value.folder, config: Object.freeze({ ...value.config }), status: value.status, created: value.created, updated: value.updated }) }
function pluginZip(version: string, config: Readonly<Record<string, unknown>>, state = 'state', name = 'Sample', folder = 'sample', useCli = false): Buffer { return zipFixture({ 'plugin.json': JSON.stringify({ name, folder, version, use_cli: useCli, keep_files: ['state.json'], config }), 'background.mjs': 'export default async function () {}', 'state.json': state }, true) }
function databaseRecord(): PluginAdminRecord { return { id: '1', name: 'Sample', folder: 'plugins/sample/', config: { port: 9501 }, status: 1, created: 100, updated: 200 } }
function databaseRow() { return { id: 1, name: 'Sample', folder: 'plugins/sample/', config: '{"port":9501}', status: 1, created: 100, updated: 200 } }
function writeValue(): PluginWrite { return { name: 'Sample', folder: 'plugins/sample/', config: { port: 9501 }, status: 1, created: 100, updated: 200 } }

function multipartBody(fields: Readonly<Record<string, string>>, file: Buffer) {
  const boundary = '----gplayer-plugin-test-boundary'
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="pluginZipFile"; filename="sample.zip"\r\nContent-Type: application/zip\r\n\r\n`), file, Buffer.from(`\r\n--${boundary}--\r\n`))
  return { contentType: `multipart/form-data; boundary=${boundary}`, payload: Buffer.concat(chunks) }
}

function zipFixture(files: Readonly<Record<string, string>>, deflated: boolean): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0
  for (const [name, value] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name); const data = Buffer.from(value); const compressed = deflated ? deflateRawSync(data) : data; const method = deflated ? 8 : 0; const crc = crc32(data)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuffer.length, 26); locals.push(local, nameBuffer, compressed)
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuffer.length, 28); central.writeUInt32LE((0x81a4 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42); centrals.push(central, nameBuffer); offset += local.length + nameBuffer.length + compressed.length
  }
  const localData = Buffer.concat(locals); const centralData = Buffer.concat(centrals); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10); eocd.writeUInt32LE(centralData.length, 12); eocd.writeUInt32LE(localData.length, 16); return Buffer.concat([localData, centralData, eocd])
}
function crc32(data: Buffer): number { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) } return (crc ^ 0xffffffff) >>> 0 }
