import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import { Security } from '../security/security.js'
import { RemoteStream, type RemoteStreamResponse } from '../stream/remote-stream.js'
import type { ProviderStreamContextRegistry } from '../stream/provider-stream-context.js'
import { PublicMediaCache, type PublicMediaCacheKind } from '../stream/public-media-cache.js'

const MAX_MEDIA_URL_LENGTH = 8_192
const MAX_POSTER_BYTES = 20 * 1_024 * 1_024
const MAX_SUBTITLE_BYTES = 5 * 1_024 * 1_024
const MAX_FILMSTRIP_BYTES = 20 * 1_024 * 1_024
const PROVIDER_CONTEXT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const forwardedResponseHeaders = [
  'accept-ranges',
  'cache-control',
  'content-encoding',
  'content-language',
  'content-length',
  'content-range',
  'etag',
  'expires',
  'last-modified'
] as const

export type MediaRouteOptions = Readonly<{
  remoteStream?: RemoteStream
  /** Integration-test escape hatch. Public deployments must keep this false. */
  allowPrivateNetworks?: boolean
  publicRoot?: string
  providerContexts?: ProviderStreamContextRegistry
}>

export function createMediaProxyPath(
  route: 'filmstrip' | 'poster' | 'subtitle',
  value: string,
  security: Security,
  contextToken?: string
): string | null {
  let target: URL
  try {
    target = new URL(value.trim())
  } catch {
    return null
  }
  if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) return null
  const extension = route === 'poster' ? posterExtension(target) : 'vtt'
  const path = `/${route}/${security.encryptURL(target.toString())}.${extension}`
  return contextToken !== undefined && PROVIDER_CONTEXT_TOKEN_PATTERN.test(contextToken)
    ? `${path}?gsc=${contextToken}`
    : path
}

