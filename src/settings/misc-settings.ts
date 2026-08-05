import { isIP } from 'node:net'
import countries from '../../resources/data/json/countries.json' with { type: 'json' }
import hostLabels from '../../resources/data/json/host-list.json' with { type: 'json' }

export const MISC_RESOLUTION_OPTIONS = Object.freeze([
  'Default',
  ...Array.from({ length: 10 }, (_value, index) => String((index + 1) * 100)),
  'Original'
] as const)

export const MISC_COUNTRY_OPTIONS = Object.freeze(
  Object.entries(countries)
    .sort((left, right) => left[1].localeCompare(right[1]))
    .map(([code, name]) => Object.freeze({ code, name }))
)

const BOOLEAN_KEYS = Object.freeze(['disable_proxy', 'free_proxy', 'block_vpn'] as const)
const PROXY_TYPES = new Set(['http', 'http1.0', 'https', 'socks4', 'socks4a', 'socks5'])
const COUNTRY_CODES = new Set(Object.keys(countries))
const RESOLUTION_VALUES = new Set<string>(MISC_RESOLUTION_OPTIONS)
const MAX_LIST_ITEMS = 1_000
const MAX_PROXY_ITEMS = 500

export type MiscHostOption = Readonly<{ value: string; label: string }>

export type MiscSettings = Readonly<{
  bypass_host: readonly string[]
  disable_host: readonly string[]
  disable_resolution: readonly string[]
  disable_proxy: boolean
  free_proxy: boolean
  proxy_list_configured: boolean
  proxy_count: number
  domain_whitelisted: string
  domain_blacklisted: string
  link_blacklisted: string
  word_blacklisted: string
  banned_countries: readonly string[]
  block_vpn: boolean
  block_vpn_list: string
}>

export type MiscSettingEntry = Readonly<{ key: string; value: string }>
export type RuntimeProxySettings = Readonly<{
  disabled: boolean
  proxies: readonly ProxyDefinition[]
}>
export type MiscSettingsMutation =
  | Readonly<{ status: 'ok'; entries: readonly MiscSettingEntry[] }>
  | Readonly<{ status: 'invalid'; message: string }>

export function miscHostOptions(supportedHosts: ReadonlySet<string>): readonly MiscHostOption[] {
  return Object.freeze(
    [...supportedHosts]
      .sort((left, right) => hostLabel(left).localeCompare(hostLabel(right)))
      .map((value) => Object.freeze({ value, label: hostLabel(value) }))
  )
}

export function miscSettings(
  raw: Readonly<Record<string, string>>,
  supportedHosts: ReadonlySet<string>
): MiscSettings {
  const proxies = raw.proxy_list === undefined ? [] : normalizedStoredLines(raw.proxy_list, MAX_PROXY_ITEMS)
  return Object.freeze({
    bypass_host: storedJsonSelection(raw.bypass_host, supportedHosts),
    disable_host: storedJsonSelection(raw.disable_host, supportedHosts),
    disable_resolution: storedJsonSelection(raw.disable_resolution, RESOLUTION_VALUES),
    disable_proxy: raw.disable_proxy === 'true',
    free_proxy: raw.free_proxy === 'true',
    proxy_list_configured: proxies.length > 0,
    proxy_count: proxies.length,
    domain_whitelisted: storedNormalizedList(raw.domain_whitelisted, normalizeDomain, 500),
    domain_blacklisted: storedNormalizedList(raw.domain_blacklisted, normalizeDomain, 500),
    link_blacklisted: storedNormalizedList(raw.link_blacklisted, normalizeReferer, 500),
    word_blacklisted: storedNormalizedList(raw.word_blacklisted, normalizeWord, MAX_LIST_ITEMS),
    banned_countries: storedJsonSelection(raw.banned_countries, COUNTRY_CODES),
    block_vpn: raw.block_vpn === 'true',
    block_vpn_list: storedNormalizedList(raw.block_vpn_list, normalizeVpnPrefix, MAX_LIST_ITEMS)
  })
}

