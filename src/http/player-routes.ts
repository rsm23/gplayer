import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AppConfig } from '../config.js'
import type { HostingData } from '../core/hosting-data.js'
import { buildPlayerQuery, parsePlayerQuery, type PlayerMediaQuery } from '../core/player-query.js'
import { createMediaProxyPath } from './media-routes.js'
import { createStreamingProxyPath } from './streaming-routes.js'
import { loadRuntimeAdsSettings, type AdsSettingsLoader } from '../settings/ads-runtime.js'
import { loadRuntimePlayerSettings, type PlayerSettingsLoader } from '../settings/player-runtime.js'
import type { PlayerSettings } from '../settings/player-settings.js'
import type { AdsSettings } from '../settings/settings-admin-service.js'
import { renderAdFrameDocument, type AdFrameContent } from '../player/ad-frame.js'
import { downloadPageLinkTargets, renderDownloadError, renderDownloadPage } from '../player/download-page.js'
import { renderEmbedError, renderEmbedPage, type EmbedAdsOptions } from '../player/embed-page.js'
import { PlayerLinkGenerator } from '../player/link-generator.js'
import { Security } from '../security/security.js'
import type { CountryCodeLookup } from '../security/geoip-country.js'
import { accessPolicyFromMisc, accessPolicyRejects, loadRuntimeMiscSettings, type MiscSettingsLoader } from '../settings/misc-runtime.js'
import { loadRuntimeHostingSettings, type HostingSettingsLoader } from '../settings/hosting-runtime.js'
import { loadRuntimePublicSettings, type PublicSettingsLoader } from '../settings/public-runtime.js'
import type { DriveBypassResult } from '../drive/drive-sharer-service.js'
import { renderSharerPage } from '../player/sharer-page.js'
import { applyPublicPageHeaders } from './system-routes.js'
import { publicErrors, renderPublicError } from '../player/public-page.js'

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

const driveBypassInputSchema = z.object({
  action: z.literal('gdriveBypassLimit'),
  gdrive_id: z.string().min(1).max(2_048),
  'g-recaptcha-response': z.string().max(8_192).optional()
}).passthrough()

const adFrameSlotSchema = z.enum(['popup', 'download-top', 'download-bottom', 'sharer-top', 'sharer-bottom'])
const TRANSPARENT_PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const MAX_SHORTLINK_TARGETS = 20

export type PlayerRouteOptions = Readonly<{
  loadAdsSettings?: AdsSettingsLoader
  loadPlayerSettings?: PlayerSettingsLoader
  loadMiscSettings?: MiscSettingsLoader
  loadHostingSettings?: HostingSettingsLoader
  loadPublicSettings?: PublicSettingsLoader
  countryCodeLookup?: CountryCodeLookup
  supportedHosts?: ReadonlySet<string>
  resolveSavedVideo?: (idOrSlug: string) => Promise<PlayerMediaQuery | null>
  shortenUrl?: (target: string) => Promise<string>
  isAuthenticated?: (request: FastifyRequest) => Promise<boolean>
  isAdmin?: (request: FastifyRequest) => Promise<boolean>
  bypassDrive?: (input: string) => Promise<DriveBypassResult | null>
  verifyRecaptcha?: (responseToken: string, remoteIp: string) => Promise<boolean>
  loadRecaptchaSiteKey?: () => Promise<string>
}>

