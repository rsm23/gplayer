const BOOLEAN_KEYS = [
  'production_mode',
  'enable_cache_file',
  'enable_bg_download',
  'gphotos_hls',
  'gdrive_hls',
  'gdrive_copy',
  'gdrive_copy_all',
  'load_balancer_rand',
  'disable_validation',
  'select_active_connections'
] as const

const INTEGER_FIELDS = Object.freeze({
  cache_file_timeout: Object.freeze({ minimum: 0, maximum: 31_536_000, fallback: '3600' }),
  visit_counter: Object.freeze({ minimum: 1, maximum: 1_000_000, fallback: '1' }),
  visit_counter_runtime: Object.freeze({ minimum: 0, maximum: 86_400, fallback: '10' }),
  import_filesize: Object.freeze({ minimum: 1, maximum: 10_000_000_000, fallback: '1024' })
})

const TEXT_FIELDS = Object.freeze({
  maxmind_license_key: 4_096,
  anti_captcha: 4_096,
  google_analytics_id: 255,
  google_tag_manager: 255,
  histats_id: 255,
  recaptcha_site_key: 4_096,
  recaptcha_secret_key: 4_096,
  disqus_shortname: 255,
  chat_widget: 100_000
})

const CACHE_MODES = Object.freeze(['php', 'apache', 'litespeed', 'nginx'] as const)
const PUBLIC_BOOLEAN_KEYS = [
  'anonymous_generator',
  'embed_only',
  'enable_request_url',
  'enable_json_subtitles',
  'enable_download_page',
  'show_sub_download',
  'show_watch_button',
  'enable_gsharer',
  'enable_registration',
  'save_public_video'
] as const
const SMTP_PROVIDERS = Object.freeze(['', 'gmail', 'ymail', 'outlook', 'other'] as const)
const PWA_DISPLAYS = Object.freeze(['standalone', 'fullscreen', 'minimal-ui'] as const)
const SHORTENER_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'random', name: 'Random', apiUrl: '' }),
  Object.freeze({ id: 'adtival_network', name: 'Adtival.Network', apiUrl: 'https://adtival.network/st?api=%s&url=%s' }),
  Object.freeze({ id: 'clicksfly_com', name: 'ClicksFly.com', apiUrl: 'https://clicksfly.com/st?api=%s&url=%s' }),
  Object.freeze({ id: 'clk_sh', name: 'Clk.sh', apiUrl: 'https://clk.sh/st?api=%s&url=%s' }),
  Object.freeze({ id: 'cutpaid_com', name: 'Cutpaid.com', apiUrl: 'https://cutpaid.com/st?api=%s&url=%s' }),
  Object.freeze({ id: 'payskip_org', name: 'PaySkip.ORG', apiUrl: 'https://payskip.org/st?api=%s&url=%s' }),
  Object.freeze({ id: 'shrinkearn_com', name: 'ShrinkEarn.com', apiUrl: 'https://shrinkearn.com/st?api=%s&url=%s' }),
  Object.freeze({ id: 'shrinkme_io', name: 'ShrinkMe.io', apiUrl: 'https://shrinkme.io/st?api=%s&url=%s' }),
  Object.freeze({ id: 'shrtfly_com', name: 'ShrtFly.com', apiUrl: 'https://shrtfly.com/st?api=%s&url=%s' }),
  Object.freeze({ id: 'v2links_com', name: 'V2links.com', apiUrl: 'https://v2links.com/st?api=%s&url=%s' }),
  Object.freeze({ id: 'ouo_io', name: 'ouo.io', apiUrl: 'https://ouo.io/qs/%s?s=%s' }),
  Object.freeze({ id: 'safelinku_com', name: 'SafelinkU.com', apiUrl: 'https://semawur.com/full/?type=2&api=%s&url=%s' })
] as const)
const BOOLEAN_KEY_SET = new Set<string>(BOOLEAN_KEYS)
const TIMEZONES = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')])

export type GeneralSettingKey =
  | 'main_site'
  | 'timezone'
  | 'cache_mode'
  | typeof BOOLEAN_KEYS[number]
  | keyof typeof INTEGER_FIELDS
  | keyof typeof TEXT_FIELDS

export type GeneralSettings = Readonly<Record<GeneralSettingKey, string | boolean>>

export type PublicSettingKey =
  | typeof PUBLIC_BOOLEAN_KEYS[number]
  | 'contact_page_link'
  | 'public_video_user'

