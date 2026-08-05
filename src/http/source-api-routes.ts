import path from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AppConfig } from '../config.js'
import {
  buildPlayerQuery,
  parsePlayerQuery,
  type PlayerMediaQuery
} from '../core/player-query.js'
import type { MediaResult, MediaSource, MediaTrack } from '../core/source-resolver.js'
import { createMediaProxyPath } from './media-routes.js'
import { createStreamingProxyPath, type StreamingRoute } from './streaming-routes.js'
import { Security } from '../security/security.js'
import type { CountryCodeLookup } from '../security/geoip-country.js'
import { legacyVastConfiguration, loadRuntimeAdsSettings, type AdsSettingsLoader } from '../settings/ads-runtime.js'
import { accessPolicyFromMisc, accessPolicyRejects, filterSourcesByResolution, loadRuntimeMiscSettings, type MiscSettingsLoader } from '../settings/misc-runtime.js'
import { loadRuntimePlayerSettings, type PlayerSettingsLoader } from '../settings/player-runtime.js'
import { languageEntry, type PlayerSettings } from '../settings/player-settings.js'
import type { AdsSettings } from '../settings/settings-admin-service.js'

const MAX_API_TOKEN_LENGTH = 65_536
const SOURCE_TOKEN_SEPARATOR = '-,'

const passwordQuerySchema = z.object({
  p: z.string().max(MAX_API_TOKEN_LENGTH).optional()
}).passthrough()

export type SourceApiRequestContext = Readonly<{
  clientIp: string
  userAgent: string
  language: string
  downloadable: boolean
}>

export type SourceApiResolver = (
  query: PlayerMediaQuery,
  context: SourceApiRequestContext
) => Promise<MediaResult>

export type SourceApiRouteOptions = Readonly<{
  resolve: SourceApiResolver
  supportedHosts?: ReadonlySet<string>
  loadAdsSettings?: AdsSettingsLoader
  loadPlayerSettings?: PlayerSettingsLoader
  loadMiscSettings?: MiscSettingsLoader
  countryCodeLookup?: CountryCodeLookup
}>

type ApiRequestEnvelope = Readonly<{
  queryToken: string
  password: string
  media: PlayerMediaQuery
}>

export async function registerSourceApiRoutes(
  app: FastifyInstance,
  config: AppConfig,
  options: SourceApiRouteOptions
): Promise<void> {
  const security = new Security(config.secureSalt)
  const playerDefaults = { ...config.slugs, adminDirectory: config.adminDirectory }

  const apiConfig = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    applyApiHeaders(reply)
    const password = passwordFromRequest(request, security)
    if (password === null) return plaintextFailure(reply)

    const queryToken = configTokenFromUrl(request.url)
    const parsed = queryToken.length === 0
      ? null
      : parsePlayerQuery(queryToken, security, { secureSalt: config.secureSalt }).media
    const [ads, player, misc, countryCode] = await Promise.all([
      loadRuntimeAdsSettings(options.loadAdsSettings),
      loadRuntimePlayerSettings(options.loadPlayerSettings, playerDefaults),
      loadRuntimeMiscSettings(options.loadMiscSettings, options.supportedHosts ?? new Set()),
      countryCodeForRequest(request, options.countryCodeLookup)
    ])
    if (networkAccessRejected(request, misc, countryCode) || mediaHostDisabled(parsed, misc.disable_host)) return plaintextFailure(reply)
    const output = isDownloadConfigRequest(request)
      ? createDownloadConfiguration(config, parsed, ads)
      : createEmbedConfiguration(config, parsed, request.headers['user-agent'] ?? '', ads, player)

    return reply
      .type('text/plain; charset=utf-8')
      .send(security.encryptResponse(JSON.stringify(output), password))
  }

  const api = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    applyApiHeaders(reply)
    const envelope = parseApiRequest(request, security, config)
    if (envelope === null) return plaintextFailure(reply)

    const [misc, countryCode] = await Promise.all([
      loadRuntimeMiscSettings(options.loadMiscSettings, options.supportedHosts ?? new Set()),
      countryCodeForRequest(request, options.countryCodeLookup)
    ])
    if (networkAccessRejected(request, misc, countryCode) || mediaHostDisabled(envelope.media, misc.disable_host)) return plaintextFailure(reply)

    let result: MediaResult
    try {
      result = await options.resolve(envelope.media, {
        clientIp: request.ip,
        userAgent: request.headers['user-agent'] ?? '',
        language: request.headers['accept-language'] ?? '',
        downloadable: legacyBoolean(envelope.media.download)
      })
    } catch {
      return plaintextFailure(reply, 'Server Error')
    }
    if (result.sources.length === 0) return plaintextFailure(reply)
    const policy = accessPolicyFromMisc(misc)
    const resolvedTitle = result.title.length > 0 ? result.title : titleFromMedia(envelope.media)
    if (policy.isTitleBlacklisted(resolvedTitle)) return plaintextFailure(reply)
    result = Object.freeze({ ...result, sources: filterSourcesByResolution(result.sources, misc.disable_resolution) })

    const player = await loadRuntimePlayerSettings(options.loadPlayerSettings, playerDefaults)
    const output = createSourceResponse(
      config,
      security,
      envelope.queryToken,
      envelope.media,
      result,
      player
    )
    return reply
      .type('text/plain; charset=utf-8')
      .send(security.encryptResponse(JSON.stringify(output), envelope.password))
  }

  app.get('/api-config', apiConfig)
  app.get('/api-config/', apiConfig)
  app.get('/api-config/*', apiConfig)
  app.route({ method: ['GET', 'POST'], url: '/api', handler: api })
  app.route({ method: ['GET', 'POST'], url: '/api/', handler: api })
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
  countryCode: string
): boolean {
  return accessPolicyRejects(accessPolicyFromMisc(settings), {
    clientIp: request.ip,
    countryCode,
    referer: '',
    userAgent: request.headers['user-agent'] ?? ''
  })
}

