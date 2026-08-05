import { isIP } from 'node:net'

const DEFAULT_VPN_PREFIXES = [
  '3.',
  '34.',
  '15.',
  '45.32.',
  '104.16.',
  '104.131.',
  '138.197.',
  '172.104.',
  '192.241.',
  '45.83.223.',
  '103.86.96.',
  '146.70.0.',
  '185.159.157.'
] as const

const DEFAULT_SHORTENER_DOMAINS = [
  'bit.ly',
  'adf.ly',
  'clk.sh',
  'iir.ai',
  'adtival.network',
  'apk.miuiku.com',
  'cutpaid.com',
  'ouo.io',
  'apk.sekilastekno.com',
  'cararegistrasi.com',
  'paypou.com',
  'tiddis.net'
] as const

const DEFAULT_BLOCKED_USER_AGENT =
  /baiduspider|adm|fdm|idm|downloader|ucbrowser|okhttp|lavf|vlc|headlesschrome|httrack|apache-httpclient|harvest|audit|dirbuster|pangolin|nmap|sqln|hydra|parser|libwww|bbbike|sqlmap|w3af|owasp|nikto|fimap|havij|zmeu|babykrokodil|netsparker|httperf| sf/

export type AccessPolicyOptions = Readonly<{
  bannedCountries?: readonly string[] | string
  domainBlacklist?: readonly string[] | string
  domainWhitelist?: readonly string[] | string
  refererBlacklist?: readonly string[] | string
  titleBlacklist?: readonly string[] | string
  blockVpn?: boolean
  vpnPrefixes?: readonly string[] | string
  blockedUserAgentPattern?: RegExp
}>

export class AccessPolicy {
  readonly #bannedCountries: ReadonlySet<string>
  readonly #domainBlacklist: ReadonlySet<string>
  readonly #domainWhitelist: readonly string[]
  readonly #refererBlacklist: ReadonlySet<string>
  readonly #titleBlacklist: readonly string[]
  readonly #blockVpn: boolean
  readonly #vpnPrefixes: readonly string[]
  readonly #blockedUserAgentPattern: RegExp