export function runtimeProxySettings(raw: Readonly<Record<string, string>>): RuntimeProxySettings {
  const proxies: ProxyDefinition[] = []
  const seen = new Set<string>()
  for (const value of normalizedStoredLines(raw.proxy_list ?? '', MAX_PROXY_ITEMS)) {
    const proxy = parseProxyDefinition(value)
    if (proxy === null || seen.has(proxy.format)) continue
    seen.add(proxy.format)
    proxies.push(proxy)
  }
  return Object.freeze({
    disabled: raw.disable_proxy === 'true',
    proxies: Object.freeze(proxies)
  })
}

export function parseMiscSettingsSubmission(
  input: Record<string, unknown>,
  raw: Readonly<Record<string, string>>,
  supportedHosts: ReadonlySet<string>
): MiscSettingsMutation {
  const entries: MiscSettingEntry[] = []
  for (const key of BOOLEAN_KEYS) {
    if (key in input) entries.push({ key, value: booleanValue(input[key]) ? 'true' : 'false' })
  }

  for (const [key, allowed] of [
    ['bypass_host', supportedHosts],
    ['disable_host', supportedHosts],
    ['disable_resolution', RESOLUTION_VALUES],
    ['banned_countries', COUNTRY_CODES]
  ] as const) {
    if (!(key in input) && !(`${key}[]` in input)) continue
    const values = uniqueStrings(input[`${key}[]`] ?? input[key])
    if (values.length > MAX_LIST_ITEMS || values.some((value) => !allowed.has(value))) {
      return invalid(`The ${key.replaceAll('_', ' ')} selection is invalid`)
    }
    entries.push({ key, value: JSON.stringify(values.sort((left, right) => left.localeCompare(right))) })
  }

  const lineFields = [
    ['domain_whitelisted', normalizeDomain, 500, 'Allowed embed domains/IPs'],
    ['domain_blacklisted', normalizeDomain, 500, 'Blacklisted domains/IPs'],
    ['link_blacklisted', normalizeReferer, 500, 'Blacklisted referer URLs'],
    ['word_blacklisted', normalizeWord, MAX_LIST_ITEMS, 'Blacklisted words'],
    ['block_vpn_list', normalizeVpnPrefix, MAX_LIST_ITEMS, 'Proxy/VPN prefixes']
  ] as const
  for (const [key, normalize, maximum, label] of lineFields) {
    if (!(key in input)) continue
    const parsed = normalizedSubmittedList(input[key], normalize, maximum)
    if (parsed === null) return invalid(`${label} contain an invalid or excessive entry`)
    entries.push({ key, value: parsed.join('\n') })
  }

  const proxySubmitted = 'proxy_list' in input
  const clearProxyList = booleanValue(input.clear_proxy_list)
  const proxyText = proxySubmitted ? scalar(input.proxy_list, false).trim() : ''
  if (proxyText !== '' && clearProxyList) return invalid('Choose either a replacement proxy list or clear the stored list')
  if (proxyText !== '') {
    const proxies = normalizedSubmittedList(proxyText, normalizeProxy, MAX_PROXY_ITEMS)
    if (proxies === null) return invalid('The proxy list contains an invalid endpoint or more than 500 entries')
    entries.push({ key: 'proxy_list', value: proxies.join('\n') })
  } else if (clearProxyList && (raw.proxy_list ?? '').trim() !== '') {
    entries.push({ key: 'proxy_list', value: '' })
  }

  if (entries.length === 0) return invalid('No supported settings were submitted')
  return Object.freeze({ status: 'ok', entries: Object.freeze(entries) })
}

function storedJsonSelection(value: string | undefined, allowed: ReadonlySet<string>): readonly string[] {
  if (value === undefined || value.length > 1_000_000) return Object.freeze([])
  try {
    const decoded: unknown = JSON.parse(value)
    if (!Array.isArray(decoded)) return Object.freeze([])
    return Object.freeze(uniqueStrings(decoded).filter((entry) => allowed.has(entry)).slice(0, MAX_LIST_ITEMS))
  } catch {
    return Object.freeze([])
  }
}

