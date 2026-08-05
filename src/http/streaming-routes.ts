import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { Readable, Transform, type TransformCallback } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import type { MediaResult, MediaSource } from '../core/source-resolver.js'
import { Security } from '../security/security.js'
import { RemoteStream, type RemoteStreamResponse } from '../stream/remote-stream.js'
import { StreamCache, type StreamCacheEntry, type StreamCacheMode, type StreamCacheSettings } from '../stream/stream-cache.js'
import type { ProviderStreamContextRegistry } from '../stream/provider-stream-context.js'
import { mediaCachePaths } from '../background/media-cache-path.js'
import { parseByteRange } from '../background/media-download-worker.js'
import type { GeoIpDetailsLookup } from '../security/geoip-details.js'
import { isSmartTvUserAgent } from '../security/smart-tv.js'

const MAX_MANIFEST_BYTES = 5 * 1_024 * 1_024
const MAX_STREAM_URL_LENGTH = 16_384
const MAX_CACHEABLE_RESOURCE_BYTES = 128 * 1_024 * 1_024
const MP4_RANGE_SIZE_TTL_MILLISECONDS = 10_800 * 1_000
const DEFAULT_MP4_RANGE_MEMORY_ENTRIES = 4_096
const INTERNAL_QUERY_KEYS = new Set(['_', 'dl', 'gcl', 'gct', 'gsc', 'gd', 'gl', 'gx', 'gxr', 'gt'])
const PROVIDER_CONTEXT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const CACHED_PROVIDER_CONTEXT_PLACEHOLDER = '__GPLAYER_PROVIDER_CONTEXT__'
const CACHED_ACCESS_TOKEN_PLACEHOLDER = '__GPLAYER_STREAM_ACCESS__'
const MAX_ACCESS_TOKEN_LENGTH = 2_048
const HLS_DIRECT_TRANSPORT_DOMAINS = ['tiktokcdn.com', 'cloudfront-net.online'] as const
/** Exact resources/data/json/custom-extensions.json pairing from 4.8.3. */
const STREAM_EXTENSION_FACADES = [
  ['.m3u8', '.txt'],
  ['.mpd', '.txt'],
  ['.ts', '.jpg'],
  ['.mp4', '.png'],
  ['.m4s', '.jpeg'],
  ['.m4a', '.gif'],
  ['.m4v', '.ico'],
  ['.m4i', '.woff'],
  ['.m4f', '.woff2'],
  ['.m4t', '.jpg'],
  ['.tar', '.png'],
  ['.mp3', '.jpeg'],
  ['.php', '.gif'],
  ['.zip', '.ico'],
  ['.rar', '.woff']
] as const
const binaryResponseHeaders = [
  'accept-ranges',
  'cache-control',
  'content-encoding',
  'content-language',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'expires',
  'last-modified'
] as const

export type StreamingRoute = 'hls' | 'mpd' | 'stream-ts' | 'stream-seg' | 'stream-vid'

export type StreamingIdentity = Readonly<{
  host: string
  id: string
  label?: string
  title?: string
  live?: boolean
  contextToken?: string
  accessToken?: string
  downloadable?: boolean
  recoverable?: boolean
}>

export type StreamingSourceRefresh = (
  identity: Readonly<{ host: string; id: string }>,
  context: Readonly<{ clientIp: string; userAgent: string; language: string; downloadable: boolean }>
) => Promise<MediaResult>

export type StreamingAccessSettings = Readonly<{
  disableValidation: boolean
  p2p: boolean
  downloadPageEnabled: boolean
}>

export type StreamingRouteOptions = Readonly<{
  remoteStream?: RemoteStream
  /** Integration-test escape hatch. Public deployments must keep this false. */
  allowPrivateNetworks?: boolean
  customHeaders?: (target: URL) => RequestInit['headers'] | Promise<RequestInit['headers']>
  providerContexts?: ProviderStreamContextRegistry
  cacheRoot?: string
  loadFileCacheEnabled?: () => boolean | Promise<boolean>
  loadCacheSettings?: () => StreamCacheSettings | Promise<StreamCacheSettings>
  maximumCacheableResourceBytes?: number
  maximumBytesPerSecond?: number
  loadAccessSettings?: () => StreamingAccessSettings | Promise<StreamingAccessSettings>
  geoIpDetailsLookup?: GeoIpDetailsLookup
  validateAdminToken?: (token: string, userAgent: string) => boolean | Promise<boolean>
  refreshSource?: StreamingSourceRefresh
  recoveryDelay?: (milliseconds: number) => Promise<void>
  recoveryRandom?: () => number
  recoveryNow?: () => number
  recoveryMaximumAttempts?: number
  mp4RangeMemoryNow?: () => number
  mp4RangeMemoryMaximumEntries?: number
}>

export function createStreamingAccessToken(clientIp: string, security: Security): string | undefined {
  const normalized = normalizeIp(clientIp)
  return normalized === null ? undefined : security.encryptURL(normalized)
}

export function createStreamingProxyPath(
  route: StreamingRoute,
  target: URL,
  security: Security,
  identity: StreamingIdentity = { host: 'direct', id: target.toString() },
  preserveTail = false,
  extensionFacade = false
): string {
  const identityToken = security.encryptURL(`${identity.host}~${identity.id}`)
  if (!preserveTail) {
    const targetToken = security.encryptURL(target.toString())
    const publicToken = extensionFacade ? disguiseStreamingToken(targetToken, target.pathname) : targetToken
    return withInternalQuery(`/${route}/${identityToken}/${publicToken}`, identity, security)
  }

  const base = new URL('.', target)
  base.search = ''
  base.hash = ''
  const pathTail = target.pathname.slice(base.pathname.length)
  const tail = (extensionFacade ? disguiseStreamingPath(pathTail) : pathTail) + target.search
  return withInternalQuery(`/${route}/${identityToken}/${security.encryptURL(base.toString())}/${tail}`, identity, security)
}