export type PublicSettings = Readonly<Record<PublicSettingKey, string | boolean>>

export type SmtpProvider = typeof SMTP_PROVIDERS[number]

export type SmtpSettings = Readonly<{
  disable_confirm: boolean
  smtp_provider: SmtpProvider
  smtp_host: string
  smtp_port: string
  smtp_tls: boolean
  smtp_email: string
  smtp_password_configured: boolean
  smtp_sender: string
  smtp_reply_email: string
  smtp_reply_name: string
}>

export type PwaDisplay = typeof PWA_DISPLAYS[number]

export type SiteSettings = Readonly<{
  site_name: string
  site_slogan: string
  site_description: string
  custom_color: string
  custom_color2: string
  pwa_shortname: string
  pwa_themecolor: string
  pwa_backgroundcolor: string
  pwa_display: PwaDisplay
}>

export type ShortenerProvider = typeof SHORTENER_PROVIDERS[number]
export type ShortenerProviderId = ShortenerProvider['id']

export type ShortlinkSettings = Readonly<{
  disable_shortener_link: boolean
  additional_url_shortener: ShortenerProviderId
  providers: readonly Readonly<{ id: Exclude<ShortenerProviderId, 'random'>; name: string; configured: boolean }>[]
}>

export type SettingEntry = Readonly<{ key: string; value: string }>

export interface SettingsAdminStore {
  getAll(): Promise<Readonly<Record<string, string>>>
  upsertMany(entries: readonly SettingEntry[]): Promise<void>
}

export type SettingsMutationResult =
  | Readonly<{ status: 'ok'; message: string }>
  | Readonly<{ status: 'invalid'; message: string }>

export class SettingsAdminService {
  public constructor(private readonly store: SettingsAdminStore) {}

  public async general(defaultBaseUrl: URL): Promise<GeneralSettings> {
    return generalSettings(await this.store.getAll(), defaultBaseUrl)
  }

  public async saveGeneral(input: Record<string, unknown>): Promise<SettingsMutationResult> {
    const entries: SettingEntry[] = []

    if ('main_site' in input) {
      const mainSite = normalizedHttpUrl(input.main_site)
      if (mainSite === null) return invalid('The main site URL is invalid')
      entries.push({ key: 'main_site', value: mainSite })
    }

    if ('timezone' in input) {
      const timezone = scalarValue(input.timezone).slice(0, 100)
      if (!TIMEZONES.has(timezone)) return invalid('The timezone is invalid')
      entries.push({ key: 'timezone', value: timezone })
    }

    if ('cache_mode' in input) {
      const cacheMode = scalarValue(input.cache_mode)
      if (!isCacheMode(cacheMode)) return invalid('The cache mode is invalid')
      entries.push({ key: 'cache_mode', value: cacheMode })
    }

    for (const key of BOOLEAN_KEYS) {
      if (key in input) entries.push({ key, value: booleanValue(input[key]) ? 'true' : 'false' })
    }

    for (const [key, limits] of Object.entries(INTEGER_FIELDS)) {
      if (!(key in input)) continue
      const value = boundedIntegerString(input[key], limits.minimum, limits.maximum)
      if (value === null) return invalid(`The ${key.replaceAll('_', ' ')} value is invalid`)
      entries.push({ key, value })
    }

    for (const [key, maximum] of Object.entries(TEXT_FIELDS)) {
      if (!(key in input)) continue
      const value = scalarValue(input[key], false)
      if (value.length > maximum) return invalid(`The ${key.replaceAll('_', ' ')} value is too long`)
      entries.push({ key, value })
    }

    if (entries.length === 0) return invalid('No supported settings were submitted')
    await this.store.upsertMany(entries)
    return Object.freeze({ status: 'ok', message: 'The General Settings have been successfully updated' })
  }

  public async publicSettings(): Promise<PublicSettings> {
    const raw = await this.store.getAll()
    const result = {} as Record<PublicSettingKey, string | boolean>
    for (const key of PUBLIC_BOOLEAN_KEYS) result[key] = raw[key] === 'true'
    result.contact_page_link = normalizedOptionalHttpUrl(raw.contact_page_link) ?? ''
    result.public_video_user = positiveId(raw.public_video_user) ?? ''
    return Object.freeze(result)
  }

