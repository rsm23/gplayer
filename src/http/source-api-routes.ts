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
import {
  createStreamingAccessToken,
  createStreamingProxyPath,
  type StreamingIdentity,
  type StreamingRoute
} from './streaming-routes.js'
import { Security } from '../security/security.js'
import type { CountryCodeLookup } from '../security/geoip-country.js'
import { legacyVastConfiguration, loadRuntimeAdsSettings, type AdsSettingsLoader } from '../settings/ads-runtime.js'
import { accessPolicyFromMisc, accessPolicyRejects, filterSourcesByResolution, loadRuntimeMiscSettings, type MiscSettingsLoader } from '../settings/misc-runtime.js'
import { loadRuntimePlayerSettings, type PlayerSettingsLoader } from '../settings/player-runtime.js'
import { languageEntry, type PlayerSettings } from '../settings/player-settings.js'
import type { AdsSettings } from '../settings/settings-admin-service.js'
import type { ProviderStreamContextRegistry } from '../stream/provider-stream-context.js'
import { loadRuntimeGeneralSettings, visitCounterRuntime, type GeneralSettingsLoader } from '../settings/general-runtime.js'
import type { GeneralSettings } from '../settings/settings-admin-service.js'
import type { DeliveryBaseUrlSelector } from '../load-balancers/load-balancer-selector.js'

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
  resolveSavedVideo?: (idOrSlug: string) => Promise<PlayerMediaQuery | null>
  supportedHosts?: ReadonlySet<string>
  loadAdsSettings?: AdsSettingsLoader
  loadPlayerSettings?: PlayerSettingsLoader
  loadMiscSettings?: MiscSettingsLoader
  loadGeneralSettings?: GeneralSettingsLoader
  countryCodeLookup?: CountryCodeLookup
  filterResponse?: (response: unknown, query: Readonly<Record<string, unknown>>) => Promise<unknown>
  capturePublicVideo?: (media: PlayerMediaQuery, result: MediaResult) => Promise<unknown>
  providerContexts?: ProviderStreamContextRegistry
  selectDeliveryBaseUrl?: DeliveryBaseUrlSelector
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
    const resolved = await resolveSavedMedia(parsed, options.resolveSavedVideo)
    const [ads, player, general, misc, countryCode] = await Promise.all([
      loadRuntimeAdsSettings(options.loadAdsSettings),
      loadRuntimePlayerSettings(options.loadPlayerSettings, playerDefaults),
      loadRuntimeGeneralSettings(options.loadGeneralSettings, config.baseUrl),
      loadRuntimeMiscSettings(options.loadMiscSettings, options.supportedHosts ?? new Set()),
      countryCodeForRequest(request, options.countryCodeLookup)
    ])
    if (networkAccessRejected(request, misc, countryCode) || mediaHostDisabled(resolved, misc.disable_host)) return plaintextFailure(reply)
    const configuredMedia = withoutDisabledAlternatives(resolved, misc.disable_host)
    const deliveryBaseUrl = await selectedDeliveryBaseUrl(config, options.selectDeliveryBaseUrl, {
      clientIp: request.ip,
      host: configuredMedia?.host ?? '',
      leastConnections: general.select_active_connections === true
    })
    const output = isDownloadConfigRequest(request)
      ? createDownloadConfiguration(deliveryBaseUrl, configuredMedia, ads, general)
      : createEmbedConfiguration(deliveryBaseUrl, configuredMedia, request.headers['user-agent'] ?? '', ads, player, general)
    const filtered = await filterResponse(options.filterResponse, output, Object.freeze({ route: 'api-config', media: configuredMedia }))

    return reply
      .type('text/plain; charset=utf-8')
      .send(security.encryptResponse(JSON.stringify(filtered), password))
  }

  const api = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    applyApiHeaders(reply)
    const envelope = parseApiRequest(request, security, config)
    if (envelope === null) return plaintextFailure(reply)

    const [misc, countryCode] = await Promise.all([
      loadRuntimeMiscSettings(options.loadMiscSettings, options.supportedHosts ?? new Set()),
      countryCodeForRequest(request, options.countryCodeLookup)
    ])
    const resolvedMedia = await resolveSavedMedia(envelope.media, options.resolveSavedVideo)
    if (resolvedMedia === null || networkAccessRejected(request, misc, countryCode) || mediaHostDisabled(resolvedMedia, misc.disable_host)) return plaintextFailure(reply)
    const playableMedia = withoutDisabledAlternatives(resolvedMedia, misc.disable_host)

    const requestContext: SourceApiRequestContext = Object.freeze({
      clientIp: request.ip,
      userAgent: request.headers['user-agent'] ?? '',
      language: request.headers['accept-language'] ?? '',
      downloadable: legacyBoolean(envelope.media.download)
    })
    let result: MediaResult
    try {
      result = await options.resolve(playableMedia, requestContext)
    } catch {
      return plaintextFailure(reply, 'Server Error')
    }
    if (result.sources.length === 0) return plaintextFailure(reply)
    const policy = accessPolicyFromMisc(misc)
    const resolvedTitle = result.title.length > 0 ? result.title : titleFromMedia(playableMedia)
    if (policy.isTitleBlacklisted(resolvedTitle)) return plaintextFailure(reply)
    await options.capturePublicVideo?.(playableMedia, result).catch(() => undefined)
    result = Object.freeze({ ...result, sources: filterSourcesByResolution(result.sources, misc.disable_resolution) })

    const [player, general] = await Promise.all([
      loadRuntimePlayerSettings(options.loadPlayerSettings, playerDefaults),
      loadRuntimeGeneralSettings(options.loadGeneralSettings, config.baseUrl)
    ])
    const deliveryBaseUrl = await selectedDeliveryBaseUrl(config, options.selectDeliveryBaseUrl, {
      clientIp: request.ip,
      host: result.upstream?.host ?? playableMedia.host ?? '',
      leastConnections: general.select_active_connections === true
    })
    const output = createSourceResponse(
      config,
      security,
      envelope.queryToken,
      playableMedia,
      result,
      player,
      requestContext,
      options.providerContexts,
      deliveryBaseUrl
    )
    const filtered = await filterResponse(options.filterResponse, output, Object.freeze({ route: 'api', media: playableMedia }))
    return reply
      .type('text/plain; charset=utf-8')
      .send(security.encryptResponse(JSON.stringify(filtered), envelope.password))
  }

  app.get('/api-config', apiConfig)
  app.get('/api-config/', apiConfig)
  app.get('/api-config/*', apiConfig)
  app.route({ method: ['GET', 'POST'], url: '/api', handler: api })
  app.route({ method: ['GET', 'POST'], url: '/api/', handler: api })
}