export async function registerStreamingRoutes(
  app: FastifyInstance,
  config: AppConfig,
  options: StreamingRouteOptions = {}
): Promise<void> {
  const security = new Security(config.secureSalt)
  const remoteStream = options.remoteStream ?? new RemoteStream()
  const sourceRecovery = new StreamingSourceRecovery(options)
  const mp4RangeMemory = new Mp4RangeMemory(
    options.mp4RangeMemoryNow,
    options.mp4RangeMemoryMaximumEntries
  )
  const allowPrivateNetworks = options.allowPrivateNetworks ?? false
  const streamCache = options.cacheRoot === undefined ? undefined : new StreamCache(options.cacheRoot)
  const requestedMaximumCacheBytes = options.maximumCacheableResourceBytes ?? MAX_CACHEABLE_RESOURCE_BYTES
  const maximumCacheableResourceBytes = Number.isFinite(requestedMaximumCacheBytes)
    ? Math.max(1, Math.min(1_073_741_824, Math.trunc(requestedMaximumCacheBytes)))
    : MAX_CACHEABLE_RESOURCE_BYTES
  const requestedMaximumBytesPerSecond = options.maximumBytesPerSecond ?? 0
  const maximumBytesPerSecond = Number.isFinite(requestedMaximumBytesPerSecond)
    ? Math.max(0, Math.trunc(requestedMaximumBytesPerSecond))
    : 0
  const loadCacheSettings = async (): Promise<StreamCacheSettings> => {
    try {
      if (options.loadCacheSettings !== undefined) return normalizeCacheSettings(await options.loadCacheSettings())
      const enabled = await Promise.resolve(options.loadFileCacheEnabled?.() ?? true)
      return Object.freeze({ enabled, maxAgeSeconds: 300, mode: 'php' })
    } catch {
      return Object.freeze({ enabled: false, maxAgeSeconds: 0, mode: 'php' })
    }
  }

  const manifestHandler = (kind: 'hls' | 'mpd') => async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const redirect = appleStreamingExtensionRedirect(request.url, request.headers['user-agent'] ?? '')
    if (redirect !== null) return sendAppleStreamingExtensionRedirect(reply, redirect)
    const parsed = parseStreamingTarget(request.url, kind, security)
    if (parsed === null) return streamError(reply, 400, 'Invalid stream link')
    if (!await streamAccessAllowed(request, kind, parsed.identity, security, options)) {
      return streamError(reply, 403, 'Stream access denied')
    }
    const cacheSettings = await loadCacheSettings()

    if (streamCache !== undefined && cacheSettings.enabled && parsed.identity.live !== true) {
      const cached = await streamCache.readText(parsed.identity, parsed.target, cacheSettings.maxAgeSeconds, MAX_MANIFEST_BYTES).catch(() => null)
      if (cached !== null) {
        const rebound = bindCachedManifestTokens(cached, parsed.identity.contextToken, parsed.identity.accessToken)
        if (rebound !== null) {
          authorizeCachedManifestResources(rebound, parsed.target, security, parsed.identity, options.providerContexts)
          sourceRecovery.succeed(parsed.identity, request.ip)
          return sendManifest(reply, kind, rebound, false, cacheSettings.maxAgeSeconds, true, request.method === 'HEAD')
        }
      }
    }

    try {
      const response = await remoteStream.open({
        url: parsed.target,
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: requestHeaders(request),
        ...targetHeadersOption(parsed.identity, options),
        allowPrivateNetworks
      })
      if (response.status === 304) {
        sourceRecovery.succeed(parsed.identity, request.ip)
        return reply.code(304).send()
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel()
        if (retryableManifestStatus(response.status)) {
          const replacement = await sourceRecovery.replacement(kind, parsed.identity, request, options.providerContexts)
          if (replacement !== null) return recoveryRedirect(reply, replacement, security)
        }
        return streamError(reply, response.status === 404 ? 404 : 502, 'Stream manifest is unavailable')
      }
      if (request.method === 'HEAD') {
        await response.body?.cancel()
        sourceRecovery.succeed(parsed.identity, request.ip)
        return reply
          .header('content-type', manifestContentType(kind))
          .header('cache-control', 'no-cache')
          .header('x-content-type-options', 'nosniff')
          .code(200)
          .send()
      }

      const source = await readLimitedText(response.body, MAX_MANIFEST_BYTES)
      const live = kind === 'hls'
        ? source.includes('#EXTINF') && !source.includes('#EXT-X-ENDLIST')
        : /\btype=["']dynamic["']/i.test(source)
      const identity = live ? Object.freeze({ ...parsed.identity, live: true }) : parsed.identity
      const observeResource = manifestResourceObserver(identity, response.url, options.providerContexts)
      const content = kind === 'hls'
        ? rewriteHlsPlaylist(source, response.url, security, identity, observeResource)
        : rewriteMpdManifest(source, response.url, security, identity, observeResource)
      if (content.trim().length === 0) return streamError(reply, 404, 'Stream manifest is unavailable')
      if (streamCache !== undefined && cacheSettings.enabled && cacheSettings.maxAgeSeconds > 0 && !live) {
        await streamCache.writeText(parsed.identity, parsed.target, cacheableManifest(content, identity.contextToken, identity.accessToken)).catch(() => undefined)
      }

      sourceRecovery.succeed(parsed.identity, request.ip)
      return sendManifest(reply, kind, content, live, cacheSettings.maxAgeSeconds, false, false)
    } catch {
      const replacement = await sourceRecovery.replacement(kind, parsed.identity, request, options.providerContexts)
      if (replacement !== null) return recoveryRedirect(reply, replacement, security)
      return streamError(reply, 502, 'Stream manifest is unavailable')
    }
  }

  const binaryHandler = (kind: 'stream-ts' | 'stream-seg' | 'stream-vid') => async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const redirect = appleStreamingExtensionRedirect(request.url, request.headers['user-agent'] ?? '')
    if (redirect !== null) return sendAppleStreamingExtensionRedirect(reply, redirect)
    const parsed = parseStreamingTarget(request.url, kind, security)
    if (parsed === null) return streamError(reply, 400, 'Invalid stream link')
    if (!await streamAccessAllowed(request, kind, parsed.identity, security, options)) {
      return streamError(reply, 403, 'Stream access denied')
    }
    const cacheSettings = await loadCacheSettings()

    if (kind === 'stream-vid' && options.cacheRoot !== undefined && parsed.identity.label !== undefined) {
      if (cacheSettings.enabled && await sendCachedMedia(request, reply, options.cacheRoot, parsed.identity, cacheSettings)) {
        sourceRecovery.succeed(parsed.identity, request.ip)
        return reply
      }
    }

    const range = typeof request.headers.range === 'string' ? request.headers.range : ''
    const persistentCacheEligible = kind !== 'stream-vid' && range === '' && streamCache !== undefined && cacheSettings.enabled && cacheSettings.maxAgeSeconds > 0
    if (persistentCacheEligible) {
      const cached = await streamCache.read(parsed.identity, parsed.target, cacheSettings.maxAgeSeconds).catch(() => null)
      if (cached !== null) {
        sourceRecovery.succeed(parsed.identity, request.ip)
        return sendCachedStreamResource(request, reply, streamCache, cached, kind, cacheSettings, parsed.identity.live === true)
      }
    }

    try {
      const upstreamRange = kind === 'stream-vid' && range !== ''
        ? mp4RangeMemory.rewrite(parsed.identity.host, parsed.target, range)
        : undefined
      const response = await remoteStream.open({
        url: parsed.target,
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: requestHeaders(request, upstreamRange),
        ...targetHeadersOption(parsed.identity, options),
        allowPrivateNetworks
      })
      if (response.status === 304) {
        sourceRecovery.succeed(parsed.identity, request.ip)
        return reply.code(304).send()
      }
      if (response.status === 416) {
        const contentRange = response.headers.get('content-range')
        if (contentRange !== null) reply.header('content-range', contentRange)
        await response.body?.cancel()
        return reply.header('accept-ranges', 'bytes').header('cache-control', 'no-store').code(416).send()
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel()
        if (kind === 'stream-vid' && retryableVideoStatus(response.status)) {
          const replacement = await sourceRecovery.replacement(kind, parsed.identity, request, options.providerContexts)
          if (replacement !== null) return recoveryRedirect(reply, replacement, security)
        }
        return streamError(reply, response.status === 404 ? 404 : 502, 'Stream resource is unavailable')
      }
      if (kind === 'stream-vid') mp4RangeMemory.observe(parsed.target, response.headers.get('content-range'))

      for (const name of binaryResponseHeaders) {
        const value = response.headers.get(name)
        if (value !== null) reply.header(name, value)
      }
      if (response.headers.get('content-type') === null) reply.header('content-type', defaultBinaryContentType(kind))
      if (response.headers.get('cache-control') === null) {
        const maxAge = parsed.identity.live === true ? 60 : Math.max(0, Math.trunc(cacheSettings.maxAgeSeconds))
        reply.header('cache-control', `public, max-age=${maxAge}`)
      }
      reply
        .header('content-disposition', kind === 'stream-vid' ? remoteMediaDisposition(parsed.identity) : 'inline')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .code(response.status)
      sourceRecovery.succeed(parsed.identity, request.ip)
      if (response.body === null) return reply.send()
      let clientBody = response.body
      if (persistentCacheEligible && response.status === 200 && streamCache !== undefined) {
        const branches = response.body.tee()
        clientBody = branches[0]
        streamCache.capture(parsed.identity, parsed.target, branches[1], response.headers, maximumCacheableResourceBytes)
      }
      return reply.send(remoteReadable(clientBody, maximumBytesPerSecond))
    } catch {
      if (kind === 'stream-vid') {
        const replacement = await sourceRecovery.replacement(kind, parsed.identity, request, options.providerContexts)
        if (replacement !== null) return recoveryRedirect(reply, replacement, security)
      }
      return streamError(reply, 502, 'Stream resource is unavailable')
    }
  }

  app.get('/hls/*', manifestHandler('hls'))
  app.get('/mpd/*', manifestHandler('mpd'))
  app.get('/stream-ts/*', binaryHandler('stream-ts'))
  app.get('/stream-seg/*', binaryHandler('stream-seg'))
  app.get('/stream-vid/*', binaryHandler('stream-vid'))
}

