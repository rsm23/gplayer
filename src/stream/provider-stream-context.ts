import { randomBytes } from 'node:crypto'

const DEFAULT_TTL_MILLISECONDS = 6 * 60 * 60 * 1_000
const DEFAULT_MAXIMUM_ENTRIES = 2_048
const DEFAULT_MAXIMUM_ORIGINS = 64
const MAXIMUM_HEADER_VALUE_LENGTH = 8_192
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const COOKIE_NAME_PATTERN = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/

export type ProviderStreamContextInput = Readonly<{
  host: string
  targets: readonly (string | URL)[]
  referer?: string
  cookies?: readonly unknown[]
  userAgent?: string
  language?: string
}>

export type ProviderStreamContextOptions = Readonly<{
  ttlMilliseconds?: number
  maximumEntries?: number
  maximumOrigins?: number
  now?: () => number
}>

type ProviderStreamContextEntry = {
  readonly headers: Headers
  readonly origins: Set<string>
  readonly expiresAt: number
}

/**
 * Keeps extractor credentials behind an opaque, short-lived player token.
 * Origins can expand only through a manifest fetched from an already-authorized origin.
 */
export class ProviderStreamContextRegistry {
  readonly #entries = new Map<string, ProviderStreamContextEntry>()
  readonly #ttlMilliseconds: number
  readonly #maximumEntries: number
  readonly #maximumOrigins: number
  readonly #now: () => number

  public constructor(options: ProviderStreamContextOptions = {}) {
    this.#ttlMilliseconds = boundedInteger(options.ttlMilliseconds, DEFAULT_TTL_MILLISECONDS, 1_000, 24 * 60 * 60 * 1_000)
    this.#maximumEntries = boundedInteger(options.maximumEntries, DEFAULT_MAXIMUM_ENTRIES, 1, 100_000)
    this.#maximumOrigins = boundedInteger(options.maximumOrigins, DEFAULT_MAXIMUM_ORIGINS, 1, 1_024)
    this.#now = options.now ?? Date.now
  }

  public register(input: ProviderStreamContextInput): string | null {
    this.prune()
    const origins = new Set<string>()
    for (const target of input.targets) {
      const origin = httpOrigin(target)
      if (origin !== null) origins.add(origin)
      if (origins.size >= this.#maximumOrigins) break
    }
    if (origins.size === 0) return null

    const token = randomBytes(32).toString('base64url')
    this.#entries.set(token, {
      headers: providerHeaders(input),
      origins,
      expiresAt: this.#now() + this.#ttlMilliseconds
    })
    this.evictOldest()
    return token
  }

  public headersForTarget(token: string, target: URL): Headers {
    const entry = this.entry(token)
    if (entry === null || !entry.origins.has(target.origin)) return new Headers()
    return new Headers(entry.headers)
  }

  public authorizeManifestResource(token: string, manifestUrl: URL, resourceUrl: URL): boolean {
    const entry = this.entry(token)
    if (entry === null || !entry.origins.has(manifestUrl.origin)) return false
    const origin = httpOrigin(resourceUrl)
    if (origin === null) return false
    if (!entry.origins.has(origin) && entry.origins.size >= this.#maximumOrigins) return false
    entry.origins.add(origin)
    return true
  }

  private entry(token: string): ProviderStreamContextEntry | null {
    if (!TOKEN_PATTERN.test(token)) return null
    const entry = this.#entries.get(token)
    if (entry === undefined) return null
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(token)
      return null
    }
    return entry
  }

  private prune(): void {
    const now = this.#now()
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(token)
    }
  }

  private evictOldest(): void {
    while (this.#entries.size > this.#maximumEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined
      if (oldest === undefined) return
      this.#entries.delete(oldest)
    }
  }
}

function providerHeaders(input: ProviderStreamContextInput): Headers {
  const headers = new Headers()
  const userAgent = safeHeaderValue(input.userAgent)
  const language = safeHeaderValue(input.language)
  const referer = safeReferer(input.referer)
  const cookie = cookieHeader(input.cookies ?? [])
  if (language !== '') headers.set('accept-language', language)
  if (userAgent !== '') headers.set('user-agent', userAgent)
  if (referer !== null) {
    headers.set('referer', referer.toString())
    const host = input.host.trim().toLowerCase()
    if (host !== 'dood' && host !== 'mp4upload') headers.set('origin', referer.origin)
  }
  if (cookie !== '') headers.set('cookie', cookie)
  return headers
}

function cookieHeader(values: readonly unknown[]): string {
  const pairs = new Map<string, string>()
  for (const candidate of values) {
    if (typeof candidate !== 'string') continue
    const pair = decodeRawUrl(candidate).split(';', 1)[0]?.trim() ?? ''
    const separator = pair.indexOf('=')
    if (separator <= 0) continue
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (!COOKIE_NAME_PATTERN.test(name) || /[\0-\x1F\x7F;]/.test(value)) continue
    pairs.set(name, `${name}=${value}`)
  }
  const output = [...pairs.values()].join('; ')
  return output.length <= MAXIMUM_HEADER_VALUE_LENGTH ? output : ''
}

function safeReferer(value: string | undefined): URL | null {
  const safe = safeHeaderValue(value)
  if (safe === '') return null
  try {
    const parsed = new URL(safe)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) return null
    return parsed
  } catch {
    return null
  }
}

function safeHeaderValue(value: string | undefined): string {
  const trimmed = value?.trim() ?? ''
  return trimmed.length <= MAXIMUM_HEADER_VALUE_LENGTH && !/[\0\r\n]/.test(trimmed) ? trimmed : ''
}

function httpOrigin(value: string | URL): string | null {
  try {
    const parsed = value instanceof URL ? value : new URL(value)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) return null
    return parsed.origin
  } catch {
    return null
  }
}

function decodeRawUrl(value: string): string {
  return value.replace(/%([\dA-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.trunc(value as number)))
}
