import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { UserAdminService, type AdminUserRecord, type UserAdminStore } from '../src/auth/user-admin-service.js'
import { loadConfig } from '../src/config.js'
import { MySqlSettingsAdminStore } from '../src/settings/mysql-settings-admin-store.js'
import { SettingsAdminService, type SettingEntry, type SettingsAdminStore } from '../src/settings/settings-admin-service.js'
import { FileSystemSiteAssetManager, type SiteAssetManager } from '../src/settings/site-assets-service.js'

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

const adminRecord: AdminUserRecord = Object.freeze({
  id: '1',
  username: 'admin',
  email: admin.email,
  name: admin.name,
  role: admin.role,
  status: admin.status,
  created: admin.created,
  updated: admin.updated,
  videos: 0
})

const routeUserStore: UserAdminStore = {
  listUsers: async () => ({ data: [adminRecord], recordsTotal: 1, recordsFiltered: 1 }),
  getUser: async (id) => id === adminRecord.id ? adminRecord : null,
  findConflict: async () => ({ username: false, email: false }),
  createUser: async () => '2',
  updateUser: async () => true,
  updateEmail: async () => true,
  updateUsername: async () => true,
  deleteUser: async () => true
}

class MemorySiteAssets implements SiteAssetManager {
  public logoAvailable = false
  public readonly updates: Array<Readonly<{ logo?: Buffer; name: string }>> = []

