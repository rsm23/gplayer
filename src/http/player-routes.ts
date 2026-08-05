import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AppConfig } from '../config.js'
import { buildPlayerQuery, parsePlayerQuery, type PlayerMediaQuery } from '../core/player-query.js'
import { createMediaProxyPath } from './media-routes.js'
import { createStreamingProxyPath } from './streaming-routes.js'
import { renderDownloadError, renderDownloadPage } from '../player/download-page.js'
import { renderEmbedError, renderEmbedPage } from '../player/embed-page.js'
import { PlayerLinkGenerator } from '../player/link-generator.js'
import { Security } from '../security/security.js'

const inputSchema = z.object({
  action: z.string().optional(),
  id: z.string().min(1),
  aid: z.union([z.string(), z.array(z.string())]).optional(),
  poster: z.string().optional(),
  sub: z.union([z.string(), z.array(z.string())]).optional(),
  'sub[]': z.union([z.string(), z.array(z.string())]).optional(),
  lang: z.union([z.string(), z.array(z.string())]).optional(),
  'lang[]': z.union([z.string(), z.array(z.string())]).optional(),
  subs: z.string().optional(),
  uid: z.string().optional()
}).passthrough()

export async function registerPlayerRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  const security = new Security(config.secureSalt)
  const generator = new PlayerLinkGenerator(security, {
    baseUrl: config.baseUrl,
    embedSlug: config.slugs.embed,
    downloadSlug: config.slugs.download,
    requestSlug: config.slugs.request
  })

  const createPlayer = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    const parsed = inputSchema.safeParse(request.body)
    if (!parsed.success || (parsed.data.action !== undefined && parsed.data.action !== 'createPlayer')) {
      reply.code(200)
      return { status: 'fail', message: 'Main video URL is required', result: null }
    }

    try {
      const sub = toArray(parsed.data['sub[]'] ?? parsed.data.sub)
      const lang = toArray(parsed.data['lang[]'] ?? parsed.data.lang)
      const aid = toArray(parsed.data.aid)[0]
      const generated = generator.generate({
        id: parsed.data.id,
        ...(aid !== undefined ? { aid } : {}),
        ...(parsed.data.poster !== undefined ? { poster: parsed.data.poster } : {}),
        ...(sub.length > 0 ? { sub } : {}),
        ...(lang.length > 0 ? { lang } : {}),
        ...(parsed.data.subs !== undefined ? { subs: parsed.data.subs } : {}),
        ...(parsed.data.uid !== undefined ? { uid: parsed.data.uid } : {})
      })
      reply.code(200)
      return {
        status: 'ok',
        message: '',
        result: {
          embed_url: generated.embedUrl,
          download_url: generated.downloadUrl,
          request_url: generated.requestUrl,
          embed_code: generated.embedCode
        }
      }
    } catch (error) {
      reply.code(200)
      return {
        status: 'fail',
        message: error instanceof Error ? error.message : 'Failed to create player',
        result: null
      }
    }
  }

  app.post('/ajax/public', createPlayer)
  app.post('/ajax/public/', createPlayer)

  const redirectPlaintextRequest = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    const rawQuery = rawQueryFromUrl(request.url)
    const parsed = parsePlayerQuery(rawQuery, security, {
      secureSalt: config.secureSalt,
      allowPlaintextMedia: true
    })
    if (parsed.media === null) {
      reply.code(400).type('application/json; charset=utf-8')
      return { status: 'fail', message: parsed.errors[0] ?? 'Bad Request', result: null }
    }
    const token = security.encryptURL(buildPlayerQuery(parsed.media))
    return reply.redirect(routePath(config.slugs.embed, token))
  }

  app.get(`/${config.slugs.request}`, redirectPlaintextRequest)
  app.get(`/${config.slugs.request}/`, redirectPlaintextRequest)

  const showEmbed = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    const parsed = parsePlayerQuery(rawQueryFromUrl(request.url), security, {
      secureSalt: config.secureSalt,
      allowPublicQuery: true
    })
    if (parsed.media === null) {
      reply.code(400).type('text/html; charset=utf-8')
      return renderEmbedError(parsed.errors[0] ?? 'The player link is invalid.')
    }
    reply
      .header('cache-control', 'private, no-store')
      .header('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; media-src http: https: blob:; connect-src http: https:; img-src http: https: data:; frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://www.dailymotion.com https://drive.google.com; worker-src blob:; base-uri 'none'; form-action 'none'; object-src 'none'")
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'strict-origin-when-cross-origin')
      .type('text/html; charset=utf-8')
    return renderEmbedPage(proxyPlayerMedia(parsed.media, security), parsed.publicOptions)
  }

  app.get(`/${config.slugs.embed}`, showEmbed)
  app.get(`/${config.slugs.embed}/`, showEmbed)

  const showDownload = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    const parsed = parsePlayerQuery(rawQueryFromUrl(request.url), security, {
      secureSalt: config.secureSalt
    })
    applyDownloadHeaders(reply)
    if (parsed.media === null) {
      reply.code(400).type('text/html; charset=utf-8')
      return renderDownloadError(parsed.errors[0] ?? 'The download link is invalid.')
    }

    const embedUrl = routePath(config.slugs.embed, parsed.token)
    const alternativeUrl = createAlternativeDownloadUrl(parsed.media, security, config.slugs.download)
    reply.type('text/html; charset=utf-8')
    return renderDownloadPage(parsed.media, {
      embedUrl,
      ...(alternativeUrl === undefined ? {} : { alternativeUrl })
    })
  }

  app.get(`/${config.slugs.download}`, showDownload)
  app.get(`/${config.slugs.download}/`, showDownload)
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function rawQueryFromUrl(url: string): string {
  const queryIndex = url.indexOf('?')
  return queryIndex < 0 ? '' : url.slice(queryIndex + 1)
}

