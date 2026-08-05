import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AppConfig } from '../config.js'
import { buildPlayerQuery, parsePlayerQuery, type PlayerMediaQuery } from '../core/player-query.js'
import { createMediaProxyPath } from './media-routes.js'
import { createStreamingProxyPath } from './streaming-routes.js'
import { loadRuntimeAdsSettings, type AdsSettingsLoader } from '../settings/ads-runtime.js'
import type { AdsSettings } from '../settings/settings-admin-service.js'
import { renderAdFrameDocument, type AdFrameContent } from '../player/ad-frame.js'
import { renderDownloadError, renderDownloadPage } from '../player/download-page.js'
import { renderEmbedError, renderEmbedPage, type EmbedAdsOptions } from '../player/embed-page.js'
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

const adFrameSlotSchema = z.enum(['popup', 'download-top', 'download-bottom', 'sharer-top', 'sharer-bottom'])
const TRANSPARENT_PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

export type PlayerRouteOptions = Readonly<{
  loadAdsSettings?: AdsSettingsLoader
}>

export async function registerPlayerRoutes(
  app: FastifyInstance,
  config: AppConfig,
  options: PlayerRouteOptions = {}
): Promise<void> {
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

  app.get('/ads/advertisement.png', async (_request, reply) => reply
    .header('cache-control', 'private, no-store')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('cross-origin-resource-policy', 'same-origin')
    .header('x-content-type-options', 'nosniff')
    .type('image/png')
    .send(TRANSPARENT_PIXEL))

  app.get('/ads/frame/:slot', async (request, reply) => {
    const slot = adFrameSlotSchema.safeParse((request.params as { slot?: unknown }).slot)
    if (!slot.success) return reply.code(404).send()
    const ads = await loadRuntimeAdsSettings(options.loadAdsSettings)
    const content = adFrameContent(slot.data, ads)
    applyAdFrameHeaders(reply)
    if (content === null) return reply.code(204).send()
    return reply.type('text/html; charset=utf-8').send(renderAdFrameDocument(content))
  })

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
    const ads = await loadRuntimeAdsSettings(options.loadAdsSettings)
    reply
      .header('cache-control', 'private, no-store')
      .header('content-security-policy', embedContentSecurityPolicy(ads))
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'strict-origin-when-cross-origin')
      .type('text/html; charset=utf-8')
    return renderEmbedPage(proxyPlayerMedia(parsed.media, security), parsed.publicOptions, embedAdsOptions(ads))
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

    const ads = await loadRuntimeAdsSettings(options.loadAdsSettings)
    const embedUrl = routePath(config.slugs.embed, parsed.token)
    const alternativeUrl = createAlternativeDownloadUrl(parsed.media, security, config.slugs.download)
    reply.type('text/html; charset=utf-8')
    return renderDownloadPage(parsed.media, {
      embedUrl,
      ...(alternativeUrl === undefined ? {} : { alternativeUrl }),
      ...downloadAdFrames(ads)
    })
  }

  app.get(`/${config.slugs.download}`, showDownload)
  app.get(`/${config.slugs.download}/`, showDownload)
}

function embedAdsOptions(ads: AdsSettings): EmbedAdsOptions {
  const popupEnabled = !ads.disable_popup_ads && (ads.popup_ads_link.length > 0 || ads.popup_ads_code.trim().length > 0)
  const directEnabled = !ads.disable_direct_ads && ads.visitads_onplay && ads.direct_ads_link.length > 0
  return Object.freeze({
    blockAdblocker: ads.block_adblocker,
    directAdUrl: directEnabled ? ads.direct_ads_link : '',
    directAdOnPlay: directEnabled,
    showIframeAds: directEnabled && ads.show_iframeads,
    popupFrameUrl: popupEnabled ? '/ads/frame/popup' : '',
    popupDelaySeconds: Number.parseInt(ads.popup_load_offset, 10) || 0
  })
}

function downloadAdFrames(ads: AdsSettings): Readonly<{
  bannerTopFrameUrl?: string
  bannerBottomFrameUrl?: string
  popupFrameUrl?: string
}> {
  const result: { bannerTopFrameUrl?: string; bannerBottomFrameUrl?: string; popupFrameUrl?: string } = {}
  if (!ads.disable_banner_ads && ads.dl_banner_top.trim().length > 0) result.bannerTopFrameUrl = '/ads/frame/download-top'
  if (!ads.disable_banner_ads && ads.dl_banner_bottom.trim().length > 0) result.bannerBottomFrameUrl = '/ads/frame/download-bottom'
  if (!ads.disable_popup_ads && (ads.popup_ads_link.length > 0 || ads.popup_ads_code.trim().length > 0)) result.popupFrameUrl = '/ads/frame/popup'
  return Object.freeze(result)
}

function adFrameContent(slot: z.infer<typeof adFrameSlotSchema>, ads: AdsSettings): AdFrameContent | null {
  if (slot === 'popup') {
    if (ads.disable_popup_ads || (ads.popup_ads_link.length === 0 && ads.popup_ads_code.trim().length === 0)) return null
    return Object.freeze({
      html: ads.popup_ads_code,
      ...(ads.popup_ads_link.length === 0 ? {} : { scriptUrl: ads.popup_ads_link })
    })
  }
  if (ads.disable_banner_ads) return null
  const html = slot === 'download-top'
    ? ads.dl_banner_top
    : slot === 'download-bottom'
      ? ads.dl_banner_bottom
      : slot === 'sharer-top'
        ? ads.sh_banner_top
        : ads.sh_banner_bottom
  return html.trim().length === 0 ? null : Object.freeze({ html })
}

function applyAdFrameHeaders(reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]): void {
  reply
    .header('cache-control', 'private, no-store')
    .header('content-security-policy', "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' http: https:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; connect-src http: https:; frame-src http: https:; media-src http: https: blob:; form-action http: https:; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox")
    .header('cross-origin-resource-policy', 'same-origin')
    .header('x-content-type-options', 'nosniff')
    .header('x-frame-options', 'SAMEORIGIN')
    .header('referrer-policy', 'no-referrer')
    .header('x-robots-tag', 'noindex, nofollow')
}

function embedContentSecurityPolicy(ads: AdsSettings): string {
  const frames = [
    "'self'",
    'https://www.youtube-nocookie.com',
    'https://player.vimeo.com',
    'https://www.dailymotion.com',
    'https://drive.google.com'
  ]
  if (!ads.disable_direct_ads && ads.show_iframeads && ads.direct_ads_link.length > 0) {
    try {
      const origin = new URL(ads.direct_ads_link).origin
      if (!frames.includes(origin)) frames.push(origin)
    } catch {
      // Settings validation normally guarantees a URL; omit invalid values defensively.
    }
  }
  return `default-src 'none'; script-src 'self'; style-src 'self'; media-src http: https: blob:; connect-src http: https:; img-src 'self' http: https: data:; frame-src ${frames.join(' ')}; worker-src blob:; base-uri 'none'; form-action 'none'; object-src 'none'`
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
    .header('content-security-policy', "default-src 'none'; style-src 'self'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; object-src 'none'")
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
