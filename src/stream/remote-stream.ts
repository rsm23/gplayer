import { isIP, type LookupFunction } from 'node:net'
import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'

const requestHeaderAllowlist = new Set([
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'cookie',
  'filemaillogintokencheck',
  'origin',
  'range',
  'referer',
  'user-agent',
  'x-bl',
  'x-api-version',
  'x-captcha-token',
  'x-embed-parent',
  'x-same-domain',
  'x-requested-with',
  'x-origin',
  'x-signature',
  'x-website-token'
])

const responseHeaderAllowlist = new Set([
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-length',
  'content-range',
  'content-type',
  'date',
  'etag',
  'expires',
  'last-modified'
])

export type RemoteStreamRequest = Readonly<{
  url: string | URL
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE'
  headers?: RequestInit['headers']
  body?: string | Uint8Array
  signal?: AbortSignal
  allowPrivateNetworks?: boolean
  maximumRedirects?: number
  /** Internal provider flows may retain response cookies only across same-origin redirects. */
  preserveRedirectCookies?: boolean
  /** Internal-only response metadata. Public proxy routes must not forward these headers. */
  includeResponseHeaders?: readonly 'set-cookie'[]
  /** Server-controlled headers resolved independently for every validated redirect target. */
  headersForTarget?: (target: URL) => RequestInit['headers'] | Promise<RequestInit['headers']>
}>

export type RemoteStreamResponse = Readonly<{
  url: URL
  status: number
  statusText: string
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}>

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true
  const [first = 0, second = 0] = octets
  return first === 0 || first === 10 || first === 127 || first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168 || first >= 224
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? ''
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)) return true
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  return mapped ? isPrivateIpv4(mapped) : false
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address)
  return version === 4 ? isPrivateIpv4(address) : version === 6 ? isPrivateIpv6(address) : true
}

type ResolvedTarget = Readonly<{
  address: string
  family: 4 | 6
}>