export async function registerPlayerRoutes(
  app: FastifyInstance,
  config: AppConfig,
  options: PlayerRouteOptions = {}
): Promise<void> {
  const security = new Security(config.secureSalt)
  const playerDefaults = { ...config.slugs, adminDirectory: config.adminDirectory }

  const bypassDrive = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    const parsed = driveBypassInputSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(200)
      return { status: 'fail', message: 'Cannot bypass the file, try later', result: null }
    }
    const publicSettings = await loadRuntimePublicSettings(options.loadPublicSettings)
    if (!publicSettings.enable_gsharer) {
      reply.code(200)
      return { status: 'fail', message: 'This feature is disabled', result: null }
    }
    try {
      const captchaValid = options.verifyRecaptcha === undefined || await options.verifyRecaptcha(
        parsed.data['g-recaptcha-response'] ?? '',
        request.ip
      )
      if (!captchaValid) {
        return { status: 'fail', message: 'The security code you entered is incorrect! Try again', result: null }
      }
      const result = await options.bypassDrive?.(parsed.data.gdrive_id) ?? null
      if (result === null) return { status: 'fail', message: 'Cannot bypass the file, try later', result: null }
      return { status: 'ok', message: 'The file has been successfully bypassed', result }
    } catch {
      return { status: 'fail', message: 'Cannot bypass the file, try later', result: null }
    }
  }

  const createPlayer = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    const parsed = inputSchema.safeParse(request.body)
    if (!parsed.success || (parsed.data.action !== undefined && parsed.data.action !== 'createPlayer')) {
      reply.code(200)
      return { status: 'fail', message: 'Main video URL is required', result: null }
    }

    try {
      const [player, publicSettings, misc, hosting, countryCode] = await Promise.all([
        loadRuntimePlayerSettings(options.loadPlayerSettings, playerDefaults),
        loadRuntimePublicSettings(options.loadPublicSettings),
        loadRuntimeMiscSettings(options.loadMiscSettings, options.supportedHosts ?? new Set()),
        loadRuntimeHostingSettings(options.loadHostingSettings, options.supportedHosts ?? new Set()),
        countryCodeForRequest(request, options.countryCodeLookup)
      ])
      if (networkAccessRejected(request, misc, countryCode, false)) throw new Error('Access denied')
      if (!publicSettings.anonymous_generator && !await authenticatedRequest(request, options.isAuthenticated)) {
        throw new Error('Access denied')
      }
      const generator = new PlayerLinkGenerator(security, {
        baseUrl: config.baseUrl,
        embedSlug: player.slug_embed,
        downloadSlug: player.slug_download,
        requestSlug: player.slug_request,
        iframeCode: player.iframe_code,
        hostingData: hosting.data
      })
      const sub = publicSettings.enable_json_subtitles ? toArray(parsed.data['sub[]'] ?? parsed.data.sub) : []
      const lang = publicSettings.enable_json_subtitles ? toArray(parsed.data['lang[]'] ?? parsed.data.lang) : []
      const aid = toArray(parsed.data.aid)[0]
      const generated = generator.generate({
        id: parsed.data.id,
        ...(aid !== undefined ? { aid } : {}),
        ...(parsed.data.poster !== undefined ? { poster: parsed.data.poster } : {}),
        ...(sub.length > 0 ? { sub } : {}),
        ...(lang.length > 0 ? { lang } : {}),
        ...(publicSettings.enable_json_subtitles && parsed.data.subs !== undefined ? { subs: parsed.data.subs } : {}),
        ...(parsed.data.uid !== undefined ? { uid: parsed.data.uid } : {})
      })
      if (mediaContainsDisabledHost(generated.query, misc.disable_host)) throw new Error('This video host is disabled')
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

  const dispatchPublicAjax = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    const action = typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
      ? (request.body as Record<string, unknown>).action
      : undefined
    return action === 'gdriveBypassLimit' ? await bypassDrive(request, reply) : await createPlayer(request, reply)
  }

  app.post('/ajax/public', dispatchPublicAjax)
  app.post('/ajax/public/', dispatchPublicAjax)

  const showSharer = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    const publicSettings = await loadRuntimePublicSettings(options.loadPublicSettings)
    const admin = await authenticatedRequest(request, options.isAdmin)
    applyPublicPageHeaders(reply, true)
    if (!publicSettings.enable_gsharer && !admin) {
      reply.code(403).type('text/html; charset=utf-8')
      return renderPublicError(publicErrors[403])
    }
    const [ads, recaptchaSiteKey] = await Promise.all([
      loadRuntimeAdsSettings(options.loadAdsSettings),
      options.loadRecaptchaSiteKey?.().catch(() => '') ?? Promise.resolve('')
    ])
    reply.header('content-security-policy', recaptchaSiteKey === ''
      ? "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; object-src 'none'"
      : "default-src 'none'; script-src 'self' https://www.google.com https://www.gstatic.com; style-src 'self' 'unsafe-inline' https://www.gstatic.com; img-src 'self' data: https://www.google.com https://www.gstatic.com; frame-src 'self' https://www.google.com; connect-src 'self' https://www.google.com; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; object-src 'none'")
    reply.type('text/html; charset=utf-8')
    return renderSharerPage({
      recaptchaSiteKey,
      ...sharerAdFrames(ads)
    })
  }

  app.get('/sharer', showSharer)
  app.get('/sharer/', showSharer)

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
    const [player, publicSettings, misc, countryCode] = await Promise.all([
      loadRuntimePlayerSettings(options.loadPlayerSettings, playerDefaults),
      loadRuntimePublicSettings(options.loadPublicSettings),
      loadRuntimeMiscSettings(options.loadMiscSettings, options.supportedHosts ?? new Set()),
      countryCodeForRequest(request, options.countryCodeLookup)
    ])
    if (!publicSettings.enable_request_url) {
      reply.code(403).type('application/json; charset=utf-8')
      return { status: 'fail', message: 'Access denied', result: null }
    }
    const rawQuery = rawQueryFromUrl(request.url)
    const parsed = parsePlayerQuery(rawQuery, security, {
      secureSalt: config.secureSalt,
      allowPlaintextMedia: true
    })
    const requestedMedia = parsed.media === null ? null : publicMediaQuery(parsed.media, publicSettings.enable_json_subtitles)
    const resolvedMedia = await resolveSavedMedia(requestedMedia, options.resolveSavedVideo)
    if (resolvedMedia === null) {
      reply.code(400).type('application/json; charset=utf-8')
      return { status: 'fail', message: parsed.errors[0] ?? 'Bad Request', result: null }
    }
    if (networkAccessRejected(request, misc, countryCode, true, config.baseUrl.origin) ||
      mediaHostDisabled(resolvedMedia, misc.disable_host) ||
      accessPolicyFromMisc(misc).isTitleBlacklisted(playerMediaTitle(resolvedMedia))) {
      reply.code(403).type('application/json; charset=utf-8')
      return { status: 'fail', message: 'Access denied', result: null }
    }
    const token = security.encryptURL(buildPlayerQuery(requestedMedia as PlayerMediaQuery))
    return reply.redirect(routePath(player.slug_embed, token))
  }

  app.get(`/${config.slugs.request}`, redirectPlaintextRequest)
  app.get(`/${config.slugs.request}/`, redirectPlaintextRequest)

  const showEmbed = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    const [ads, player, publicSettings, misc, hosting, countryCode] = await Promise.all([
      loadRuntimeAdsSettings(options.loadAdsSettings),
      loadRuntimePlayerSettings(options.loadPlayerSettings, playerDefaults),
      loadRuntimePublicSettings(options.loadPublicSettings),
      loadRuntimeMiscSettings(options.loadMiscSettings, options.supportedHosts ?? new Set()),
      loadRuntimeHostingSettings(options.loadHostingSettings, options.supportedHosts ?? new Set()),
      countryCodeForRequest(request, options.countryCodeLookup)
    ])
    if (embedOnlyRejectsRequest(publicSettings.embed_only, request.headers['sec-fetch-dest'])) {
      applyEmbedHeaders(reply, ads)
      reply.code(403)
      return renderEmbedError('This player is available only when embedded in a page.')
    }
    const parsed = parsePlayerQuery(rawQueryFromUrl(request.url), security, {
      secureSalt: config.secureSalt,
      allowPublicQuery: player.allow_public_qry,
      publicDefaults: {
        autoplay: player.autoplay,
        mute: player.mute,
        repeat: player.repeat
      }
    })
    const resolvedMedia = await resolveSavedMedia(parsed.media, options.resolveSavedVideo)
    if (resolvedMedia === null) {
      reply.code(400).type('text/html; charset=utf-8')
      return renderEmbedError(parsed.errors[0] ?? 'The player link is invalid.')
    }
    applyEmbedHeaders(reply, ads)
    if (networkAccessRejected(request, misc, countryCode, true, config.baseUrl.origin) ||
      mediaHostDisabled(resolvedMedia, misc.disable_host) ||
      accessPolicyFromMisc(misc).isTitleBlacklisted(playerMediaTitle(resolvedMedia))) {
      reply.code(403)
      return renderEmbedError('You are not allowed to access this player.')
    }
    const media = proxyPlayerMedia(withDefaultPoster(resolvedMedia, player), security)
    return renderEmbedPage(media, parsed.publicOptions, embedAdsOptions(ads), {
      settings: player,
      downloadUrl: publicSettings.enable_download_page ? routePath(player.slug_download, parsed.token) : '',
      embedOnly: publicSettings.embed_only,
      hostingData: hosting.data,
      customNames: hosting.customNames
    })
  }

  app.get(`/${config.slugs.embed}`, showEmbed)
  app.get(`/${config.slugs.embed}/`, showEmbed)

  const showDownload = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    const [ads, player, publicSettings, misc, hosting, countryCode] = await Promise.all([
      loadRuntimeAdsSettings(options.loadAdsSettings),
      loadRuntimePlayerSettings(options.loadPlayerSettings, playerDefaults),
      loadRuntimePublicSettings(options.loadPublicSettings),
      loadRuntimeMiscSettings(options.loadMiscSettings, options.supportedHosts ?? new Set()),
      loadRuntimeHostingSettings(options.loadHostingSettings, options.supportedHosts ?? new Set()),
      countryCodeForRequest(request, options.countryCodeLookup)
    ])
    const parsed = parsePlayerQuery(rawQueryFromUrl(request.url), security, {
      secureSalt: config.secureSalt
    })
    applyDownloadHeaders(reply)
    if (!publicSettings.enable_download_page) {
      reply.code(403).type('text/html; charset=utf-8')
      return renderDownloadError('The download page is disabled.')
    }
    const resolvedMedia = await resolveSavedMedia(parsed.media, options.resolveSavedVideo)
    if (resolvedMedia === null) {
      reply.code(400).type('text/html; charset=utf-8')
      return renderDownloadError(parsed.errors[0] ?? 'The download link is invalid.')
    }
    if (networkAccessRejected(request, misc, countryCode, false) ||
      mediaHostDisabled(resolvedMedia, misc.disable_host) ||
      accessPolicyFromMisc(misc).isTitleBlacklisted(playerMediaTitle(resolvedMedia))) {
      reply.code(403).type('text/html; charset=utf-8')
      return renderDownloadError('You are not allowed to access this download.')
    }
    const embedUrl = routePath(player.slug_embed, parsed.token)
    const alternativeUrl = createAlternativeDownloadUrl(resolvedMedia, security, player.slug_download, misc.disable_host)
    const shortenedLinks = await transformDownloadLinks(resolvedMedia, hosting.data, publicSettings.show_sub_download, options.shortenUrl)
    reply.type('text/html; charset=utf-8')
    return renderDownloadPage(resolvedMedia, {
      embedUrl,
      ...(alternativeUrl === undefined ? {} : { alternativeUrl }),
      downloadLabel: player.text_download,
      hideHostname: player.hide_hostname,
      hostingData: hosting.data,
      customNames: hosting.customNames,
      shortenedLinks,
      showSubtitleDownloads: publicSettings.show_sub_download,
      showWatchButton: publicSettings.show_watch_button,
      ...downloadAdFrames(ads)
    })
  }

  app.get(`/${config.slugs.download}`, showDownload)
  app.get(`/${config.slugs.download}/`, showDownload)

  const dispatchConfiguredPlayerRoute = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    const slug = String((request.params as { playerSlug?: unknown }).playerSlug ?? '').toLowerCase()
    const player = await loadRuntimePlayerSettings(options.loadPlayerSettings, playerDefaults)
    if (slug === player.slug_embed.toLowerCase()) return await showEmbed(request, reply)
    if (slug === player.slug_download.toLowerCase()) return await showDownload(request, reply)
    if (slug === player.slug_request.toLowerCase()) return await redirectPlaintextRequest(request, reply)
    return reply.callNotFound()
  }

  app.get('/:playerSlug', dispatchConfiguredPlayerRoute)
  app.get('/:playerSlug/', dispatchConfiguredPlayerRoute)

  const dispatchSavedPlayerRoute = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    const parameters = request.params as { playerSlug?: unknown; savedSlug?: unknown }
    const routeSlug = String(parameters.playerSlug ?? '').toLowerCase()
    const savedSlug = String(parameters.savedSlug ?? '').trim()
    if (savedSlug === '' || savedSlug.length > 150 || options.resolveSavedVideo === undefined) return reply.callNotFound()
    const player = await loadRuntimePlayerSettings(options.loadPlayerSettings, playerDefaults)
    const target = routeSlug === player.slug_embed.toLowerCase()
      ? player.slug_embed
      : routeSlug === player.slug_download.toLowerCase()
        ? player.slug_download
        : ''
    if (target === '' || await options.resolveSavedVideo(savedSlug) === null) return reply.callNotFound()
    const token = security.encryptURL(buildPlayerQuery({ source: 'db', id: savedSlug }))
    return reply.redirect(routePath(target, token), 302)
  }

  app.get('/:playerSlug/:savedSlug', dispatchSavedPlayerRoute)
  app.get('/:playerSlug/:savedSlug/', dispatchSavedPlayerRoute)
}