  public async savePublic(input: Record<string, unknown>): Promise<SettingsMutationResult> {
    const entries: SettingEntry[] = []
    for (const key of PUBLIC_BOOLEAN_KEYS) {
      if (key in input) entries.push({ key, value: booleanValue(input[key]) ? 'true' : 'false' })
    }

    if ('contact_page_link' in input) {
      const contactUrl = normalizedOptionalHttpUrl(input.contact_page_link)
      if (contactUrl === null) return invalid('The contact page URL is invalid')
      entries.push({ key: 'contact_page_link', value: contactUrl })
    }

    if ('public_video_user' in input) {
      const userId = positiveId(input.public_video_user)
      if (userId === null) return invalid('The public video user is invalid')
      entries.push({ key: 'public_video_user', value: userId })
    }

    if (entries.length === 0) return invalid('No supported settings were submitted')
    await this.store.upsertMany(entries)
    return Object.freeze({ status: 'ok', message: 'The Public Settings have been successfully updated' })
  }

  public async smtpSettings(): Promise<SmtpSettings> {
    const raw = await this.store.getAll()
    const provider = raw.smtp_provider ?? ''
    return Object.freeze({
      disable_confirm: raw.disable_confirm === 'true',
      smtp_provider: isSmtpProvider(provider) ? provider : '',
      smtp_host: normalizedSmtpHost(raw.smtp_host) ?? '',
      smtp_port: optionalPort(raw.smtp_port) ?? '',
      smtp_tls: raw.smtp_tls === 'true',
      smtp_email: optionalEmail(raw.smtp_email) ?? '',
      smtp_password_configured: (raw.smtp_password ?? '') !== '',
      smtp_sender: boundedText(raw.smtp_sender, 255) ?? '',
      smtp_reply_email: optionalEmail(raw.smtp_reply_email) ?? '',
      smtp_reply_name: boundedText(raw.smtp_reply_name, 255) ?? ''
    })
  }

  public async saveSmtp(input: Record<string, unknown>): Promise<SettingsMutationResult> {
    const entries: SettingEntry[] = []
    if ('disable_confirm' in input) entries.push({ key: 'disable_confirm', value: booleanValue(input.disable_confirm) ? 'true' : 'false' })
    if ('smtp_tls' in input) entries.push({ key: 'smtp_tls', value: booleanValue(input.smtp_tls) ? 'true' : 'false' })

    if ('smtp_provider' in input) {
      const provider = scalarValue(input.smtp_provider)
      if (!isSmtpProvider(provider)) return invalid('The SMTP provider is invalid')
      entries.push({ key: 'smtp_provider', value: provider })
    }

    if ('smtp_host' in input) {
      const host = normalizedSmtpHost(input.smtp_host)
      if (host === null) return invalid('The SMTP host is invalid')
      entries.push({ key: 'smtp_host', value: host })
    }

    if ('smtp_port' in input) {
      const port = optionalPort(input.smtp_port)
      if (port === null) return invalid('The SMTP port is invalid')
      entries.push({ key: 'smtp_port', value: port })
    }

    for (const key of ['smtp_email', 'smtp_reply_email'] as const) {
      if (!(key in input)) continue
      const email = optionalEmail(input[key])
      if (email === null) return invalid(`The ${key.replaceAll('_', ' ')} is invalid`)
      entries.push({ key, value: email })
    }

    for (const key of ['smtp_sender', 'smtp_reply_name'] as const) {
      if (!(key in input)) continue
      const value = boundedText(input[key], 255)
      if (value === null) return invalid(`The ${key.replaceAll('_', ' ')} is too long`)
      entries.push({ key, value })
    }

    const password = scalarValue(input.smtp_password, false)
    const clearPassword = booleanValue(input.clear_smtp_password)
    if (password !== '' && clearPassword) return invalid('Choose either a new SMTP password or remove the stored password')
    if (password.length > 4_096) return invalid('The SMTP password is too long')
    if (clearPassword) entries.push({ key: 'smtp_password', value: '' })
    else if (password !== '') entries.push({ key: 'smtp_password', value: password })

    if (entries.length === 0) return invalid('No supported settings were submitted')
    await this.store.upsertMany(entries)
    return Object.freeze({ status: 'ok', message: 'The SMTP Settings have been successfully updated' })
  }