  constructor(options: AccessPolicyOptions = {}) {
    this.#bannedCountries = new Set(normalizeValues(options.bannedCountries).map((value) => value.toUpperCase()))
    this.#domainBlacklist = new Set(normalizeDomainValues(options.domainBlacklist))
    this.#domainWhitelist = normalizeDomainValues(options.domainWhitelist)
    this.#refererBlacklist = new Set(
      normalizeValues(options.refererBlacklist).map((value) => removeUnwantedStrings(value).replace(/^\/+|\/+$/g, ''))
    )
    this.#titleBlacklist = normalizeValues(options.titleBlacklist).map((value) => value.toLowerCase())
    this.#blockVpn = options.blockVpn ?? false
    const configuredVpnPrefixes = normalizeValues(options.vpnPrefixes)
    this.#vpnPrefixes = configuredVpnPrefixes.length > 0 ? configuredVpnPrefixes : DEFAULT_VPN_PREFIXES
    this.#blockedUserAgentPattern = options.blockedUserAgentPattern ?? DEFAULT_BLOCKED_USER_AGENT
  }

  isBrowserBlacklisted(userAgent = ''): boolean {
    this.#blockedUserAgentPattern.lastIndex = 0
    return this.#blockedUserAgentPattern.test(userAgent.toLowerCase())
  }

  isCountryBlacklisted(countryCode = ''): boolean {
    return this.#bannedCountries.size > 0 && this.#bannedCountries.has(countryCode.toUpperCase())
  }

  isDomainBlacklisted(referer = ''): boolean {
    if (referer.length === 0 || this.#domainBlacklist.size === 0) return false
    return this.#domainBlacklist.has(getHostOrigin(referer).toLowerCase())
  }

  isDomainWhitelisted(referer = ''): boolean {
    if (referer.length === 0 || this.#domainWhitelist.length === 0) return true
    const domains = [...this.#domainWhitelist, ...DEFAULT_SHORTENER_DOMAINS]
    return domains.includes(removeUnwantedStrings(getHostOrigin(referer).toLowerCase()))
  }

  isProxyVpnBlacklisted(clientIp: string): boolean {
    if (!this.#blockVpn) return false
    return this.#vpnPrefixes.some((prefix) =>
      prefix.includes('/') ? isIpInRange(clientIp, prefix) : clientIp.startsWith(prefix)
    )
  }

  isRefererBlacklisted(referer = ''): boolean {
    if (referer.length === 0 || this.#refererBlacklist.size === 0) return false
    const normalized = removeUnwantedStrings(referer).replace(/^\/+|\/+$/g, '')
    return this.#refererBlacklist.has(normalized)
  }

  isTitleBlacklisted(title = ''): boolean {
    if (title.length === 0) return false
    const normalizedTitle = title.trim().toLowerCase()
    return this.#titleBlacklist.some(
      (word) => normalizedTitle.includes(word) || word.includes(normalizedTitle)
    )
  }
}

export function getHostOrigin(value: string, includeScheme = false): string {
  try {
    const url = new URL(value)
    const port = url.port !== '' && url.port !== '80' && url.port !== '443' ? `:${url.port}` : ''
    return includeScheme ? `${url.protocol}//${url.hostname}${port}` : `${url.hostname}${port}`
  } catch {
    return ''
  }
}

export function isIpInRange(ip: string, range: string): boolean {
  if (!range.includes('/')) return ip === range
  const separator = range.lastIndexOf('/')
  const subnet = range.slice(0, separator)
  const bitsText = range.slice(separator + 1)
  const ipVersion = isIP(ip)
  if (ipVersion === 0 || isIP(subnet) !== ipVersion || !/^\d+$/.test(bitsText)) return false

  const totalBits = ipVersion === 4 ? 32 : 128
  const bits = Number(bitsText)
  if (!Number.isInteger(bits) || bits < 0 || bits > totalBits) return false

  const ipNumber = ipVersion === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip)
  const subnetNumber = ipVersion === 4 ? ipv4ToBigInt(subnet) : ipv6ToBigInt(subnet)
  if (ipNumber === null || subnetNumber === null) return false
  if (bits === 0) return true

  const mask = ((1n << BigInt(bits)) - 1n) << BigInt(totalBits - bits)
  return (ipNumber & mask) === (subnetNumber & mask)
}

function normalizeValues(value: readonly string[] | string | undefined): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r\n|\n|\r/) : []
  return values.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

function normalizeDomainValues(value: readonly string[] | string | undefined): string[] {
  return normalizeValues(value).map((entry) => removeUnwantedStrings(entry))
}

function removeUnwantedStrings(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('https://', '')
    .replaceAll('http://', '')
    .replaceAll('www.', '')
}

function ipv4ToBigInt(value: string): bigint | null {
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null
  }
  return parts.reduce((result, part) => (result << 8n) | BigInt(part), 0n)
}

function ipv6ToBigInt(value: string): bigint | null {
  const normalized = normalizeEmbeddedIpv4(value.toLowerCase())
  if (normalized === null || normalized.split('::').length > 2) return null

  const [headText = '', tailText = ''] = normalized.split('::')
  const head = headText.length > 0 ? headText.split(':') : []
  const tail = tailText.length > 0 ? tailText.split(':') : []
  const hasCompression = normalized.includes('::')
  const missing = 8 - head.length - tail.length
  if ((!hasCompression && missing !== 0) || (hasCompression && missing < 1)) return null

  const groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail]
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n)
}

function normalizeEmbeddedIpv4(value: string): string | null {
  if (!value.includes('.')) return value
  const lastColon = value.lastIndexOf(':')
  if (lastColon < 0) return null
  const ipv4 = ipv4ToBigInt(value.slice(lastColon + 1))
  if (ipv4 === null) return null
  const high = ((ipv4 >> 16n) & 0xffffn).toString(16)
  const low = (ipv4 & 0xffffn).toString(16)
  return `${value.slice(0, lastColon)}:${high}:${low}`
}
