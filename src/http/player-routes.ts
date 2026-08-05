import { createHmac, randomInt } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AppConfig } from '../config.js'
import type { HostingData } from '../core/hosting-data.js'
import { buildPlayerQuery, parsePlayerQuery, playerMediaCandidates, type PlayerMediaQuery } from '../core/player-query.js'
import { createMediaProxyPath } from './media-routes.js'
import { createStreamingAccessToken, createStreamingProxyPath } from './streaming-routes.js'
import { loadRuntimeAdsSettings, runtimeVastConfiguration, type AdsSettingsLoader } from '../settings/ads-runtime.js'
import { loadRuntimePlayerSettings, type PlayerSettingsLoader } from '../settings/player-runtime.js'
import type { PlayerSettings } from '../settings/player-settings.js'
import type { AdsSettings } from '../settings/settings-admin-service.js'
import { renderAdFrameDocument, type AdFrameContent } from '../player/ad-frame.js'
import { downloadPageLinkTargets, renderDownloadError, renderDownloadPage } from '../player/download-page.js'
import { P2P_CORE_IMPORT_MAP_CSP_HASH, renderEmbedError, renderEmbedPage, type EmbedAdsOptions } from '../player/embed-page.js'
import { PlayerLinkGenerator } from '../player/link-generator.js'
import { Security } from '../security/security.js'
import type { CountryCodeLookup } from '../security/geoip-country.js'
import { accessPolicyFromMisc, accessPolicyRejects, filterSourcesByResolution, loadRuntimeMiscSettings, type MiscSettingsLoader } from '../settings/misc-runtime.js'
import { loadRuntimeHostingSettings, type HostingSettingsLoader } from '../settings/hosting-runtime.js'
import { loadRuntimePublicSettings, type PublicSettingsLoader } from '../settings/public-runtime.js'
import type { DriveBypassResult } from '../drive/drive-sharer-service.js'
import { renderSharerPage } from '../player/sharer-page.js'
import { applyPublicPageHeaders } from './system-routes.js'
import { publicErrors, renderPublicError } from '../player/public-page.js'
import { loadRuntimeGeneralSettings, visitCounterLimit, visitCounterRuntime, type GeneralSettingsLoader } from '../settings/general-runtime.js'
import type { ViewCounterCapture } from '../stats/view-counter-service.js'
import {
  createSourceResponse,
  selectedDeliveryBaseUrl,
  type PublicSourceResponse,
  type SourceApiRequestContext,
  type SourceApiResolver
} from './source-api-routes.js'
import type { ProviderStreamContextRegistry } from '../stream/provider-stream-context.js'
import type { DeliveryBaseUrlSelector } from '../load-balancers/load-balancer-selector.js'
import type { MediaResult } from '../core/source-resolver.js'
import { analyticsConfig, analyticsCspSources, histatsOnly, type AnalyticsConfig } from '../player/analytics.js'
import { SUBTITLE_MAX_BYTES } from '../subtitles/subtitle-assets-service.js'
import { VIDEO_POSTER_MAX_BYTES } from '../videos/video-assets-service.js'

const inputSchema = z.object({
  action: z.string().optional(),
  id: z.string().min(1),
  aid: z.union([z.string(), z.array(z.string())]).optional(),
  poster: z.string().optional(),
  sub: z.union([z.string(), z.array(z.string())]).optional(),
  'sub[]': z.union([z.string(), z.array(z.string())]).optional(),
  lang: z.union([z.string(), z.array(z.string())]).optional(),
  'lang[]': z.union([z.string(), z.array(z.string())]).optional(),
  'sub-url': z.union([z.string(), z.array(z.string())]).optional(),
  'sub-url[]': z.union([z.string(), z.array(z.string())]).optional(),
  'lang-url': z.union([z.string(), z.array(z.string())]).optional(),
  'lang-url[]': z.union([z.string(), z.array(z.string())]).optional(),
  'lang-file': z.union([z.string(), z.array(z.string())]).optional(),
  'lang-file[]': z.union([z.string(), z.array(z.string())]).optional(),
  subs: z.string().optional(),
  uid: z.string().optional(),
  'g-recaptcha-response': z.string().max(8_192).optional()
}).passthrough()

const driveBypassInputSchema = z.object({
  action: z.literal('gdriveBypassLimit'),
  gdrive_id: z.string().min(1).max(2_048),
  'g-recaptcha-response': z.string().max(8_192).optional()
}).passthrough()

const statCounterInputSchema = z.object({
  action: z.literal('statCounter'),
  data: z.string().min(1).max(65_536)
}).passthrough()

const clearVideoCacheInputSchema = z.object({
  action: z.literal('clearVideoCache'),
  data: z.string().min(1).max(65_536)
}).passthrough()

const usernameLookupSchema = z.object({
  action: z.literal('checkUsername'),
  username: z.string().max(254).optional().default('')
}).passthrough()

const emailLookupSchema = z.object({
  action: z.literal('checkEmail'),
  email: z.string().max(512).optional().default('')
}).passthrough()

const adFrameSlotSchema = z.enum(['popup', 'download-top', 'download-bottom', 'sharer-top', 'sharer-bottom'])
const TRANSPARENT_PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const MAX_SHORTLINK_TARGETS = 20
const MAX_PUBLIC_SUBTITLE_FILES = 10

