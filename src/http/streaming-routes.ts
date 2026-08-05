import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import { Security } from '../security/security.js'
import { RemoteStream, type RemoteStreamResponse } from '../stream/remote-stream.js'

const MAX_MANIFEST_BYTES = 5 * 1_024 * 1_024
const MAX_STREAM_URL_LENGTH = 16_384
const INTERNAL_QUERY_KEYS = new Set(['_', 'dl', 'gd', 'gl', 'gx', 'gxr', 'gt'])
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
}>

export type StreamingRouteOptions = Readonly<{
  remoteStream?: RemoteStream
  /** Integration-test escape hatch. Public deployments must keep this false. */
  allowPrivateNetworks?: boolean
  customHeaders?: (target: URL) => RequestInit['headers'] | Promise<RequestInit['headers']>
}>

export function createStreamingProxyPath(
  route: StreamingRoute,
  target: URL,
  security: Security,
  identity: StreamingIdentity = { host: 'direct', id: target.toString() },
  preserveTail = false
): string {
  const identityToken = security.encryptURL(`${identity.host}~${identity.id}`)
  if (!preserveTail) return `/${route}/${identityToken}/${security.encryptURL(target.toString())}`

  const base = new URL('.', target)
  base.search = ''
  base.hash = ''
  const tail = target.pathname.slice(base.pathname.length) + target.search
  return `/${route}/${identityToken}/${security.encryptURL(base.toString())}/${tail}`
}

export async function registerStreamingRoutes(
  app: FastifyInstance,
  config: AppConfig,
  options: StreamingRouteOptions = {}
): Promise<void> {
  const security = new Security(config.secureSalt)
  const remoteStream = options.remoteStream ?? new RemoteStream()
  const allowPrivateNetworks = options.allowPrivateNetworks ?? false

  const manifestHandler = (kind: 'hls' | 'mpd') => async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const parsed = parseStreamingTarget(request.url, kind, security)
    if (parsed === null) return streamError(reply, 400, 'Invalid stream link')

    try {
      const response = await remoteStream.open({
        url: parsed.target,
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: requestHeaders(request),
        ...(options.customHeaders === undefined ? {} : { headersForTarget: options.customHeaders }),
        allowPrivateNetworks
      })
      if (response.status === 304) return reply.code(304).send()
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel()
        return streamError(reply, response.status === 404 ? 404 : 502, 'Stream manifest is unavailable')
      }
      if (request.method === 'HEAD') {
        await response.body?.cancel()
        return reply
          .header('content-type', manifestContentType(kind))
          .header('cache-control', 'no-cache')
          .header('x-content-type-options', 'nosniff')
          .code(200)
          .send()
      }

      const source = await readLimitedText(response.body, MAX_MANIFEST_BYTES)
      const content = kind === 'hls'
        ? rewriteHlsPlaylist(source, response.url, security, parsed.identity)
        : rewriteMpdManifest(source, response.url, security, parsed.identity)
      if (content.trim().length === 0) return streamError(reply, 404, 'Stream manifest is unavailable')
      const live = kind === 'hls'
        ? content.includes('#EXTINF') && !content.includes('#EXT-X-ENDLIST')
        : /\btype=["']dynamic["']/i.test(content)

      return reply
        .header('content-type', manifestContentType(kind))
        .header('content-length', Buffer.byteLength(content))
        .header('cache-control', live ? 'no-store' : 'public, max-age=300')
        .header('x-gplayer-live', live ? '1' : '0')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .code(200)
        .send(content)
    } catch {
      return streamError(reply, 502, 'Stream manifest is unavailable')
    }
  }

  const binaryHandler = (kind: 'stream-ts' | 'stream-seg' | 'stream-vid') => async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const parsed = parseStreamingTarget(request.url, kind, security)
    if (parsed === null) return streamError(reply, 400, 'Invalid stream link')

    try {
      const response = await remoteStream.open({
        url: parsed.target,
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: requestHeaders(request),
        ...(options.customHeaders === undefined ? {} : { headersForTarget: options.customHeaders }),
        allowPrivateNetworks
      })
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel()
        return streamError(reply, response.status === 404 ? 404 : 502, 'Stream resource is unavailable')
      }

      for (const name of binaryResponseHeaders) {
        const value = response.headers.get(name)
        if (value !== null) reply.header(name, value)
      }
      if (response.headers.get('content-type') === null) reply.header('content-type', defaultBinaryContentType(kind))
      reply
        .header('content-disposition', 'inline')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .code(response.status)
      if (response.body === null) return reply.send()
      return reply.send(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>))
    } catch {
      return streamError(reply, 502, 'Stream resource is unavailable')
    }
  }

  app.get('/hls/*', manifestHandler('hls'))
  app.get('/mpd/*', manifestHandler('mpd'))
  app.get('/stream-ts/*', binaryHandler('stream-ts'))
  app.get('/stream-seg/*', binaryHandler('stream-seg'))
  app.get('/stream-vid/*', binaryHandler('stream-vid'))
}

type ParsedStreamingTarget = Readonly<{
  identity: StreamingIdentity
  target: URL
}>

