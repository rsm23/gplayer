import languages from '../../resources/data/json/languages.json' with { type: 'json' }

export const PLAYER_CHOICES = Object.freeze([
  Object.freeze({ value: 'jwplayer', label: 'JW Player' }),
  Object.freeze({ value: 'plyr', label: 'Plyr' })
] as const)
export const PLAYER_SKINS = Object.freeze(['', 'dropload', 'hotstar', 'iqiyi', 'lulustream', 'netflix'] as const)
export const PLAYER_STRETCHING = Object.freeze(['uniform', 'exactfit', 'fill', 'none'] as const)
export const PLAYER_PRELOAD = Object.freeze(['auto', 'metadata', 'none'] as const)
export const PLAYER_RESOLUTIONS = Object.freeze(['Auto', 'Default', 'Original', ...Array.from({ length: 12 }, (_, index) => String((index + 1) * 100)), '1400', '2000', '4000'] as const)
export const PLAYER_FONTS = Object.freeze(['Arial', 'Courier', 'Georgia', 'Impact', 'Lucida Console', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'] as const)
export const PLAYER_EDGE_STYLES = Object.freeze(['none', 'raised', 'depressed', 'uniform', 'dropShadow'] as const)
export const PLAYER_LOGO_POSITIONS = Object.freeze(['top-right', 'top-left', 'bottom-right', 'bottom-left'] as const)
export const PLAYER_LOADERS = Object.freeze(['cube-1', 'cube-2', 'cube-3', 'gradient-stroke-bounce', 'hotstar', 'loader-2', 'loader-3', 'loader', 'multi-color-1', 'multi-color-2', 'multi-color-3', 'multi-color-4', 'multi-color-5', 'multi-color-6', 'multi-color-7', 'preloader-infinity'] as const)
export const PLAYER_LANGUAGE_OPTIONS = Object.freeze([
  Object.freeze({ key: 'unknown', value: 'Unknown' }),
  ...Object.entries(languages).sort((left, right) => left[1].localeCompare(right[1])).map(([key, value]) => Object.freeze({ key, value }))
])

export const DEFAULT_TORRENT_TRACKERS = Object.freeze([
  'wss://tracker.novage.com.ua',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz'
])

export const DEFAULT_IFRAME_CODE = '<iframe title="{title}" src="{embed_url}" width="640" height="320" loading="lazy" allow="fullscreen; accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; geolocation; web-share; screen-wake-lock; idle-detection"></iframe>'

const BOOLEAN_KEYS = Object.freeze([
  'autoplay',
  'mute',
  'repeat',
  'display_title',
  'playback_rate',
  'enable_share_button',
  'enable_download_button',
  'disable_filmstrip',
  'fake_play_button',
  'continue_watching',
  'pause_on_left',
  'allow_public_qry',
  'force_default_poster',
  'logo_hide',
  'p2p',
  'hide_hostname'
] as const)
const COLOR_KEYS = Object.freeze(['player_color', 'player_color2', 'subtitle_color', 'background_color', 'window_color'] as const)
const URL_KEYS = Object.freeze(['poster', 'logo_file', 'logo_open_link', 'small_logo_file', 'small_logo_link'] as const)
const TEXT_LIMITS = Object.freeze({
  text_title: 1_000,
  text_loading: 1_000,
  text_download: 1_000,
  text_resume: 5_000,
  text_resume_yes: 500,
  text_resume_no: 500,
  text_rewind: 500,
  text_forward: 500,
  iframe_code: 100_000
})
const RESERVED_SLUGS = new Set([
  '400', '401', '403', '404', '405', '429', '500', '502', '503', 'administrator', 'ads', 'ajax', 'api', 'api-config',
  'assets', 'changelog', 'dmca', 'filmstrip', 'health-check', 'hls', 'mpd', 'offline', 'ping', 'poster', 'privacy',
  'redirect', 'sharer', 'sitemap', 'stream', 'stream-seg', 'stream-ts', 'stream-vid', 'subtitle', 'terms', 'uploads'
])

export type PlayerSettingsDefaults = Readonly<{
  embed: string
  download: string
  request: string
  adminDirectory?: string
}>

export type PlayerChoice = typeof PLAYER_CHOICES[number]['value']
export type PlayerSkin = typeof PLAYER_SKINS[number]
export type PlayerStretching = typeof PLAYER_STRETCHING[number]
export type PlayerPreload = typeof PLAYER_PRELOAD[number]
export type PlayerResolution = typeof PLAYER_RESOLUTIONS[number]
export type PlayerFont = typeof PLAYER_FONTS[number]
export type PlayerEdgeStyle = typeof PLAYER_EDGE_STYLES[number]
export type PlayerLogoPosition = typeof PLAYER_LOGO_POSITIONS[number]
export type PlayerLoader = typeof PLAYER_LOADERS[number]

export type PlayerSettings = Readonly<{
  player: PlayerChoice
  player_skin: PlayerSkin
  player_color: string
  player_color2: string
  stretching: PlayerStretching
  preload: PlayerPreload
  default_resolution: PlayerResolution
  default_audio: string
  autoplay: boolean
  mute: boolean
  repeat: boolean
  display_title: boolean
  playback_rate: boolean
  enable_share_button: boolean
  enable_download_button: boolean
  disable_filmstrip: boolean
  fake_play_button: boolean
  continue_watching: boolean
  pause_on_left: boolean
  allow_public_qry: boolean
  default_subtitle: string
  subtitle_color: string
  font_family: PlayerFont
  edge_style: PlayerEdgeStyle
  background_opacity: string
  background_color: string
  window_opacity: string
  window_color: string
  poster: string
  force_default_poster: boolean
  logo_file: string
  logo_open_link: string
  logo_position: PlayerLogoPosition
  logo_margin: string
  logo_hide: boolean
  small_logo_file: string
  small_logo_link: string
  p2p: boolean
  torrent_tracker: string
  text_title: string
  loader: PlayerLoader
  text_loading: string
  text_download: string
  text_resume: string
  text_resume_yes: string
  text_resume_no: string
  text_rewind: string
  text_forward: string
  hide_hostname: boolean
  slug_embed: string
  slug_download: string
  slug_request: string
  iframe_code: string
}>

export type PlayerSettingEntry = Readonly<{ key: string; value: string }>
export type PlayerSettingsMutation =
  | Readonly<{ status: 'ok'; entries: readonly PlayerSettingEntry[] }>
  | Readonly<{ status: 'invalid'; message: string }>

export function playerSettings(
  raw: Readonly<Record<string, string>>,
  defaultSlugs: PlayerSettingsDefaults
): PlayerSettings {
  const slugs = normalizedPlayerSlugs(raw, defaultSlugs)
  return Object.freeze({
    player: member(raw.player, PLAYER_CHOICES.map(({ value }) => value), 'jwplayer'),
    player_skin: member(raw.player_skin, PLAYER_SKINS, 'netflix'),
    player_color: color(raw.player_color, 'e50914'),
    player_color2: color(raw.player_color2, 'e50914'),
    stretching: member(raw.stretching, PLAYER_STRETCHING, 'uniform'),
    preload: member(raw.preload, PLAYER_PRELOAD, 'metadata'),
    default_resolution: member(raw.default_resolution, PLAYER_RESOLUTIONS, '700'),
    default_audio: languageValue(raw.default_audio, 'English'),
    ...booleanSettings(raw),
    default_subtitle: languageValue(raw.default_subtitle, 'Indonesian'),
    subtitle_color: color(raw.subtitle_color, 'ffff00'),
    font_family: member(raw.font_family, PLAYER_FONTS, 'Arial'),
    edge_style: member(raw.edge_style, PLAYER_EDGE_STYLES, 'dropShadow'),
    background_opacity: boundedInteger(raw.background_opacity, 0, 100, '75'),
    background_color: color(raw.background_color, '000000'),
    window_opacity: boundedInteger(raw.window_opacity, 0, 100, '0'),
    window_color: color(raw.window_color, '000000'),
    poster: optionalHttpUrl(raw.poster),
    logo_file: optionalHttpUrl(raw.logo_file),
    logo_open_link: optionalHttpUrl(raw.logo_open_link),
    logo_position: member(raw.logo_position, PLAYER_LOGO_POSITIONS, 'top-right'),
    logo_margin: boundedInteger(raw.logo_margin, 0, 1_000, '0'),
    small_logo_file: optionalHttpUrl(raw.small_logo_file),
    small_logo_link: optionalHttpUrl(raw.small_logo_link),
    torrent_tracker: normalizedTrackers(raw.torrent_tracker) ?? DEFAULT_TORRENT_TRACKERS.join('\n'),
    text_title: boundedText(raw.text_title, TEXT_LIMITS.text_title, 'Watch {title} - {siteName}'),
    loader: member(raw.loader, PLAYER_LOADERS, 'loader'),
    text_loading: boundedText(raw.text_loading, TEXT_LIMITS.text_loading, ''),
    text_download: boundedText(raw.text_download, TEXT_LIMITS.text_download, 'Download {title}'),
    text_resume: boundedText(raw.text_resume, TEXT_LIMITS.text_resume, 'Resume at hh:mm:ss'),
    text_resume_yes: boundedText(raw.text_resume_yes, TEXT_LIMITS.text_resume_yes, 'Yes'),
    text_resume_no: boundedText(raw.text_resume_no, TEXT_LIMITS.text_resume_no, 'No'),
    text_rewind: boundedText(raw.text_rewind, TEXT_LIMITS.text_rewind, 'Rewind 10 Seconds'),
    text_forward: boundedText(raw.text_forward, TEXT_LIMITS.text_forward, 'Forward 10 Seconds'),
    slug_embed: slugs.embed,
    slug_download: slugs.download,
    slug_request: slugs.request,
    iframe_code: boundedText(raw.iframe_code, TEXT_LIMITS.iframe_code, DEFAULT_IFRAME_CODE)
  })
}

export function parsePlayerSettingsSubmission(
  input: Record<string, unknown>,
  raw: Readonly<Record<string, string>>,
  defaultSlugs: PlayerSettingsDefaults
): PlayerSettingsMutation {
  const entries: PlayerSettingEntry[] = []
  for (const key of BOOLEAN_KEYS) {
    if (key in input) entries.push({ key, value: booleanValue(input[key]) ? 'true' : 'false' })
  }

  const enumFields = [
    ['player', PLAYER_CHOICES.map(({ value }) => value)],
    ['player_skin', PLAYER_SKINS],
    ['stretching', PLAYER_STRETCHING],
    ['preload', PLAYER_PRELOAD],
    ['default_resolution', PLAYER_RESOLUTIONS],
    ['font_family', PLAYER_FONTS],
    ['edge_style', PLAYER_EDGE_STYLES],
    ['logo_position', PLAYER_LOGO_POSITIONS],
    ['loader', PLAYER_LOADERS]
  ] as const
  for (const [key, allowed] of enumFields) {
    if (!(key in input)) continue
    const value = scalar(input[key])
    if (!allowed.some((candidate) => candidate === value)) return invalid(`The ${key.replaceAll('_', ' ')} value is invalid`)
    entries.push({ key, value })
  }

  for (const key of COLOR_KEYS) {
    if (!(key in input)) continue
    const value = scalar(input[key]).replace(/^#/, '').toLowerCase()
    if (!/^[a-f0-9]{6}$/.test(value)) return invalid(`The ${key.replaceAll('_', ' ')} value is invalid`)
    entries.push({ key, value })
  }

  for (const key of ['default_audio', 'default_subtitle'] as const) {
    if (!(key in input)) continue
    const value = languageValue(scalar(input[key]), '')
    if (value === '') return invalid(`The ${key.replaceAll('_', ' ')} language is invalid`)
    entries.push({ key, value })
  }

  for (const [key, minimum, maximum] of [['background_opacity', 0, 100], ['window_opacity', 0, 100], ['logo_margin', 0, 1_000]] as const) {
    if (!(key in input)) continue
    const value = strictBoundedInteger(input[key], minimum, maximum)
    if (value === null) return invalid(`The ${key.replaceAll('_', ' ')} value is invalid`)
    entries.push({ key, value })
  }

  for (const key of URL_KEYS) {
    if (!(key in input)) continue
    const value = normalizedOptionalHttpUrl(input[key])
    if (value === null) return invalid(`The ${key.replaceAll('_', ' ')} URL is invalid`)
    entries.push({ key, value })
  }

  if ('torrent_tracker' in input) {
    const value = normalizedTrackers(scalar(input.torrent_tracker, false))
    if (value === null) return invalid('Torrent trackers must contain no more than 100 valid ws:// or wss:// URLs')
    entries.push({ key: 'torrent_tracker', value })
  }

  for (const [key, maximum] of Object.entries(TEXT_LIMITS)) {
    if (!(key in input)) continue
    const value = scalar(input[key], false)
    if (value.length > maximum) return invalid(`The ${key.replaceAll('_', ' ')} value is too long`)
    if (key === 'iframe_code' && (!value.includes('{embed_url}') || !value.includes('{title}'))) {
      return invalid('The custom embed code must contain both {embed_url} and {title}')
    }
    entries.push({ key, value })
  }

  const current = playerSettings({ ...raw, ...Object.fromEntries(entries.map(({ key, value }) => [key, value])) }, defaultSlugs)
  for (const key of ['slug_embed', 'slug_download', 'slug_request'] as const) {
    if (!(key in input)) continue
    const value = scalar(input[key]).replace(/^\/+|\/+$/g, '').toLowerCase()
    if (!validSlug(value) || reservedSlugs(defaultSlugs).has(value)) return invalid(`The ${key.replaceAll('_', ' ')} value is invalid or reserved`)
    entries.push({ key, value })
  }
  const submittedSlugs = {
    slug_embed: entries.find(({ key }) => key === 'slug_embed')?.value ?? current.slug_embed,
    slug_download: entries.find(({ key }) => key === 'slug_download')?.value ?? current.slug_download,
    slug_request: entries.find(({ key }) => key === 'slug_request')?.value ?? current.slug_request
  }
  if (new Set(Object.values(submittedSlugs)).size !== 3) return invalid('Embed, download, and request slugs must be different')

  if (entries.length === 0) return invalid('No supported settings were submitted')
  return Object.freeze({ status: 'ok', entries: Object.freeze(entries) })
}

export function languageEntry(value: string): Readonly<{ key: string; value: string }> {
  const normalized = value.trim().toLowerCase()
  return PLAYER_LANGUAGE_OPTIONS.find((item) => item.key.toLowerCase() === normalized || item.value.toLowerCase() === normalized)
    ?? Object.freeze({ key: 'unknown', value: 'Unknown' })
}

function booleanSettings(raw: Readonly<Record<string, string>>): Record<typeof BOOLEAN_KEYS[number], boolean> {
  const result = {} as Record<typeof BOOLEAN_KEYS[number], boolean>
  for (const key of BOOLEAN_KEYS) result[key] = raw[key] === 'true'
  result.playback_rate = raw.playback_rate === undefined || raw.playback_rate === 'true'
  result.enable_share_button = raw.enable_share_button === undefined || raw.enable_share_button === 'true'
  result.enable_download_button = raw.enable_download_button === undefined || raw.enable_download_button === 'true'
  result.allow_public_qry = raw.allow_public_qry === undefined || raw.allow_public_qry === 'true'
  return result
}

function member<const T extends readonly string[]>(value: string | undefined, values: T, fallback: T[number]): T[number] {
  return values.includes(value ?? '') ? value as T[number] : fallback
}

function languageValue(value: string | undefined, fallback: string): string {
  if (value === undefined || value.trim() === '') return fallback
  const normalized = value.trim().toLowerCase()
  return PLAYER_LANGUAGE_OPTIONS.find((item) => item.key.toLowerCase() === normalized || item.value.toLowerCase() === normalized)?.value ?? fallback
}

function color(value: string | undefined, fallback: string): string {
  const normalized = (value ?? '').trim().replace(/^#/, '').toLowerCase()
  return /^[a-f0-9]{6}$/.test(normalized) ? normalized : fallback
}

function boundedInteger(value: string | undefined, minimum: number, maximum: number, fallback: string): string {
  return strictBoundedInteger(value, minimum, maximum) ?? fallback
}

function strictBoundedInteger(value: unknown, minimum: number, maximum: number): string | null {
  const normalized = scalar(value)
  if (!/^[0-9]+$/.test(normalized)) return null
  const number = Number(normalized)
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? String(number) : null
}

function boundedText(value: string | undefined, maximum: number, fallback: string): string {
  return value !== undefined && value.length <= maximum ? value : fallback
}

function optionalHttpUrl(value: string | undefined): string {
  return normalizedOptionalHttpUrl(value) ?? ''
}

function normalizedOptionalHttpUrl(value: unknown): string | null {
  const normalized = scalar(value)
  if (normalized === '') return ''
  try {
    const url = new URL(normalized)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

function normalizedTrackers(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return DEFAULT_TORRENT_TRACKERS.join('\n')
  const trackers = value.split(/\r\n|\n|\r/).map((item) => item.trim()).filter(Boolean)
  if (trackers.length > 100) return null
  const result: string[] = []
  for (const tracker of trackers) {
    try {
      const url = new URL(tracker)
      if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.username || url.password) return null
      result.push(url.toString())
    } catch {
      return null
    }
  }
  return [...new Set(result)].join('\n')
}

function validSlug(value: string | undefined): value is string {
  return value !== undefined && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
}

function normalizedPlayerSlugs(
  raw: Readonly<Record<string, string>>,
  defaults: PlayerSettingsDefaults
): Readonly<{ embed: string; download: string; request: string }> {
  const reserved = reservedSlugs(defaults)
  const safeDefaults = [defaults.embed, defaults.download, defaults.request]
    .map((value, index) => validSlug(value) && !reserved.has(value) ? value : ['e', 'd', 'r'][index] ?? 'e')
  const fallback = new Set(safeDefaults).size === 3 ? safeDefaults : ['e', 'd', 'r']
  const selected = [raw.slug_embed, raw.slug_download, raw.slug_request]
    .map((value, index) => validSlug(value) && !reserved.has(value) ? value : fallback[index] ?? 'e')
  const result = new Set(selected).size === 3 ? selected : fallback
  return Object.freeze({ embed: result[0] ?? 'e', download: result[1] ?? 'd', request: result[2] ?? 'r' })
}

function reservedSlugs(defaults: PlayerSettingsDefaults): ReadonlySet<string> {
  const result = new Set(RESERVED_SLUGS)
  if (defaults.adminDirectory !== undefined && validSlug(defaults.adminDirectory.toLowerCase())) {
    result.add(defaults.adminDirectory.toLowerCase())
  }
  return result
}

function scalar(value: unknown, trim = true): string {
  const result = Array.isArray(value) ? value.at(-1) : value
  const text = typeof result === 'string' ? result : result === undefined || result === null ? '' : String(result)
  return trim ? text.trim() : text
}

function booleanValue(value: unknown): boolean {
  return ['1', 'true', 'on', 'yes'].includes(scalar(value).toLowerCase())
}

function invalid(message: string): PlayerSettingsMutation {
  return Object.freeze({ status: 'invalid', message })
}
