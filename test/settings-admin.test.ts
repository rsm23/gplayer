import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { loadConfig } from '../src/config.js'
import { MySqlSettingsAdminStore } from '../src/settings/mysql-settings-admin-store.js'
import { SettingsAdminService, type SettingEntry, type SettingsAdminStore } from '../src/settings/settings-admin-service.js'

const token = 'settings-admin-token-1234567890'
const userAgent = 'GPlayer settings test'
const admin: AuthUser = Object.freeze({
  id: 1,
  username: 'admin',
  email: 'admin@gplayer.local',
  name: 'Admin',
  role: 0,
  status: 1,
  created: 1_600_000_000,
  updated: 1_600_000_000
})

class MemorySettingsStore implements SettingsAdminStore {
  public readonly values: Record<string, string>
  public readonly writes: SettingEntry[][] = []

  public constructor(values: Record<string, string> = {}) {
    this.values = { ...values }
  }

  public async getAll(): Promise<Readonly<Record<string, string>>> {
    return Object.freeze({ ...this.values })
  }

  public async upsertMany(entries: readonly SettingEntry[]): Promise<void> {
    this.writes.push(entries.map((entry) => ({ ...entry })))
    for (const entry of entries) this.values[entry.key] = entry.value
  }
}

class RouteAuthStore implements AuthStore {
  public constructor(private readonly user: AuthUser | null = admin) {}
  public async findUserByIdentifier(): Promise<StoredAuthUser | null> { return null }
  public async createSession(_session: SessionWrite): Promise<void> {}
  public async recordFailedLogin(_session: Omit<SessionWrite, 'expires' | 'state'>): Promise<void> {}
  public async findActiveSession(requestedToken: string, requestedUserAgent: string): Promise<AuthUser | null> {
    return requestedToken === token && requestedUserAgent === userAgent ? this.user : null
  }
  public async revokeSession(): Promise<boolean> { return true }
}

describe('settings administration service', () => {
  it('loads legacy scalar values and stable defaults', async () => {
    const store = new MemorySettingsStore({ production_mode: 'true', cache_file_timeout: '90', timezone: 'Europe/Paris', cache_mode: 'nginx' })
    const result = await new SettingsAdminService(store).general(new URL('https://player.example/base/'))

    expect(result).toEqual(expect.objectContaining({
      main_site: 'https://player.example/base/',
      production_mode: true,
      enable_cache_file: false,
      cache_file_timeout: '90',
      timezone: 'Europe/Paris',
      cache_mode: 'nginx'
    }))
  })

  it('allowlists, validates, and serializes the complete general save contract', async () => {
    const store = new MemorySettingsStore()
    const settings = new SettingsAdminService(store)
    const result = await settings.saveGeneral({
      main_site: 'https://player.example/app',
      timezone: 'UTC',
      cache_mode: 'nginx',
      production_mode: ['false', 'true'],
      enable_cache_file: 'false',
      cache_file_timeout: '0042',
      visit_counter: '3',
      chat_widget: '<script src="/support.js"></script>',
      attacker_controlled_key: 'must-not-persist'
    })

    expect(result).toEqual({ status: 'ok', message: 'The General Settings have been successfully updated' })
    expect(store.values).toEqual({
      main_site: 'https://player.example/app/',
      timezone: 'UTC',
      cache_mode: 'nginx',
      production_mode: 'true',
      enable_cache_file: 'false',
      cache_file_timeout: '42',
      visit_counter: '3',
      chat_widget: '<script src="/support.js"></script>'
    })
    expect(store.values).not.toHaveProperty('attacker_controlled_key')
  })

  it('rejects invalid URLs, timezones, cache modes, and numeric limits without writing', async () => {
    const store = new MemorySettingsStore()
    const settings = new SettingsAdminService(store)
    await expect(settings.saveGeneral({ main_site: 'javascript:alert(1)' })).resolves.toEqual({ status: 'invalid', message: 'The main site URL is invalid' })
    await expect(settings.saveGeneral({ timezone: 'Mars/Olympus' })).resolves.toEqual({ status: 'invalid', message: 'The timezone is invalid' })
    await expect(settings.saveGeneral({ cache_mode: 'shell' })).resolves.toEqual({ status: 'invalid', message: 'The cache mode is invalid' })
    await expect(settings.saveGeneral({ visit_counter: '0' })).resolves.toEqual({ status: 'invalid', message: 'The visit counter value is invalid' })
    expect(store.writes).toEqual([])
  })
})

