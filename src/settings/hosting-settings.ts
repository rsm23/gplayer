import hostLabels from '../../resources/data/json/host-list.json' with { type: 'json' }
import { legacyHostingData, type HostingData } from '../core/hosting-data.js'

const COOKIE_LIMIT = 32_768
const HOSTNAME_LIMIT = 100
const MAP_LIMIT = 1_000_000

export type HostingProviderSettings = Readonly<{
  host: string
  label: string
  cookieConfigured: boolean
  customHostnames: string
  downloadUrl: string
  customName: string
}>

export type HostingSettings = Readonly<{
  providers: readonly HostingProviderSettings[]
  configuredCookies: number
}>

export type RuntimeHostingSettings = Readonly<{
  data: HostingData
  customNames: Readonly<Record<string, string>>
  cookies: Readonly<Record<string, string>>
}>

export type HostingSettingEntry = Readonly<{ key: string; value: string }>
export type HostingSettingsMutation =
  | Readonly<{ status: 'ok'; entries: readonly HostingSettingEntry[] }>
  | Readonly<{ status: 'invalid'; message: string }>

export function hostingSettings(
  raw: Readonly<Record<string, string>>,
  supportedHosts: ReadonlySet<string>
): HostingSettings {
  const runtime = runtimeHostingSettings(raw, supportedHosts)
  const providers = sortedHosts(supportedHosts).map((host) => Object.freeze({
    host,
    label: hostLabel(host),
    cookieConfigured: (runtime.cookies[host] ?? '') !== '',
    customHostnames: (runtime.data.hostnames[host] ?? []).join('\n'),
    downloadUrl: runtime.data.downloadUrls[host] ?? '%s',
    customName: runtime.customNames[host] ?? hostLabel(host)
  }))
  return Object.freeze({
    providers: Object.freeze(providers),
    configuredCookies: providers.filter((provider) => provider.cookieConfigured).length
  })
}

export function runtimeHostingSettings(
  raw: Readonly<Record<string, string>>,
  supportedHosts: ReadonlySet<string>
): RuntimeHostingSettings {
  const customHostnameMap = storedObject(raw['custom-hostnames'])
  const downloadUrlMap = storedObject(raw['download-urls'])
  const customNameMap = storedObject(raw.custom_names)
  const hostnames: Record<string, readonly string[]> = {}
  const downloadUrls: Record<string, string> = {}
  const customNames: Record<string, string> = {}
  const cookies: Record<string, string> = {}

  const runtimeHosts = new Set([...Object.keys(hostLabels), ...supportedHosts])
  for (const host of runtimeHosts) {
    const configuredHostnames = Object.hasOwn(customHostnameMap, host)
      ? normalizedStoredHostnames(customHostnameMap[host])
      : undefined
    hostnames[host] = Object.freeze(configuredHostnames ?? normalizedStoredHostnames(legacyHostingData.hostnames[host] ?? []))

    const configuredDownloadUrl = normalizeDownloadUrl(downloadUrlMap[host])
    const defaultDownloadUrl = normalizeDownloadUrl(legacyHostingData.downloadUrls[host]) ?? '%s'
    downloadUrls[host] = configuredDownloadUrl ?? defaultDownloadUrl

    customNames[host] = normalizeCustomName(customNameMap[host]) ?? hostLabel(host)
    if (host !== 'direct') {
      const cookie = normalizeCookieHeader(raw[`cookie_${host}`])
      if (cookie !== null && cookie !== '') cookies[host] = cookie
    }
  }

  return Object.freeze({
    data: Object.freeze({ hostnames: Object.freeze(hostnames), downloadUrls: Object.freeze(downloadUrls) }),
    customNames: Object.freeze(customNames),
    cookies: Object.freeze(cookies)
  })
}

export function legacyHostingHosts(): ReadonlySet<string> {
  return new Set(Object.keys(hostLabels))
}

export function parseHostingSettingsSubmission(
  input: Record<string, unknown>,
  raw: Readonly<Record<string, string>>,
  supportedHosts: ReadonlySet<string>
): HostingSettingsMutation {
  const entries: HostingSettingEntry[] = []
  const customHostnames = bracketMap(input, 'custom-hostnames')
  const downloadUrls = bracketMap(input, 'download-urls')
  const customNames = bracketMap(input, 'custom_names')
  const submittedMaps = [customHostnames, downloadUrls, customNames]
  for (const map of submittedMaps) {
    const unsupported = [...map.keys()].find((host) => !supportedHosts.has(host))
    if (unsupported !== undefined) return invalid(`The hosting provider ${unsupported} is not supported`)
  }

  if (customHostnames.size > 0) {
    const normalized: Record<string, readonly string[]> = {}
    for (const [host, value] of customHostnames) {
      if (host === 'direct') return invalid('Direct URLs cannot define provider hostnames')
      const hostnames = normalizeSubmittedHostnames(value)
      if (hostnames === null) return invalid(`The ${hostLabel(host)} custom domains are invalid or excessive`)
      normalized[host] = hostnames
    }
    entries.push({ key: 'custom-hostnames', value: JSON.stringify(normalized) })
  }

  if (downloadUrls.size > 0) {
    const normalized: Record<string, string> = {}
    for (const [host, value] of downloadUrls) {
      const url = normalizeDownloadUrl(value)
      if (url === null) return invalid(`The ${hostLabel(host)} download URL must contain exactly one %s placeholder and use HTTP or HTTPS`)
      normalized[host] = url
    }
    entries.push({ key: 'download-urls', value: JSON.stringify(normalized) })
  }

  if (customNames.size > 0) {
    const normalized: Record<string, string> = {}
    for (const [host, value] of customNames) {
      const name = normalizeCustomName(value)
      if (name === null) return invalid(`The ${hostLabel(host)} custom name is invalid`)
      normalized[host] = name
    }
    entries.push({ key: 'custom_names', value: JSON.stringify(normalized) })
  }

  for (const host of supportedHosts) {
    if (host === 'direct') continue
    const key = `cookie_${host}`
    const clear = booleanValue(input[`clear_${key}`])
    const submitted = key in input ? scalar(input[key], false).trim() : ''
    if (submitted !== '' && clear) return invalid(`Choose either a replacement ${hostLabel(host)} cookie or clear the stored cookie`)
    if (submitted !== '') {
      const cookie = normalizeCookieHeader(submitted)
      if (cookie === null || cookie === '') return invalid(`The ${hostLabel(host)} cookie header is invalid or too long`)
      entries.push({ key, value: cookie })
    } else if (clear && (raw[key] ?? '') !== '') {
      entries.push({ key, value: '' })
    }
  }

  if (entries.length === 0) return invalid('No supported hosting settings were submitted')
  return Object.freeze({ status: 'ok', entries: Object.freeze(entries) })
}