type StreamingRecoveryReplacement = Readonly<{
  route: 'hls' | 'mpd' | 'stream-vid'
  target: URL
  identity: StreamingIdentity
}>

class StreamingSourceRecovery {
  readonly #attempts = new Map<string, Readonly<{ count: number; expiresAt: number }>>()
  readonly #delay: (milliseconds: number) => Promise<void>
  readonly #random: () => number
  readonly #now: () => number
  readonly #maximumAttempts: number

  public constructor(private readonly options: StreamingRouteOptions) {
    this.#delay = options.recoveryDelay ?? (async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.#random = options.recoveryRandom ?? Math.random
    this.#now = options.recoveryNow ?? Date.now
    const requestedMaximum = options.recoveryMaximumAttempts ?? 3
    this.#maximumAttempts = Number.isFinite(requestedMaximum)
      ? Math.max(1, Math.min(10, Math.trunc(requestedMaximum)))
      : 3
  }

  public succeed(identity: StreamingIdentity, clientIp: string): void {
    if (identity.recoverable === true) this.#attempts.delete(this.key(identity, clientIp))
  }

  public async replacement(
    route: 'hls' | 'mpd' | 'stream-vid',
    identity: StreamingIdentity,
    request: FastifyRequest,
    providerContexts: ProviderStreamContextRegistry | undefined
  ): Promise<StreamingRecoveryReplacement | null> {
    if (identity.recoverable !== true || this.options.refreshSource === undefined) return null
    const now = this.#now()
    this.prune(now)
    const key = this.key(identity, request.ip)
    const previous = this.#attempts.get(key)
    const attempt = previous?.count ?? 0
    if (attempt >= this.#maximumAttempts) return null
    this.#attempts.set(key, Object.freeze({ count: attempt + 1, expiresAt: now + 300_000 }))

    const sample = this.#random()
    const normalizedSample = Number.isFinite(sample) ? Math.max(0, Math.min(0.999999999, sample)) : 0
    const milliseconds = Math.min(64_000, 2 ** attempt * 1_000 + Math.floor(normalizedSample * 1_001))
    try {
      await this.#delay(milliseconds)
    } catch {
      return null
    }

    let result: MediaResult
    try {
      result = await this.options.refreshSource(
        { host: identity.host, id: identity.id },
        {
          clientIp: request.ip,
          userAgent: request.headers['user-agent'] ?? '',
          language: request.headers['accept-language'] ?? '',
          downloadable: identity.downloadable === true
        }
      )
    } catch {
      return null
    }
    const selected = selectRecoverySource(result.sources, route, identity.label)
    if (selected === null) return null

    const upstream = result.upstream
    const contextToken = providerContexts?.register({
      host: upstream?.host ?? identity.host,
      targets: mediaResultTargets(result),
      referer: result.referer,
      cookies: result.cookies,
      userAgent: upstream?.userAgent ?? request.headers['user-agent'] ?? '',
      language: upstream?.language ?? request.headers['accept-language'] ?? ''
    }) ?? undefined
    const { contextToken: _oldContext, label: _oldLabel, live: _oldLive, ...preserved } = identity
    return Object.freeze({
      route: selected.route,
      target: selected.target,
      identity: Object.freeze({
        ...preserved,
        label: selected.label,
        recoverable: true,
        ...(contextToken === undefined ? {} : { contextToken })
      })
    })
  }

  private key(identity: StreamingIdentity, clientIp: string): string {
    return `${identity.host}\u0000${identity.id}\u0000${normalizeIp(clientIp) ?? 'unknown'}`
  }

  private prune(now: number): void {
    for (const [key, value] of this.#attempts) if (value.expiresAt <= now) this.#attempts.delete(key)
  }
}

function selectRecoverySource(
  sources: readonly MediaSource[],
  requestedRoute: 'hls' | 'mpd' | 'stream-vid',
  requestedLabel: string | undefined
): Readonly<{ route: 'hls' | 'mpd' | 'stream-vid'; target: URL; label: string }> | null {
  const candidates = sources.flatMap((source) => {
    const target = mediaSourceTarget(source)
    if (target === null) return []
    const route = streamingRouteForSource(source, target)
    const label = typeof source.label === 'string' && source.label.trim() !== '' ? source.label.trim() : 'Original'
    return [{ route, target, label }]
  })
  const sameKind = candidates.filter((candidate) => candidate.route === requestedRoute)
  const compatible = requestedRoute === 'stream-vid'
    ? candidates.filter((candidate) => candidate.route === 'stream-vid')
    : candidates.filter((candidate) => candidate.route !== 'stream-vid')
  const pool = sameKind.length > 0 ? sameKind : compatible
  const normalizedLabel = requestedLabel?.trim().toLowerCase() ?? ''
  return pool.find((candidate) => normalizedLabel !== '' && candidate.label.toLowerCase() === normalizedLabel)
    ?? pool[0]
    ?? null
}

function streamingRouteForSource(source: MediaSource, target: URL): 'hls' | 'mpd' | 'stream-vid' {
  const type = typeof source.type === 'string' ? source.type.toLowerCase() : ''
  const pathname = target.pathname.toLowerCase()
  if (type.includes('hls') || type.includes('mpegurl') || pathname.endsWith('.m3u8')) return 'hls'
  if (type.includes('mpd') || type.includes('dash') || pathname.endsWith('.mpd')) return 'mpd'
  return 'stream-vid'
}

function mediaSourceTarget(source: MediaSource): URL | null {
  if (typeof source.file !== 'string' || source.file.length === 0) return null
  try {
    const target = new URL(source.file)
    return (target.protocol === 'http:' || target.protocol === 'https:') && !target.username && !target.password ? target : null
  } catch {
    return null
  }
}

function mediaResultTargets(result: MediaResult): URL[] {
  const values: unknown[] = [
    ...result.sources.map((source) => source.file),
    ...result.tracks.map((track) => track.file),
    result.image,
    result.filmstrip
  ]
  const targets: URL[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    try {
      const target = new URL(value)
      if ((target.protocol === 'http:' || target.protocol === 'https:') && !target.username && !target.password) targets.push(target)
    } catch {
      // Non-URL metadata is excluded from the server-side provider context.
    }
  }
  return targets
}

function retryableManifestStatus(status: number): boolean {
  return status === 400 || status === 410 || status === 429 || status >= 500
}

function retryableVideoStatus(status: number): boolean {
  return status >= 400 && status !== 410 && status !== 416
}

function recoveryRedirect(reply: FastifyReply, replacement: StreamingRecoveryReplacement, security: Security): unknown {
  const location = createStreamingProxyPath(replacement.route, replacement.target, security, replacement.identity)
  return reply
    .header('cache-control', 'no-store')
    .header('location', location)
    .code(307)
    .send()
}

type ParsedStreamingTarget = Readonly<{
  identity: StreamingIdentity
  target: URL
}>

async function streamAccessAllowed(
  request: FastifyRequest,
  route: StreamingRoute,
  identity: StreamingIdentity,
  security: Security,
  options: StreamingRouteOptions
): Promise<boolean> {
  // The supplied application deliberately validates only top-level manifests
  // and MP4 resources. Child segment URLs remain protected by their encrypted
  // target and provider-context envelopes, but are not rebound independently.
  if (route === 'stream-ts' || route === 'stream-seg') return true
  if (options.loadAccessSettings === undefined) return true

  let settings: StreamingAccessSettings
  try {
    settings = await options.loadAccessSettings()
  } catch {
    settings = Object.freeze({ disableValidation: false, p2p: false, downloadPageEnabled: true })
  }
  if (settings.disableValidation || settings.p2p) return true
  if (isSmartTvUserAgent(request.headers['user-agent'] ?? '')) return true
  if (identity.downloadable === true && !settings.downloadPageEnabled) return true

  const token = identity.accessToken ?? ''
  const clientIp = normalizeIp(request.ip)
  const tokenIp = normalizeIp(security.decryptURLStrict(token) ?? '')
  if (clientIp !== null && tokenIp !== null) {
    if (clientIp === tokenIp) return true
    if (options.geoIpDetailsLookup !== undefined) {
      try {
        const [clientDetails, tokenDetails] = await Promise.all([
          options.geoIpDetailsLookup(clientIp),
          options.geoIpDetailsLookup(tokenIp)
        ])
        if (clientDetails?.asn !== null && clientDetails?.asn !== undefined && clientDetails.asn === tokenDetails?.asn) return true
      } catch {
        // A missing or unavailable ASN database falls back to exact IP binding.
      }
    }
  }

  if (token !== '' && tokenIp === null && options.validateAdminToken !== undefined) {
    try {
      return await options.validateAdminToken(token, request.headers['user-agent'] ?? '')
    } catch {
      return false
    }
  }
  return false
}

function parseStreamingTarget(requestUrl: string, route: StreamingRoute, security: Security): ParsedStreamingTarget | null {
  const request = new URL(requestUrl, 'http://gplayer.invalid')
  const prefix = `/${route}/`
  if (!request.pathname.startsWith(prefix)) return null
  const parts = request.pathname.slice(prefix.length).split('/')
  const identityToken = parts.shift() ?? ''
  const baseToken = restoreStreamingToken(parts.shift() ?? '')
  const identityValue = security.decryptURLStrict(identityToken)
  const baseValue = security.decryptURLStrict(baseToken)
  if (identityValue === null || baseValue === null) return null
  const separator = identityValue.indexOf('~')
  if (separator <= 0 || separator === identityValue.length - 1) return null

  try {
    const base = new URL(baseValue)
    const target = parts.length === 0 || parts.every((part) => part.length === 0)
      ? base
      : new URL(restoreStreamingPath(parts.join('/')), base)
    for (const [key, value] of request.searchParams) {
      if (!INTERNAL_QUERY_KEYS.has(key)) target.searchParams.append(key, value)
    }
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) return null
    if (target.toString().length > MAX_STREAM_URL_LENGTH) return null
    const label = cacheLabel(request, security)
    const title = cacheTitle(request, security)
    const live = request.searchParams.get('gl') === '1'
    const contextToken = providerContextToken(request)
    const accessToken = streamingAccessToken(request)
    const downloadable = legacyNonEmpty(request.searchParams.get('dl'))
    const recoverable = request.searchParams.get('gxr') === '1'
    return {
      identity: {
        host: identityValue.slice(0, separator),
        id: identityValue.slice(separator + 1),
        ...(label === null ? {} : { label }),
        ...(title === null ? {} : { title }),
        ...(live ? { live: true } : {}),
        ...(contextToken === null ? {} : { contextToken }),
        ...(accessToken === null ? {} : { accessToken }),
        ...(downloadable ? { downloadable: true } : {}),
        ...(recoverable ? { recoverable: true } : {})
      },
      target
    }
  } catch {
    return null
  }
}

function disguiseStreamingToken(token: string, targetPathname: string): string {
  const facade = streamingExtensionFacade(targetPathname)
  return facade === null ? token : `${facade.original.slice(1)}_gx_${token}${facade.custom}`
}

function disguiseStreamingPath(value: string): string {
  const facade = streamingExtensionFacade(value)
  if (facade === null) return value
  const separator = value.lastIndexOf('/')
  const basename = value.slice(separator + 1)
  const filename = basename.slice(0, -facade.original.length)
  return `${value.slice(0, separator + 1)}${facade.original.slice(1)}_gx_${filename}${facade.custom}`
}

function streamingExtensionFacade(value: string): Readonly<{ original: string; custom: string }> | null {
  const basename = value.slice(value.lastIndexOf('/') + 1)
  for (const [original, custom] of STREAM_EXTENSION_FACADES) {
    if (basename.length > original.length && basename.endsWith(original)) return { original, custom }
  }
  return null
}

function facadeNameParts(value: string): Readonly<{ payload: string; original: string }> | null {
  for (const [original, custom] of STREAM_EXTENSION_FACADES) {
    const prefix = `${original.slice(1)}_gx_`
    if (!value.startsWith(prefix) || !value.endsWith(custom)) continue
    const payload = value.slice(prefix.length, -custom.length)
    if (payload !== '') return { payload, original }
  }
  return null
}

function restoreStreamingToken(value: string): string {
  const facade = facadeNameParts(value)
  if (facade !== null) return facade.payload
  for (const [original] of STREAM_EXTENSION_FACADES) {
    if (value.length > original.length && value.endsWith(original)) return value.slice(0, -original.length)
  }
  return value
}

function restoreStreamingPath(value: string): string {
  const separator = value.lastIndexOf('/')
  const facade = facadeNameParts(value.slice(separator + 1))
  return facade === null ? value : `${value.slice(0, separator + 1)}${facade.payload}${facade.original}`
}

function appleStreamingExtensionRedirect(requestUrl: string, userAgent: string): string | null {
  if (!isAppleStreamingUserAgent(userAgent)) return null
  const request = new URL(requestUrl, 'http://gplayer.invalid')
  const separator = request.pathname.lastIndexOf('/')
  const facade = facadeNameParts(request.pathname.slice(separator + 1))
  if (facade === null) return null
  request.pathname = `${request.pathname.slice(0, separator + 1)}${facade.payload}${facade.original}`
  return `${request.pathname}${request.search}`
}

function sendAppleStreamingExtensionRedirect(reply: FastifyReply, location: string): unknown {
  return reply
    .header('cache-control', 'no-store')
    .header('vary', 'User-Agent')
    .header('location', location)
    .code(302)
    .send()
}

function isAppleStreamingUserAgent(userAgent: string): boolean {
  return /(?:mac|ios|iphone|ipad|ipod)/i.test(userAgent)
}

function normalizeIp(value: string): string | null {
  const candidate = value.trim().toLowerCase()
  const normalized = candidate.startsWith('::ffff:') && isIP(candidate.slice('::ffff:'.length)) === 4
    ? candidate.slice('::ffff:'.length)
    : candidate
  return isIP(normalized) === 0 ? null : normalized
}

function legacyNonEmpty(value: string | null): boolean {
  return value !== null && value !== '' && value !== '0'
}

export function rewriteHlsPlaylist(
  input: string,
  manifestUrl: URL,
  security: Security,
  identity: StreamingIdentity,
  observeResource?: (target: URL) => void
): string {
  const nestedIdentity = withoutSourceRecovery(identity)
  const lines = input.replace(/\r\n?/g, '\n').split('\n')
  let nextUriIsPlaylist = false
  const output = lines.map((rawLine) => {
    const line = rawLine.trimEnd()
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-PREFETCH:')) {
        const value = line.slice('#EXT-X-PREFETCH:'.length).trim()
        const target = resolveHttpResource(value, manifestUrl)
        if (target === null || bypassHlsTransport(target)) return line
        observeResource?.(target)
        return `#EXT-X-PREFETCH:${createStreamingProxyPath('stream-ts', target, security, nestedIdentity, false, true)}`
      }
      const rewritten = line.replace(/URI=(["'])(.*?)\1/g, (match, quote: string, value: string) => {
        const target = resolveHttpResource(decodeXml(value), manifestUrl)
        if (target === null || bypassHlsTransport(target)) return match
        observeResource?.(target)
        const playlist = line.startsWith('#EXT-X-MEDIA') || target.pathname.toLowerCase().endsWith('.m3u8')
        const path = createStreamingProxyPath(playlist ? 'hls' : 'stream-ts', target, security, nestedIdentity, false, true)
        return `URI=${quote}${path}${quote}`
      })
      nextUriIsPlaylist = line.startsWith('#EXT-X-STREAM-INF')
      return rewritten
    }
    if (line.trim().length === 0) return line
    const target = resolveHttpResource(line.trim(), manifestUrl)
    if (target === null || bypassHlsTransport(target)) return line
    observeResource?.(target)
    const playlist = nextUriIsPlaylist || target.pathname.toLowerCase().endsWith('.m3u8')
    nextUriIsPlaylist = false
    return createStreamingProxyPath(playlist ? 'hls' : 'stream-ts', target, security, nestedIdentity, false, true)
  })
  return `${output.join('\n').trimEnd()}\n`
}