describe('MySqlSettingsAdminStore', () => {
  it('reads and atomically upserts parameterized legacy setting rows', async () => {
    const database = {
      read: vi.fn().mockResolvedValue([{ key: 'timezone', value: 'UTC' }, { key: 'production_mode', value: 'true' }]),
      write: vi.fn().mockResolvedValue({ affectedRows: 3 })
    }
    const store = new MySqlSettingsAdminStore(database)
    await expect(store.getAll()).resolves.toEqual({ timezone: 'UTC', production_mode: 'true' })
    await store.upsertMany([{ key: 'timezone', value: 'Europe/Paris' }, { key: 'production_mode', value: 'false' }])
    expect(database.read).toHaveBeenCalledWith('SELECT `key`, `value` FROM `tb_settings`')
    expect(database.write).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO `tb_settings` (`key`, `value`) VALUES (?, ?), (?, ?) ON DUPLICATE KEY UPDATE'),
      ['timezone', 'Europe/Paris', 'production_mode', 'false']
    )
  })
})

describe('general settings administration routes', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function createApp(settingsStore: MemorySettingsStore, routeAuth = new RouteAuthStore()): Promise<FastifyInstance> {
    return await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: '1234567890123456' }), {
      auth: new AuthService(routeAuth),
      settings: new SettingsAdminService(settingsStore)
    })
  }

  const headers = Object.freeze({ cookie: `${AUTH_COOKIE_NAME}=${token}`, 'user-agent': userAgent })

  it('renders the full general form for administrators without exposing the session token', async () => {
    app = await createApp(new MemorySettingsStore({ timezone: 'Europe/Paris', production_mode: 'true' }))
    const response = await app.inject({ method: 'GET', url: '/administrator/settings/general/', headers })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('General settings.')
    expect(response.body).toContain('name="main_site"')
    expect(response.body).toContain('name="chat_widget"')
    expect(response.body).toContain('<option value="Europe/Paris" selected>')
    expect(response.body).not.toContain(token)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['referrer-policy']).toBe('same-origin')
  })

  it('updates settings through a signed same-origin form and ignores unknown keys', async () => {
    const store = new MemorySettingsStore()
    app = await createApp(store)
    const page = await app.inject({ method: 'GET', url: '/administrator/settings/general/', headers })
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1]
    const response = await app.inject({
      method: 'POST',
      url: '/administrator/settings/general/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${csrf}&main_site=https%3A%2F%2Fapp.example%2Fbase&timezone=UTC&cache_mode=php&production_mode=true&unknown=blocked`
    })

    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/administrator/settings/general/?updated=1')
    expect(store.values).toEqual(expect.objectContaining({ main_site: 'https://app.example/base/', timezone: 'UTC', cache_mode: 'php', production_mode: 'true' }))
    expect(store.values).not.toHaveProperty('unknown')
  })

  it('rejects non-admin, cross-origin, and invalid-CSRF settings writes', async () => {
    const store = new MemorySettingsStore()
    app = await createApp(store, new RouteAuthStore({ ...admin, role: 1 }))
    const denied = await app.inject({ method: 'GET', url: '/administrator/settings/general/', headers })
    expect(denied.statusCode).toBe(302)
    expect(denied.headers.location).toBe('/administrator/403/')

    await app.close()
    app = await createApp(store)
    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/administrator/settings/general/',
      headers: { ...headers, origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'csrf=invalid&timezone=UTC'
    })
    const badCsrf = await app.inject({
      method: 'POST',
      url: '/administrator/settings/general/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'csrf=invalid&timezone=UTC'
    })
    expect(crossOrigin.statusCode).toBe(403)
    expect(badCsrf.statusCode).toBe(403)
    expect(store.writes).toEqual([])
  })
})