async function authenticatedRequest(
  request: FastifyRequest,
  authenticate: PlayerRouteOptions['isAuthenticated']
): Promise<boolean> {
  if (authenticate === undefined) return false
  try {
    return await authenticate(request)
  } catch {
    return false
  }
}

function embedOnlyRejectsRequest(enabled: boolean, destination: string | string[] | undefined): boolean {
  if (!enabled) return false
  const value = (Array.isArray(destination) ? destination[0] : destination)?.trim().toLowerCase() ?? ''
  // Fetch Metadata is unavailable in older browsers and non-browser clients.
  // Some instrumented Chromium sessions report `empty` for both frame and
  // top-level navigations. The document boot guard handles that ambiguous case.
  return value !== '' && value !== 'empty' && value !== 'iframe' && value !== 'frame'
}

function publicMediaQuery(media: PlayerMediaQuery, allowSubtitles: boolean): PlayerMediaQuery {
  if (allowSubtitles) return media
  const { sub: _sub, lang: _lang, subs: _subs, ...withoutSubtitles } = media
  return withoutSubtitles
}

async function transformDownloadLinks(
  media: PlayerMediaQuery,
  hostingData: HostingData | undefined,
  includeSubtitles: boolean,
  shortenUrl: PlayerRouteOptions['shortenUrl']
): Promise<ReadonlyMap<string, string>> {
  if (shortenUrl === undefined) return new Map()
  const targets = downloadPageLinkTargets(media, hostingData, includeSubtitles).slice(0, MAX_SHORTLINK_TARGETS)
  const transformed = await Promise.all(targets.map(async (target) => {
    try {
      return [target, await shortenUrl(target)] as const
    } catch {
      return [target, target] as const
    }
  }))
  return new Map(transformed)
}