export function rewriteMpdManifest(
  input: string,
  manifestUrl: URL,
  security: Security,
  identity: StreamingIdentity,
  observeResource?: (target: URL) => void
): string {
  const nestedIdentity = withoutSourceRecovery(identity)
  input = repairMpdManifest(input)
  const firstBase = input.match(/<BaseURL\b[^>]*>([\s\S]*?)<\/BaseURL>/i)?.[1]
  const effectiveBase = firstBase === undefined
    ? manifestUrl
    : resolveHttpResource(decodeXml(firstBase.trim()), manifestUrl) ?? manifestUrl

  let output = input.replace(/(<BaseURL\b[^>]*>)([\s\S]*?)(<\/BaseURL>)/gi, (_match, open: string, value: string, close: string) => {
    const target = resolveHttpResource(decodeXml(value.trim()), manifestUrl)
    if (target === null) return `${open}${value}${close}`
    observeResource?.(target)
    const path = createStreamingBasePath(target, security, nestedIdentity)
    return `${open}${escapeXml(path)}${close}`
  })

  output = output.replace(/\b(media|initialization|sourceURL|FBPredictedMedia|reportingUrl|xlink:href)=(["'])(.*?)\2/gi, (match, attribute: string, quote: string, value: string) => {
    const decoded = decodeXml(value)
    if (decoded.startsWith('#') || /^[A-Za-z][A-Za-z0-9+.-]*:(?!https?:)/.test(decoded)) return match
    const target = resolveHttpResource(decoded, effectiveBase)
    if (target === null) return match
    observeResource?.(target)
    const route: StreamingRoute = attribute.toLowerCase() === 'xlink:href'
      ? 'mpd'
      : 'stream-seg'
    const path = createStreamingProxyPath(route, target, security, nestedIdentity, true, true)
    return `${attribute}=${quote}${escapeXml(path)}${quote}`
  })

  output = output.replace(/\bmoreInformationURL=(["'])(.*?)\1/gi, (match, quote: string, value: string) => {
    const target = resolveHttpResource(decodeXml(value), effectiveBase)
    if (target === null) return match
    return `moreInformationURL=${quote}${escapeXml(createRedirectProxyPath(target, security, nestedIdentity))}${quote}`
  })

  output = output.replace(/(<UTCTiming\b[^>]*\bvalue=)(["'])(.*?)\2/gi, (match, prefix: string, quote: string, value: string) => {
    const target = resolveHttpResource(decodeXml(value), effectiveBase)
    if (target === null) return match
    observeResource?.(target)
    const rewritten = createStreamingProxyPath('stream-seg', target, security, nestedIdentity, true, true)
    return `${prefix}${quote}${escapeXml(rewritten)}${quote}`
  })
  return output
}

function createStreamingBasePath(target: URL, security: Security, identity: StreamingIdentity): string {
  if (!target.pathname.endsWith('/')) {
    return createStreamingProxyPath('stream-seg', target, security, identity, false, true)
  }
  const normalized = new URL(target)
  normalized.search = ''
  normalized.hash = ''
  const identityToken = security.encryptURL(`${identity.host}~${identity.id}`)
  return withInternalQuery(`/stream-seg/${identityToken}/${security.encryptURL(normalized.toString())}/`, identity, security)
}

function createRedirectProxyPath(target: URL, security: Security, identity: StreamingIdentity): string {
  const origin = new URL('/', target)
  origin.search = ''
  origin.hash = ''
  const tail = `${target.pathname.replace(/^\//, '')}${target.search}${target.hash}`
  const identityToken = security.encryptURL(`${identity.host}~${identity.id}`)
  return `/redirect/${identityToken}/${security.encryptURL(origin.toString())}/${tail}`
}

function withInternalQuery(value: string, identity: StreamingIdentity, security: Security): string {
  const internal = new URLSearchParams()
  if (identity.live === true) internal.set('gl', '1')
  if (identity.downloadable === true) internal.set('dl', '1')
  if (identity.recoverable === true) internal.set('gxr', '1')
  if (identity.label !== undefined && identity.label.trim() !== '') internal.set('gcl', security.encryptURL(identity.label))
  if (identity.title !== undefined && validCacheTitle(identity.title)) internal.set('gct', security.encryptURL(identity.title))
  if (identity.contextToken !== undefined && PROVIDER_CONTEXT_TOKEN_PATTERN.test(identity.contextToken)) internal.set('gsc', identity.contextToken)
  if (identity.accessToken !== undefined && validAccessToken(identity.accessToken)) internal.set('gt', identity.accessToken)
  const query = internal.toString()
  return query === '' ? value : `${value}${value.includes('?') ? '&' : '?'}${query}`
}

function withoutSourceRecovery(identity: StreamingIdentity): StreamingIdentity {
  const { recoverable: _recoverable, ...nested } = identity
  return nested
}

function cacheLabel(request: URL, security: Security): string | null {
  const token = request.searchParams.get('gcl') ?? ''
  if (token === '' || token.length > 2_048) return null
  const label = security.decryptURLStrict(token)?.trim() ?? ''
  return label === '' || label.length > 120 ? null : label
}

function cacheTitle(request: URL, security: Security): string | null {
  const token = request.searchParams.get('gct') ?? ''
  if (token === '' || token.length > 2_048) return null
  const title = security.decryptURLStrict(token) ?? ''
  return validCacheTitle(title) ? title : null
}

function validCacheTitle(value: string): boolean {
  return value.trim() !== '' && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
}

function providerContextToken(request: URL): string | null {
  const token = request.searchParams.get('gsc') ?? ''
  return PROVIDER_CONTEXT_TOKEN_PATTERN.test(token) ? token : null
}

function streamingAccessToken(request: URL): string | null {
  const token = request.searchParams.get('gt') ?? ''
  return validAccessToken(token) ? token : null
}

function validAccessToken(token: string): boolean {
  return token.length >= 8 && token.length <= MAX_ACCESS_TOKEN_LENGTH && !/[\u0000-\u001f\u007f]/.test(token)
}

function targetHeadersOption(
  identity: StreamingIdentity,
  options: StreamingRouteOptions
): Readonly<{ headersForTarget?: (target: URL) => Promise<Headers> }> {
  if (options.providerContexts === undefined && options.customHeaders === undefined) return {}
  return {
    headersForTarget: async (target) => {
      const headers = identity.contextToken === undefined || options.providerContexts === undefined
        ? new Headers()
        : options.providerContexts.headersForTarget(identity.contextToken, target)
      if (options.customHeaders !== undefined) {
        for (const [name, value] of new Headers(await options.customHeaders(target))) headers.set(name, value)
      }
      return headers
    }
  }
}

function manifestResourceObserver(
  identity: StreamingIdentity,
  manifestUrl: URL,
  registry: ProviderStreamContextRegistry | undefined
): ((target: URL) => void) | undefined {
  if (identity.contextToken === undefined || registry === undefined) return undefined
  return (target) => {
    registry.authorizeManifestResource(identity.contextToken as string, manifestUrl, target)
  }
}

function cacheableManifest(content: string, contextToken: string | undefined, accessToken: string | undefined): string {
  if (contextToken !== undefined) {
    content = content.replaceAll(`gsc=${contextToken}`, `gsc=${CACHED_PROVIDER_CONTEXT_PLACEHOLDER}`)
  }
  if (accessToken !== undefined) {
    content = content.replaceAll(`gt=${encodeURIComponent(accessToken)}`, `gt=${CACHED_ACCESS_TOKEN_PLACEHOLDER}`)
  }
  return content
}

function bindCachedManifestTokens(content: string, contextToken: string | undefined, accessToken: string | undefined): string | null {
  const hasContextPlaceholder = content.includes(`gsc=${CACHED_PROVIDER_CONTEXT_PLACEHOLDER}`)
  if ((contextToken === undefined && hasContextPlaceholder) || (contextToken !== undefined && !hasContextPlaceholder)) return null
  if (contextToken !== undefined) {
    content = content.replaceAll(`gsc=${CACHED_PROVIDER_CONTEXT_PLACEHOLDER}`, `gsc=${contextToken}`)
  }

  const hasAccessPlaceholder = content.includes(`gt=${CACHED_ACCESS_TOKEN_PLACEHOLDER}`)
  if ((accessToken === undefined && hasAccessPlaceholder) || (accessToken !== undefined && !hasAccessPlaceholder)) return null
  if (accessToken !== undefined) {
    content = content.replaceAll(`gt=${CACHED_ACCESS_TOKEN_PLACEHOLDER}`, `gt=${encodeURIComponent(accessToken)}`)
  }
  return content
}

function authorizeCachedManifestResources(
  content: string,
  manifestUrl: URL,
  security: Security,
  identity: StreamingIdentity,
  registry: ProviderStreamContextRegistry | undefined
): void {
  if (identity.contextToken === undefined || registry === undefined) return
  const matches = content.matchAll(/\/(hls|mpd|stream-ts|stream-seg)\/[^\s"'<>]+/g)
  for (const match of matches) {
    const route = match[1] as StreamingRoute | undefined
    if (route === undefined) continue
    const decoded = decodeXml(match[0])
    const parsed = parseStreamingTarget(decoded, route, security)
    if (parsed !== null) registry.authorizeManifestResource(identity.contextToken, manifestUrl, parsed.target)
  }
}

function mediaDownloadFilename(identity: StreamingIdentity): string {
  const title = identity.title ?? 'video.mp4'
  const stem = path.posix.parse(title).name
  const label = identity.label ?? ''
  const joined = `${stem}-${label}`.replace(/^[ _-]+|[ _-]+$/gu, '') || 'video'
  const safe = joined
    .toWellFormed()
    .replace(/[\u0000-\u001f\u007f/\\]/gu, '_')
  return `${Array.from(safe).slice(0, 480).join('')}.mp4`
}

function encodedDispositionFilename(value: string): string {
  return encodeURIComponent(value.toWellFormed()).replace(/['()*]/gu, (character) =>
    `%${character.codePointAt(0)?.toString(16).toUpperCase().padStart(2, '0') ?? '3F'}`)
}

function remoteMediaDisposition(identity: StreamingIdentity): string {
  if (identity.downloadable !== true) return 'inline'
  return `attachment; filename*=UTF-8''${encodedDispositionFilename(mediaDownloadFilename(identity))}`
}

function cachedMediaDisposition(identity: StreamingIdentity): string {
  const disposition = identity.downloadable === true ? 'attachment' : 'inline'
  const filename = mediaDownloadFilename(identity)
  const ascii = filename
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .replace(/[^\x20-\x7e]/gu, '_')
    .replace(/["\\]/gu, '_')
  const quoted = `${disposition}; filename="${ascii}"`
  return ascii === filename ? quoted : `${quoted}; filename*=UTF-8''${encodedDispositionFilename(filename)}`
}

async function sendCachedMedia(
  request: FastifyRequest,
  reply: FastifyReply,
  cacheRoot: string,
  identity: StreamingIdentity,
  settings: StreamCacheSettings
): Promise<boolean> {
  const paths = mediaCachePaths(cacheRoot, identity.host, identity.id, identity.label ?? 'Original')
  const details = await lstat(paths.complete).catch(() => null)
  if (details === null || !details.isFile() || details.isSymbolicLink() || details.size <= 0) return false
  const rangeValue = typeof request.headers.range === 'string' ? request.headers.range : ''
  const range = rangeValue === '' ? Object.freeze({ start: 0, end: Math.max(0, details.size - 1) }) : parseByteRange(rangeValue, details.size)
  if (range === null) {
    reply
      .header('accept-ranges', 'bytes')
      .header('content-range', `bytes */${details.size}`)
      .header('cache-control', 'no-store')
      .code(416)
      .send()
    return true
  }
  const partial = rangeValue !== ''
  const localFileMode = settings.mode === 'php'
  const contentType = isAppleStreamingUserAgent(request.headers['user-agent'] ?? '') || !localFileMode && request.method !== 'GET'
    ? 'video/mp4'
    : 'application/octet-stream'
  reply
    .header('accept-ranges', 'bytes')
    .header('content-type', contentType)
    .header('content-length', Math.max(0, range.end - range.start + 1))
    .header('last-modified', details.mtime.toUTCString())
    .header('cache-control', `public, max-age=${localFileMode ? 3_600 : settings.maxAgeSeconds}`)
    .header('content-disposition', localFileMode ? cachedMediaDisposition(identity) : remoteMediaDisposition(identity))
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .code(partial ? 206 : 200)
  if (localFileMode || partial) reply.header('content-range', `bytes ${range.start}-${range.end}/${details.size}`)
  if (localFileMode) reply.header('x-cache', 'HIT')
  sendCachedFile(reply, settings.mode, paths.complete, cacheOffloadPath(cacheRoot, paths.complete), () => createReadStream(paths.complete, { start: range.start, end: range.end }))
  return true
}

function sendCachedStreamResource(
  request: FastifyRequest,
  reply: FastifyReply,
  cache: StreamCache,
  entry: StreamCacheEntry,
  kind: 'stream-ts' | 'stream-seg',
  settings: StreamCacheSettings,
  live: boolean
): unknown {
  for (const [name, value] of Object.entries(entry.headers)) reply.header(name, value)
  if (entry.headers['content-type'] === undefined) reply.header('content-type', defaultBinaryContentType(kind))
  const maxAge = live ? Math.min(60, settings.maxAgeSeconds) : settings.maxAgeSeconds
  reply
    .header('accept-ranges', 'bytes')
    .header('content-length', entry.size)
    .header('last-modified', entry.modified.toUTCString())
    .header('cache-control', `public, max-age=${maxAge}`)
    .header('content-disposition', 'inline')
    .header('x-cache', 'HIT')
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .code(200)
  if (request.method === 'HEAD') return reply.send()
  return sendCachedFile(reply, settings.mode, entry.file, entry.offloadPath, () => cache.open(entry))
}

function sendCachedFile(
  reply: FastifyReply,
  mode: StreamCacheMode,
  file: string,
  offloadPath: string,
  nodeStream: () => Readable
): unknown {
  if (mode === 'apache') return reply.header('x-sendfile', file).header('x-cache-server', 'HIT').send()
  if (mode === 'nginx') return reply.header('x-accel-buffering', 'no').header('x-accel-redirect', offloadPath).header('x-cache-server', 'HIT').send()
  if (mode === 'litespeed') return reply.header('x-litespeed-location', offloadPath).header('x-cache-server', 'HIT').send()
  return reply.send(nodeStream())
}

function cacheOffloadPath(cacheRoot: string, file: string): string {
  const filesRoot = path.resolve(cacheRoot, 'files')
  const resolved = path.resolve(file)
  if (resolved === filesRoot || !resolved.startsWith(`${filesRoot}${path.sep}`)) throw new Error('Cached media path escaped its configured root')
  return `/cache-files/${path.relative(filesRoot, resolved).split(path.sep).join('/')}`
}

function resolveHttpResource(value: string, base: URL): URL | null {
  try {
    const target = new URL(value, base)
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) return null
    return target
  } catch {
    return null
  }
}

function bypassHlsTransport(target: URL): boolean {
  const hostname = target.hostname.toLowerCase()
  return HLS_DIRECT_TRANSPORT_DOMAINS.some((domain) => hostname.includes(domain))
}

function repairMpdManifest(input: string): string {
  if (/<MPD\b/i.test(input)) return input
  const duration = input.match(/\bduration=(["'])(.*?)\1/i)?.[2]
  if (duration === undefined || duration.trim() === '') return input
  return `<?xml version="1.0" encoding="UTF-8"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static" mediaPresentationDuration="${escapeXml(duration)}">${input}</MPD>`
}

function sendManifest(
  reply: FastifyReply,
  kind: 'hls' | 'mpd',
  content: string,
  live: boolean,
  configuredMaxAge: number,
  cacheHit: boolean,
  head: boolean
): unknown {
  const maxAge = Math.max(0, Math.min(31_536_000, Math.trunc(configuredMaxAge)))
  reply
    .header('content-type', manifestContentType(kind))
    .header('content-length', Buffer.byteLength(content))
    .header('cache-control', live ? 'no-store' : `public, max-age=${maxAge}`)
    .header('x-gplayer-live', live ? '1' : '0')
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .code(200)
  if (cacheHit) reply.header('x-cache', 'HIT')
  return reply.send(head ? undefined : content)
}

function normalizeCacheSettings(input: StreamCacheSettings): StreamCacheSettings {
  const mode: StreamCacheMode = input.mode === 'apache' || input.mode === 'litespeed' || input.mode === 'nginx' ? input.mode : 'php'
  const maxAgeSeconds = Number.isFinite(input.maxAgeSeconds)
    ? Math.max(0, Math.min(31_536_000, Math.trunc(input.maxAgeSeconds)))
    : 0
  return Object.freeze({ enabled: input.enabled === true, maxAgeSeconds, mode })
}

function remoteReadable(body: ReadableStream<Uint8Array>, maximumBytesPerSecond: number): Readable {
  const source = Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>)
  if (maximumBytesPerSecond <= 0) return source
  return source.pipe(new RateLimitTransform(maximumBytesPerSecond))
}

class RateLimitTransform extends Transform {
  private bytes = 0
  private readonly started = Date.now()

  public constructor(private readonly maximumBytesPerSecond: number) {
    super()
  }

  public override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.byteLength
    const expectedElapsed = this.bytes / this.maximumBytesPerSecond * 1_000
    const delay = Math.max(0, Math.ceil(expectedElapsed - (Date.now() - this.started)))
    if (delay === 0) callback(null, chunk)
    else setTimeout(callback, delay, null, chunk)
  }
}

type Mp4RangeSizeEntry = Readonly<{
  size: number
  expiresAt: number
}>

class Mp4RangeMemory {
  private readonly entries = new Map<string, Mp4RangeSizeEntry>()
  private readonly maximumEntries: number

  public constructor(
    private readonly now: () => number = Date.now,
    maximumEntries = DEFAULT_MP4_RANGE_MEMORY_ENTRIES
  ) {
    this.maximumEntries = Number.isFinite(maximumEntries)
      ? Math.max(1, Math.min(65_536, Math.trunc(maximumEntries)))
      : DEFAULT_MP4_RANGE_MEMORY_ENTRIES
  }

  public rewrite(host: string, target: URL, rawRange: string): string {
    const key = target.toString()
    const entry = this.entries.get(key)
    if (entry === undefined) return rawRange
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return rawRange
    }

    const chunkSize = host.toLowerCase() === 'mp4upload' ? 9_999_999 : 4_999_999
    if (entry.size <= chunkSize) return rawRange
    const match = rawRange.match(/^bytes=(\d*)-(\d*)$/i)
    if (match === null) return rawRange
    const start = Number(match[1] ?? 0)
    if (!Number.isSafeInteger(start) || start < 0 || start >= entry.size) return rawRange
    const end = Math.min(start + chunkSize, entry.size - 1)
    return `bytes=${start}-${end}`
  }

  public observe(target: URL, contentRange: string | null): void {
    const match = contentRange?.match(/^bytes\s+\d+-\d+\/(\d+)$/i)
    if (match === undefined || match === null) return
    const size = Number(match[1])
    if (!Number.isSafeInteger(size) || size <= 0) return
    const now = this.now()
    this.prune(now)
    const key = target.toString()
    this.entries.delete(key)
    while (this.entries.size >= this.maximumEntries) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    this.entries.set(key, Object.freeze({ size, expiresAt: now + MP4_RANGE_SIZE_TTL_MILLISECONDS }))
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key)
    }
  }
}

function requestHeaders(request: FastifyRequest, rangeOverride?: string): Headers {
  const headers = new Headers()
  for (const name of ['accept', 'accept-language', 'if-modified-since', 'if-none-match', 'if-range', 'range', 'user-agent']) {
    const value = request.headers[name]
    if (typeof value === 'string') headers.set(name, value)
  }
  if (rangeOverride !== undefined) headers.set('range', rangeOverride)
  return headers
}

async function readLimitedText(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (body === null) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) throw new Error(`Manifest exceeds the ${limit}-byte limit`)
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
}

function manifestContentType(kind: 'hls' | 'mpd'): string {
  return kind === 'hls' ? 'application/vnd.apple.mpegurl; charset=utf-8' : 'application/dash+xml; charset=utf-8'
}

function defaultBinaryContentType(kind: 'stream-ts' | 'stream-seg' | 'stream-vid'): string {
  if (kind === 'stream-ts') return 'video/mp2t'
  if (kind === 'stream-vid') return 'video/mp4'
  return 'application/octet-stream'
}

function decodeXml(value: string): string {
  return value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>')
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&apos;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function streamError(reply: FastifyReply, status: number, message: string): unknown {
  return reply
    .header('cache-control', 'no-store')
    .header('content-type', 'text/plain; charset=utf-8')
    .header('x-content-type-options', 'nosniff')
    .code(status)
    .send(message)
}