  public async siteSettings(): Promise<SiteSettings> {
    const raw = await this.store.getAll()
    const display = raw.pwa_display ?? ''
    return Object.freeze({
      site_name: requiredText(raw.site_name, 100) ?? 'GPlayer',
      site_slogan: requiredText(raw.site_slogan, 200) ?? 'Universal media gateway',
      site_description: requiredText(raw.site_description, 5_000) ?? 'A Node.js media gateway with 63 registered source adapters.',
      custom_color: normalizedHexColor(raw.custom_color) ?? 'ccea59',
      custom_color2: normalizedHexColor(raw.custom_color2) ?? '172019',
      pwa_shortname: requiredText(raw.pwa_shortname, 30) ?? 'GPlayer',
      pwa_themecolor: normalizedHexColor(raw.pwa_themecolor) ?? '0b0e0c',
      pwa_backgroundcolor: normalizedHexColor(raw.pwa_backgroundcolor) ?? '0b0e0c',
      pwa_display: isPwaDisplay(display) ? display : 'standalone'
    })
  }

  public async saveSite(input: Record<string, unknown>): Promise<SettingsMutationResult> {
    const entries: SettingEntry[] = []
    for (const [key, maximum] of Object.entries({ site_name: 100, site_slogan: 200, site_description: 5_000, pwa_shortname: 30 })) {
      if (!(key in input)) continue
      const value = requiredText(input[key], maximum)
      if (value === null) return invalid(`The ${key.replaceAll('_', ' ')} is invalid`)
      entries.push({ key, value })
    }

    for (const key of ['custom_color', 'custom_color2', 'pwa_themecolor', 'pwa_backgroundcolor'] as const) {
      if (!(key in input)) continue
      const color = normalizedHexColor(input[key])
      if (color === null) return invalid(`The ${key.replaceAll('_', ' ')} is invalid`)
      entries.push({ key, value: color })
    }

    if ('pwa_display' in input) {
      const display = scalarValue(input.pwa_display)
      if (!isPwaDisplay(display)) return invalid('The PWA display mode is invalid')
      entries.push({ key: 'pwa_display', value: display })
    }

    if (entries.length === 0) return invalid('No supported settings were submitted')
    await this.store.upsertMany(entries)
    return Object.freeze({ status: 'ok', message: 'The Site Settings have been successfully updated' })
  }

  public async shortlinkSettings(): Promise<ShortlinkSettings> {
    const raw = await this.store.getAll()
    const selected = raw.additional_url_shortener ?? ''
    return Object.freeze({
      disable_shortener_link: raw.disable_shortener_link === 'true',
      additional_url_shortener: isShortenerProviderId(selected) ? selected : 'random',
      providers: Object.freeze(SHORTENER_PROVIDERS.flatMap((provider) => provider.id === 'random' ? [] : [Object.freeze({
        id: provider.id,
        name: provider.name,
        configured: (raw[`additional_url_shortener_${provider.id}`] ?? '') !== ''
      })]))
    })
  }

  public async saveShortlink(input: Record<string, unknown>): Promise<SettingsMutationResult> {
    const entries: SettingEntry[] = []
    if ('disable_shortener_link' in input) entries.push({ key: 'disable_shortener_link', value: booleanValue(input.disable_shortener_link) ? 'true' : 'false' })
    if ('additional_url_shortener' in input) {
      const selected = scalarValue(input.additional_url_shortener)
      if (!isShortenerProviderId(selected)) return invalid('The URL shortener provider is invalid')
      entries.push({ key: 'additional_url_shortener', value: selected })
    }

    for (const provider of SHORTENER_PROVIDERS) {
      if (provider.id === 'random') continue
      const key = `additional_url_shortener_${provider.id}`
      const clearKey = `clear_${key}`
      const apiKey = scalarValue(input[key])
      const clear = booleanValue(input[clearKey])
      if (apiKey !== '' && clear) return invalid(`Choose either a new ${provider.name} API key or remove the stored key`)
      if (apiKey.length > 4_096) return invalid(`The ${provider.name} API key is too long`)
      if (clear) entries.push({ key, value: '' })
      else if (apiKey !== '') entries.push({ key, value: apiKey })
    }

    if (entries.length === 0) return invalid('No supported settings were submitted')
    await this.store.upsertMany(entries)
    return Object.freeze({ status: 'ok', message: 'The Shortlink Settings have been successfully updated' })
  }
}