function storedNormalizedList(
  value: string | undefined,
  normalize: (value: string) => string | null,
  maximum: number
): string {
  if (value === undefined || value.length > 1_000_000) return ''
  return normalizedStoredLines(value, maximum).flatMap((entry) => {
    const normalized = normalize(entry)
    return normalized === null ? [] : [normalized]
  }).filter((entry, index, list) => list.indexOf(entry) === index).join('\n')
}

function normalizedStoredLines(value: string, maximum: number): string[] {
  return value.split(/\r\n|\n|\r/).map((entry) => entry.trim()).filter(Boolean).slice(0, maximum)
}

function normalizedSubmittedList(
  value: unknown,
  normalize: (value: string) => string | null,
  maximum: number
): string[] | null {
  const raw = scalar(value, false)
  if (raw.length > 1_000_000) return null
  const lines = raw.split(/\r\n|\n|\r/).map((entry) => entry.trim()).filter(Boolean)
  if (lines.length > maximum) return null
  const result: string[] = []
  for (const line of lines) {
    const normalized = normalize(line)
    if (normalized === null) return null
    if (!result.includes(normalized)) result.push(normalized)
  }
  return result
}

function normalizeDomain(value: string): string | null {
  const withoutScheme = value.replace(/^https?:\/\//i, '')
  if (value.length > 253 || /[/?#@\s]/.test(withoutScheme)) return null
  if (isIP(withoutScheme) === 6) return `[${withoutScheme.toLowerCase()}]`
  try {
    const target = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) return null
    const hostname = target.hostname.toLowerCase().replace(/^www\./, '')
    if (!validHostname(hostname)) return null
    const port = target.port !== '' && target.port !== '80' && target.port !== '443' ? `:${target.port}` : ''
    return `${hostname}${port}`
  } catch {
    return null
  }
}

function normalizeReferer(value: string): string | null {
  if (value.length > 4_096 || /\s/.test(value)) return null
  try {
    const target = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) return null
    const hostname = target.hostname.toLowerCase().replace(/^www\./, '')
    if (!validHostname(hostname)) return null
    const port = target.port !== '' && target.port !== '80' && target.port !== '443' ? `:${target.port}` : ''
    const path = `${target.pathname}${target.search}`.replace(/^\/+|\/+$/g, '')
    return `${hostname}${port}${path === '' ? '' : `/${path}`}`
  } catch {
    return null
  }
}

function normalizeWord(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase('en-US')
  if (normalized.length === 0 || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) return null
  return normalized
}

function normalizeVpnPrefix(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0 || normalized.length > 64) return null
  if (normalized.includes('/')) {
    const [address, bits, ...remainder] = normalized.split('/')
    const version = isIP(address ?? '')
    if (version === 0 || remainder.length > 0 || !/^\d+$/.test(bits ?? '')) return null
    const prefix = Number(bits)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > (version === 4 ? 32 : 128)) return null
    return `${address}/${prefix}`
  }
  if (isIP(normalized) !== 0) return normalized
  if (/^(?:\d{1,3}\.){1,3}$/.test(normalized)) {
    return normalized.slice(0, -1).split('.').every((part) => Number(part) <= 255) ? normalized : null
  }
  if (normalized.endsWith(':') && normalized.includes(':') && /^[0-9a-f:]+$/.test(normalized) && !normalized.includes(':::')) return normalized
  return null
}

export type ProxyType = 'http' | 'http1.0' | 'https' | 'socks4' | 'socks4a' | 'socks5'
export type ProxyDefinition = Readonly<{
  format: string
  hostname: string
  port: number
  type: ProxyType
  username: string
  password: string
}>