function bracketMap(input: Record<string, unknown>, prefix: string): Map<string, unknown> {
  const result = new Map<string, unknown>()
  const nested = input[prefix]
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    for (const [host, value] of Object.entries(nested as Record<string, unknown>)) result.set(host, value)
  }
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\[([a-z0-9_-]+)]$`, 'i')
  for (const [key, value] of Object.entries(input)) {
    const match = pattern.exec(key)
    if (match?.[1] !== undefined) result.set(match[1].toLowerCase(), value)
  }
  return result
}

function storedObject(value: string | undefined): Readonly<Record<string, unknown>> {
  if (value === undefined || value.length > MAP_LIMIT) return Object.freeze({})
  try {
    const decoded: unknown = JSON.parse(value)
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return Object.freeze({})
    return Object.freeze(decoded as Record<string, unknown>)
  } catch {
    return Object.freeze({})
  }
}

function normalizedStoredHostnames(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r\n|\n|\r/) : []
  return values.flatMap((entry) => {
    const normalized = normalizeHostname(entry)
    return normalized === null ? [] : [normalized]
  }).filter((entry, index, list) => list.indexOf(entry) === index).slice(0, HOSTNAME_LIMIT)
}

function normalizeSubmittedHostnames(value: unknown): readonly string[] | null {
  const text = scalar(value, false)
  if (text.length > MAP_LIMIT) return null
  const lines = text.split(/\r\n|\n|\r/).map((entry) => entry.trim()).filter(Boolean)
  if (lines.length > HOSTNAME_LIMIT) return null
  const normalized: string[] = []
  for (const line of lines) {
    const hostname = normalizeHostname(line)
    if (hostname === null) return null
    if (!normalized.includes(hostname)) normalized.push(hostname)
  }
  return Object.freeze(normalized)
}

function normalizeHostname(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase().replace(/^www\./, '')
  if (normalized.length < 3 || normalized.length > 253 || !/^[a-z0-9.-]+$/.test(normalized)) return null
  if (normalized.startsWith('.') || normalized.includes('..') || normalized.split('.').some((label) => label.length > 63)) return null
  return normalized
}

function normalizeDownloadUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 4_096 || /[\u0000-\u001f\u007f]/.test(normalized)) return null
  if (normalized.split('%s').length !== 2) return null
  if (normalized === '%s') return normalized
  try {
    const url = new URL(normalized.replace('%s', 'provider-id'))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null
    return normalized
  } catch {
    return null
  }
}

function normalizeCustomName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (normalized.length === 0 || normalized.length > 100 || /[\u0000-\u001f\u007f]/.test(normalized)) return null
  return normalized
}

function normalizeCookieHeader(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (normalized === '') return ''
  if (normalized.length > COOKIE_LIMIT || /[\u0000-\u001f\u007f]/.test(normalized)) return null
  const pairs = normalized.split(';').map((entry) => entry.trim()).filter(Boolean)
  if (pairs.length === 0 || pairs.length > 500) return null
  const result: string[] = []
  for (const pair of pairs) {
    const separator = pair.indexOf('=')
    if (separator < 1) return null
    const name = pair.slice(0, separator).trim()
    const cookieValue = pair.slice(separator + 1).trim()
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || /[;,]/.test(cookieValue)) return null
    result.push(`${name}=${cookieValue}`)
  }
  return result.join('; ')
}

function hostLabel(host: string): string {
  return (hostLabels as Record<string, string>)[host] ?? host.replaceAll(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function sortedHosts(supportedHosts: ReadonlySet<string>): string[] {
  return [...supportedHosts].sort((left, right) => hostLabel(left).localeCompare(hostLabel(right)))
}

function scalar(value: unknown, trim = true): string {
  const selected = Array.isArray(value) ? value.at(-1) : value
  const normalized = selected === undefined || selected === null ? '' : String(selected)
  return trim ? normalized.trim() : normalized
}

function booleanValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => booleanValue(entry))
  return value === true || value === 1 || String(value).toLowerCase() === 'true' || String(value) === '1' || String(value).toLowerCase() === 'on'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function invalid(message: string): HostingSettingsMutation {
  return Object.freeze({ status: 'invalid', message })
}