export async function registerMediaRoutes(
  app: FastifyInstance,
  config: AppConfig,
  options: MediaRouteOptions = {}
): Promise<void> {
  const security = new Security(config.secureSalt)
  const remoteStream = options.remoteStream ?? new RemoteStream()
  const allowPrivateNetworks = options.allowPrivateNetworks ?? false
  const publicMediaCache = options.publicRoot === undefined
    ? undefined
    : new PublicMediaCache(options.publicRoot, config.baseUrl)
  if (publicMediaCache !== undefined) {
    app.addHook('onClose', async () => await publicMediaCache.settle())
  }

  const poster = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const target = mediaTarget(request.url, 'poster', security)
    if (target === null) return mediaError(reply, 400, 'Invalid poster link')
    if (target.hostname === config.baseUrl.hostname) return cachedMediaRedirect(reply, target)
    const cached = await readCachedMedia(publicMediaCache, 'poster', target)
    if (cached !== null) return cachedMediaRedirect(reply, cached.url)

    try {
      const response = await remoteStream.open({
        url: target,
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: requestHeaders(request),
        ...providerHeadersOption(request.url, options.providerContexts),
        allowPrivateNetworks
      })
      if (!successfulMediaResponse(response)) {
        await response.body?.cancel()
        return mediaError(reply, response.status === 404 ? 404 : 502, 'Poster is unavailable')
      }

      applyProxyHeaders(reply, response)
      const contentType = response.headers.get('content-type') ?? ''
      reply
        .header('content-type', contentType.toLowerCase().startsWith('image/') ? contentType : 'application/octet-stream')
        .header('content-disposition', 'inline')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .code(response.status)
      if (request.method !== 'HEAD' && response.status === 200 && response.body !== null && publicMediaCache !== undefined) {
        const branches = response.body.tee()
        publicMediaCache.capture('poster', target, branches[1], MAX_POSTER_BYTES)
        return sendWebBody(reply, branches[0])
      }
      return sendRemoteBody(reply, response)
    } catch {
      return mediaError(reply, 502, 'Poster is unavailable')
    }
  }

  const subtitle = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const target = mediaTarget(request.url, 'subtitle', security)
    if (target === null) return mediaError(reply, 400, 'Invalid subtitle link')
    const cached = await readCachedMedia(publicMediaCache, 'subtitle', target)
    if (cached !== null) return cachedMediaRedirect(reply, cached.url)

    try {
      const response = await remoteStream.open({
        url: target,
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: requestHeaders(request),
        ...providerHeadersOption(request.url, options.providerContexts),
        allowPrivateNetworks
      })
      if (!successfulMediaResponse(response)) {
        await response.body?.cancel()
        return mediaError(reply, response.status === 404 ? 404 : 502, 'Subtitle is unavailable')
      }
      if (request.method === 'HEAD') {
        await response.body?.cancel()
        return reply
          .header('content-type', 'text/vtt; charset=utf-8')
          .header('cache-control', 'public, max-age=300')
          .header('x-content-type-options', 'nosniff')
          .code(200)
          .send()
      }

      const source = await readLimitedText(response.body, MAX_SUBTITLE_BYTES)
      const output = normalizeWebVtt(source, target)
      await publicMediaCache?.write('subtitle', target, Buffer.from(output), MAX_SUBTITLE_BYTES).catch(() => undefined)
      return reply
        .header('content-type', 'text/vtt; charset=utf-8')
        .header('content-length', Buffer.byteLength(output))
        .header('cache-control', 'public, max-age=300')
        .header('content-disposition', 'inline')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .code(200)
        .send(output)
    } catch {
      return mediaError(reply, 502, 'Subtitle is unavailable')
    }
  }

  const filmstrip = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const target = mediaTarget(request.url, 'filmstrip', security)
    if (target === null) return mediaError(reply, 400, 'Invalid filmstrip link')

    if (target.hostname === config.baseUrl.hostname) {
      return reply
        .header('cache-control', 'public, max-age=300')
        .redirect(target.toString(), 302)
    }
    const customSize = customFilmstripSize(target)
    if (customSize !== null) {
      const cachedImage = await readCachedMedia(publicMediaCache, 'filmstrip-image', target)
      if (cachedImage !== null && cachedImage.size <= MAX_FILMSTRIP_BYTES) {
        const source = await readFile(cachedImage.file).catch(() => null)
        if (source !== null) return sendFilmstripOutput(reply, createSpriteFilmstripWebVtt(source, target, customSize.width, customSize.height))
      }
    }

    try {
      const response = await remoteStream.open({
        url: target,
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: requestHeaders(request),
        ...providerHeadersOption(request.url, options.providerContexts),
        allowPrivateNetworks
      })
      if (!successfulMediaResponse(response)) {
        await response.body?.cancel()
        return mediaError(reply, response.status === 404 ? 404 : 502, 'Filmstrip is unavailable')
      }
      if (request.method === 'HEAD') {
        await response.body?.cancel()
        return reply
          .header('content-type', 'text/vtt; charset=utf-8')
          .header('cache-control', 'public, max-age=300')
          .header('x-content-type-options', 'nosniff')
          .code(200)
          .send()
      }

      const source = await readLimitedBytes(response.body, MAX_FILMSTRIP_BYTES, 'Filmstrip')
      if (customSize !== null) {
        await publicMediaCache?.write('filmstrip-image', target, source, MAX_FILMSTRIP_BYTES).catch(() => undefined)
      }
      const output = customSize === null
        ? repairFilmstripWebVtt(new TextDecoder().decode(source), target)
        : createSpriteFilmstripWebVtt(source, target, customSize.width, customSize.height)
      return sendFilmstripOutput(reply, output)
    } catch {
      return mediaError(reply, 502, 'Filmstrip is unavailable')
    }
  }

  app.get('/poster', poster)
  app.get('/poster/*', poster)
  app.get('/subtitle', subtitle)
  app.get('/subtitle/*', subtitle)
  app.get('/filmstrip', filmstrip)
  app.get('/filmstrip/*', filmstrip)
}

function mediaTarget(requestUrl: string, route: 'filmstrip' | 'poster' | 'subtitle', security: Security): URL | null {
  const parsed = new URL(requestUrl, 'http://gplayer.invalid')
  const queryUrl = parsed.searchParams.get('url')?.trim() ?? ''
  let value = queryUrl

  if (value.length === 0) {
    const routePrefix = `/${route}/`
    if (!parsed.pathname.startsWith(routePrefix)) return null
    let pathToken: string
    try {
      pathToken = decodeURIComponent(parsed.pathname.slice(routePrefix.length))
        .replace(/\.[A-Za-z0-9]{1,8}$/, '')
    } catch {
      return null
    }
    value = security.decryptURLStrict(pathToken)?.trim().replace(/^[?#]+|[?#]+$/g, '') ?? ''
  }

  if (value.length === 0 || value.length > MAX_MEDIA_URL_LENGTH) return null
  try {
    const target = new URL(value)
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) return null
    return target
  } catch {
    return null
  }
}

function posterExtension(target: URL): string {
  const extension = target.pathname.split('.').at(-1)?.toLowerCase() ?? ''
  return ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'avif'].includes(extension) ? extension : 'jpg'
}