export function parseProxyDefinition(value: string): ProxyDefinition | null {
  if (value.length === 0 || value.length > 8_192 || /[\u0000-\u001f\u007f]/.test(value)) return null
  const parts = value.split(',').map((entry) => entry.trim())
  if (parts.length < 1 || parts.length > 3 || parts.some((entry) => entry === '')) return null
  const endpoint = parts[0] ?? ''
  const endpointParts = proxyEndpoint(endpoint)
  if (endpointParts === null) return null

  let credentials = ''
  let type: ProxyType = 'http'
  if (parts.length === 2) {
    const second = (parts[1] ?? '').toLowerCase()
    if (isProxyType(second)) type = second
    else credentials = validProxyCredentials(parts[1] ?? '') ? parts[1] ?? '' : ''
    if (credentials === '' && !isProxyType(second)) return null
  } else if (parts.length === 3) {
    credentials = validProxyCredentials(parts[1] ?? '') ? parts[1] ?? '' : ''
    const candidateType = (parts[2] ?? '').toLowerCase()
    if (credentials === '' || !isProxyType(candidateType)) return null
    type = candidateType
  }
  const separator = credentials.indexOf(':')
  const username = separator < 0 ? '' : credentials.slice(0, separator)
  const password = separator < 0 ? '' : credentials.slice(separator + 1)
  const explicitType = parts.length > 1 && (parts.length === 3 || isProxyType((parts[1] ?? '').toLowerCase()))
  return Object.freeze({
    format: [endpoint, credentials, explicitType ? type : ''].filter(Boolean).join(','),
    hostname: endpointParts.hostname,
    port: endpointParts.port,
    type,
    username,
    password
  })
}

function normalizeProxy(value: string): string | null {
  return parseProxyDefinition(value)?.format ?? null
}

function proxyEndpoint(value: string): Readonly<{ hostname: string; port: number }> | null {
  const bracketed = /^\[([^\]]+)]:(\d{1,5})$/.exec(value)
  if (bracketed !== null) {
    const hostname = bracketed[1] ?? ''
    const port = bracketed[2] ?? ''
    return isIP(hostname) === 6 && validPort(port) ? Object.freeze({ hostname, port: Number(port) }) : null
  }
  const separator = value.lastIndexOf(':')
  if (separator < 1) return null
  const hostname = value.slice(0, separator)
  const port = value.slice(separator + 1)
  return isIP(hostname) === 4 && validPort(port) ? Object.freeze({ hostname, port: Number(port) }) : null
}

function isProxyType(value: string): value is ProxyType {
  return PROXY_TYPES.has(value)
}

function validPort(value: string): boolean {
  if (!/^\d+$/.test(value)) return false
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65_535
}

function validProxyCredentials(value: string): boolean {
  const separator = value.indexOf(':')
  if (separator < 1 || separator === value.length - 1) return false
  const username = value.slice(0, separator)
  const password = value.slice(separator + 1)
  return username.length <= 512 && password.length <= 4_096 && !/[\s,]/.test(username) && !/[\s,]/.test(password)
}

function validHostname(value: string): boolean {
  const address = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  if (isIP(address) !== 0) return true
  return value.length <= 253 && value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
}

function uniqueStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value]
  return [...new Set(values.map((entry) => String(entry).trim()).filter(Boolean))]
}

function booleanValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => booleanValue(entry))
  return value === true || value === 1 || String(value).toLowerCase() === 'true' || String(value) === '1' || String(value).toLowerCase() === 'on'
}

function scalar(value: unknown, trim = true): string {
  const selected = Array.isArray(value) ? value.at(-1) : value
  const normalized = selected === undefined || selected === null ? '' : String(selected)
  return trim ? normalized.trim() : normalized
}

function hostLabel(value: string): string {
  return (hostLabels as Record<string, string>)[value] ?? value.replaceAll('-', ' ').replace(/^./, (character) => character.toUpperCase())
}

function invalid(message: string): MiscSettingsMutation {
  return Object.freeze({ status: 'invalid', message })
}