  public async hasLogo(): Promise<boolean> { return this.logoAvailable }
  public async validateLogo(logo: Buffer): Promise<void> {
    if (!logo.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error('invalid logo')
  }
  public async update(settings: Awaited<ReturnType<SettingsAdminService['siteSettings']>>, logo?: Buffer): Promise<void> {
    if (logo !== undefined) this.logoAvailable = true
    this.updates.push(Object.freeze({ name: settings.site_name, ...(logo === undefined ? {} : { logo }) }))
  }
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

  it('preserves the twelve-key public settings contract and validates ownership inputs', async () => {
    const store = new MemorySettingsStore({ anonymous_generator: 'true', public_video_user: '1', contact_page_link: 'https://example.test/contact' })
    const settings = new SettingsAdminService(store)
    await expect(settings.publicSettings()).resolves.toEqual(expect.objectContaining({
      anonymous_generator: true,
      embed_only: false,
      public_video_user: '1',
      contact_page_link: 'https://example.test/contact'
    }))

    await expect(settings.savePublic({
      anonymous_generator: ['false', 'true'],
      enable_download_page: 'false',
      contact_page_link: '',
      public_video_user: '1',
      ignored_public_key: 'blocked'
    })).resolves.toEqual({ status: 'ok', message: 'The Public Settings have been successfully updated' })
    expect(store.values).toEqual(expect.objectContaining({ anonymous_generator: 'true', enable_download_page: 'false', contact_page_link: '', public_video_user: '1' }))
    expect(store.values).not.toHaveProperty('ignored_public_key')
    await expect(settings.savePublic({ public_video_user: '4294967296' })).resolves.toEqual({ status: 'invalid', message: 'The public video user is invalid' })
    await expect(settings.savePublic({ contact_page_link: 'javascript:alert(1)' })).resolves.toEqual({ status: 'invalid', message: 'The contact page URL is invalid' })
  })

  it('preserves the ten-key SMTP contract without returning the stored password', async () => {
    const store = new MemorySettingsStore({
      disable_confirm: 'false',
      smtp_provider: 'gmail',
      smtp_host: 'SMTP.GMAIL.COM',
      smtp_port: '587',
      smtp_tls: 'true',
      smtp_email: 'mailer@example.test',
      smtp_password: 'stored-secret',
      smtp_sender: 'GPlayer Mailer',
      smtp_reply_email: 'support@example.test',
      smtp_reply_name: 'Support'
    })
    const settings = new SettingsAdminService(store)
    const values = await settings.smtpSettings()
    expect(values).toEqual({
      disable_confirm: false,
      smtp_provider: 'gmail',
      smtp_host: 'smtp.gmail.com',
      smtp_port: '587',
      smtp_tls: true,
      smtp_email: 'mailer@example.test',
      smtp_password_configured: true,
      smtp_sender: 'GPlayer Mailer',
      smtp_reply_email: 'support@example.test',
      smtp_reply_name: 'Support'
    })
    expect(values).not.toHaveProperty('smtp_password')

    await expect(settings.saveSmtp({
      disable_confirm: ['false', 'true'],
      smtp_provider: 'outlook',
      smtp_host: 'smtp.office365.com',
      smtp_port: '0587',
      smtp_tls: 'true',
      smtp_email: 'mailer@example.test',
      smtp_password: 'replacement-secret',
      smtp_sender: 'No Reply',
      smtp_reply_email: 'support@example.test',
      smtp_reply_name: 'Support Team',
      attacker_controlled_key: 'blocked'
    })).resolves.toEqual({ status: 'ok', message: 'The SMTP Settings have been successfully updated' })
    expect(store.values).toEqual(expect.objectContaining({ smtp_provider: 'outlook', smtp_host: 'smtp.office365.com', smtp_port: '587', smtp_password: 'replacement-secret' }))
    expect(store.values).not.toHaveProperty('attacker_controlled_key')
  })

  it('validates SMTP transport fields and requires an explicit password removal', async () => {
    const store = new MemorySettingsStore({ smtp_password: 'preserve-me' })
    const settings = new SettingsAdminService(store)
    await expect(settings.saveSmtp({ smtp_host: 'https://smtp.example.test' })).resolves.toEqual({ status: 'invalid', message: 'The SMTP host is invalid' })
    await expect(settings.saveSmtp({ smtp_port: '65536' })).resolves.toEqual({ status: 'invalid', message: 'The SMTP port is invalid' })
    await expect(settings.saveSmtp({ smtp_email: 'not-an-email' })).resolves.toEqual({ status: 'invalid', message: 'The smtp email is invalid' })
    await expect(settings.saveSmtp({ smtp_password: 'new-secret', clear_smtp_password: 'true' })).resolves.toEqual({ status: 'invalid', message: 'Choose either a new SMTP password or remove the stored password' })
    expect(store.writes).toEqual([])

    await expect(settings.saveSmtp({ smtp_password: '', smtp_sender: 'Mailer' })).resolves.toEqual({ status: 'ok', message: 'The SMTP Settings have been successfully updated' })
    expect(store.values.smtp_password).toBe('preserve-me')
    await expect(settings.saveSmtp({ clear_smtp_password: 'true' })).resolves.toEqual({ status: 'ok', message: 'The SMTP Settings have been successfully updated' })
    expect(store.values.smtp_password).toBe('')
  })

  it('preserves and validates the nine-key site and PWA settings contract', async () => {
    const store = new MemorySettingsStore({ site_name: 'My Player', pwa_display: 'fullscreen', custom_color: 'ABCDEF' })
    const settings = new SettingsAdminService(store)
    await expect(settings.siteSettings()).resolves.toEqual(expect.objectContaining({
      site_name: 'My Player',
      pwa_display: 'fullscreen',
      custom_color: 'abcdef',
      pwa_shortname: 'GPlayer'
    }))

    await expect(settings.saveSite({
      site_name: 'GPlayer Node',
      site_slogan: 'Media without detours',
      site_description: 'A complete Node.js media gateway.',
      custom_color: '#ccea59',
      custom_color2: '#172019',
      pwa_shortname: 'GPlayer',
      pwa_themecolor: '#0b0e0c',
      pwa_backgroundcolor: '#101511',
      pwa_display: 'minimal-ui',
      unknown_site_key: 'blocked'
    })).resolves.toEqual({ status: 'ok', message: 'The Site Settings have been successfully updated' })
    expect(store.values).toEqual(expect.objectContaining({ site_name: 'GPlayer Node', custom_color: 'ccea59', pwa_display: 'minimal-ui' }))
    expect(store.values).not.toHaveProperty('unknown_site_key')
  })

  it('rejects empty copy, invalid colors, and unsupported PWA display modes', async () => {
    const store = new MemorySettingsStore()
    const settings = new SettingsAdminService(store)
    await expect(settings.saveSite({ site_name: '' })).resolves.toEqual({ status: 'invalid', message: 'The site name is invalid' })
    await expect(settings.saveSite({ custom_color: '#not-a-color' })).resolves.toEqual({ status: 'invalid', message: 'The custom color is invalid' })
    await expect(settings.saveSite({ pwa_display: 'browser' })).resolves.toEqual({ status: 'invalid', message: 'The PWA display mode is invalid' })
    expect(store.writes).toEqual([])
  })
})