function mediaHostDisabled(media: PlayerMediaQuery | null, disabledHosts: readonly string[]): boolean {
  return media?.host !== undefined && disabledHosts.includes(media.host)
}

function parseApiRequest(
  request: FastifyRequest,
  security: Security,
  config: AppConfig
): ApiRequestEnvelope | null {
  const password = passwordFromRequest(request, security)
  const body = typeof request.body === 'string' ? request.body.trim() : ''
  if (password === null || body.length === 0 || body.length > MAX_API_TOKEN_LENGTH) return null

  const separator = body.indexOf(SOURCE_TOKEN_SEPARATOR)
  if (separator < 0) return null
  const queryToken = body.slice(0, separator)
  const apiSaltToken = body.slice(separator + SOURCE_TOKEN_SEPARATOR.length)
  if (!security.validateApiSalt(apiSaltToken)) return null

  const media = parsePlayerQuery(queryToken, security, { secureSalt: config.secureSalt }).media
  if (media === null) return null
  return { queryToken, password, media }
}

function passwordFromRequest(request: FastifyRequest, security: Security): string | null {
  const parsed = passwordQuerySchema.safeParse(request.query)
  if (!parsed.success || parsed.data.p === undefined || parsed.data.p.length === 0) return null
  const password = security.decryptURLStrict(parsed.data.p)
  return password === null || password.length === 0 || password.length > 1_024 ? null : password
}

function configTokenFromUrl(requestUrl: string): string {
  const parsed = new URL(requestUrl, 'http://gplayer.invalid')
  const prefix = '/api-config/'
  if (!parsed.pathname.startsWith(prefix)) return ''
  try {
    return decodeURIComponent(parsed.pathname.slice(prefix.length)).replace(/^\/+|\/+$/g, '')
  } catch {
    return ''
  }
}

function isDownloadConfigRequest(request: FastifyRequest): boolean {
  const parsed = new URL(request.url, 'http://gplayer.invalid')
  return legacyBoolean(parsed.searchParams.get('dl') ?? undefined)
}