async function filterResponse(filter: SourceApiRouteOptions['filterResponse'], response: unknown, query: Readonly<Record<string, unknown>>): Promise<unknown> {
  if (filter === undefined) return response
  try {
    const filtered = await filter(response, query)
    return JSON.stringify(filtered) === undefined ? response : filtered
  } catch { return response }
}

async function resolveSavedMedia(
  media: PlayerMediaQuery | null,
  resolve: SourceApiRouteOptions['resolveSavedVideo']
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

function withoutDisabledAlternatives(media: PlayerMediaQuery, disabledHosts: readonly string[]): PlayerMediaQuery
function withoutDisabledAlternatives(media: null, disabledHosts: readonly string[]): null
function withoutDisabledAlternatives(media: PlayerMediaQuery | null, disabledHosts: readonly string[]): PlayerMediaQuery | null
function withoutDisabledAlternatives(media: PlayerMediaQuery | null, disabledHosts: readonly string[]): PlayerMediaQuery | null {
  if (media === null || disabledHosts.length === 0) return media
  const { ahost: _ahost, aid: _aid, alternatives: _alternatives, ...shared } = media
  const alternatives = (media.alternatives ?? []).filter((item) => !disabledHosts.includes(item.host))
  const selected = media.ahost !== undefined && media.aid !== undefined && !disabledHosts.includes(media.ahost)
    ? { host: media.ahost, id: media.aid }
    : alternatives[0]
  return Object.freeze({
    ...shared,
    ...(selected === undefined ? {} : { ahost: selected.host, aid: selected.id }),
    ...(alternatives.length === 0 ? {} : { alternatives: Object.freeze(alternatives) })
  })
}

function parseApiRequest(
  request: FastifyRequest,
  security: Security,
  config: AppConfig
): ApiRequestEnvelope | null {
  const body = typeof request.body === 'string' ? request.body.trim() : ''
  const envelope = body || legacyEnvelopeFromUrl(request.url)
  if (envelope.length === 0 || envelope.length > MAX_API_TOKEN_LENGTH) return null

  const separator = envelope.indexOf(SOURCE_TOKEN_SEPARATOR)
  if (separator < 0) return null
  const queryToken = envelope.slice(0, separator)
  const apiSaltToken = envelope.slice(separator + SOURCE_TOKEN_SEPARATOR.length)
  if (!security.validateApiSalt(apiSaltToken)) return null

  const password = passwordFromRequest(request, security) ?? legacyPasswordFromQueryToken(queryToken, security)
  if (password === null) return null

  const media = parsePlayerQuery(queryToken, security, { secureSalt: config.secureSalt }).media
  if (media === null) return null
  return { queryToken, password, media }
}

function legacyEnvelopeFromUrl(requestUrl: string): string {
  const raw = requestUrl.split('?', 2)[1]?.split('&', 1)[0]?.split('=', 1)[0] ?? ''
  try {
    return decodeURIComponent(raw.replaceAll('+', ' ')).trim()
  } catch {
    return ''
  }
}

function legacyPasswordFromQueryToken(queryToken: string, security: Security): string | null {
  const query = security.decryptURLStrict(queryToken)
  if (query === null || query === '') return null
  const token = new URLSearchParams(query).get('token') ?? ''
  const password = security.decryptURLStrict(token)
  return password === null || password.length === 0 || password.length > 1_024 ? null : password
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
  deliveryBaseUrl: URL,
  media: PlayerMediaQuery | null,
  userAgent: string,
  ads: AdsSettings,
  playerSettings: PlayerSettings,
  generalSettings: GeneralSettings
): Readonly<Record<string, unknown>> {
  const valid = media !== null
  return {
    apiURL: valid ? deliveryBaseUrl.toString() : '',
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
    productionMode: generalSettings.production_mode,
    statCounterRuntime: visitCounterRuntime(generalSettings),
    showDownloadButton: playerSettings.enable_download_button,
    enableDownloadPage: true,
    defaultResolution: numericResolution(playerSettings.default_resolution),
    logoMargin: Number(playerSettings.logo_margin),
    pauseOnLeft: playerSettings.pause_on_left
  }
}

function createDownloadConfiguration(
  deliveryBaseUrl: URL,
  media: PlayerMediaQuery | null,
  ads: AdsSettings,
  generalSettings: GeneralSettings
): Readonly<Record<string, unknown>> {
  const valid = media !== null
  return {
    apiURL: valid ? deliveryBaseUrl.toString() : '',
    message: valid ? '' : 'Bad Request',
    hosts: mediaHosts(media),
    disableDirectAds: ads.disable_direct_ads,
    directAdsLink: ads.direct_ads_link,
    showIframeAds: ads.show_iframeads,
    productionMode: generalSettings.production_mode
  }
}

export type PublicSourceResponse = Readonly<{
  query: Readonly<{
    host: string
    id: string
    poster: string
    download: string
    alt: string
  }>
  status: 'ok'
  message: 'Success'
  embed_url: string
  download_url: string
  title: string
  poster: string
  filmstrip: string
  sources: readonly MediaSource[]
  tracks: readonly MediaTrack[]
}>

export function createSourceResponse(
  config: AppConfig,
  security: Security,
  queryToken: string,
  media: PlayerMediaQuery,
  result: MediaResult,
  playerSettings: PlayerSettings,
  requestContext: SourceApiRequestContext,
  providerContexts: ProviderStreamContextRegistry | undefined,
  deliveryBaseUrl: URL
): PublicSourceResponse {
  const canonicalToken = queryToken.length > 0
    ? queryToken
    : security.encryptURL(buildPlayerQuery(media))
  const upstream = result.upstream ?? Object.freeze({
    host: media.host ?? 'direct',
    id: media.id ?? '',
    userAgent: requestContext.userAgent,
    language: requestContext.language
  })
  const title = result.title.length > 0 ? result.title : titleFromMedia(media)
  const configuredPoster = playerSettings.poster
  const posterSource = playerSettings.force_default_poster && configuredPoster.length > 0
    ? configuredPoster
    : media.poster || result.image || configuredPoster
  const providerTrackFiles = new Set(result.tracks.flatMap((track) => typeof track.file === 'string' ? [track.file] : []))
  const queryTracks = mediaSubtitleTracks(media).filter((track) => !providerTrackFiles.has(String(track.file ?? '')))
  const contextToken = providerContexts?.register({
    host: upstream.host,
    targets: [
      ...result.sources.flatMap(sourceTargets),
      ...result.tracks.flatMap(sourceTargets),
      ...sourceTargets({ file: result.image }),
      ...sourceTargets({ file: result.filmstrip })
    ],
    referer: result.referer,
    cookies: result.cookies,
    userAgent: upstream.userAgent,
    language: upstream.language
  }) ?? undefined
  const accessToken = createStreamingAccessToken(requestContext.clientIp, security)
  const identity: StreamingIdentity = {
    host: upstream.host,
    id: upstream.id,
    ...(contextToken === undefined ? {} : { contextToken }),
    ...(accessToken === undefined ? {} : { accessToken }),
    ...(requestContext.downloadable ? { downloadable: true } : {})
  }
  const poster = proxyPoster(
    posterSource,
    security,
    deliveryBaseUrl,
    posterSource !== '' && posterSource === result.image ? contextToken : undefined
  )

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
    filmstrip: playerSettings.disable_filmstrip ? '' : proxyFilmstrip(result.filmstrip, security, deliveryBaseUrl, contextToken),
    sources: result.sources.flatMap((source) => proxySource(source, security, identity, config.baseUrl, deliveryBaseUrl)),
    tracks: [
      ...result.tracks.flatMap((track) => proxyTrack(track, security, deliveryBaseUrl, contextToken)),
      ...queryTracks.flatMap((track) => proxyTrack(track, security, deliveryBaseUrl))
    ]
  }
}