async function resolveSavedMedia(
  media: PlayerMediaQuery | null,
  resolve: PlayerRouteOptions['resolveSavedVideo']
): Promise<PlayerMediaQuery | null> {
  if (media === null) return null
  if (media.source !== 'db') return media
  if (resolve === undefined || media.id === undefined || media.id === '') return null
  try {
    return await resolve(media.id)
  } catch {
    return null
  }
}

async function countryCodeForRequest(request: FastifyRequest, lookup: CountryCodeLookup | undefined): Promise<string> {
  if (lookup === undefined) return ''
  try {
    return await lookup(request.ip)
  } catch {
    return ''
  }
}

function networkAccessRejected(
  request: FastifyRequest,
  settings: Awaited<ReturnType<typeof loadRuntimeMiscSettings>>,
  countryCode: string,
  includeReferer: boolean,
  selfOrigin = ''
): boolean {
  const referer = includeReferer ? request.headers.referer ?? '' : ''
  return accessPolicyRejects(accessPolicyFromMisc(settings), {
    clientIp: request.ip,
    countryCode,
    referer: sameOrigin(referer, selfOrigin) ? '' : referer,
    userAgent: request.headers['user-agent'] ?? ''
  })
}

function sameOrigin(referer: string, origin: string): boolean {
  if (referer === '' || origin === '') return false
  try {
    return new URL(referer).origin === origin
  } catch {
    return false
  }
}