function parseStreamingTarget(requestUrl: string, route: StreamingRoute, security: Security): ParsedStreamingTarget | null {
  const request = new URL(requestUrl, 'http://gplayer.invalid')
  const prefix = `/${route}/`
  if (!request.pathname.startsWith(prefix)) return null
  const parts = request.pathname.slice(prefix.length).split('/')
  const identityToken = parts.shift() ?? ''
  const baseToken = parts.shift() ?? ''
  const identityValue = security.decryptURLStrict(identityToken)
  const baseValue = security.decryptURLStrict(baseToken)
  if (identityValue === null || baseValue === null) return null
  const separator = identityValue.indexOf('~')
  if (separator <= 0 || separator === identityValue.length - 1) return null

  try {
    const base = new URL(baseValue)
    const target = parts.length === 0 || parts.every((part) => part.length === 0)
      ? base
      : new URL(parts.join('/'), base)
    for (const [key, value] of request.searchParams) {
      if (!INTERNAL_QUERY_KEYS.has(key)) target.searchParams.append(key, value)
    }
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) return null
    if (target.toString().length > MAX_STREAM_URL_LENGTH) return null
    return {
      identity: {
        host: identityValue.slice(0, separator),
        id: identityValue.slice(separator + 1)
      },
      target
    }
  } catch {
    return null
  }
}

export function rewriteHlsPlaylist(
  input: string,
  manifestUrl: URL,
  security: Security,
  identity: StreamingIdentity
): string {
  const lines = input.replace(/\r\n?/g, '\n').split('\n')
  let nextUriIsPlaylist = false
  const output = lines.map((rawLine) => {
    const line = rawLine.trimEnd()
    if (line.startsWith('#')) {
      const rewritten = line.replace(/URI=(["'])(.*?)\1/g, (match, quote: string, value: string) => {
        const target = resolveHttpResource(decodeXml(value), manifestUrl)
        if (target === null) return match
        const playlist = line.startsWith('#EXT-X-MEDIA') || target.pathname.toLowerCase().endsWith('.m3u8')
        const path = createStreamingProxyPath(playlist ? 'hls' : 'stream-ts', target, security, identity)
        return `URI=${quote}${path}${quote}`
      })
      nextUriIsPlaylist = line.startsWith('#EXT-X-STREAM-INF')
      return rewritten
    }
    if (line.trim().length === 0) return line
    const target = resolveHttpResource(line.trim(), manifestUrl)
    if (target === null) return line
    const playlist = nextUriIsPlaylist || target.pathname.toLowerCase().endsWith('.m3u8')
    nextUriIsPlaylist = false
    return createStreamingProxyPath(playlist ? 'hls' : 'stream-ts', target, security, identity)
  })
  return `${output.join('\n').trimEnd()}\n`
}

export function rewriteMpdManifest(
  input: string,
  manifestUrl: URL,
  security: Security,
  identity: StreamingIdentity
): string {
  const firstBase = input.match(/<BaseURL\b[^>]*>([\s\S]*?)<\/BaseURL>/i)?.[1]
  const effectiveBase = firstBase === undefined
    ? manifestUrl
    : resolveHttpResource(decodeXml(firstBase.trim()), manifestUrl) ?? manifestUrl

  let output = input.replace(/(<BaseURL\b[^>]*>)([\s\S]*?)(<\/BaseURL>)/gi, (_match, open: string, value: string, close: string) => {
    const target = resolveHttpResource(decodeXml(value.trim()), manifestUrl)
    if (target === null) return `${open}${value}${close}`
    const path = createStreamingBasePath(target, security, identity)
    return `${open}${escapeXml(path)}${close}`
  })

  output = output.replace(/\b(media|initialization|sourceURL|href)=(["'])(.*?)\2/gi, (match, attribute: string, quote: string, value: string) => {
    const decoded = decodeXml(value)
    if (decoded.startsWith('#') || /^[A-Za-z][A-Za-z0-9+.-]*:(?!https?:)/.test(decoded)) return match
    const target = resolveHttpResource(decoded, effectiveBase)
    if (target === null) return match
    const route: StreamingRoute = attribute.toLowerCase() === 'href' && target.pathname.toLowerCase().endsWith('.mpd')
      ? 'mpd'
      : 'stream-seg'
    const path = createStreamingProxyPath(route, target, security, identity, true)
    return `${attribute}=${quote}${escapeXml(path)}${quote}`
  })
  return output
}

function createStreamingBasePath(target: URL, security: Security, identity: StreamingIdentity): string {
  if (!target.pathname.endsWith('/')) {
    return createStreamingProxyPath('stream-seg', target, security, identity)
  }
  const normalized = new URL(target)
  normalized.search = ''
  normalized.hash = ''
  const identityToken = security.encryptURL(`${identity.host}~${identity.id}`)
  return `/stream-seg/${identityToken}/${security.encryptURL(normalized.toString())}/`
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

function requestHeaders(request: FastifyRequest): Headers {
  const headers = new Headers()
  for (const name of ['accept', 'accept-language', 'if-modified-since', 'if-none-match', 'if-range', 'range', 'user-agent']) {
    const value = request.headers[name]
    if (typeof value === 'string') headers.set(name, value)
  }
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