function mediaSubtitleTracks(media: PlayerMediaQuery): readonly MediaTrack[] {
  const subtitles = [...(media.sub ?? []), ...(media.subs === undefined ? [] : [media.subs])]
  return Object.freeze(subtitles.map((file, index) => Object.freeze({
    file,
    kind: 'captions',
    label: media.lang?.[index]?.trim() || `Subtitle ${index + 1}`
  })))
}

function sourceTargets(source: MediaSource): URL[] {
  if (typeof source.file !== 'string') return []
  try {
    const target = new URL(source.file)
    return target.protocol === 'http:' || target.protocol === 'https:' ? [target] : []
  } catch {
    return []
  }
}

export async function selectedDeliveryBaseUrl(
  config: AppConfig,
  selector: DeliveryBaseUrlSelector | undefined,
  input: Parameters<DeliveryBaseUrlSelector>[0]
): Promise<URL> {
  if (selector === undefined) return new URL(config.baseUrl)
  try {
    const selected = new URL(await selector(input))
    if ((selected.protocol !== 'http:' && selected.protocol !== 'https:') || selected.username !== '' || selected.password !== '') return new URL(config.baseUrl)
    if (selected.hostname === '' || selected.search !== '' || selected.hash !== '') return new URL(config.baseUrl)
    selected.pathname = `${selected.pathname.replace(/\/+$/, '')}/`
    return selected
  } catch {
    return new URL(config.baseUrl)
  }
}

