import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { UserAdminService, type AdminUserRecord, type UserAdminStore } from '../src/auth/user-admin-service.js'
import { loadConfig } from '../src/config.js'
import { MySqlSettingsAdminStore } from '../src/settings/mysql-settings-admin-store.js'
import { SettingsAdminService, shortenerProviderList, type SettingEntry, type SettingsAdminStore } from '../src/settings/settings-admin-service.js'
import { FileSystemSiteAssetManager, type SiteAssetManager } from '../src/settings/site-assets-service.js'
import { FileSystemVastAssetManager, InvalidVastAssetError, type VastAsset, type VastAssetInput, type VastAssetManager } from '../src/settings/vast-assets-service.js'

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
  public reads = 0

  public constructor(values: Record<string, string> = {}) {
    this.values = { ...values }
  }

  public async getAll(): Promise<Readonly<Record<string, string>>> {
    this.reads += 1
    return Object.freeze({ ...this.values })
  }

  public async upsertMany(entries: readonly SettingEntry[]): Promise<void> {
    this.writes.push(entries.map((entry) => ({ ...entry })))
    for (const entry of entries) this.values[entry.key] = entry.value
  }

  public async deleteAll(): Promise<number> {
    const keys = Object.keys(this.values).filter((key) => key !== '')
    for (const key of keys) delete this.values[key]
    return keys.length
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

class MemoryVastAssets implements VastAssetManager {
  public readonly assets: VastAsset[] = []
  public readonly creates: VastAssetInput[] = []
  public readonly deletes: string[] = []

  public async list(): Promise<readonly VastAsset[]> { return Object.freeze(this.assets.map((asset) => Object.freeze({ ...asset }))) }
  public async create(input: VastAssetInput): Promise<VastAsset> {
    this.creates.push({ ...input })
    const name = String(input.adFilename ?? '')
    const asset = Object.freeze({ name, url: `https://player.example/uploads/${encodeURIComponent(name)}` })
    const existing = this.assets.findIndex((candidate) => candidate.name === name)
    if (existing === -1) this.assets.push(asset)
    else this.assets[existing] = asset
    return asset
  }
  public async delete(name: string): Promise<boolean> {
    this.deletes.push(name)
    const index = this.assets.findIndex((asset) => asset.name === name)
    if (index === -1) return false
    this.assets.splice(index, 1)
    return true
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

  it('resets every non-empty legacy setting only after exact destructive confirmation', async () => {
    const store = new MemorySettingsStore({ timezone: 'UTC', cookie_youtube: 'SID=private', '': 'reserved' })
    const settings = new SettingsAdminService(store)

    await expect(settings.resetSettings({ confirmation: 'reset settings', acknowledge: 'true' })).resolves.toEqual({
      status: 'invalid',
      message: 'Type RESET SETTINGS exactly to confirm the reset'
    })
    expect(store.values).toEqual({ timezone: 'UTC', cookie_youtube: 'SID=private', '': 'reserved' })

    await expect(settings.resetSettings({ confirmation: 'RESET SETTINGS', acknowledge: 'true' })).resolves.toEqual({
      status: 'ok',
      message: 'The Reset Settings have been successfully reset'
    })
    expect(store.values).toEqual({ '': 'reserved' })
  })

  it('synchronizes only an allowlisted legacy cache mode', async () => {
    const store = new MemorySettingsStore({ cache_mode: 'php', timezone: 'UTC' })
    const settings = new SettingsAdminService(store)
    await expect(settings.synchronizeCacheMode({ cache_mode: 'shell', ignored: 'value' })).resolves.toEqual({
      status: 'invalid',
      message: 'The cache mode is invalid'
    })
    expect(store.values.cache_mode).toBe('php')

    await expect(settings.synchronizeCacheMode({ cache_mode: 'nginx', ignored: 'value' })).resolves.toEqual({
      status: 'ok',
      message: 'Load balancer server config updated successfully.'
    })
    expect(store.writes.at(-1)).toEqual([{ key: 'cache_mode', value: 'nginx' }])
    expect(store.values).toEqual({ cache_mode: 'nginx', timezone: 'UTC' })
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
    await expect(settings.runtimePublicSettings()).resolves.toEqual({
      anonymous_generator: true,
      embed_only: false,
      enable_gsharer: false,
      enable_request_url: true,
      enable_json_subtitles: true,
      enable_download_page: true,
      show_sub_download: true,
      show_watch_button: true,
      save_public_video: false,
      public_video_user: '1',
      contact_page_link: 'https://example.test/contact'
    })

    await expect(settings.savePublic({
      anonymous_generator: ['false', 'true'],
      enable_download_page: 'false',
      contact_page_link: '',
      public_video_user: '1',
      ignored_public_key: 'blocked'
    })).resolves.toEqual({ status: 'ok', message: 'The Public Settings have been successfully updated' })
    expect(store.values).toEqual(expect.objectContaining({ anonymous_generator: 'true', enable_download_page: 'false', contact_page_link: '', public_video_user: '1' }))
    expect(store.values).not.toHaveProperty('ignored_public_key')
    await expect(settings.runtimePublicSettings()).resolves.toEqual(expect.objectContaining({ enable_download_page: false }))
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

  it('builds bounded server-only account, CAPTCHA, and SMTP runtime settings', async () => {
    const store = new MemorySettingsStore({
      enable_registration: 'true',
      disable_confirm: 'false',
      site_name: 'GPlayer Cloud',
      recaptcha_site_key: 'site-key',
      recaptcha_secret_key: 'secret-key',
      smtp_provider: 'ymail',
      smtp_tls: 'false',
      smtp_email: 'mailer@example.test',
      smtp_password: 'stored-secret',
      smtp_sender: 'GPlayer Mailer'
    })
    const settings = new SettingsAdminService(store)

    await expect(settings.accountLifecycleSettings()).resolves.toEqual({
      enableRegistration: true,
      disableConfirmation: false,
      siteName: 'GPlayer Cloud',
      recaptchaSiteKey: 'site-key',
      recaptchaSecretKey: 'secret-key',
      smtp: {
        host: 'smtp.mail.yahoo.com',
        port: 465,
        startTls: false,
        username: 'mailer@example.test',
        password: 'stored-secret',
        senderName: 'GPlayer Mailer',
        replyEmail: 'mailer@example.test',
        replyName: 'GPlayer Mailer'
      }
    })
    const rendered = await settings.smtpSettings()
    expect(rendered).not.toHaveProperty('smtp_password')
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

  it('preserves the exact thirteen-key shortlink contract without returning stored API keys', async () => {
    const store = new MemorySettingsStore({
      disable_shortener_link: 'true',
      additional_url_shortener: 'ouo_io',
      additional_url_shortener_ouo_io: 'never-return-this'
    })
    const settings = new SettingsAdminService(store)
    const values = await settings.shortlinkSettings()
    expect(values.disable_shortener_link).toBe(true)
    expect(values.additional_url_shortener).toBe('ouo_io')
    expect(values.providers.find((provider) => provider.id === 'ouo_io')).toEqual({ id: 'ouo_io', name: 'ouo.io', configured: true })
    expect(JSON.stringify(values)).not.toContain('never-return-this')
    await expect(settings.runtimeShortlinkSettings()).resolves.toEqual(expect.objectContaining({
      disabled: true,
      selected: 'ouo_io',
      providers: [expect.objectContaining({ id: 'ouo_io', apiKey: 'never-return-this' })]
    }))
    expect(shortenerProviderList().map(({ id, apiUrl }) => [id, apiUrl])).toEqual([
      ['random', ''],
      ['adtival_network', 'https://adtival.network/st?api=%s&url=%s'],
      ['clicksfly_com', 'https://clicksfly.com/st?api=%s&url=%s'],
      ['clk_sh', 'https://clk.sh/st?api=%s&url=%s'],
      ['cutpaid_com', 'https://cutpaid.com/st?api=%s&url=%s'],
      ['payskip_org', 'https://payskip.org/st?api=%s&url=%s'],
      ['shrinkearn_com', 'https://shrinkearn.com/st?api=%s&url=%s'],
      ['shrinkme_io', 'https://shrinkme.io/st?api=%s&url=%s'],
      ['shrtfly_com', 'https://shrtfly.com/st?api=%s&url=%s'],
      ['v2links_com', 'https://v2links.com/st?api=%s&url=%s'],
      ['ouo_io', 'https://ouo.io/qs/%s?s=%s'],
      ['safelinku_com', 'https://semawur.com/full/?type=2&api=%s&url=%s']
    ])

    const submitted = Object.fromEntries(shortenerProviderList()
      .filter((provider) => provider.id !== 'random')
      .map((provider) => [`additional_url_shortener_${provider.id}`, `key-for-${provider.id}`]))
    await expect(settings.saveShortlink({
      disable_shortener_link: ['false', 'true'],
      additional_url_shortener: 'random',
      ...submitted,
      unsupported_shortener_key: 'blocked'
    })).resolves.toEqual({ status: 'ok', message: 'The Shortlink Settings have been successfully updated' })
    expect(store.writes.at(-1)).toHaveLength(13)
    expect(store.values).not.toHaveProperty('unsupported_shortener_key')
  })

  it('preserves blank shortlink secrets and requires an explicit, unambiguous removal', async () => {
    const store = new MemorySettingsStore({ additional_url_shortener_ouo_io: 'preserve-me' })
    const settings = new SettingsAdminService(store)
    await expect(settings.saveShortlink({ disable_shortener_link: 'false', additional_url_shortener: 'ouo_io', additional_url_shortener_ouo_io: '' }))
      .resolves.toEqual({ status: 'ok', message: 'The Shortlink Settings have been successfully updated' })
    expect(store.values.additional_url_shortener_ouo_io).toBe('preserve-me')

    await expect(settings.saveShortlink({ clear_additional_url_shortener_ouo_io: 'true' }))
      .resolves.toEqual({ status: 'ok', message: 'The Shortlink Settings have been successfully updated' })
    expect(store.values.additional_url_shortener_ouo_io).toBe('')
    const writeCount = store.writes.length
    await expect(settings.saveShortlink({ additional_url_shortener: 'unknown' })).resolves.toEqual({ status: 'invalid', message: 'The URL shortener provider is invalid' })
    await expect(settings.saveShortlink({ additional_url_shortener_ouo_io: 'new-key', clear_additional_url_shortener_ouo_io: 'true' }))
      .resolves.toEqual({ status: 'invalid', message: 'Choose either a new ouo.io API key or remove the stored key' })
    expect(store.writes).toHaveLength(writeCount)
  })

  it('loads the bundled custom-header defaults and preserves first-match URL semantics', async () => {
    const settings = new SettingsAdminService(new MemorySettingsStore())
    const rules = await settings.customHeaderSettings()
    expect(rules).toHaveLength(11)
    expect(rules[0]).toEqual({ keywords: ['cdn.dzen.ru'], headers: { Referer: 'https://dzen.ru/' } })
    await expect(settings.customHeadersForUrl('https://CDN.DZEN.RU/video/master.m3u8')).resolves.toEqual({ Referer: 'https://dzen.ru/' })
    await expect(settings.customHeadersForUrl('https://unmatched.example/video.mp4')).resolves.toEqual({})
  })

  it('invalidates the active custom-header runtime cache without deleting stored settings', async () => {
    const store = new MemorySettingsStore({ custom_headers: JSON.stringify([{ keywords: ['cdn.example'], headers: { Referer: 'https://app.example/' } }]) })
    const settings = new SettingsAdminService(store)
    await expect(settings.customHeadersForUrl('https://cdn.example/video.mp4')).resolves.toEqual({ Referer: 'https://app.example/' })
    await settings.customHeadersForUrl('https://cdn.example/second.mp4')
    expect(store.reads).toBe(1)

    settings.clearRuntimeCaches()
    await expect(settings.customHeadersForUrl('https://cdn.example/third.mp4')).resolves.toEqual({ Referer: 'https://app.example/' })
    expect(store.reads).toBe(2)
    expect(store.values.custom_headers).toContain('cdn.example')
    expect(store.writes).toEqual([])
  })

  it('loads and serializes the complete fifty-three-key Player Settings contract', async () => {
    const store = new MemorySettingsStore({ player: 'plyr', default_audio: 'fr', player_color: '#ABCDEF', autoplay: 'true', slug_embed: 'watch' })
    const settings = new SettingsAdminService(store)
    const slugs = { embed: 'e', download: 'd', request: 'r' }
    await expect(settings.playerSettings(slugs)).resolves.toEqual(expect.objectContaining({
      player: 'plyr',
      default_audio: 'French',
      default_subtitle: 'Indonesian',
      player_color: 'abcdef',
      autoplay: true,
      playback_rate: true,
      slug_embed: 'watch',
      slug_download: 'd'
    }))

    const result = await settings.savePlayer({
      player: 'jwplayer',
      player_skin: 'hotstar',
      player_color: '#095AE5',
      player_color2: '#062794',
      stretching: 'exactfit',
      preload: 'auto',
      default_resolution: '700',
      default_audio: 'English',
      autoplay: ['false', 'true'],
      mute: 'true',
      repeat: 'false',
      display_title: 'true',
      playback_rate: 'false',
      enable_share_button: 'true',
      enable_download_button: 'true',
      disable_filmstrip: 'false',
      fake_play_button: 'true',
      continue_watching: 'true',
      pause_on_left: 'true',
      allow_public_qry: 'false',
      default_subtitle: 'fr',
      subtitle_color: '#FFFF00',
      font_family: 'Verdana',
      edge_style: 'uniform',
      background_opacity: '080',
      background_color: '#000000',
      window_opacity: '25',
      window_color: '#112233',
      poster: 'https://images.example/default.jpg',
      force_default_poster: 'true',
      logo_file: 'https://images.example/logo.png',
      logo_open_link: 'https://brand.example/',
      logo_position: 'bottom-left',
      logo_margin: '0012',
      logo_hide: 'true',
      small_logo_file: 'https://images.example/small.png',
      small_logo_link: 'https://brand.example/small',
      p2p: 'true',
      torrent_tracker: 'wss://tracker.example/socket\nwss://tracker2.example/',
      text_title: 'Watch {title} on {siteName}',
      loader: 'cube-2',
      text_loading: 'Preparing stream…',
      text_download: 'Save {title}',
      text_resume: 'Resume at hh:mm:ss',
      text_resume_yes: 'Resume',
      text_resume_no: 'Start over',
      text_rewind: 'Back 10 seconds',
      text_forward: 'Ahead 10 seconds',
      hide_hostname: 'true',
      slug_embed: '/watch/',
      slug_download: 'fetch',
      slug_request: 'request-player',
      iframe_code: '<iframe title="{title}" src="{embed_url}"></iframe>',
      unsupported_player_key: 'blocked'
    }, slugs)

    expect(result).toEqual({ status: 'ok', message: 'The Player Settings have been successfully updated' })
    expect(store.writes.at(-1)).toHaveLength(53)
    expect(store.values).toEqual(expect.objectContaining({
      player_skin: 'hotstar',
      player_color: '095ae5',
      default_subtitle: 'French',
      background_opacity: '80',
      logo_margin: '12',
      poster: 'https://images.example/default.jpg',
      slug_embed: 'watch',
      slug_download: 'fetch',
      slug_request: 'request-player'
    }))
    expect(store.values).not.toHaveProperty('unsupported_player_key')
  })

  it('rejects unsafe Player Settings URLs, trackers, embed templates, and route collisions atomically', async () => {
    const store = new MemorySettingsStore()
    const settings = new SettingsAdminService(store)
    const slugs = { embed: 'e', download: 'd', request: 'r' }
    await expect(settings.savePlayer({ poster: 'javascript:alert(1)' }, slugs)).resolves.toEqual({ status: 'invalid', message: 'The poster URL is invalid' })
    await expect(settings.savePlayer({ torrent_tracker: 'https://tracker.example/' }, slugs)).resolves.toEqual({ status: 'invalid', message: 'Torrent trackers must contain no more than 100 valid ws:// or wss:// URLs' })
    await expect(settings.savePlayer({ iframe_code: '<iframe src="{embed_url}"></iframe>' }, slugs)).resolves.toEqual({ status: 'invalid', message: 'The custom embed code must contain both {embed_url} and {title}' })
    await expect(settings.savePlayer({ slug_embed: 'api' }, slugs)).resolves.toEqual({ status: 'invalid', message: 'The slug embed value is invalid or reserved' })
    await expect(settings.savePlayer({ slug_embed: 'ping' }, slugs)).resolves.toEqual({ status: 'invalid', message: 'The slug embed value is invalid or reserved' })
    await expect(settings.savePlayer({ slug_embed: 'control' }, { ...slugs, adminDirectory: 'control' })).resolves.toEqual({ status: 'invalid', message: 'The slug embed value is invalid or reserved' })
    await expect(settings.savePlayer({ slug_embed: 'same', slug_download: 'same' }, slugs)).resolves.toEqual({ status: 'invalid', message: 'Embed, download, and request slugs must be different' })
    expect(store.writes).toEqual([])
  })

  it('falls back from unsafe or duplicate stored player slugs', async () => {
    const settings = new SettingsAdminService(new MemorySettingsStore({ slug_embed: 'ping', slug_download: 'same', slug_request: 'same' }))
    await expect(settings.playerSettings({ embed: 'e', download: 'd', request: 'r' })).resolves.toEqual(expect.objectContaining({
      slug_embed: 'e',
      slug_download: 'd',
      slug_request: 'r'
    }))
  })

  it('validates and serializes ordered custom-header rules into the single legacy JSON key', async () => {
    const store = new MemorySettingsStore()
    const settings = new SettingsAdminService(store)
    await expect(settings.saveCustomHeaders({
      'items[0][keywords]': 'media.example\ncdn.example',
      'items[0][headers]': 'Origin: https://app.example\nReferer: https://app.example/',
      'items[1][keywords]': 'tokenized.example',
      'items[1][headers]': 'X-Playback-Token: server-secret',
      ignored_custom_header_key: 'blocked'
    })).resolves.toEqual({ status: 'ok', message: 'The Custom Headers Settings have been successfully updated' })
    expect(store.writes.at(-1)).toEqual([{ key: 'custom_headers', value: expect.any(String) }])
    expect(JSON.parse(store.values.custom_headers ?? '')).toEqual([
      { keywords: ['media.example', 'cdn.example'], headers: { Origin: 'https://app.example', Referer: 'https://app.example/' } },
      { keywords: ['tokenized.example'], headers: { 'X-Playback-Token': 'server-secret' } }
    ])
    await expect(settings.customHeadersForUrl('https://cdn.example/segment.ts')).resolves.toEqual({ Origin: 'https://app.example', Referer: 'https://app.example/' })

    const writeCount = store.writes.length
    await expect(settings.saveCustomHeaders({ 'items[0][keywords]': 'example.test', 'items[0][headers]': 'Host: attacker.example' }))
      .resolves.toEqual({ status: 'invalid', message: 'Custom-header rule 1 contains the unsafe header Host' })
    await expect(settings.saveCustomHeaders({ 'items[0][keywords]': 'example.test', 'items[0][headers]': 'missing-separator' }))
      .resolves.toEqual({ status: 'invalid', message: 'Custom-header rule 1 contains a malformed header' })
    expect(store.writes).toHaveLength(writeCount)
  })

  it('preserves and serializes the complete nineteen-key Ads Settings contract', async () => {
    const store = new MemorySettingsStore({
      block_adblocker: 'true',
      vast_client: 'googima',
      vast_xml: '["https://ads.example/preroll.xml"]',
      vast_offset: '["preroll"]',
      vast_skip: '7',
      popup_ads_code: '<aside>Ad</aside>'
    })
    const settings = new SettingsAdminService(store)
    await expect(settings.adsSettings()).resolves.toEqual(expect.objectContaining({
      block_adblocker: true,
      disable_vast_ads: false,
      vast_client: 'googima',
      vast_xml: ['https://ads.example/preroll.xml'],
      vast_offset: ['preroll'],
      vast_skip: '7',
      popup_ads_code: '<aside>Ad</aside>'
    }))

    await expect(settings.saveAds({
      block_adblocker: ['false', 'true'],
      disable_vast_ads: 'false',
      vast_client: 'vast',
      'vast_offset[]': ['preroll', '50%'],
      'vast_xml[]': ['https://ads.example/pre.xml', 'https://ads.example/mid.xml'],
      vast_skip: '0005',
      disable_popup_ads: 'false',
      popup_load_offset: '10',
      popup_ads_link: 'https://ads.example/popup.js',
      popup_ads_code: '<script src="/ad.js"></script>',
      disable_banner_ads: 'true',
      dl_banner_top: '<div>Download top</div>',
      dl_banner_bottom: '<div>Download bottom</div>',
      sh_banner_top: '<div>Sharer top</div>',
      sh_banner_bottom: '<div>Sharer bottom</div>',
      disable_direct_ads: 'false',
      direct_ads_link: 'https://ads.example/campaign',
      visitads_onplay: 'true',
      show_iframeads: 'false',
      unsupported_ads_key: 'blocked'
    })).resolves.toEqual({ status: 'ok', message: 'The Ads Settings have been successfully updated' })
    expect(store.writes.at(-1)).toHaveLength(19)
    expect(store.values).toEqual(expect.objectContaining({
      block_adblocker: 'true',
      vast_client: 'vast',
      vast_xml: '["https://ads.example/pre.xml","https://ads.example/mid.xml"]',
      vast_offset: '["preroll","50%"]',
      vast_skip: '5',
      direct_ads_link: 'https://ads.example/campaign'
    }))
    expect(store.values).not.toHaveProperty('unsupported_ads_key')
  })

  it('rejects unsupported ad clients, malformed VAST schedules, and unsafe ad URLs', async () => {
    const store = new MemorySettingsStore()
    const settings = new SettingsAdminService(store)
    await expect(settings.saveAds({ vast_client: 'other' })).resolves.toEqual({ status: 'invalid', message: 'The VAST client is invalid' })
    await expect(settings.saveAds({ 'vast_xml[]': 'javascript:alert(1)', 'vast_offset[]': 'preroll' })).resolves.toEqual({ status: 'invalid', message: 'VAST URL 1 is invalid' })
    await expect(settings.saveAds({ 'vast_xml[]': 'https://ads.example/tag.xml', 'vast_offset[]': 'middle-ish' })).resolves.toEqual({ status: 'invalid', message: 'VAST position 1 is invalid' })
    await expect(settings.saveAds({ direct_ads_link: 'file:///tmp/ad.html' })).resolves.toEqual({ status: 'invalid', message: 'The direct ads link URL is invalid' })
    expect(store.writes).toEqual([])
  })

  it('maintains the legacy custom_vast JSON index with safe unique filenames', async () => {
    const store = new MemorySettingsStore({ custom_vast: '["first.xml","../escape.xml","FIRST.xml","notes.txt"]' })
    const settings = new SettingsAdminService(store)
    await expect(settings.customVastNames()).resolves.toEqual(['first.xml'])

    await settings.addCustomVastName('second-ad.xml')
    expect(JSON.parse(store.values.custom_vast ?? '')).toEqual(['first.xml', 'second-ad.xml'])
    await settings.addCustomVastName('FIRST.xml')
    expect(JSON.parse(store.values.custom_vast ?? '')).toEqual(['second-ad.xml', 'FIRST.xml'])
    await settings.removeCustomVastName('first.xml')
    expect(JSON.parse(store.values.custom_vast ?? '')).toEqual(['second-ad.xml'])
    await expect(settings.addCustomVastName('../outside.xml')).rejects.toThrow('Invalid VAST asset name')
  })
})

describe('custom VAST asset generation', () => {
  it('writes, lists, replaces, and deletes safe VAST 3.0 XML files', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'gplayer-vast-assets-'))
    try {
      const assets = new FileSystemVastAssetManager(temporaryRoot, new URL('https://player.example/base/'))
      const created = await assets.create({
        adTitle: 'Launch & <pre-roll>',
        adClickThrough: 'https://ads.example/click?x=1&y=2',
        adMediaFile: 'https://cdn.example/launch.mp4?x=1&y=2',
        adDuration: '30',
        adSkipOffset: '5',
        adFilename: 'launch-ad.xml'
      }, 'GPlayer & Test')

      expect(created).toEqual({ name: 'launch-ad.xml', url: 'https://player.example/base/uploads/launch-ad.xml' })
      const xml = await readFile(path.join(temporaryRoot, 'launch-ad.xml'), 'utf8')
      expect(xml).toContain('<VAST xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"')
      expect(xml).toContain('<AdSystem>GPlayer &amp; Test</AdSystem>')
      expect(xml).toContain('<AdTitle>Launch &amp; &lt;pre-roll&gt;</AdTitle>')
      expect(xml).toContain('<Linear skipoffset="00:00:05">')
      expect(xml).toContain('<Duration>00:00:30</Duration>')
      expect(xml).toContain('<![CDATA[https://ads.example/click?x=1&y=2]]>')
      expect(xml).toContain('<CustomClick>https://ads.example/click?x=1&amp;y=2</CustomClick>')

      await writeFile(path.join(temporaryRoot, 'ignore.txt'), 'not an asset')
      await expect(assets.list()).resolves.toEqual([created])
      await assets.create({
        adTitle: 'Replacement',
        adClickThrough: 'https://ads.example/replacement',
        adMediaFile: 'https://cdn.example/signed-media?id=replacement',
        adDuration: '60',
        adSkipOffset: '',
        adFilename: 'launch-ad.php'
      }, 'GPlayer')
      const replacement = await readFile(path.join(temporaryRoot, 'launch-ad.xml'), 'utf8')
      expect(replacement).toContain('<AdTitle>Replacement</AdTitle>')
      expect(replacement).toContain('<Linear skipoffset="00:00:00">')
      await expect(assets.delete('launch-ad.xml')).resolves.toBe(true)
      await expect(assets.delete('launch-ad.xml')).resolves.toBe(false)
      await expect(assets.list()).resolves.toEqual([])
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('rejects traversal, missing or unsafe URLs, credentials, and invalid durations', async () => {
    const assets = new FileSystemVastAssetManager(path.join(os.tmpdir(), 'unused-gplayer-vast-root'), new URL('https://player.example/'))
    const base = {
      adTitle: '',
      adClickThrough: 'https://ads.example/click',
      adMediaFile: 'https://cdn.example/ad.mp4',
      adDuration: '30',
      adSkipOffset: '',
      adFilename: 'safe.xml'
    }
    await expect(assets.create({ ...base, adFilename: '../escape.xml' }, 'GPlayer')).rejects.toBeInstanceOf(InvalidVastAssetError)
    await expect(assets.create({ ...base, adFilename: 'nested/ad.xml' }, 'GPlayer')).rejects.toThrow('must contain only')
    await expect(assets.create({ ...base, adMediaFile: 'file:///tmp/ad.mp4' }, 'GPlayer')).rejects.toThrow('valid HTTP(S) URL')
    await expect(assets.create({ ...base, adClickThrough: 'https://user:secret@ads.example/click' }, 'GPlayer')).rejects.toThrow('embedded credentials')
    await expect(assets.create({ ...base, adDuration: '-1' }, 'GPlayer')).rejects.toThrow('whole number of seconds')
    await expect(assets.delete('../../escape.xml')).rejects.toThrow('filename is invalid')
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
      expect(manifest).toEqual(expect.objectContaining({
        start_url: './?source=pwa',
        display_override: ['window-controls-overlay'],
        shortcuts: [
          expect.objectContaining({ name: 'Google Drive Bypass Limit', url: './sharer/?utm_source=homescreen' }),
          expect.objectContaining({ name: 'Video List', url: './control/videos/list/?utm_source=homescreen' })
        ]
      }))
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
})

describe('MySqlSettingsAdminStore', () => {
  it('reads, atomically upserts, and resets parameterized legacy setting rows', async () => {
    const database = {
      read: vi.fn().mockResolvedValue([{ key: 'timezone', value: 'UTC' }, { key: 'production_mode', value: 'true' }]),
      write: vi.fn().mockResolvedValue({ affectedRows: 3 })
    }
    const store = new MySqlSettingsAdminStore(database)
    await expect(store.getAll()).resolves.toEqual({ timezone: 'UTC', production_mode: 'true' })
    await store.upsertMany([{ key: 'timezone', value: 'Europe/Paris' }, { key: 'production_mode', value: 'false' }])
    await expect(store.deleteAll()).resolves.toBe(3)
    expect(database.read).toHaveBeenCalledWith('SELECT `key`, `value` FROM `tb_settings`')
    expect(database.write).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO `tb_settings` (`key`, `value`) VALUES (?, ?), (?, ?) ON DUPLICATE KEY UPDATE'),
      ['timezone', 'Europe/Paris', 'production_mode', 'false']
    )
    expect(database.write).toHaveBeenCalledWith('DELETE FROM `tb_settings` WHERE `key` <> ?', [''])
  })
})

describe('general settings administration routes', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function createApp(
    settingsStore: MemorySettingsStore,
    routeAuth = new RouteAuthStore(),
    siteAssets: SiteAssetManager = new MemorySiteAssets(),
    vastAssets: VastAssetManager = new MemoryVastAssets()
  ): Promise<FastifyInstance> {
    return await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: '1234567890123456' }), {
      auth: new AuthService(routeAuth),
      settings: new SettingsAdminService(settingsStore),
      users: new UserAdminService(routeUserStore, { hashPassword: async () => 'hash' }),
      siteAssets,
      vastAssets
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

  it('renders and updates shortlink settings without reflecting stored or submitted API keys', async () => {
    const store = new MemorySettingsStore({
      additional_url_shortener: 'ouo_io',
      additional_url_shortener_ouo_io: 'stored-shortlink-secret'
    })
    app = await createApp(store)
    const page = await app.inject({ method: 'GET', url: '/administrator/settings/shortlink/', headers })
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1]
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Shortlink settings.')
    expect(page.body).toContain('<option value="ouo_io" selected>ouo.io</option>')
    expect(page.body).toContain('Leave blank to preserve the stored key.')
    expect(page.body).not.toContain('stored-shortlink-secret')

    const response = await app.inject({
      method: 'POST',
      url: '/administrator/settings/shortlink/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${csrf}&disable_shortener_link=false&additional_url_shortener=clicksfly_com&additional_url_shortener_clicksfly_com=submitted-shortlink-secret&additional_url_shortener_ouo_io=`
    })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/administrator/settings/shortlink/?updated=1')
    expect(store.values).toEqual(expect.objectContaining({
      disable_shortener_link: 'false',
      additional_url_shortener: 'clicksfly_com',
      additional_url_shortener_clicksfly_com: 'submitted-shortlink-secret',
      additional_url_shortener_ouo_io: 'stored-shortlink-secret'
    }))

    const updated = await app.inject({ method: 'GET', url: response.headers.location ?? '', headers })
    expect(updated.body).toContain('The Shortlink Settings have been successfully updated')
    expect(updated.body).not.toContain('stored-shortlink-secret')
    expect(updated.body).not.toContain('submitted-shortlink-secret')
  })

  it('renders and updates the ordered custom-header editor through a signed form', async () => {
    const store = new MemorySettingsStore()
    app = await createApp(store)
    const page = await app.inject({ method: 'GET', url: '/administrator/settings/custom-headers/', headers })
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1]
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Custom headers.')
    expect(page.body).toContain('cdn.dzen.ru')
    expect(page.body).toContain('/assets/js/gplayer-admin-settings.js')
    expect(page.headers['content-security-policy']).toContain("script-src 'self'")

    const payload = new URLSearchParams({
      csrf: csrf ?? '',
      'items[0][keywords]': 'media.example',
      'items[0][headers]': 'Origin: https://app.example\nX-Playback-Token: route-secret',
      'items[1][keywords]': '',
      'items[1][headers]': ''
    }).toString()
    const response = await app.inject({
      method: 'POST',
      url: '/administrator/settings/custom-headers/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload
    })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/administrator/settings/custom-headers/?updated=1')
    expect(JSON.parse(store.values.custom_headers ?? '')).toEqual([
      { keywords: ['media.example'], headers: { Origin: 'https://app.example', 'X-Playback-Token': 'route-secret' } }
    ])
  })

  it('renders and updates every Player Settings field through a signed form', async () => {
    const store = new MemorySettingsStore({ player: 'plyr', player_skin: 'netflix', default_audio: 'French', slug_embed: 'watch' })
    app = await createApp(store)
    const page = await app.inject({ method: 'GET', url: '/administrator/settings/player/', headers })
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1] ?? ''
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Player settings.')
    expect(page.body).toContain('53 keys')
    expect(page.body).toContain('<option value="plyr" selected>Plyr</option>')
    expect(page.body).toContain('<option value="French" selected>French</option>')
    expect(page.body).toContain('Markup is never executed on this page.')

    const expectedKeys = [
      'allow_public_qry', 'autoplay', 'background_color', 'background_opacity', 'continue_watching',
      'default_audio', 'default_resolution', 'default_subtitle', 'disable_filmstrip', 'display_title',
      'edge_style', 'enable_download_button', 'enable_share_button', 'fake_play_button', 'font_family',
      'force_default_poster', 'hide_hostname', 'iframe_code', 'loader', 'logo_file', 'logo_hide', 'logo_margin',
      'logo_open_link', 'logo_position', 'mute', 'p2p', 'pause_on_left', 'playback_rate', 'player', 'player_color',
      'player_color2', 'player_skin', 'poster', 'preload', 'repeat', 'slug_download', 'slug_embed', 'slug_request',
      'small_logo_file', 'small_logo_link', 'stretching', 'subtitle_color', 'text_download', 'text_forward',
      'text_loading', 'text_resume', 'text_resume_no', 'text_resume_yes', 'text_rewind', 'text_title',
      'torrent_tracker', 'window_color', 'window_opacity'
    ]
    const playerForm = page.body.match(/<form class="admin-settings-form player-settings-editor"[\s\S]*?<\/form>/)?.[0] ?? ''
    const renderedNames = new Set([...playerForm.matchAll(/name="([^"]+)"/g)].map((match) => match[1]).filter((name) => name !== 'csrf'))
    expect([...renderedNames].sort()).toEqual([...expectedKeys].sort())

    const payload = new URLSearchParams({
      csrf,
      player: 'jwplayer',
      player_skin: 'hotstar',
      player_color: '#095AE5',
      player_color2: '#062794',
      stretching: 'exactfit',
      preload: 'auto',
      default_resolution: '700',
      default_audio: 'English',
      default_subtitle: 'French',
      subtitle_color: '#FFFF00',
      font_family: 'Verdana',
      edge_style: 'uniform',
      background_opacity: '80',
      background_color: '#000000',
      window_opacity: '25',
      window_color: '#112233',
      poster: 'https://images.example/default.jpg',
      logo_file: 'https://images.example/logo.png',
      logo_open_link: 'https://brand.example/',
      logo_position: 'bottom-left',
      logo_margin: '12',
      small_logo_file: 'https://images.example/small.png',
      small_logo_link: 'https://brand.example/small',
      torrent_tracker: 'wss://tracker.example/socket\nwss://tracker2.example/',
      text_title: 'Watch {title} on {siteName}',
      loader: 'cube-2',
      text_loading: 'Preparing stream…',
      text_download: 'Save {title}',
      text_resume: 'Resume at hh:mm:ss',
      text_resume_yes: 'Resume',
      text_resume_no: 'Start over',
      text_rewind: 'Back 10 seconds',
      text_forward: 'Ahead 10 seconds',
      slug_embed: '/watch/',
      slug_download: 'fetch',
      slug_request: 'request-player',
      iframe_code: '<iframe title="{title}" src="{embed_url}"></iframe>'
    })
    for (const key of ['autoplay', 'mute', 'repeat', 'display_title', 'playback_rate', 'enable_share_button', 'enable_download_button', 'disable_filmstrip', 'fake_play_button', 'continue_watching', 'pause_on_left', 'allow_public_qry', 'force_default_poster', 'logo_hide', 'p2p', 'hide_hostname']) {
      payload.append(key, 'false')
    }
    for (const key of ['autoplay', 'mute', 'display_title', 'enable_share_button', 'enable_download_button', 'fake_play_button', 'continue_watching', 'pause_on_left', 'force_default_poster', 'logo_hide', 'p2p', 'hide_hostname']) {
      payload.append(key, 'true')
    }
    const response = await app.inject({
      method: 'POST',
      url: '/administrator/settings/player/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: payload.toString()
    })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/administrator/settings/player/?updated=1')
    expect(store.writes.at(-1)).toHaveLength(53)
    expect(store.values).toEqual(expect.objectContaining({
      player: 'jwplayer',
      player_color: '095ae5',
      default_subtitle: 'French',
      autoplay: 'true',
      repeat: 'false',
      p2p: 'true',
      slug_embed: 'watch',
      slug_download: 'fetch',
      slug_request: 'request-player'
    }))

    const updated = await app.inject({ method: 'GET', url: response.headers.location ?? '', headers })
    expect(updated.body).toContain('The Player Settings have been successfully updated')
  })

  it('renders and updates all dynamic Hosting Settings without exposing provider cookies', async () => {
    const store = new MemorySettingsStore({
      'custom-hostnames': JSON.stringify({ youtube: ['video.private.example'] }),
      'download-urls': JSON.stringify({ youtube: 'https://watch.example/%s' }),
      custom_names: JSON.stringify({ youtube: 'Primary video' }),
      cookie_youtube: 'SID=never-render-this-cookie'
    })
    app = await createApp(store)
    const page = await app.inject({ method: 'GET', url: '/administrator/settings/hosting/', headers })
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1] ?? ''
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Hosting settings.')
    expect(page.body).toContain('73 providers')
    expect(page.body).toContain('name="cookie_youtube"')
    expect(page.body).toContain('name="custom-hostnames[youtube]"')
    expect(page.body).toContain('name="download-urls[youtube]"')
    expect(page.body).toContain('name="custom_names[youtube]"')
    expect(page.body).toContain('Cookie stored')
    expect(page.body).toContain('video.private.example')
    expect(page.body).toContain('value="https://watch.example/%s"')
    expect(page.body).toContain('value="Primary video"')
    expect(page.body).not.toContain('never-render-this-cookie')

    const form = page.body.match(/<form class="admin-settings-form hosting-settings-editor"[\s\S]*?<\/form>/)?.[0] ?? ''
    const names = [...form.matchAll(/name="([^"]+)"/g)].map((match) => match[1] ?? '')
    expect(new Set(names.filter((name) => name.startsWith('cookie_'))).size).toBe(72)
    expect(new Set(names.filter((name) => name.startsWith('custom-hostnames['))).size).toBe(72)
    expect(new Set(names.filter((name) => name.startsWith('download-urls['))).size).toBe(73)
    expect(new Set(names.filter((name) => name.startsWith('custom_names['))).size).toBe(73)

    const payload = new URLSearchParams({
      csrf,
      'custom-hostnames[youtube]': 'media.private.example\nvideo.private.example',
      'download-urls[youtube]': 'https://watch.example/player/%s',
      'custom_names[youtube]': 'Video server 1',
      cookie_youtube: 'SID=replacement; PREF=hd'
    })
    const response = await app.inject({
      method: 'POST',
      url: '/administrator/settings/hosting/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: payload.toString()
    })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/administrator/settings/hosting/?updated=1')
    expect(JSON.parse(store.values['custom-hostnames'] ?? '')).toEqual({ youtube: ['media.private.example', 'video.private.example'] })
    expect(JSON.parse(store.values['download-urls'] ?? '')).toEqual({ youtube: 'https://watch.example/player/%s' })
    expect(JSON.parse(store.values.custom_names ?? '')).toEqual({ youtube: 'Video server 1' })
    expect(store.values.cookie_youtube).toBe('SID=replacement; PREF=hd')

    const updated = await app.inject({ method: 'GET', url: response.headers.location ?? '', headers })
    expect(updated.body).toContain('The Hosting Settings have been successfully updated')
    expect(updated.body).not.toContain('SID=replacement')
  })

  it('renders and executes the signed Reset Settings contract only after exact confirmation', async () => {
    const store = new MemorySettingsStore({ timezone: 'Europe/Paris', cookie_youtube: 'SID=private' })
    app = await createApp(store)
    const page = await app.inject({ method: 'GET', url: '/administrator/settings/reset/', headers })
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1] ?? ''
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Reset settings.')
    expect(page.body).toContain('Type <code>RESET SETTINGS</code> to continue')
    expect(page.body).toContain('name="acknowledge"')
    expect(page.body).not.toContain('SID=private')

    const rejected = await app.inject({
      method: 'POST',
      url: '/administrator/settings/reset/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ csrf, confirmation: 'wrong', acknowledge: 'true' }).toString()
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.body).toContain('Type RESET SETTINGS exactly to confirm the reset')
    expect(store.values).toEqual({ timezone: 'Europe/Paris', cookie_youtube: 'SID=private' })

    const response = await app.inject({
      method: 'POST',
      url: '/administrator/settings/reset/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ csrf, confirmation: 'RESET SETTINGS', acknowledge: 'true' }).toString()
    })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/administrator/settings/reset/?reset=1')
    expect(store.values).toEqual({})

    const updated = await app.inject({ method: 'GET', url: response.headers.location ?? '', headers })
    expect(updated.body).toContain('The Reset Settings have been successfully reset')
  })

  it('preserves the authenticated load-balancer Sync Settings JSON contract', async () => {
    const store = new MemorySettingsStore({ cache_mode: 'php' })
    app = await createApp(store)

    const denied = await app.inject({
      method: 'POST',
      url: '/administrator/settings/sync/',
      headers: { 'user-agent': userAgent, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'cache_mode=nginx'
    })
    expect(denied.statusCode).toBe(200)
    expect(denied.json()).toEqual({ status: 'fail', message: 'Access denied' })
    expect(store.values.cache_mode).toBe('php')

    const invalid = await app.inject({
      method: 'POST',
      url: '/administrator/settings/sync/',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'cache_mode=invalid'
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toEqual({ status: 'fail', message: 'The cache mode is invalid' })
    expect(store.values.cache_mode).toBe('php')

    const response = await app.inject({
      method: 'POST',
      url: '/administrator/settings/sync/',
      headers: { authorization: `Bearer ${token}`, 'user-agent': userAgent, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'cache_mode=litespeed'
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok', message: 'Load balancer server config updated successfully.' })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(store.values.cache_mode).toBe('litespeed')
    expect(store.writes.at(-1)).toEqual([{ key: 'cache_mode', value: 'litespeed' }])
  })

  it('renders and updates every Misc Settings field without exposing proxy credentials', async () => {
    const store = new MemorySettingsStore({
      bypass_host: '["gdrive"]',
      proxy_list: '203.0.113.8:1080,route-user:never-render,socks5',
      banned_countries: '["FR"]'
    })
    app = await createApp(store)
    const page = await app.inject({ method: 'GET', url: '/administrator/settings/misc/', headers })
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1] ?? ''
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Misc settings.')
    expect(page.body).toContain('13 keys')
    expect(page.body).toContain('1 stored endpoint')
    expect(page.body).toContain('<option value="gdrive" selected>Google Drive</option>')
    expect(page.body).toContain('<option value="FR" selected>France</option>')
    expect(page.body).not.toContain('never-render')
    expect(page.body).not.toContain('route-user')

    const names = new Set([...page.body.matchAll(/name="([^"]+)"/g)].map((match) => match[1] ?? '').filter((name) => name !== 'csrf' && name !== 'clear_proxy_list'))
    expect([...names].filter((name) => [
      'bypass_host[]', 'disable_host[]', 'disable_resolution[]', 'disable_proxy', 'free_proxy', 'proxy_list',
      'domain_whitelisted', 'domain_blacklisted', 'link_blacklisted', 'word_blacklisted', 'banned_countries[]',
      'block_vpn', 'block_vpn_list'
    ].includes(name))).toHaveLength(13)

    const payload = new URLSearchParams({
      csrf,
      disable_proxy: 'false',
      free_proxy: 'true',
      proxy_list: '198.51.100.8:443,https',
      clear_proxy_list: 'false',
      domain_whitelisted: 'allowed.example',
      domain_blacklisted: 'blocked.example',
      link_blacklisted: 'blocked.example/watch',
      word_blacklisted: 'forbidden',
      block_vpn: 'true',
      block_vpn_list: '203.0.113.0/24'
    })
    payload.append('bypass_host[]', '')
    payload.append('bypass_host[]', 'gdrive')
    payload.append('disable_host[]', '')
    payload.append('disable_host[]', 'youtube')
    payload.append('disable_resolution[]', '')
    payload.append('disable_resolution[]', '700')
    payload.append('banned_countries[]', '')
    payload.append('banned_countries[]', 'DE')
    const response = await app.inject({
      method: 'POST',
      url: '/administrator/settings/misc/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: payload.toString()
    })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/administrator/settings/misc/?updated=1')
    expect(store.writes.at(-1)).toHaveLength(13)
    expect(store.values).toEqual(expect.objectContaining({
      bypass_host: '["gdrive"]',
      disable_host: '["youtube"]',
      disable_resolution: '["700"]',
      disable_proxy: 'false',
      free_proxy: 'true',
      proxy_list: '198.51.100.8:443,https',
      domain_whitelisted: 'allowed.example',
      banned_countries: '["DE"]',
      block_vpn: 'true'
    }))

    const updated = await app.inject({ method: 'GET', url: response.headers.location ?? '', headers })
    expect(updated.body).toContain('The Misc Settings have been successfully updated')
    expect(updated.body).not.toContain('198.51.100.8')
  })

  it('renders and updates Ads Settings with paired dynamic VAST schedule rows', async () => {
    const store = new MemorySettingsStore({
      vast_xml: '["https://ads.example/original.xml"]',
      vast_offset: '["preroll"]',
      vast_client: 'vast'
    })
    app = await createApp(store)
    const page = await app.inject({ method: 'GET', url: '/administrator/settings/ads/', headers })
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1]
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Ads settings.')
    expect(page.body).toContain('name="vast_xml[]"')
    expect(page.body).toContain('value="https://ads.example/original.xml"')
    expect(page.body).toContain('data-vast-template')

    const payload = new URLSearchParams({
      csrf: csrf ?? '',
      block_adblocker: 'true',
      disable_vast_ads: 'false',
      vast_client: 'googima',
      vast_skip: '6',
      disable_popup_ads: 'true',
      popup_load_offset: '12',
      popup_ads_link: 'https://ads.example/popup.js',
      popup_ads_code: '<aside>Route ad</aside>',
      disable_banner_ads: 'false',
      dl_banner_top: '',
      dl_banner_bottom: '',
      sh_banner_top: '',
      sh_banner_bottom: '',
      disable_direct_ads: 'true',
      direct_ads_link: 'https://ads.example/direct',
      visitads_onplay: 'false',
      show_iframeads: 'true'
    })
    payload.append('vast_offset[]', 'preroll')
    payload.append('vast_xml[]', 'https://ads.example/pre.xml')
    payload.append('vast_offset[]', '00:10:00')
    payload.append('vast_xml[]', 'https://ads.example/mid.xml')
    const response = await app.inject({
      method: 'POST',
      url: '/administrator/settings/ads/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: payload.toString()
    })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/administrator/settings/ads/?updated=1')
    expect(store.values).toEqual(expect.objectContaining({
      block_adblocker: 'true',
      vast_client: 'googima',
      vast_xml: '["https://ads.example/pre.xml","https://ads.example/mid.xml"]',
      vast_offset: '["preroll","00:10:00"]',
      popup_ads_code: '<aside>Route ad</aside>',
      show_iframeads: 'true'
    }))
  })

  it('creates and deletes custom VAST XML assets through separately signed forms', async () => {
    const store = new MemorySettingsStore({ site_name: 'GPlayer Route Test' })
    const assets = new MemoryVastAssets()
    app = await createApp(store, new RouteAuthStore(), new MemorySiteAssets(), assets)
    const page = await app.inject({ method: 'GET', url: '/administrator/settings/ads/', headers })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('VAST asset builder')
    expect(page.body).toContain('No custom VAST XML files have been generated yet.')
    const createForm = page.body.match(/action="\/administrator\/settings\/ads\/vast\/create\/" method="post">([\s\S]*?)<\/form>/)?.[1] ?? ''
    const createCsrf = createForm.match(/name="csrf" value="([^"]+)"/)?.[1] ?? ''

    const createResponse = await app.inject({
      method: 'POST',
      url: '/administrator/settings/ads/vast/create/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        csrf: createCsrf,
        adTitle: 'Route pre-roll',
        adClickThrough: 'https://ads.example/click',
        adMediaFile: 'https://cdn.example/route.mp4',
        adDuration: '30',
        adSkipOffset: '5',
        adFilename: 'route-ad.xml'
      }).toString()
    })
    expect(createResponse.statusCode).toBe(303)
    expect(createResponse.headers.location).toBe('/administrator/settings/ads/?vast=created#custom-vast')
    expect(assets.creates).toHaveLength(1)
    expect(JSON.parse(store.values.custom_vast ?? '')).toEqual(['route-ad.xml'])

    const createdPage = await app.inject({ method: 'GET', url: createResponse.headers.location ?? '', headers })
    expect(createdPage.body).toContain('VAST ad file has been generated successfully')
    expect(createdPage.body).toContain('route-ad.xml')
    expect(createdPage.body).toContain('https://player.example/uploads/route-ad.xml')
    const deleteForm = createdPage.body.match(/action="\/administrator\/settings\/ads\/vast\/delete\/" method="post">([\s\S]*?)<\/form>/)?.[1] ?? ''
    const deleteCsrf = deleteForm.match(/name="csrf" value="([^"]+)"/)?.[1] ?? ''
    const deleteResponse = await app.inject({
      method: 'POST',
      url: '/administrator/settings/ads/vast/delete/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ csrf: deleteCsrf, file_name: 'route-ad.xml' }).toString()
    })
    expect(deleteResponse.statusCode).toBe(303)
    expect(deleteResponse.headers.location).toBe('/administrator/settings/ads/?vast=deleted#custom-vast')
    expect(assets.deletes).toEqual(['route-ad.xml'])
    expect(JSON.parse(store.values.custom_vast ?? '')).toEqual([])
  })

  it('preserves the legacy action-based custom VAST AJAX contract', async () => {
    const store = new MemorySettingsStore({ site_name: 'GPlayer AJAX Test' })
    const assets = new MemoryVastAssets()
    app = await createApp(store, new RouteAuthStore(), new MemorySiteAssets(), assets)
    const createResponse = await app.inject({
      method: 'POST',
      url: '/administrator/ajax/settings/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        action: 'createCustomVast',
        adTitle: 'AJAX pre-roll',
        adClickThrough: 'https://ads.example/click',
        adMediaFile: 'https://cdn.example/ajax.mp4',
        adDuration: '20',
        adSkipOffset: '4',
        adFilename: 'ajax-ad.xml'
      }).toString()
    })
    expect(createResponse.statusCode).toBe(200)
    expect(createResponse.json()).toEqual({
      status: 'ok',
      message: 'VAST ad file has been generated successfully',
      data: 'https://player.example/uploads/ajax-ad.xml'
    })
    expect(JSON.parse(store.values.custom_vast ?? '')).toEqual(['ajax-ad.xml'])

    const deleteResponse = await app.inject({
      method: 'POST',
      url: '/administrator/ajax/settings/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ action: 'deleteCustomVast', file_name: 'ajax-ad.xml' }).toString()
    })
    expect(deleteResponse.statusCode).toBe(200)
    expect(deleteResponse.json()).toEqual({ status: 'ok', message: 'The VAST ad file has been successfully deleted' })
    expect(JSON.parse(store.values.custom_vast ?? '')).toEqual([])
  })

  it('denies dotfiles and traversal through the dynamic upload route', async () => {
    app = await createApp(new MemorySettingsStore())
    const dotfile = await app.inject({ method: 'GET', url: '/uploads/.htaccess' })
    const traversal = await app.inject({ method: 'GET', url: '/uploads/%2e%2e/package.json' })
    expect(dotfile.statusCode).toBe(403)
    expect([403, 404]).toContain(traversal.statusCode)
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