function mediaHostDisabled(media: PlayerMediaQuery, disabledHosts: readonly string[]): boolean {
  return media.host !== undefined && disabledHosts.includes(media.host)
}

function mediaContainsDisabledHost(media: PlayerMediaQuery, disabledHosts: readonly string[]): boolean {
  return mediaHosts(media).some((host) => disabledHosts.includes(host))
}

function playerMediaTitle(media: PlayerMediaQuery): string {
  if (media.title?.trim()) return media.title.trim()
  if (media.host === 'direct' && media.id !== undefined) {
    try {
      const filename = decodeURIComponent(new URL(media.id).pathname.split('/').filter(Boolean).at(-1) ?? '')
      if (filename.trim().length > 0) return filename
    } catch {
      // The renderer falls back to the provider label for invalid URL/escape input.
    }
  }
  return `${(media.host ?? 'video').replaceAll(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())} video`
}

function mediaHosts(media: PlayerMediaQuery): readonly string[] {
  return [...new Set([
    media.host,
    media.ahost,
    ...(media.alternatives ?? []).map((item) => item.host)
  ].filter((host): host is string => host !== undefined && host.length > 0))]
}

function applyEmbedHeaders(
  reply: Parameters<FastifyRequest['routeOptions']['handler']>[1],
  ads: AdsSettings
): void {
  reply
    .header('cache-control', 'private, no-store')
    .header('content-security-policy', embedContentSecurityPolicy(ads))
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'strict-origin-when-cross-origin')
    .type('text/html; charset=utf-8')
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