function routePath(slug: string, query: string): string {
  return `/${slug.replace(/^\/+|\/+$/g, '')}/?${query}`
}

function createAlternativeDownloadUrl(
  media: ReturnType<typeof parsePlayerQuery>['media'] & object,
  security: Security,
  downloadSlug: string
): string | undefined {
  if (media.ahost === undefined || media.aid === undefined) return undefined
  const { host: _host, id: _id, ahost: _ahost, aid: _aid, ...shared } = media
  const alternative = {
    host: media.ahost,
    id: media.aid,
    ...shared
  }
  return routePath(downloadSlug, security.encryptURL(buildPlayerQuery(alternative)))
}

function applyDownloadHeaders(reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]): void {
  reply
    .header('cache-control', 'private, no-store')
    .header('content-security-policy', "default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; object-src 'none'")
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .header('x-robots-tag', 'noindex, nofollow')
}

function proxyPlayerMedia(media: PlayerMediaQuery, security: Security): PlayerMediaQuery {
  const { id: _id, poster: _poster, sub: _sub, subs: _subs, ...shared } = media
  let id = media.id
  if (media.host === 'direct' && media.id !== undefined) {
    try {
      const target = new URL(media.id)
      const pathname = target.pathname.toLowerCase()
      if (pathname.endsWith('.m3u8')) {
        id = createStreamingProxyPath('hls', target, security, { host: 'direct', id: media.id })
      } else if (pathname.endsWith('.mpd')) {
        id = createStreamingProxyPath('mpd', target, security, { host: 'direct', id: media.id })
      }
    } catch {
      // Invalid direct URLs remain unchanged and are rejected by the renderer.
    }
  }
  const poster = media.poster === undefined || media.poster.length === 0
    ? media.poster
    : createMediaProxyPath('poster', media.poster, security) ?? ''
  const subtitles = (media.sub ?? []).flatMap((url) => {
    const proxy = createMediaProxyPath('subtitle', url, security)
    return proxy === null ? [] : [proxy]
  })
  const legacySubtitle = media.subs === undefined
    ? undefined
    : createMediaProxyPath('subtitle', media.subs, security) ?? undefined

  return {
    ...shared,
    ...(id === undefined ? {} : { id }),
    ...(poster === undefined ? {} : { poster }),
    ...(subtitles.length === 0 ? {} : { sub: subtitles }),
    ...(legacySubtitle === undefined ? {} : { subs: legacySubtitle })
  }
}
