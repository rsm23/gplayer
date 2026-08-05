import { decryptLegacyData, type Security } from '../security/security.js'

const MAX_QUERY_LENGTH = 32_768
const MAIN_ARRAY_KEYS = new Set(['sub', 'lang'])
const MEDIA_KEYS = new Set([
  'host',
  'id',
  'ahost',
  'aid',
  'poster',
  'sub',
  'lang',
  'subs',
  'source',
  'uid',
  'email',
  'download',
  'onlylink'
])

const HOST_ALIASES: Readonly<Record<string, string>> = {
  filelions: 'earnvids',
  vidhide: 'earnvids',
  streamwish: 'streamhg'
}

export type PlayerQueryEncoding = 'security-url' | 'legacy-aes' | 'plaintext' | 'none'

export type PlayerMediaQuery = Readonly<{
  host?: string
  id?: string
  ahost?: string
  aid?: string
  poster?: string
  sub?: readonly string[]
  lang?: readonly string[]
  subs?: string
  source?: string
  uid?: string
  email?: string
  download?: string
  onlylink?: string
  /** Runtime-only metadata hydrated from a saved database video. */
  title?: string
  /** Runtime-only ordered fallbacks; these are never serialized into public tokens. */
  alternatives?: readonly Readonly<{ host: string; id: string }>[]
}>

export type PlayerPublicOptions = Readonly<{
  autoplay: boolean
  mute: boolean
  repeat: boolean
}>

export type ParsePlayerQueryOptions = Readonly<{
  /** Required for the pre-4.8 AES-128 compatibility decoder. */
  secureSalt: string
  /** Plaintext media queries are reserved for the explicit embed2/request route. */
  allowPlaintextMedia?: boolean
  /** Mirrors the allow_public_qry setting in Player::setPublicQueries. */
  allowPublicQuery?: boolean
  publicDefaults?: Partial<PlayerPublicOptions>
}>

export type ParsedPlayerQuery = Readonly<{
  encoding: PlayerQueryEncoding
  media: PlayerMediaQuery | null
  publicOptions: PlayerPublicOptions
  token: string
  errors: readonly string[]
}>

/**
 * Parses the media contract emitted by PublicAjax::createPlayer in 4.8.3.
 *
 * Current links place one authenticated Security::encryptURL token in the
 * query-string key. The old AES-128 envelope remains readable for links made
 * by older releases. Plaintext media values are accepted only when a caller
 * explicitly opts into the legacy embed2/request route.
 */
export function parsePlayerQuery(
  rawQuery: string,
  security: Security,
  options: ParsePlayerQueryOptions
): ParsedPlayerQuery {
  const errors: string[] = []
  const normalizedRawQuery = rawQuery.replace(/^\?/, '')
  const outer = parseQueryFields(normalizedRawQuery)
  const publicOptions = parsePublicOptions(outer, options)

  if (normalizedRawQuery.length === 0) {
    return { encoding: 'none', media: null, publicOptions, token: '', errors }
  }
  if (normalizedRawQuery.length > MAX_QUERY_LENGTH) {
    return {
      encoding: 'none',
      media: null,
      publicOptions,
      token: '',
      errors: [`Query exceeds the ${MAX_QUERY_LENGTH}-byte limit`]
    }
  }

  const token = firstQueryKey(normalizedRawQuery)
  const decrypted = security.decryptURLStrict(token)
  if (decrypted !== null && decrypted.length > 0) {
    const media = normalizeMediaQuery(parseQueryFields(decrypted))
    if (isUsableMediaQuery(media)) {
      return { encoding: 'security-url', media, publicOptions, token, errors }
    }
    errors.push('Authenticated token does not contain a usable media query')
  }

  const legacy = decryptLegacyData(token, options.secureSalt)
  if (legacy.length > 0) {
    const media = normalizeMediaQuery(parseQueryFields(legacy))
    if (isUsableMediaQuery(media)) {
      return { encoding: 'legacy-aes', media, publicOptions, token, errors }
    }
    errors.push('Legacy token does not contain a usable media query')
  }

  if (options.allowPlaintextMedia === true) {
    const media = normalizeMediaQuery(outer)
    if (isUsableMediaQuery(media)) {
      return { encoding: 'plaintext', media, publicOptions, token: '', errors }
    }
    errors.push('Plaintext query does not contain a usable media query')
  } else if (decrypted === null) {
    errors.push('Query token is malformed or failed authentication')
  }

  return { encoding: 'none', media: null, publicOptions, token, errors }
}