function proxySource(
  source: MediaSource,
  security: Security,
  identity: StreamingIdentity,
  applicationBaseUrl: URL,
  deliveryBaseUrl: URL
): readonly MediaSource[] {
  const file = typeof source.file === 'string' ? source.file : ''
  if (file.length === 0) return []
  const { proxy: _proxy, ...publicSource } = source
  let target: URL
  try {
    target = new URL(file)
  } catch {
    return [publicSource]
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return []
  if (source.proxy === false && target.origin === applicationBaseUrl.origin && target.pathname.startsWith('/gdrive-media/')) {
    return [publicSource]
  }

  const route = streamingRoute(source, target)
  const label = typeof source.label === 'string' ? source.label : 'Original'
  const proxyPath = createStreamingProxyPath(route, target, security, { ...identity, label })
  return [{ ...publicSource, file: new URL(proxyPath, deliveryBaseUrl).toString() }]
}

function proxyTrack(track: MediaTrack, security: Security, baseUrl: URL, contextToken?: string): readonly MediaTrack[] {
  const file = typeof track.file === 'string' ? track.file : ''
  if (file.length === 0) return []
  const proxied = createMediaProxyPath('subtitle', file, security, contextToken)
  return proxied === null ? [track] : [{ ...track, file: new URL(proxied, baseUrl).toString() }]
}

function proxyPoster(value: string, security: Security, baseUrl: URL, contextToken?: string): string {
  if (value.length === 0) return ''
  const proxied = createMediaProxyPath('poster', value, security, contextToken)
  return proxied === null ? value : new URL(proxied, baseUrl).toString()
}

function proxyFilmstrip(value: string, security: Security, baseUrl: URL, contextToken?: string): string {
  if (value.length === 0) return ''
  const proxied = createMediaProxyPath('filmstrip', value, security, contextToken)
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
  return [...new Set([
    media.host,
    media.ahost,
    ...(media.alternatives ?? []).map((item) => item.host)
  ].filter((host): host is string => host !== undefined && host.length > 0))]
}

function absolutePlayerUrl(config: AppConfig, slug: string, token: string): string {
  return new URL(`/${slug.replace(/^\/+|\/+$/g, '')}/?${token}`, config.baseUrl).toString()
}

function titleFromMedia(media: PlayerMediaQuery): string {
  if (media.title?.trim()) return media.title.trim()
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