function createEmbedConfiguration(
  config: AppConfig,
  media: PlayerMediaQuery | null,
  userAgent: string,
  ads: AdsSettings,
  playerSettings: PlayerSettings
): Readonly<Record<string, unknown>> {
  const valid = media !== null
  return {
    apiURL: valid ? config.baseUrl.toString() : '',
    defaultSubtitle: languageEntry(playerSettings.default_subtitle),
    defaultAudio: languageEntry(playerSettings.default_audio),
    embedOnly: legacyBoolean(media?.onlylink),
    disableCast: true,
    backgroundColor: `#${playerSettings.background_color}`,
    backgroundOpacity: Number(playerSettings.background_opacity),
    edgeStyle: playerSettings.edge_style,
    fontFamily: playerSettings.font_family,
    windowColor: `#${playerSettings.window_color}`,
    windowOpacity: Number(playerSettings.window_opacity),
    isSafariIE: isSafariOrInternetExplorer(userAgent),
    player: playerSettings.player,
    message: valid ? '' : 'Bad Request',
    enableP2P: playerSettings.p2p,
    hosts: mediaHosts(media),
    preload: playerSettings.preload,
    stretching: playerSettings.stretching,
    displayTitle: playerSettings.display_title,
    displayRateControls: playerSettings.playback_rate,
    captionsColor: `#${playerSettings.subtitle_color}`,
    playerSkin: playerSettings.player_skin,
    vastAds: legacyVastConfiguration(ads),
    blockADB: ads.block_adblocker,
    enableSharer: playerSettings.enable_share_button,
    logoHide: playerSettings.logo_hide,
    logoPosition: playerSettings.logo_position,
    visitAdsOnplay: ads.visitads_onplay,
    showIframeAds: ads.show_iframeads,
    logoImage: playerSettings.logo_file,
    logoLink: playerSettings.logo_open_link,
    torrentList: playerSettings.torrent_tracker.split(/\r?\n/).filter(Boolean),
    disableDirectAds: ads.disable_direct_ads,
    directAdsLink: ads.direct_ads_link,
    smallLogoFile: playerSettings.small_logo_file,
    smallLogoLink: playerSettings.small_logo_link,
    playerColor: `#${playerSettings.player_color}`,
    playerColor2: `#${playerSettings.player_color2}`,
    playerVersion: '4.6.6',
    rgbColor: rgbColor(playerSettings.player_color),
    text_rewind: playerSettings.text_rewind,
    text_forward: playerSettings.text_forward,
    text_download: playerSettings.text_download,
    productionMode: false,
    statCounterRuntime: 60,
    showDownloadButton: playerSettings.enable_download_button,
    enableDownloadPage: true,
    defaultResolution: numericResolution(playerSettings.default_resolution),
    logoMargin: Number(playerSettings.logo_margin),
    pauseOnLeft: playerSettings.pause_on_left
  }
}

function createDownloadConfiguration(
  config: AppConfig,
  media: PlayerMediaQuery | null,
  ads: AdsSettings
): Readonly<Record<string, unknown>> {
  const valid = media !== null
  return {
    apiURL: valid ? config.baseUrl.toString() : '',
    message: valid ? '' : 'Bad Request',
    hosts: mediaHosts(media),
    disableDirectAds: ads.disable_direct_ads,
    directAdsLink: ads.direct_ads_link,
    showIframeAds: ads.show_iframeads,
    productionMode: false
  }
}

function createSourceResponse(
  config: AppConfig,
  security: Security,
  queryToken: string,
  media: PlayerMediaQuery,
  result: MediaResult,
  playerSettings: PlayerSettings
): Readonly<Record<string, unknown>> {
  const canonicalToken = queryToken.length > 0
    ? queryToken
    : security.encryptURL(buildPlayerQuery(media))
  const identity = {
    host: media.host ?? 'direct',
    id: media.id ?? ''
  }
  const title = result.title.length > 0 ? result.title : titleFromMedia(media)
  const configuredPoster = playerSettings.poster
  const posterSource = playerSettings.force_default_poster && configuredPoster.length > 0
    ? configuredPoster
    : media.poster || result.image || configuredPoster
  const poster = proxyPoster(posterSource, security, config.baseUrl)

  return {
    query: {
      host: media.host ?? '',
      id: media.id ?? '',
      poster: media.poster ?? '',
      download: media.download ?? '',
      alt: '-1'
    },
    status: 'ok',
    message: 'Success',
    embed_url: absolutePlayerUrl(config, playerSettings.slug_embed, canonicalToken),
    download_url: absolutePlayerUrl(config, playerSettings.slug_download, canonicalToken),
    title,
    poster,
    filmstrip: playerSettings.disable_filmstrip ? '' : proxyFilmstrip(result.filmstrip, security, config.baseUrl),
    sources: result.sources.flatMap((source) => proxySource(source, security, identity, config.baseUrl)),
    tracks: result.tracks.flatMap((track) => proxyTrack(track, security, config.baseUrl))
  }
}