/** Reproduces the PHP buildQueryNoIndex helper used by the player generator. */
export function buildPlayerQuery(query: PlayerMediaQuery): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(query)) {
    if (!MEDIA_KEYS.has(key) || value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) parts.push(`${key}[]=${phpUrlEncode(decodeOnce(String(item)))}`)
    } else {
      parts.push(`${key}=${phpUrlEncode(decodeOnce(String(value)))}`)
    }
  }
  return parts.join('&')
}

export function normalizeLegacyHost(host: string): string {
  const normalized = host.trim().toLowerCase()
  return HOST_ALIASES[normalized] ?? normalized
}

function normalizeMediaQuery(fields: ReadonlyMap<string, readonly string[]>): PlayerMediaQuery {
  const result: {
    host?: string
    id?: string
    ahost?: string
    aid?: string
    poster?: string
    sub?: readonly string[]
    lang?: readonly string[]
    subs?: string
    source?: string
    uid?: string
    email?: string
    download?: string
    onlylink?: string
  } = {}

  for (const key of MEDIA_KEYS) {
    const values = fields.get(key)
    if (values === undefined || values.length === 0) continue

    if (MAIN_ARRAY_KEYS.has(key)) {
      const cleaned = values.map((value) => value.trim()).filter(Boolean)
      if (cleaned.length > 0) {
        if (key === 'sub') result.sub = cleaned
        else result.lang = cleaned
      }
      continue
    }

    const value = values.at(-1)?.trim() ?? ''
    if (value.length === 0 && key !== 'poster') continue
    switch (key) {
      case 'host':
        result.host = normalizeLegacyHost(value)
        break
      case 'ahost':
        result.ahost = normalizeLegacyHost(value)
        break
      case 'id': result.id = value; break
      case 'aid': result.aid = value; break
      case 'poster': result.poster = value; break
      case 'subs': result.subs = value; break
      case 'source': result.source = value.toLowerCase(); break
      case 'uid': result.uid = value; break
      case 'email': result.email = value; break
      case 'download': result.download = value; break
      case 'onlylink': result.onlylink = value; break
    }
  }

  return result
}

function isUsableMediaQuery(query: PlayerMediaQuery): boolean {
  if (query.id === undefined || query.id.length === 0) return false
  return (query.host !== undefined && query.host.length > 0) || query.source === 'db'
}

function parsePublicOptions(
  fields: ReadonlyMap<string, readonly string[]>,
  options: ParsePlayerQueryOptions
): PlayerPublicOptions {
  const defaults = {
    autoplay: options.publicDefaults?.autoplay ?? false,
    mute: options.publicDefaults?.mute ?? false,
    repeat: options.publicDefaults?.repeat ?? false
  }
  if (options.allowPublicQuery !== true) return defaults

  return {
    autoplay: phpBoolean(lastValue(fields, 'autoplay'), defaults.autoplay),
    mute: phpBoolean(lastValue(fields, 'mute'), defaults.mute),
    repeat: phpBoolean(lastValue(fields, 'repeat'), defaults.repeat)
  }
}

function parseQueryFields(query: string): ReadonlyMap<string, readonly string[]> {
  const fields = new Map<string, string[]>()
  for (const [rawKey, value] of new URLSearchParams(query)) {
    const key = rawKey.endsWith('[]') ? rawKey.slice(0, -2) : rawKey
    if (key.length === 0 || key === '__proto__' || key === 'prototype' || key === 'constructor') {
      continue
    }
    const values = fields.get(key) ?? []
    // PHP parse_str keeps the last scalar value but appends bracket-array values.
    if (!rawKey.endsWith('[]') && !MAIN_ARRAY_KEYS.has(key)) values.length = 0
    values.push(value)
    fields.set(key, values)
  }
  return fields
}

function firstQueryKey(query: string): string {
  const firstPart = query.split('&', 1)[0] ?? ''
  const rawKey = firstPart.split('=', 1)[0] ?? ''
  try {
    return decodeURIComponent(rawKey.replaceAll('+', ' '))
  } catch {
    return ''
  }
}

function lastValue(fields: ReadonlyMap<string, readonly string[]>, key: string): string | undefined {
  return fields.get(key)?.at(-1)
}

function phpBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return ['1', 'true', 'on', 'yes'].includes(value.trim().toLowerCase())
}

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '))
  } catch {
    return value
  }
}

function phpUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll('%20', '+')
}