function requestHeaders(request: FastifyRequest): Headers {
  const headers = new Headers()
  for (const name of ['accept', 'accept-language', 'if-modified-since', 'if-none-match', 'if-range', 'range', 'user-agent']) {
    const value = request.headers[name]
    if (typeof value === 'string') headers.set(name, value)
  }
  return headers
}

function successfulMediaResponse(response: RemoteStreamResponse): boolean {
  return response.status >= 200 && response.status < 300
}

function applyProxyHeaders(reply: FastifyReply, response: RemoteStreamResponse): void {
  for (const name of forwardedResponseHeaders) {
    const value = response.headers.get(name)
    if (value !== null) reply.header(name, value)
  }
}

function sendRemoteBody(reply: FastifyReply, response: RemoteStreamResponse): unknown {
  if (response.body === null) return reply.send()
  return sendWebBody(reply, response.body)
}

function sendWebBody(reply: FastifyReply, body: ReadableStream<Uint8Array>): unknown {
  return reply.send(Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>))
}

async function readCachedMedia(
  cache: PublicMediaCache | undefined,
  kind: PublicMediaCacheKind,
  target: URL
): Promise<Awaited<ReturnType<PublicMediaCache['read']>>> {
  return cache === undefined ? null : await cache.read(kind, target).catch(() => null)
}

function cachedMediaRedirect(reply: FastifyReply, target: URL): unknown {
  return reply
    .header('cache-control', 'public, max-age=300')
    .header('referrer-policy', 'no-referrer')
    .header('x-content-type-options', 'nosniff')
    .redirect(target.toString(), 302)
}

function sendFilmstripOutput(reply: FastifyReply, output: string): unknown {
  return reply
    .header('content-type', 'text/vtt; charset=utf-8')
    .header('content-length', Buffer.byteLength(output))
    .header('cache-control', 'public, max-age=300')
    .header('content-disposition', 'inline')
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .code(200)
    .send(output)
}

function providerHeadersOption(
  requestUrl: string,
  registry: ProviderStreamContextRegistry | undefined
): Readonly<{ headersForTarget?: (target: URL) => Headers }> {
  if (registry === undefined) return {}
  const request = new URL(requestUrl, 'http://gplayer.invalid')
  const token = request.searchParams.get('gsc') ?? ''
  if (!PROVIDER_CONTEXT_TOKEN_PATTERN.test(token)) return {}
  return { headersForTarget: (target) => registry.headersForTarget(token, target) }
}

async function readLimitedText(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  return new TextDecoder().decode(await readLimitedBytes(body, limit, 'Subtitle'))
}

async function readLimitedBytes(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  resourceName: string
): Promise<Buffer> {
  if (body === null) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) throw new Error(`${resourceName} exceeds the ${limit}-byte limit`)
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
}

export function repairFilmstripWebVtt(input: string, sourceUrl: URL): string {
  let content = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (content.includes('roseimgs.com') && !content.includes('://')) {
    content = content.replaceAll('roseimgs.com/', 'https://roseimgs.com/')
  }

  const doodCdn = sourceUrl.hostname.toLowerCase().includes('doodcdn.')
  const doodBase = new URL(sourceUrl.origin)
  if (doodCdn) doodBase.hostname = doodBase.hostname.replace(/^i\.doodcdn\./, 'img.doodcdn.')

  const repaired = content.split('\n').map((line) => {
    const value = line.trim()
    if (!value.includes('#xywh=')) return line
    try {
      const absolute = new URL(value, doodCdn ? doodBase : sourceUrl)
      return absolute.toString()
    } catch {
      return line
    }
  }).join('\n').trim()

  return repaired.startsWith('WEBVTT') ? repaired : `WEBVTT\n\n${repaired}`
}