export function generalSettings(raw: Readonly<Record<string, string>>, defaultBaseUrl: URL): GeneralSettings {
  const result = {} as Record<GeneralSettingKey, string | boolean>
  result.main_site = normalizedHttpUrl(raw.main_site) ?? defaultBaseUrl.toString()
  result.timezone = raw.timezone !== undefined && TIMEZONES.has(raw.timezone) ? raw.timezone : 'UTC'
  result.cache_mode = isCacheMode(raw.cache_mode ?? '') ? raw.cache_mode ?? 'php' : 'php'

  for (const key of BOOLEAN_KEYS) result[key] = raw[key] === 'true'
  for (const [key, limits] of Object.entries(INTEGER_FIELDS)) {
    result[key as keyof typeof INTEGER_FIELDS] = boundedIntegerString(raw[key], limits.minimum, limits.maximum) ?? limits.fallback
  }
  for (const key of Object.keys(TEXT_FIELDS)) result[key as keyof typeof TEXT_FIELDS] = raw[key] ?? ''
  return Object.freeze(result)
}

export function generalBooleanKeys(): ReadonlySet<string> {
  return BOOLEAN_KEY_SET
}

export function timezoneList(): readonly string[] {
  return Object.freeze([...TIMEZONES].sort((left, right) => left.localeCompare(right)))
}

export function shortenerProviderList(): readonly ShortenerProvider[] {
  return SHORTENER_PROVIDERS
}

function normalizedHttpUrl(value: unknown): string | null {
  const candidate = scalarValue(value)
  if (candidate === '') return null
  try {
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
    return url.toString()
  } catch {
    return null
  }
}

function normalizedOptionalHttpUrl(value: unknown): string | null {
  const candidate = scalarValue(value)
  if (candidate === '') return ''
  try {
    const url = new URL(candidate)
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === '' ? url.toString() : null
  } catch {
    return null
  }
}

function positiveId(value: unknown): string | null {
  const candidate = scalarValue(value)
  if (!/^[1-9]\d{0,9}$/.test(candidate)) return null
  try {
    return BigInt(candidate) <= 4_294_967_295n ? candidate : null
  } catch {
    return null
  }
}

function normalizedSmtpHost(value: unknown): string | null {
  const candidate = scalarValue(value).toLowerCase()
  if (candidate === '') return ''
  if (candidate.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?))*$/.test(candidate)) return null
  return candidate
}

function optionalPort(value: unknown): string | null {
  const candidate = scalarValue(value)
  return candidate === '' ? '' : boundedIntegerString(candidate, 1, 65_535)
}

function optionalEmail(value: unknown): string | null {
  const candidate = scalarValue(value)
  if (candidate === '') return ''
  return candidate.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null
}

function boundedText(value: unknown, maximum: number): string | null {
  const candidate = scalarValue(value)
  return candidate.length <= maximum ? candidate : null
}

function requiredText(value: unknown, maximum: number): string | null {
  const candidate = scalarValue(value)
  return candidate !== '' && candidate.length <= maximum ? candidate : null
}

function normalizedHexColor(value: unknown): string | null {
  const candidate = scalarValue(value).replace(/^#/, '').toLowerCase()
  return /^[0-9a-f]{6}$/.test(candidate) ? candidate : null
}

function boundedIntegerString(value: unknown, minimum: number, maximum: number): string | null {
  const candidate = scalarValue(value)
  if (!/^\d+$/.test(candidate)) return null
  const parsed = Number(candidate)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? String(parsed) : null
}

function booleanValue(value: unknown): boolean {
  const values = Array.isArray(value) ? value : [value]
  return values.some((item) => ['1', 'true', 'on', 'yes'].includes(scalarValue(item).toLowerCase()))
}

function scalarValue(value: unknown, trim = true): string {
  const source = Array.isArray(value) ? value.at(-1) : value
  const result = typeof source === 'string' || typeof source === 'number' || typeof source === 'boolean' ? String(source) : ''
  return trim ? result.trim() : result
}

function isCacheMode(value: string): value is typeof CACHE_MODES[number] {
  return (CACHE_MODES as readonly string[]).includes(value)
}

function isSmtpProvider(value: string): value is SmtpProvider {
  return (SMTP_PROVIDERS as readonly string[]).includes(value)
}

function isPwaDisplay(value: string): value is PwaDisplay {
  return (PWA_DISPLAYS as readonly string[]).includes(value)
}

function isShortenerProviderId(value: string): value is ShortenerProviderId {
  return SHORTENER_PROVIDERS.some((provider) => provider.id === value)
}

function invalid(message: string): SettingsMutationResult {
  return Object.freeze({ status: 'invalid', message })
}
