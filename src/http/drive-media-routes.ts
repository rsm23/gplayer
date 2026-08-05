import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { DriveMediaService } from '../drive/drive-media-service.js'
import { RemoteStream } from '../stream/remote-stream.js'

const responseHeaders = [
  'accept-ranges',
  'content-encoding',
  'content-language',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'expires',
  'last-modified'
] as const

export type DriveMediaRouteOptions = Readonly<{
  remoteStream?: RemoteStream
  allowPrivateNetworks?: boolean
}>

export async function registerDriveMediaRoutes(
  app: FastifyInstance,
  service: Pick<DriveMediaService, 'mediaRequest'>,
  options: DriveMediaRouteOptions = {}
): Promise<void> {
  const remoteStream = options.remoteStream ?? new RemoteStream()

  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const token = driveMediaToken(request.url)
    const media = token === null ? null : await service.mediaRequest(token)
    if (media === null) return unavailable(reply, 404)

    const headers = forwardedRequestHeaders(request)
    headers.set('authorization', media.authorization)
    try {
      const response = await remoteStream.open({
        url: media.target,
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
        allowPrivateNetworks: options.allowPrivateNetworks ?? false,
        signal: AbortSignal.timeout(30_000)
      })
      if (response.status === 304) return reply.code(304).send()
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel()
        return unavailable(reply, response.status === 404 ? 404 : 502)
      }
      for (const name of responseHeaders) {
        const value = response.headers.get(name)
        if (value !== null) reply.header(name, value)
      }
      reply
        .header('cache-control', 'private, no-store')
        .header('content-disposition', 'inline')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .code(response.status)
      if (response.body === null) return reply.send()
      return reply.send(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>))
    } catch {
      return unavailable(reply, 502)
    }
  }

  app.route({ method: ['GET', 'HEAD'], url: '/gdrive-media/*', handler })
}

function driveMediaToken(requestUrl: string): string | null {
  const request = new URL(requestUrl, 'http://gplayer.invalid')
  const prefix = '/gdrive-media/'
  if (!request.pathname.startsWith(prefix)) return null
  const token = request.pathname.slice(prefix.length)
  return token !== '' && !token.includes('/') ? token : null
}

function forwardedRequestHeaders(request: FastifyRequest): Headers {
  const headers = new Headers()
  for (const name of ['accept', 'accept-language', 'if-match', 'if-modified-since', 'if-none-match', 'if-range', 'if-unmodified-since', 'range', 'user-agent']) {
    const value = request.headers[name]
    if (typeof value === 'string') headers.set(name, value)
  }
  return headers
}

function unavailable(reply: FastifyReply, status: 404 | 502): unknown {
  return reply
    .header('cache-control', 'no-store')
    .header('x-content-type-options', 'nosniff')
    .code(status)
    .type('text/plain; charset=utf-8')
    .send('Drive media is unavailable')
}