async function resolveAllowedTarget(url: URL, allowPrivateNetworks: boolean): Promise<ResolvedTarget> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Unsupported stream protocol: ${url.protocol}`)
  if (url.username || url.password) throw new Error('Stream URLs must not contain credentials')

  const ipVersion = isIP(url.hostname)
  const addresses = ipVersion > 0
    ? [{ address: url.hostname, family: ipVersion }]
    : await lookup(url.hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || (!allowPrivateNetworks && addresses.some(({ address }) => isPrivateAddress(address)))) {
    throw new Error(`Private or unresolved stream target is not allowed: ${url.hostname}`)
  }
  const selected = addresses[0]
  if (selected === undefined || (selected.family !== 4 && selected.family !== 6)) {
    throw new Error(`Stream target did not resolve to IPv4 or IPv6: ${url.hostname}`)
  }
  return { address: selected.address, family: selected.family }
}

function filteredRequestHeaders(input: RequestInit['headers']): Headers {
  const headers = new Headers(input)
  for (const name of [...headers.keys()]) if (!requestHeaderAllowlist.has(name.toLowerCase())) headers.delete(name)
  return headers
}

function filteredResponseHeaders(input: Headers, extraNames: readonly string[] = []): Headers {
  const headers = new Headers()
  const allowed = new Set([...responseHeaderAllowlist, ...extraNames.map((name) => name.toLowerCase())])
  for (const [name, value] of input) {
    if (!allowed.has(name.toLowerCase())) continue
    if (name.toLowerCase() === 'set-cookie') headers.append(name, value)
    else headers.set(name, value)
  }
  return headers
}

function redirectMethod(status: number, method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE'): 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' {
  if (method === 'HEAD') return 'HEAD'
  return status === 303 || method === 'POST' && (status === 301 || status === 302) ? 'GET' : method
}

export class RemoteStream {
  public constructor(private readonly fetchImplementation?: typeof fetch) {}

  public async open(request: RemoteStreamRequest): Promise<RemoteStreamResponse> {
    let target = request.url instanceof URL ? new URL(request.url) : new URL(request.url)
    let method = request.method ?? 'GET'
    let body = request.body
    const baseHeaders = filteredRequestHeaders(request.headers)
    const maximumRedirects = request.maximumRedirects ?? 5
    const redirectCookies = new Map<string, string>()
    if (request.preserveRedirectCookies === true) addCookieHeader(redirectCookies, baseHeaders.get('cookie') ?? '')

    for (let redirectCount = 0; redirectCount <= maximumRedirects; redirectCount += 1) {
      const resolved = await resolveAllowedTarget(target, request.allowPrivateNetworks ?? false)
      const headers = new Headers(baseHeaders)
      if (request.headersForTarget !== undefined) mergeTrustedRequestHeaders(headers, await request.headersForTarget(new URL(target)))
      if (request.preserveRedirectCookies === true) {
        if (redirectCookies.size > 0) headers.set('cookie', [...redirectCookies.values()].join('; '))
        else headers.delete('cookie')
      }
      if (method !== 'GET' && method !== 'HEAD' && body !== undefined) {
        headers.set('content-length', String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength))
      }
      const response = this.fetchImplementation === undefined
        ? await openPinnedConnection(target, method, headers, resolved, body, request.signal)
        : await this.fetchImplementation(target, {
            method,
            headers,
            redirect: 'manual',
            ...(method !== 'GET' && method !== 'HEAD' && body !== undefined ? { body } : {}),
            ...(request.signal ? { signal: request.signal } : {})
          })

      if (request.preserveRedirectCookies === true) {
        for (const value of setCookieValues(response.headers)) addSetCookie(redirectCookies, value)
      }

      if (response.status < 300 || response.status >= 400 || !response.headers.has('location')) {
        return Object.freeze({
          url: target,
          status: response.status,
          statusText: response.statusText,
          headers: filteredResponseHeaders(response.headers, request.includeResponseHeaders),
          body: method === 'HEAD' ? null : response.body
        })
      }

      if (redirectCount === maximumRedirects) {
        await response.body?.cancel()
        throw new Error(`Stream target exceeded ${maximumRedirects} redirects`)
      }

      const location = response.headers.get('location')
      await response.body?.cancel()
      const redirectedTarget = new URL(location ?? '', target)
      if (redirectedTarget.origin !== target.origin) {
        if (method === 'POST') throw new Error('Cross-origin POST redirects are not allowed')
        if (method === 'PUT' || method === 'DELETE') throw new Error('Cross-origin mutation redirects are not allowed')
        for (const name of ['authorization', 'cookie', 'x-website-token']) baseHeaders.delete(name)
        redirectCookies.clear()
      }
      target = redirectedTarget
      const redirectedMethod = redirectMethod(response.status, method)
      if (redirectedMethod !== method) body = undefined
      method = redirectedMethod
    }

    throw new Error('Unreachable redirect state')
  }
}

function mergeTrustedRequestHeaders(target: Headers, input: RequestInit['headers']): void {
  if (input === undefined) return
  const forbidden = new Set(['connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
  for (const [name, value] of new Headers(input)) {
    if (!forbidden.has(name.toLowerCase())) target.set(name, value)
  }
}

function setCookieValues(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  if (typeof getSetCookie === 'function') return getSetCookie.call(headers)
  const combined = headers.get('set-cookie') ?? ''
  return combined === '' ? [] : combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/)
}

function addCookieHeader(target: Map<string, string>, value: string): void {
  for (const pair of value.split(';')) {
    const separator = pair.indexOf('=')
    if (separator <= 0) continue
    const name = pair.slice(0, separator).trim()
    const cookieValue = pair.slice(separator + 1).trim()
    if (/^[!#$%&'*+.^_`|~\dA-Za-z-]+$/.test(name)) target.set(name, `${name}=${cookieValue}`)
  }
}

function addSetCookie(target: Map<string, string>, value: string): void {
  const pair = value.split(';', 1)[0] ?? ''
  const separator = pair.indexOf('=')
  if (separator <= 0) return
  const name = pair.slice(0, separator).trim()
  const cookieValue = pair.slice(separator + 1).trim()
  if (!/^[!#$%&'*+.^_`|~\dA-Za-z-]+$/.test(name)) return
  if (cookieValue === '' || /(?:^|;)\s*max-age=0(?:;|$)/i.test(value)) target.delete(name)
  else target.set(name, `${name}=${cookieValue}`)
}

async function openPinnedConnection(
  target: URL,
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE',
  headers: Headers,
  resolved: ResolvedTarget,
  body?: string | Uint8Array,
  signal?: AbortSignal
): Promise<Readonly<{
  status: number
  statusText: string
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}>> {
  return await new Promise((resolve, reject) => {
    const requestImplementation = target.protocol === 'https:' ? httpsRequest : httpRequest
    const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all === true) callback(null, [resolved])
      else callback(null, resolved.address, resolved.family)
    }
    const upstream = requestImplementation(target, {
      method,
      headers: Object.fromEntries(headers),
      lookup: pinnedLookup
    })

    const abort = (): void => {
      upstream.destroy(signal?.reason instanceof Error ? signal.reason : new Error('Stream request aborted'))
    }
    if (signal?.aborted === true) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })

    upstream.once('error', reject)
    upstream.once('response', (response) => {
      resolve({
        status: response.statusCode ?? 502,
        statusText: response.statusMessage ?? '',
        headers: nodeResponseHeaders(response),
        body: method === 'HEAD' ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>
      })
    })
    upstream.end(method !== 'GET' && method !== 'HEAD' ? body : undefined)
  })
}

function nodeResponseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else if (value !== undefined) headers.set(name, value)
  }
  return headers
}