function sharerAdFrames(ads: AdsSettings): Readonly<{
  bannerTopFrameUrl?: string
  bannerBottomFrameUrl?: string
}> {
  const result: { bannerTopFrameUrl?: string; bannerBottomFrameUrl?: string } = {}
  if (!ads.disable_banner_ads && ads.sh_banner_top.trim().length > 0) result.bannerTopFrameUrl = '/ads/frame/sharer-top'
  if (!ads.disable_banner_ads && ads.sh_banner_bottom.trim().length > 0) result.bannerBottomFrameUrl = '/ads/frame/sharer-bottom'
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
  downloadSlug: string,
  disabledHosts: readonly string[] = []
): string | undefined {
  const alternative = media.ahost !== undefined && media.aid !== undefined && !disabledHosts.includes(media.ahost)
    ? { host: media.ahost, id: media.aid }
    : media.alternatives?.find((item) => !disabledHosts.includes(item.host))
  if (alternative === undefined) return undefined
  const { host: _host, id: _id, ahost: _ahost, aid: _aid, ...shared } = media
  const query = {
    host: alternative.host,
    id: alternative.id,
    ...shared
  }
  return routePath(downloadSlug, security.encryptURL(buildPlayerQuery(query)))
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

function withDefaultPoster(media: PlayerMediaQuery, settings: PlayerSettings): PlayerMediaQuery {
  const poster = settings.force_default_poster && settings.poster.length > 0
    ? settings.poster
    : media.poster || settings.poster
  return poster === undefined || poster.length === 0 ? media : { ...media, poster }
}