type PublicGeneratorFile = Readonly<{ fieldname: string; filename: string; content: Buffer }>
type PublicGeneratorRequestData = Readonly<{ fields: Record<string, unknown>; files: readonly PublicGeneratorFile[] }>

export interface PublicGeneratorUploads {
  savePoster(input: Readonly<{ originalName: string; content: Buffer }>, request: FastifyRequest): Promise<string | null>
  saveSubtitle(input: Readonly<{ originalName: string; content: Buffer; language: string }>, request: FastifyRequest): Promise<Readonly<{ url: string; label: string }> | null>
}

export type PlayerRouteOptions = Readonly<{
  loadAdsSettings?: AdsSettingsLoader
  loadPlayerSettings?: PlayerSettingsLoader
  loadMiscSettings?: MiscSettingsLoader
  loadHostingSettings?: HostingSettingsLoader
  loadPublicSettings?: PublicSettingsLoader
  loadGeneralSettings?: GeneralSettingsLoader
  countryCodeLookup?: CountryCodeLookup
  supportedHosts?: ReadonlySet<string>
  resolveSavedVideo?: (idOrSlug: string) => Promise<PlayerMediaQuery | null>
  shortenUrl?: (target: string) => Promise<string>
  isAuthenticated?: (request: FastifyRequest) => Promise<boolean>
  isAdmin?: (request: FastifyRequest) => Promise<boolean>
  bypassDrive?: (input: string) => Promise<DriveBypassResult | null>
  verifyRecaptcha?: (responseToken: string, remoteIp: string) => Promise<boolean>
  publicGeneratorUploads?: PublicGeneratorUploads
  loadRecaptchaSiteKey?: () => Promise<string>
  capturePublicVideo?: (media: PlayerMediaQuery, ownerId: string) => Promise<unknown>
  captureView?: (input: ViewCounterCapture) => Promise<string | null>
  invalidateSource?: (identity: Readonly<{ host: string; id: string }>) => Promise<boolean>
  usernameExists?: (username: string, request: FastifyRequest) => Promise<boolean>
  emailExists?: (email: string, request: FastifyRequest) => Promise<boolean>
  loadBalancerLinks?: () => Promise<readonly string[]>
  resolvePlayback?: SourceApiResolver
  providerContexts?: ProviderStreamContextRegistry
  selectDeliveryBaseUrl?: DeliveryBaseUrlSelector
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
    if (request.isMultipart() && !hasSameOrigin(request, config)) {
      reply.code(200)
      return { status: 'fail', message: 'Access denied', result: null }
    }
    let requestInput: PublicGeneratorRequestData
    try {
      requestInput = await publicGeneratorRequestData(request)
    } catch {
      reply.code(200)
      return { status: 'fail', message: 'The uploaded player form is invalid', result: null }
    }
    const parsed = inputSchema.safeParse(requestInput.fields)
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
      const urlSubtitles = publicSettings.enable_json_subtitles
        ? toArray(parsed.data['sub-url[]'] ?? parsed.data['sub-url'] ?? parsed.data['sub[]'] ?? parsed.data.sub).slice(0, MAX_PUBLIC_SUBTITLE_FILES)
        : []
      const urlLanguages = publicSettings.enable_json_subtitles
        ? toArray(parsed.data['lang-url[]'] ?? parsed.data['lang-url'] ?? parsed.data['lang[]'] ?? parsed.data.lang).slice(0, MAX_PUBLIC_SUBTITLE_FILES)
        : []
      const aid = toArray(parsed.data.aid)[0]
      const baseInput = {
        id: parsed.data.id,
        ...(aid !== undefined ? { aid } : {}),
        ...(parsed.data.poster !== undefined ? { poster: parsed.data.poster } : {}),
        ...(urlSubtitles.length > 0 ? { sub: urlSubtitles } : {}),
        ...(urlLanguages.length > 0 ? { lang: urlLanguages } : {}),
        ...(publicSettings.enable_json_subtitles && parsed.data.subs !== undefined ? { subs: parsed.data.subs } : {}),
        ...(parsed.data.uid !== undefined ? { uid: parsed.data.uid } : {})
      }
      const validated = generator.generate(baseInput)
      if (mediaContainsDisabledHost(validated.query, misc.disable_host)) throw new Error('This video host is disabled')
      const captchaValid = options.verifyRecaptcha === undefined || await options.verifyRecaptcha(
        parsed.data['g-recaptcha-response'] ?? '',
        request.ip
      )
      if (!captchaValid) throw new Error('The security code you entered is incorrect! Try again')

      let poster = parsed.data.poster
      const posterFile = requestInput.files.find((file) => normalizeUploadField(file.fieldname) === 'poster-file')
      if (posterFile !== undefined && options.publicGeneratorUploads !== undefined) {
        poster = await options.publicGeneratorUploads.savePoster({
          originalName: posterFile.filename,
          content: posterFile.content
        }, request).catch(() => null) ?? poster
      }

      const uploadedSubtitles: string[] = []
      const uploadedLanguages: string[] = []
      if (publicSettings.enable_json_subtitles && options.publicGeneratorUploads !== undefined) {
        const fileLanguages = toArray(parsed.data['lang-file[]'] ?? parsed.data['lang-file']).slice(0, MAX_PUBLIC_SUBTITLE_FILES)
        const subtitleFiles = requestInput.files
          .filter((file) => normalizeUploadField(file.fieldname) === 'sub-file')
          .slice(0, MAX_PUBLIC_SUBTITLE_FILES)
        for (const [index, file] of subtitleFiles.entries()) {
          const language = fileLanguages[index]?.trim() || `Subtitle ${index + 1}`
          const uploaded = await options.publicGeneratorUploads.saveSubtitle({
            originalName: file.filename,
            content: file.content,
            language
          }, request).catch(() => null)
          if (uploaded === null) continue
          uploadedSubtitles.push(uploaded.url)
          uploadedLanguages.push(uploaded.label)
        }
      }
      const sub = [...uploadedSubtitles, ...urlSubtitles]
      const lang = [...uploadedLanguages, ...urlLanguages]
      const generated = generator.generate({
        ...baseInput,
        ...(poster !== undefined ? { poster } : {}),
        ...(sub.length > 0 ? { sub } : {}),
        ...(lang.length > 0 ? { lang } : {})
      })
      if (publicSettings.save_public_video && publicSettings.public_video_user !== '') {
        await options.capturePublicVideo?.(generated.query, publicSettings.public_video_user).catch(() => undefined)
      }
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

  const statCounter = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    reply.headers({
      'cache-control': 'private, no-store',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff'
    })
    const input = statCounterInputSchema.safeParse(request.method === 'GET' ? request.query : request.body)
    if (!input.success) return statCounterFailure()
    const media = parsePlayerQuery(input.data.data, security, { secureSalt: config.secureSalt }).media
    if (media === null) return statCounterFailure()
    const general = await loadRuntimeGeneralSettings(options.loadGeneralSettings, config.baseUrl)
    try {
      const id = await options.captureView?.(Object.freeze({
        media,
        clientIp: request.ip,
        userAgent: request.headers['user-agent'] ?? '',
        maximum: visitCounterLimit(general)
      })) ?? null
      return id === null
        ? statCounterFailure()
        : { status: 'ok', message: 'Total daily visits successfully created', result: id }
    } catch {
      return statCounterFailure()
    }
  }

  const clearVideoCache = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    reply.headers({
      'cache-control': 'private, no-store',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow'
    })
    const input = clearVideoCacheInputSchema.safeParse(requestData(request))
    if (!input.success) return clearVideoCacheFailure()
    const parsed = parsePlayerQuery(input.data.data, security, { secureSalt: config.secureSalt })
    const media = await resolveSavedMedia(parsed.media, options.resolveSavedVideo)
    const identity = media === null ? undefined : playerMediaCandidates(media)[0]
    if (identity === undefined || options.invalidateSource === undefined) return clearVideoCacheFailure()
    try {
      const deleted = await options.invalidateSource(identity)
      return {
        status: 'ok',
        message: 'The video cache cleared successfully',
        result: { clear_video_sources: deleted }
      }
    } catch {
      return clearVideoCacheFailure()
    }
  }

  const checkUsername = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    applyPublicLookupHeaders(reply)
    const input = usernameLookupSchema.safeParse(requestData(request))
    if (!input.success || options.usernameExists === undefined) return publicLookupFailure('')
    try {
      return await options.usernameExists(input.data.username, request)
        ? publicLookupFailure('The username is already registered')
        : publicLookupSuccess()
    } catch {
      return publicLookupFailure('The username is already registered')
    }
  }

  const checkEmail = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    applyPublicLookupHeaders(reply)
    const input = emailLookupSchema.safeParse(requestData(request))
    if (!input.success || options.emailExists === undefined) return publicLookupFailure('')
    try {
      return await options.emailExists(input.data.email, request)
        ? publicLookupFailure('The email address is already registered')
        : publicLookupSuccess()
    } catch {
      return publicLookupFailure('The email address is already registered')
    }
  }

  const getLoadBalancerList = async (_request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    applyPublicLookupHeaders(reply)
    try {
      const links = await options.loadBalancerLinks?.() ?? []
      return { status: 'ok', message: 'OK', result: [...new Set(links.filter((link) => link !== ''))] }
    } catch {
      return { status: 'ok', message: 'OK', result: [] }
    }
  }

  const dispatchPublicAjax = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    if (request.isMultipart()) return await createPlayer(request, reply)
    const action = requestData(request).action
    if (action === 'gdriveBypassLimit') return await bypassDrive(request, reply)
    if (action === 'statCounter') return await statCounter(request, reply)
    if (action === 'clearVideoCache') return await clearVideoCache(request, reply)
    if (action === 'checkUsername') return await checkUsername(request, reply)
    if (action === 'checkEmail') return await checkEmail(request, reply)
    if (action === 'getLoadBalancerList') return await getLoadBalancerList(request, reply)
    return await createPlayer(request, reply)
  }

  app.route({ method: ['GET', 'POST'], url: '/ajax/public', handler: dispatchPublicAjax })
  app.route({ method: ['GET', 'POST'], url: '/ajax/public/', handler: dispatchPublicAjax })
  app.get('/ajax', statCounter)
  app.get('/ajax/', statCounter)

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
    const [ads, player, publicSettings, general, misc, hosting, countryCode] = await Promise.all([
      loadRuntimeAdsSettings(options.loadAdsSettings),
      loadRuntimePlayerSettings(options.loadPlayerSettings, playerDefaults),
      loadRuntimePublicSettings(options.loadPublicSettings),
      loadRuntimeGeneralSettings(options.loadGeneralSettings, config.baseUrl),
      loadRuntimeMiscSettings(options.loadMiscSettings, options.supportedHosts ?? new Set()),
      loadRuntimeHostingSettings(options.loadHostingSettings, options.supportedHosts ?? new Set()),
      countryCodeForRequest(request, options.countryCodeLookup)
    ])
    const pageAnalytics = analyticsConfig(general)
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
      applyEmbedHeaders(reply, ads)
      reply.code(400).type('text/html; charset=utf-8')
      return renderEmbedError(parsed.errors[0] ?? 'The player link is invalid.')
    }
    if (networkAccessRejected(request, misc, countryCode, true, config.baseUrl.origin) ||
      mediaHostDisabled(resolvedMedia, misc.disable_host) ||
      accessPolicyFromMisc(misc).isTitleBlacklisted(playerMediaTitle(resolvedMedia))) {
      applyEmbedHeaders(reply, ads)
      reply.code(403)
      return renderEmbedError('You are not allowed to access this player.')
    }
    const configuredMedia = withoutDisabledAlternatives(resolvedMedia, misc.disable_host)
    const playableMedia = general.load_balancer_rand ? randomizedPlaybackMedia(configuredMedia) : configuredMedia
    const requestContext: SourceApiRequestContext = Object.freeze({
      clientIp: request.ip,
      userAgent: request.headers['user-agent'] ?? '',
      language: request.headers['accept-language'] ?? '',
      downloadable: false
    })
    const extracted = await resolveEmbedPlayback(playableMedia, requestContext, options.resolvePlayback, misc.disable_resolution)
    if (extracted !== null && accessPolicyFromMisc(misc).isTitleBlacklisted(extracted.result.title || playerMediaTitle(playableMedia))) {
      applyEmbedHeaders(reply, ads)
      reply.code(403)
      return renderEmbedError('You are not allowed to access this player.')
    }
    const deliveryBaseUrl = extracted === null
      ? new URL(config.baseUrl)
      : await selectedDeliveryBaseUrl(config, options.selectDeliveryBaseUrl, {
          clientIp: request.ip,
          host: extracted.result.upstream?.host ?? playableMedia.host ?? '',
          leastConnections: general.select_active_connections === true
        })
    const sourceResponse = extracted === null
      ? null
      : createSourceResponse(
          config,
          security,
          parsed.token,
          playableMedia,
          extracted.result,
          player,
          requestContext,
          options.providerContexts,
          deliveryBaseUrl
        )
    const media = sourceResponse === null
      ? proxyPlayerMedia(withDefaultPoster(playableMedia, player), security, request.ip)
      : playableMedia
    const p2pMode = playerP2pMode(player, media, sourceResponse)
    applyEmbedHeaders(reply, ads, p2pMode, player, pageAnalytics)
    return renderEmbedPage(media, parsed.publicOptions, embedAdsOptions(ads), {
      settings: player,
      downloadUrl: publicSettings.enable_download_page ? routePath(player.slug_download, parsed.token) : '',
      analytics: pageAnalytics,
      ...(p2pMode === null ? {} : { p2pSwarmId: playerP2pSwarmId(config, resolvedMedia) }),
      embedOnly: publicSettings.embed_only,
      viewCounter: Object.freeze({ token: parsed.token, runtime: visitCounterRuntime(general) }),
      cacheToken: cacheInvalidationToken(playableMedia, extracted?.result ?? null, parsed.token, security),
      hostingData: hosting.data,
      customNames: hosting.customNames,
      ...(sourceResponse === null ? {} : {
        resolvedPlayback: {
          title: sourceResponse.title,
          poster: sourceResponse.poster,
          filmstrip: sourceResponse.filmstrip,
          sources: sourceResponse.sources,
          tracks: sourceResponse.tracks
        }
      }),
      ...fallbackPlayerUrl(playableMedia, extracted?.result ?? null, player.slug_embed, security),
      ...(general.load_balancer_rand ? {} : {
        servers: mediaServerOptions(playableMedia, extracted?.result ?? null, player.slug_embed, security, hosting.customNames)
      })
    })
  }

  app.get(`/${config.slugs.embed}`, showEmbed)
  app.get(`/${config.slugs.embed}/`, showEmbed)

  const showDownload = async (request: FastifyRequest, reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]) => {
    const [ads, player, publicSettings, general, misc, hosting, countryCode] = await Promise.all([
      loadRuntimeAdsSettings(options.loadAdsSettings),
      loadRuntimePlayerSettings(options.loadPlayerSettings, playerDefaults),
      loadRuntimePublicSettings(options.loadPublicSettings),
      loadRuntimeGeneralSettings(options.loadGeneralSettings, config.baseUrl),
      loadRuntimeMiscSettings(options.loadMiscSettings, options.supportedHosts ?? new Set()),
      loadRuntimeHostingSettings(options.loadHostingSettings, options.supportedHosts ?? new Set()),
      countryCodeForRequest(request, options.countryCodeLookup)
    ])
    const pageAnalytics = analyticsConfig(general)
    const errorAnalytics = histatsOnly(pageAnalytics)
    const parsed = parsePlayerQuery(rawQueryFromUrl(request.url), security, {
      secureSalt: config.secureSalt
    })
    if (!publicSettings.enable_download_page) {
      applyDownloadHeaders(reply, errorAnalytics)
      reply.code(403).type('text/html; charset=utf-8')
      return renderDownloadError('The download page is disabled.', pageAnalytics)
    }
    const resolvedMedia = await resolveSavedMedia(parsed.media, options.resolveSavedVideo)
    if (resolvedMedia === null) {
      applyDownloadHeaders(reply, errorAnalytics)
      reply.code(400).type('text/html; charset=utf-8')
      return renderDownloadError(parsed.errors[0] ?? 'The download link is invalid.', pageAnalytics)
    }
    if (networkAccessRejected(request, misc, countryCode, false) ||
      mediaHostDisabled(resolvedMedia, misc.disable_host) ||
      accessPolicyFromMisc(misc).isTitleBlacklisted(playerMediaTitle(resolvedMedia))) {
      applyDownloadHeaders(reply, errorAnalytics)
      reply.code(403).type('text/html; charset=utf-8')
      return renderDownloadError('You are not allowed to access this download.', pageAnalytics)
    }
    const configuredMedia = withoutDisabledAlternatives(resolvedMedia, misc.disable_host)
    const playableMedia = general.load_balancer_rand ? randomizedPlaybackMedia(configuredMedia) : configuredMedia
    const requestContext: SourceApiRequestContext = Object.freeze({
      clientIp: request.ip,
      userAgent: request.headers['user-agent'] ?? '',
      language: request.headers['accept-language'] ?? '',
      downloadable: true
    })
    const extracted = await resolveDownloadPlayback(playableMedia, requestContext, options.resolvePlayback)
    if (extracted !== null && accessPolicyFromMisc(misc).isTitleBlacklisted(extracted.result.title || playerMediaTitle(playableMedia))) {
      applyDownloadHeaders(reply, errorAnalytics)
      reply.code(403).type('text/html; charset=utf-8')
      return renderDownloadError('You are not allowed to access this download.', pageAnalytics)
    }
    const deliveryBaseUrl = extracted === null
      ? new URL(config.baseUrl)
      : await selectedDeliveryBaseUrl(config, options.selectDeliveryBaseUrl, {
          clientIp: request.ip,
          host: extracted.result.upstream?.host ?? playableMedia.host ?? '',
          leastConnections: general.select_active_connections === true
        })
    const sourceResponse = extracted === null
      ? null
      : createSourceResponse(
          config,
          security,
          parsed.token,
          playableMedia,
          extracted.result,
          player,
          requestContext,
          options.providerContexts,
          deliveryBaseUrl
        )
    const embedUrl = routePath(player.slug_embed, parsed.token)
    const alternativeUrl = nextCandidateRoute(playableMedia, extracted?.result ?? null, player.slug_download, security)
    const shortenedLinks = await transformDownloadLinks(
      playableMedia,
      hosting.data,
      publicSettings.show_sub_download,
      options.shortenUrl,
      sourceResponse === null ? undefined : sourceDownloadTargets(sourceResponse, publicSettings.show_sub_download)
    )
    applyDownloadHeaders(reply, pageAnalytics)
    reply.type('text/html; charset=utf-8')
    return renderDownloadPage(playableMedia, {
      embedUrl,
      analytics: pageAnalytics,
      ...(alternativeUrl === undefined ? {} : { alternativeUrl }),
      downloadLabel: player.text_download,
      hideHostname: player.hide_hostname,
      hostingData: hosting.data,
      customNames: hosting.customNames,
      shortenedLinks,
      directAdUrl: ads.disable_direct_ads ? '' : ads.direct_ads_link,
      showSubtitleDownloads: publicSettings.show_sub_download,
      showWatchButton: publicSettings.show_watch_button,
      ...(sourceResponse === null ? {} : {
        resolvedPlayback: {
          title: sourceResponse.title,
          sources: sourceResponse.sources,
          tracks: sourceResponse.tracks
        }
      }),
      ...(general.load_balancer_rand ? {} : {
        servers: mediaServerOptions(playableMedia, extracted?.result ?? null, player.slug_download, security, hosting.customNames)
      }),
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

function statCounterFailure(): Readonly<{ status: 'fail'; message: string; result: 0 }> {
  return Object.freeze({ status: 'fail', message: 'Total daily visits have been exceeded', result: 0 })
}

function clearVideoCacheFailure(): Readonly<{ status: 'fail'; message: string; result: readonly never[] }> {
  return Object.freeze({ status: 'fail', message: 'Failed to clear the cache of the video or the video does not exist', result: Object.freeze([]) })
}

function publicLookupSuccess(): Readonly<{ status: 'ok'; message: ''; result: null }> {
  return Object.freeze({ status: 'ok', message: '', result: null })
}

function publicLookupFailure(message: string): Readonly<{ status: 'fail'; message: string; result: null }> {
  return Object.freeze({ status: 'fail', message, result: null })
}

function applyPublicLookupHeaders(reply: Parameters<FastifyRequest['routeOptions']['handler']>[1]): void {
  reply.headers({
    'cache-control': 'private, no-store',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow'
  })
}

function requestData(request: FastifyRequest): Record<string, unknown> {
  const query = typeof request.query === 'object' && request.query !== null && !Array.isArray(request.query)
    ? request.query as Record<string, unknown>
    : {}
  const body = typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {}
  return { ...query, ...body }
}

async function publicGeneratorRequestData(request: FastifyRequest): Promise<PublicGeneratorRequestData> {
  if (!request.isMultipart()) return Object.freeze({ fields: requestData(request), files: Object.freeze([]) })
  const fields: Record<string, unknown> = { ...requestQuery(request) }
  const files: PublicGeneratorFile[] = []
  let posters = 0
  let subtitles = 0
  for await (const part of request.parts({
    limits: { fieldNameSize: 100, fieldSize: 100_000, fields: 80, fileSize: VIDEO_POSTER_MAX_BYTES, files: 11, parts: 91 }
  })) {
    if (part.type === 'field') {
      addRepeatedField(fields, part.fieldname, part.value)
      continue
    }
    const fieldname = normalizeUploadField(part.fieldname)
    if (part.filename === '' || !['poster-file', 'sub-file'].includes(fieldname)) {
      part.file.resume()
      continue
    }
    if ((fieldname === 'poster-file' && posters >= 1) || (fieldname === 'sub-file' && subtitles >= MAX_PUBLIC_SUBTITLE_FILES)) {
      part.file.resume()
      continue
    }
    const content = await part.toBuffer()
    if (part.file.truncated || (fieldname === 'sub-file' && content.length > SUBTITLE_MAX_BYTES)) throw new Error('File limit exceeded')
    files.push(Object.freeze({ fieldname: part.fieldname, filename: part.filename, content }))
    if (fieldname === 'poster-file') posters += 1
    else subtitles += 1
  }
  return Object.freeze({ fields, files: Object.freeze(files) })
}

function requestQuery(request: FastifyRequest): Record<string, unknown> {
  return typeof request.query === 'object' && request.query !== null && !Array.isArray(request.query)
    ? request.query as Record<string, unknown>
    : {}
}

function addRepeatedField(fields: Record<string, unknown>, key: string, value: unknown): void {
  const current = fields[key]
  if (current === undefined) fields[key] = value
  else if (Array.isArray(current)) current.push(value)
  else fields[key] = [current, value]
}

function normalizeUploadField(value: string): string {
  return value.replace(/\[\]$/u, '')
}

function hasSameOrigin(request: FastifyRequest, config: AppConfig): boolean {
  const source = request.headers.origin ?? request.headers.referer
  if (source === undefined) return true
  try {
    return new URL(source).origin === config.baseUrl.origin
  } catch {
    return false
  }
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
  shortenUrl: PlayerRouteOptions['shortenUrl'],
  overrideTargets?: readonly string[]
): Promise<ReadonlyMap<string, string>> {
  if (shortenUrl === undefined) return new Map()
  const targets = [...new Set(overrideTargets ?? downloadPageLinkTargets(media, hostingData, includeSubtitles))].slice(0, MAX_SHORTLINK_TARGETS)
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
  ads: AdsSettings,
  p2pMode: 'hls' | 'dash' | null = null,
  player?: PlayerSettings,
  analytics?: AnalyticsConfig
): void {
  reply
    .header('cache-control', 'private, no-store')
    .header('content-security-policy', embedContentSecurityPolicy(ads, p2pMode, player, analytics))
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'strict-origin-when-cross-origin')
    .type('text/html; charset=utf-8')
}

function embedAdsOptions(ads: AdsSettings): EmbedAdsOptions {
  const popupEnabled = !ads.disable_popup_ads && (ads.popup_ads_link.length > 0 || ads.popup_ads_code.trim().length > 0)
  const directEnabled = !ads.disable_direct_ads && ads.visitads_onplay && ads.direct_ads_link.length > 0
  const vastAds = runtimeVastConfiguration(ads)
  return Object.freeze({
    blockAdblocker: ads.block_adblocker,
    vastAds: vastAds !== null && vastAds.schedule.length > 0 ? vastAds : null,
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

function embedContentSecurityPolicy(ads: AdsSettings, p2pMode: 'hls' | 'dash' | null, player?: PlayerSettings, analytics?: AnalyticsConfig): string {
  const scripts = ["'self'"]
  const connections = ['http:', 'https:']
  const images = ["'self'", 'http:', 'https:', 'data:']
  const frames = [
    "'self'",
    'https://www.youtube-nocookie.com',
    'https://player.vimeo.com',
    'https://www.dailymotion.com',
    'https://drive.google.com'
  ]
  if (!ads.disable_vast_ads && ads.vast_xml.length > 0) {
    scripts.push("'unsafe-eval'", 'https://imasdk.googleapis.com')
    frames.push('http:', 'https:', 'blob:')
  }
  if (p2pMode !== null && player !== undefined) {
    if (p2pMode === 'hls') scripts.push(P2P_CORE_IMPORT_MAP_CSP_HASH)
    for (const tracker of player.torrent_tracker.split(/\r?\n/)) {
      try {
        const url = new URL(tracker)
        if (['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password && !connections.includes(url.origin)) connections.push(url.origin)
      } catch {
        // Runtime settings validation normally guarantees tracker URLs.
      }
    }
  }
  const analyticsSources = analyticsCspSources(analytics)
  appendUnique(scripts, analyticsSources.scripts)
  appendUnique(connections, analyticsSources.connections)
  appendUnique(images, analyticsSources.images)
  appendUnique(frames, analyticsSources.frames)
  if (!ads.disable_direct_ads && ads.show_iframeads && ads.direct_ads_link.length > 0) {
    try {
      const origin = new URL(ads.direct_ads_link).origin
      if (!frames.includes(origin)) frames.push(origin)
    } catch {
      // Settings validation normally guarantees a URL; omit invalid values defensively.
    }
  }
  return `default-src 'none'; script-src ${scripts.join(' ')}; style-src 'self' 'unsafe-inline'; media-src http: https: blob:; connect-src ${connections.join(' ')}; img-src ${images.join(' ')}; frame-src ${frames.join(' ')}; worker-src blob:; base-uri 'none'; form-action 'none'; object-src 'none'`
}

function playerP2pMode(
  player: PlayerSettings,
  media: PlayerMediaQuery,
  response: PublicSourceResponse | null = null
): 'hls' | 'dash' | null {
  if (player.player !== 'plyr' || !player.p2p) return null
  const resolved = response?.sources[0]
  if (resolved !== undefined) {
    const file = typeof resolved.file === 'string' ? resolved.file : ''
    const type = typeof resolved.type === 'string' ? resolved.type.toLowerCase() : ''
    try {
      const pathname = new URL(file).pathname.toLowerCase()
      if (type === 'hls' || type.includes('mpegurl') || pathname.startsWith('/hls/') || pathname.endsWith('.m3u8')) return 'hls'
      if (type === 'dash' || type === 'mpd' || type.includes('dash') || pathname.startsWith('/mpd/') || pathname.endsWith('.mpd')) return 'dash'
    } catch {
      return null
    }
    return null
  }
  if (media.host !== 'direct' || media.id === undefined) return null
  if (media.id.startsWith('/hls/')) return 'hls'
  if (media.id.startsWith('/mpd/')) return 'dash'
  try {
    const pathname = new URL(media.id).pathname.toLowerCase()
    if (pathname.endsWith('.m3u8')) return 'hls'
    if (pathname.endsWith('.mpd')) return 'dash'
  } catch {
    // Invalid direct URLs are handled by the renderer.
  }
  return null
}

async function resolveEmbedPlayback(
  media: PlayerMediaQuery,
  context: SourceApiRequestContext,
  resolve: SourceApiResolver | undefined,
  disabledResolutions: readonly string[]
): Promise<Readonly<{ result: MediaResult }> | null> {
  if (resolve === undefined) return null
  try {
    const result = await resolve(media, context)
    if (result.sources.length === 0) return null
    return Object.freeze({
      result: Object.freeze({ ...result, sources: filterSourcesByResolution(result.sources, disabledResolutions) })
    })
  } catch {
    return null
  }
}

async function resolveDownloadPlayback(
  media: PlayerMediaQuery,
  context: SourceApiRequestContext,
  resolve: SourceApiResolver | undefined
): Promise<Readonly<{ result: MediaResult }> | null> {
  if (resolve === undefined) return null
  const { host: _host, id: _id, ahost: _ahost, aid: _aid, alternatives: _alternatives, ...shared } = media
  for (const candidate of playerMediaCandidates(media)) {
    try {
      const result = await resolve(Object.freeze({ ...shared, host: candidate.host, id: candidate.id }), context)
      const sources = result.sources.filter(isDownloadableMediaSource)
      if (sources.length === 0) continue
      return Object.freeze({ result: Object.freeze({ ...result, sources: Object.freeze(sources) }) })
    } catch {
      // The supplied download client advances to the next configured server on transport failure.
    }
  }
  return null
}

function isDownloadableMediaSource(source: Readonly<Record<string, unknown>>): boolean {
  const file = typeof source.file === 'string' ? source.file : ''
  const type = typeof source.type === 'string' ? source.type.toLowerCase() : ''
  if (file.length === 0 || type.includes('hls') || type.includes('dash') || type.includes('mpd')) return false
  if (type.includes('video')) return true
  try {
    return ['.mp4', '.m4v', '.mkv', '.webm'].some((extension) => new URL(file).pathname.toLowerCase().endsWith(extension))
  } catch {
    return false
  }
}

function withoutDisabledAlternatives(media: PlayerMediaQuery, disabledHosts: readonly string[]): PlayerMediaQuery {
  if (disabledHosts.length === 0) return media
  const alternatives = (media.alternatives ?? []).filter((candidate) => !disabledHosts.includes(candidate.host))
  const hasLegacyAlternative = media.ahost !== undefined && media.aid !== undefined && !disabledHosts.includes(media.ahost)
  const { ahost: _ahost, aid: _aid, alternatives: _alternatives, ...shared } = media
  return Object.freeze({
    ...shared,
    ...(hasLegacyAlternative ? { ahost: media.ahost, aid: media.aid } : {}),
    ...(alternatives.length === 0 ? {} : { alternatives: Object.freeze(alternatives) })
  })
}

function fallbackPlayerUrl(
  media: PlayerMediaQuery,
  result: MediaResult | null,
  embedSlug: string,
  security: Security
): Readonly<{ fallbackUrl?: string }> {
  const fallbackUrl = nextCandidateRoute(media, result, embedSlug, security)
  return fallbackUrl === undefined ? Object.freeze({}) : Object.freeze({ fallbackUrl })
}

function cacheInvalidationToken(
  media: PlayerMediaQuery,
  result: MediaResult | null,
  fallbackToken: string,
  security: Security
): string {
  const host = result?.upstream?.host ?? media.host
  const id = result?.upstream?.id ?? media.id
  if (host === undefined || host === '' || id === undefined || id === '') return fallbackToken
  return security.encryptURL(buildPlayerQuery({ host, id }))
}

function nextCandidateRoute(
  media: PlayerMediaQuery,
  result: MediaResult | null,
  slug: string,
  security: Security
): string | undefined {
  const candidates = playerMediaCandidates(media)
  if (candidates.length < 2) return undefined
  const resolvedHost = result?.upstream?.host ?? media.host ?? ''
  const resolvedId = result?.upstream?.id ?? media.id ?? ''
  const resolvedIndex = candidates.findIndex((candidate) => candidate.host === resolvedHost && candidate.id === resolvedId)
  const nextIndex = resolvedIndex < 0 ? 1 : resolvedIndex + 1
  const next = candidates[nextIndex]
  if (next === undefined) return undefined
  const after = candidates[nextIndex + 1]
  const { host: _host, id: _id, ahost: _ahost, aid: _aid, alternatives: _alternatives, ...shared } = media
  const fallbackMedia: PlayerMediaQuery = Object.freeze({
    ...shared,
    host: next.host,
    id: next.id,
    ...(after === undefined ? {} : { ahost: after.host, aid: after.id })
  })
  return routePath(slug, security.encryptURL(buildPlayerQuery(fallbackMedia)))
}

function sourceDownloadTargets(response: PublicSourceResponse, includeSubtitles: boolean): readonly string[] {
  return Object.freeze([
    ...response.sources.flatMap((source) => typeof source.file === 'string' ? [source.file] : []),
    ...(includeSubtitles
      ? response.tracks.flatMap((track) => typeof track.file === 'string' ? [track.file] : [])
      : [])
  ])
}

function randomizedPlaybackMedia(media: PlayerMediaQuery): PlayerMediaQuery {
  const candidates = playerMediaCandidates(media)
  if (candidates.length < 2) return media
  const offset = randomInt(candidates.length)
  const ordered = [...candidates.slice(offset), ...candidates.slice(0, offset)]
  const selected = ordered[0]
  if (selected === undefined) return media
  const { host: _host, id: _id, ahost: _ahost, aid: _aid, alternatives: _alternatives, ...shared } = media
  return Object.freeze({
    ...shared,
    host: selected.host,
    id: selected.id,
    ...(ordered[1] === undefined ? {} : { ahost: ordered[1].host, aid: ordered[1].id }),
    ...(ordered.length < 3 ? {} : { alternatives: Object.freeze(ordered.slice(2)) })
  })
}

function mediaServerOptions(
  media: PlayerMediaQuery,
  result: MediaResult | null,
  embedSlug: string,
  security: Security,
  customNames: Readonly<Record<string, string>> | undefined
): readonly Readonly<{ label: string; url: string; active: boolean }>[] {
  const candidates = playerMediaCandidates(media)
  if (candidates.length < 2) return Object.freeze([])
  const activeHost = result?.upstream?.host ?? media.host ?? ''
  const activeId = result?.upstream?.id ?? media.id ?? ''
  const { host: _host, id: _id, ahost: _ahost, aid: _aid, alternatives: _alternatives, ...shared } = media
  return Object.freeze(candidates.map((candidate, index) => Object.freeze({
    label: customNames?.[candidate.host]?.trim() || candidate.host.replaceAll(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) || `Server ${index + 1}`,
    url: routePath(embedSlug, security.encryptURL(buildPlayerQuery({ ...shared, host: candidate.host, id: candidate.id }))),
    active: candidate.host === activeHost && candidate.id === activeId
  })))
}

function playerP2pSwarmId(config: AppConfig, media: PlayerMediaQuery): string {
  return createHmac('sha256', config.secureSalt)
    .update(`gplayer-p2p\0${media.host ?? ''}\0${media.id ?? ''}`)
    .digest('hex')
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

function applyDownloadHeaders(reply: Parameters<FastifyRequest['routeOptions']['handler']>[1], analytics?: AnalyticsConfig): void {
  const analyticsSources = analyticsCspSources(analytics)
  const scripts = ["'self'", ...analyticsSources.scripts]
  const connections = analyticsSources.connections.length === 0 ? ["'none'"] : [...analyticsSources.connections]
  const images = ["'self'", 'data:', ...analyticsSources.images]
  const frames = ["'self'", ...analyticsSources.frames]
  reply
    .header('cache-control', 'private, no-store')
    .header('content-security-policy', `default-src 'none'; script-src ${scripts.join(' ')}; style-src 'self'; connect-src ${connections.join(' ')}; img-src ${images.join(' ')}; frame-src ${frames.join(' ')}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; object-src 'none'`)
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .header('x-robots-tag', 'noindex, nofollow')
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value)
}

function proxyPlayerMedia(media: PlayerMediaQuery, security: Security, clientIp: string): PlayerMediaQuery {
  const { id: _id, poster: _poster, sub: _sub, subs: _subs, ...shared } = media
  let id = media.id
  const accessToken = createStreamingAccessToken(clientIp, security)
  if (media.host === 'direct' && media.id !== undefined) {
    try {
      const target = new URL(media.id)
      const pathname = target.pathname.toLowerCase()
      if (pathname.endsWith('.m3u8')) {
        id = createStreamingProxyPath('hls', target, security, {
          host: 'direct',
          id: media.id,
          ...(accessToken === undefined ? {} : { accessToken })
        })
      } else if (pathname.endsWith('.mpd')) {
        id = createStreamingProxyPath('mpd', target, security, {
          host: 'direct',
          id: media.id,
          ...(accessToken === undefined ? {} : { accessToken })
        })
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