export function createSpriteFilmstripWebVtt(
  image: Uint8Array,
  sourceUrl: URL,
  thumbWidth: number,
  thumbHeight: number
): string {
  const dimensions = imageDimensions(image)
  if (dimensions === null || thumbWidth <= 0 || thumbHeight <= 0) return 'WEBVTT\n\n'

  const fragment = new URLSearchParams(sourceUrl.hash.replace(/^#/, ''))
  let count = positiveInteger(fragment.get('count'))
  const frequency = nonnegativeInteger(fragment.get('frequency'))
  if (count === 0 && dimensions.width === thumbWidth && dimensions.height > dimensions.width) {
    count = Math.floor(dimensions.height / thumbHeight)
  }

  const columns = Math.floor(dimensions.width / thumbWidth)
  const rows = Math.floor(dimensions.height / thumbHeight)
  if (count === 0 || count > columns * rows) return 'WEBVTT\n\n'

  const imageUrl = new URL(sourceUrl)
  imageUrl.hash = ''
  const cues: string[] = []
  for (let index = 0; index < count; index += 1) {
    const start = index * frequency
    const end = start + frequency
    const x = index % columns * thumbWidth
    const y = Math.floor(index / columns) * thumbHeight
    cues.push(`${formatTime(start)} --> ${formatTime(end)}\n${imageUrl.toString()}#xywh=${x},${y},${thumbWidth},${thumbHeight}`)
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n\n`
}

function customFilmstripSize(target: URL): Readonly<{ width: number, height: number }> | null {
  const hostname = target.hostname.toLowerCase()
  if ((hostname === 'mycdn.me' || hostname.endsWith('.mycdn.me')) && target.toString().includes('videoPreview')) {
    return { width: 80, height: 44 }
  }
  if (hostname === 'sendvid.com' || hostname.endsWith('.sendvid.com')) return { width: 200, height: 113 }
  return null
}

function imageDimensions(input: Uint8Array): Readonly<{ width: number, height: number }> | null {
  const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return validDimensions(data.readUInt32BE(16), data.readUInt32BE(20))
  }
  if (data.length >= 10 && (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return validDimensions(data.readUInt16LE(6), data.readUInt16LE(8))
  }
  if (data.length >= 30 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    const type = data.subarray(12, 16).toString('ascii')
    if (type === 'VP8X') return validDimensions(1 + readUInt24LE(data, 24), 1 + readUInt24LE(data, 27))
    if (type === 'VP8L' && data[20] === 0x2f) {
      const first = data[21] ?? 0
      const second = data[22] ?? 0
      const third = data[23] ?? 0
      const fourth = data[24] ?? 0
      return validDimensions(1 + first + ((second & 0x3f) << 8), 1 + (second >> 6) + (third << 2) + ((fourth & 0x0f) << 10))
    }
    if (type === 'VP8 ' && data.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      return validDimensions(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff)
    }
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    for (let offset = 2; offset + 8 < data.length;) {
      if (data[offset] !== 0xff) { offset += 1; continue }
      const marker = data[offset + 1] ?? 0
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue }
      const length = data.readUInt16BE(offset + 2)
      if (length < 2 || offset + length + 2 > data.length) break
      if (isJpegStartOfFrame(marker)) return validDimensions(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 7))
      offset += length + 2
    }
  }
  return null
}

function readUInt24LE(data: Buffer, offset: number): number {
  return (data[offset] ?? 0) + ((data[offset + 1] ?? 0) << 8) + ((data[offset + 2] ?? 0) << 16)
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
}

function validDimensions(width: number, height: number): Readonly<{ width: number, height: number }> | null {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? { width, height } : null
}

function positiveInteger(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

function nonnegativeInteger(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

export function normalizeWebVtt(input: string, sourceUrl: URL): string {
  let content = input
    .replace(/^\uFEFF/, '')
    .replace(/\\x[0-9A-Fa-f]{2}/g, '')
    .replace(/\{.*?\}/g, '')
    .trim()
  if (content.startsWith('WEBVTT')) return content

  const extension = sourceUrl.pathname.split('.').at(-1)?.toLowerCase() ?? ''
  if (sourceUrl.hostname.toLowerCase().includes('youtube.com') && extension !== 'vtt') {
    content = youtubeTimedTextToVtt(content)
  } else if (extension === 'ass' || content.includes('[Script Info]') || content.includes('[Events]')) {
    content = assToVtt(content)
  } else if (extension === 'dfxp' || extension === 'ttml' || /<tt(?:\s|>)/i.test(content)) {
    content = timedTextMarkupToVtt(content)
  } else {
    content = srtLikeToVtt(content)
  }

  return content.startsWith('WEBVTT') ? content : `WEBVTT\n\n${content}`
}

function srtLikeToVtt(content: string): string {
  return content
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/^(\d{1,2}:\d{2}:\d{2}\.\d+)\s*,\s*(\d{1,2}:\d{2}:\d{2}\.\d+)$/gm, '$1 --> $2')
    .trim()
}

function assToVtt(content: string): string {
  const cues: string[] = []
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    if (!/^Dialogue:/i.test(line)) continue
    const parts = line.slice(line.indexOf(':') + 1).split(',')
    if (parts.length < 10) continue
    const start = assTimestamp(parts[1] ?? '')
    const end = assTimestamp(parts[2] ?? '')
    const text = decodeEntities(parts.slice(9).join(',').replaceAll('\\N', '\n').replaceAll('\\n', '\n'))
    if (start !== null && end !== null && text.trim().length > 0) cues.push(`${start} --> ${end}\n${text.trim()}`)
  }
  return `WEBVTT\n\n${cues.join('\n\n')}`
}

function assTimestamp(value: string): string | null {
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})[.](\d{1,3})$/)
  if (match === null) return null
  const [, hours = '0', minutes = '00', seconds = '00', fraction = '0'] = match
  return `${hours.padStart(2, '0')}:${minutes}:${seconds}.${fraction.padEnd(3, '0').slice(0, 3)}`
}

function timedTextMarkupToVtt(content: string): string {
  const cues: string[] = []
  for (const match of content.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
    const attributes = match[1] ?? ''
    const begin = attributes.match(/\bbegin=["']([^"']+)["']/i)?.[1]
    const end = attributes.match(/\bend=["']([^"']+)["']/i)?.[1]
    const duration = attributes.match(/\bdur=["']([^"']+)["']/i)?.[1]
    const startSeconds = parseTime(begin ?? '')
    const endSeconds = end === undefined ? startSeconds + parseTime(duration ?? '') : parseTime(end)
    const text = decodeEntities((match[2] ?? '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '')).trim()
    if (Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && endSeconds > startSeconds && text.length > 0) {
      cues.push(`${formatTime(startSeconds)} --> ${formatTime(endSeconds)}\n${text}`)
    }
  }
  return `WEBVTT\n\n${cues.join('\n\n')}`
}

function youtubeTimedTextToVtt(content: string): string {
  const cues: string[] = []
  for (const match of content.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
    const attributes = match[1] ?? ''
    const start = Number(attributes.match(/\bstart=["']([^"']+)["']/i)?.[1] ?? Number.NaN)
    const duration = Number(attributes.match(/\bdur=["']([^"']+)["']/i)?.[1] ?? Number.NaN)
    const text = decodeEntities((match[2] ?? '').replace(/<[^>]+>/g, '')).trim()
    if (Number.isFinite(start) && Number.isFinite(duration) && duration > 0 && text.length > 0) {
      cues.push(`${formatTime(start)} --> ${formatTime(start + duration)}\n${text}`)
    }
  }
  return `WEBVTT\n\n${cues.join('\n\n')}`
}

function parseTime(value: string): number {
  const trimmed = value.trim()
  if (/^\d+(?:\.\d+)?s$/.test(trimmed)) return Number(trimmed.slice(0, -1))
  const match = trimmed.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d+))?$/)
  if (match === null) return Number.NaN
  const [, hours = '0', minutes = '0', seconds = '0', fraction = '0'] = match
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(`0.${fraction}`)
}

function formatTime(value: number): string {
  const milliseconds = Math.max(0, Math.round(value * 1_000))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000)
  const seconds = Math.floor(milliseconds % 60_000 / 1_000)
  const remainder = milliseconds % 1_000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
}

function mediaError(reply: FastifyReply, status: number, message: string): unknown {
  return reply
    .header('cache-control', 'no-store')
    .header('content-type', 'text/plain; charset=utf-8')
    .header('x-content-type-options', 'nosniff')
    .code(status)
    .send(message)
}
