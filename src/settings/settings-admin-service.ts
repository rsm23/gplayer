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

function invalid(message: string): SettingsMutationResult {
  return Object.freeze({ status: 'invalid', message })
}