describe('site asset generation', () => {
  it('normalizes one PNG into the legacy icon family, favicon, and manifest', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'gplayer-site-assets-'))
    try {
      const logo = await sharp({ create: { width: 640, height: 320, channels: 4, background: '#ccea59' } }).png().toBuffer()
      const settings = await new SettingsAdminService(new MemorySettingsStore({
        site_name: 'GPlayer Test',
        site_slogan: 'Test gateway',
        site_description: 'Test manifest generation.',
        pwa_shortname: 'GPlayer',
        pwa_themecolor: '0b0e0c',
        pwa_backgroundcolor: '101511',
        pwa_display: 'standalone'
      })).siteSettings()
      const assets = new FileSystemSiteAssetManager(temporaryRoot, 'control')
      await expect(assets.validateLogo(Buffer.from('not a PNG'))).rejects.toThrow('The logo must be a PNG image no larger than 5 MB')
      await assets.update(settings, logo)

      await expect(assets.hasLogo()).resolves.toBe(true)
      const metadata = await sharp(path.join(temporaryRoot, 'assets/img/logo.png')).metadata()
      expect([metadata.width, metadata.height]).toEqual([512, 512])
      expect((await readFile(path.join(temporaryRoot, 'favicon.ico'))).subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]))
      await expect(readFile(path.join(temporaryRoot, 'assets/img/apple-touch-icon-152x152.png'))).resolves.toBeInstanceOf(Buffer)
      const manifest = JSON.parse(await readFile(path.join(temporaryRoot, 'manifest.json'), 'utf8')) as Record<string, unknown>
      expect(manifest).toEqual(expect.objectContaining({ name: 'GPlayer Test', theme_color: '#0b0e0c', display: 'standalone' }))
      expect(JSON.stringify(manifest)).toContain('./control/dashboard/?source=homescreen')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
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

  async function createApp(settingsStore: MemorySettingsStore, routeAuth = new RouteAuthStore(), siteAssets: SiteAssetManager = new MemorySiteAssets()): Promise<FastifyInstance> {
    return await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: '1234567890123456' }), {
      auth: new AuthService(routeAuth),
      settings: new SettingsAdminService(settingsStore),
      users: new UserAdminService(routeUserStore, { hashPassword: async () => 'hash' }),
      siteAssets
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

  it('renders and updates public feature settings with a validated user owner', async () => {
    const store = new MemorySettingsStore({ public_video_user: '1', anonymous_generator: 'true' })
    app = await createApp(store)
    const page = await app.inject({ method: 'GET', url: '/administrator/settings/public/', headers })
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1]
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Public settings.')
    expect(page.body).toContain('name="enable_registration"')
    expect(page.body).toContain('<option value="1" selected>Admin (admin)</option>')

    const response = await app.inject({
      method: 'POST',
      url: '/administrator/settings/public/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${csrf}&anonymous_generator=true&embed_only=false&enable_registration=true&contact_page_link=https%3A%2F%2Fexample.test%2Fcontact&public_video_user=1`
    })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/administrator/settings/public/?updated=1')
    expect(store.values).toEqual(expect.objectContaining({ anonymous_generator: 'true', embed_only: 'false', enable_registration: 'true', public_video_user: '1' }))
  })

  it('rejects a missing public-video owner without persisting the category', async () => {
    const store = new MemorySettingsStore()
    app = await createApp(store)
    const page = await app.inject({ method: 'GET', url: '/administrator/settings/public/', headers })
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1]
    const response = await app.inject({
      method: 'POST',
      url: '/administrator/settings/public/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${csrf}&anonymous_generator=true&public_video_user=99`
    })
    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('The public video user is invalid')
    expect(store.writes).toEqual([])
  })

  it('renders and updates SMTP settings without exposing the stored password', async () => {
    const store = new MemorySettingsStore({
      smtp_provider: 'gmail',
      smtp_host: 'smtp.gmail.com',
      smtp_port: '587',
      smtp_tls: 'true',
      smtp_email: 'mailer@example.test',
      smtp_password: 'never-render-this',
      smtp_sender: 'GPlayer Mailer'
    })
    app = await createApp(store)
    const page = await app.inject({ method: 'GET', url: '/administrator/settings/smtp/', headers })
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1]
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('SMTP settings.')
    expect(page.body).toContain('<option value="gmail" selected>Gmail</option>')
    expect(page.body).toContain('A password is stored. Leave this blank to preserve it.')
    expect(page.body).not.toContain('never-render-this')

    const response = await app.inject({
      method: 'POST',
      url: '/administrator/settings/smtp/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${csrf}&disable_confirm=false&smtp_provider=other&smtp_host=mail.example.test&smtp_port=465&smtp_tls=false&smtp_email=mailer%40example.test&smtp_password=&smtp_sender=Mailer&smtp_reply_email=support%40example.test&smtp_reply_name=Support`
    })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/administrator/settings/smtp/?updated=1')
    expect(store.values).toEqual(expect.objectContaining({ smtp_provider: 'other', smtp_host: 'mail.example.test', smtp_port: '465', smtp_tls: 'false', smtp_password: 'never-render-this' }))
  })

  it('renders and updates site settings from a signed multipart form with a PNG logo', async () => {
    const store = new MemorySettingsStore({ site_name: 'GPlayer', pwa_display: 'standalone' })
    const assets = new MemorySiteAssets()
    app = await createApp(store, new RouteAuthStore(), assets)
    const page = await app.inject({ method: 'GET', url: '/administrator/settings/site/', headers })
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1] ?? ''
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Site settings.')
    expect(page.body).toContain('enctype="multipart/form-data"')

    const logo = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#ccea59' } }).png().toBuffer()
    const multipart = multipartPayload({
      csrf,
      site_name: 'GPlayer Node',
      site_slogan: 'Media gateway',
      site_description: 'A complete media gateway.',
      custom_color: '#ccea59',
      custom_color2: '#172019',
      pwa_shortname: 'GPlayer',
      pwa_themecolor: '#0b0e0c',
      pwa_backgroundcolor: '#101511',
      pwa_display: 'standalone'
    }, logo)
    const response = await app.inject({
      method: 'POST',
      url: '/administrator/settings/site/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': multipart.contentType },
      payload: multipart.payload
    })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/administrator/settings/site/?updated=1')
    expect(store.values).toEqual(expect.objectContaining({ site_name: 'GPlayer Node', custom_color: 'ccea59', pwa_themecolor: '0b0e0c' }))
    expect(assets.updates).toHaveLength(1)
    expect(assets.updates[0]?.logo).toEqual(logo)
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

function multipartPayload(fields: Readonly<Record<string, string>>, logo: Buffer): Readonly<{ contentType: string; payload: Buffer }> {
  const boundary = '----gplayer-settings-test-boundary'
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="favicon"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`))
  chunks.push(logo)
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  return Object.freeze({ contentType: `multipart/form-data; boundary=${boundary}`, payload: Buffer.concat(chunks) })
}
