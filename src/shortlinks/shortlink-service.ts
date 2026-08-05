import { shortenerProviderList, type RuntimeShortlinkSettings, type ShortenerProviderId } from '../settings/settings-admin-service.js'

const MAX_RESPONSE_BYTES = 65_536
const REQUEST_TIMEOUT_MILLISECONDS = 5_000
const PROVIDER_TEMPLATES = new Map(shortenerProviderList().flatMap((provider) => provider.id === 'random'
  ? []
  : [[provider.id, provider.apiUrl] as const]))

export type ShortlinkHttpResponse = Readonly<{
  status: number
  location: string
  body: string
}>

export interface ShortlinkHttpClient {
  get(url: URL): Promise<ShortlinkHttpResponse>
}

export interface ShortlinkTransformer {
  shorten(input: string): Promise<string>
}

export class FetchShortlinkHttpClient implements ShortlinkHttpClient {
  public async get(url: URL): Promise<ShortlinkHttpResponse> {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json, text/plain;q=0.9' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)
    })
    return Object.freeze({
      status: response.status,
      location: response.headers.get('location') ?? '',
      body: await boundedResponseBody(response)
    })
  }
}

export class ShortlinkService implements ShortlinkTransformer {
  public constructor(
    private readonly loadSettings: () => Promise<RuntimeShortlinkSettings>,
    private readonly http: ShortlinkHttpClient = new FetchShortlinkHttpClient(),
    private readonly random: () => number = Math.random
  ) {}

  public async shorten(input: string): Promise<string> {
    const target = safeHttpUrl(input)
    if (target === null) return input

    try {
      const settings = await this.loadSettings()
      if (settings.disabled || settings.providers.length === 0) return target.href
      const provider = settings.selected === 'random'
        ? randomProvider(settings.providers, this.random())
        : settings.providers.find((candidate) => candidate.id === settings.selected)
      if (provider === undefined) return target.href

      const endpoint = providerEndpoint(provider.id, provider.apiUrl, provider.apiKey, target.href)
      if (endpoint === null) return target.href
      const shortened = parseShortlinkResponse(await this.http.get(endpoint))
      return shortened ?? target.href
    } catch {
      return target.href
    }
  }
}

function randomProvider<T>(providers: readonly T[], value: number): T | undefined {
  if (providers.length === 0) return undefined
  const normalized = Number.isFinite(value) ? Math.max(0, Math.min(0.999999999999, value)) : 0
  return providers[Math.floor(normalized * providers.length)]
}

function providerEndpoint(
  providerId: Exclude<ShortenerProviderId, 'random'>,
  template: string,
  apiKey: string,
  target: string
): URL | null {
  if (PROVIDER_TEMPLATES.get(providerId) !== template) return null
  const expected = safeHttpUrl(template.replaceAll('%s', 'placeholder'))
  if (expected === null || (template.match(/%s/g) ?? []).length !== 2) return null
  const value = template.replace('%s', encodeURIComponent(apiKey)).replace('%s', encodeURIComponent(target))
  const endpoint = safeHttpUrl(value)
  return endpoint !== null && endpoint.origin === expected.origin ? endpoint : null
}

export function parseShortlinkResponse(response: ShortlinkHttpResponse): string | null {
  if (response.status >= 300 && response.status < 400) return safeHttpUrl(response.location)?.href ?? null
  if (response.status < 200 || response.status >= 300) return null

  const body = response.body.trim()
  const direct = safeHttpUrl(body)
  if (direct !== null) return direct.href
  try {
    const value = JSON.parse(body) as unknown
    if (responseReportsFailure(value)) return null
    for (const candidate of responseUrlCandidates(value)) {
      const url = safeHttpUrl(candidate)
      if (url !== null) return url.href
    }
  } catch {
    return null
  }
  return null
}

function responseReportsFailure(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.success === false) return true
  return typeof record.status === 'string' && ['error', 'fail', 'failed'].includes(record.status.toLowerCase())
}

function responseUrlCandidates(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const record = value as Record<string, unknown>
  const result = ['shortenedUrl', 'shortened_url', 'short_url', 'shorturl', 'url', 'link']
    .flatMap((key) => typeof record[key] === 'string' ? [record[key] as string] : [])
  if (typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)) {
    const data = record.data as Record<string, unknown>
    for (const key of ['shortenedUrl', 'shortened_url', 'short_url', 'shorturl', 'url', 'link']) {
      if (typeof data[key] === 'string') result.push(data[key] as string)
    }
  }
  return result
}

async function boundedResponseBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('Shortlink response is too large')
  if (response.body === null) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('Shortlink response is too large')
    }
    chunks.push(next.value)
  }
  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(combined)
}

function safeHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim())
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') return null
    return url
  } catch {
    return null
  }
}