function proxySource(
  source: MediaSource,
  security: Security,
  identity: Readonly<{ host: string; id: string }>,
  baseUrl: URL
): readonly MediaSource[] {
  const file = typeof source.file === 'string' ? source.file : ''
  if (file.length === 0) return []
  let target: URL
  try {
    target = new URL(file)
  } catch {
    return [source]
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return []

  const route = streamingRoute(source, target)
  const proxyPath = createStreamingProxyPath(route, target, security, identity)
  return [{ ...source, file: new URL(proxyPath, baseUrl).toString() }]
}

function proxyTrack(track: MediaTrack, security: Security, baseUrl: URL): readonly MediaTrack[] {
  const file = typeof track.file === 'string' ? track.file : ''
  if (file.length === 0) return []
  const proxied = createMediaProxyPath('subtitle', file, security)
  return proxied === null ? [track] : [{ ...track, file: new URL(proxied, baseUrl).toString() }]
}

function proxyPoster(value: string, security: Security, baseUrl: URL): string {
  if (value.length === 0) return ''
  const proxied = createMediaProxyPath('poster', value, security)
  return proxied === null ? value : new URL(proxied, baseUrl).toString()
}

function proxyFilmstrip(value: string, security: Security, baseUrl: URL): string {
  if (value.length === 0) return ''
  const proxied = createMediaProxyPath('filmstrip', value, security)
  return proxied === null ? value : new URL(proxied, baseUrl).toString()
}

function streamingRoute(source: MediaSource, target: URL): StreamingRoute {
  const type = typeof source.type === 'string' ? source.type.toLowerCase() : ''
  const pathname = target.pathname.toLowerCase()
  if (type.includes('hls') || pathname.endsWith('.m3u8')) return 'hls'
  if (type.includes('mpd') || type.includes('dash') || pathname.endsWith('.mpd')) return 'mpd'
  return 'stream-vid'
}

function mediaHosts(media: PlayerMediaQuery | null): readonly string[] {
  if (media === null) return []
  return [...new Set([media.host, media.ahost].filter((host): host is string => host !== undefined && host.length > 0))]
}

function absolutePlayerUrl(config: AppConfig, slug: string, token: string): string {
  return new URL(`/${slug.replace(/^\/+|\/+$/g, '')}/?${token}`, config.baseUrl).toString()
}

function titleFromMedia(media: PlayerMediaQuery): string {
  const value = media.id ?? ''
  try {
    const target = new URL(value)
    return decodeURIComponent(path.posix.basename(target.pathname))
  } catch {
    return value
  }
}

function isSafariOrInternetExplorer(userAgent: string): boolean {
  return /(?:MSIE|Trident)/i.test(userAgent) || /Safari/i.test(userAgent) && !/(?:Chrome|Chromium|CriOS|Edg)/i.test(userAgent)
}

function numericResolution(value: PlayerSettings['default_resolution']): number | string {
  return /^\d+$/.test(value) ? Number(value) : value
}

function rgbColor(value: string): string {
  return [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)]
    .map((part) => Number.parseInt(part, 16))
    .join(',')
}

function legacyBoolean(value: string | undefined): boolean {
  if (value === undefined) return false
  return ['1', 'true', 'on', 'yes'].includes(value.trim().toLowerCase())
}

function applyApiHeaders(reply: FastifyReply): void {
  reply
    .header('cache-control', 'no-cache, no-store, no-transform, must-revalidate')
    .header('pragma', 'no-cache')
    .header('expires', '0')
    .header('x-content-type-options', 'nosniff')
}

function plaintextFailure(reply: FastifyReply, message = 'Not Found'): unknown {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .send(JSON.stringify({ status: 'fail', message }))
}
