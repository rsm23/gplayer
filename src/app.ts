import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cookie from '@fastify/cookie'
import formbody from '@fastify/formbody'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { createAuthRuntime } from './auth/auth-runtime.js'
import { AUTH_COOKIE_NAME, authTokenFromRequest, type AuthService, type AuthUser } from './auth/auth-service.js'
import type { SessionAdminService } from './auth/session-admin-service.js'
import type { UserAdminService } from './auth/user-admin-service.js'
import { AccountLifecycleService, type AccountSettingsLoader } from './auth/account-lifecycle-service.js'
import { loadConfig, type AppConfig } from './config.js'
import { ExtractorFactory } from './hosting/extractor-factory.js'
import { registerAdminRoutes } from './http/admin-routes.js'
import { registerAccountRoutes } from './http/account-routes.js'
import { registerAdminSettingsRoutes } from './http/admin-settings-routes.js'
import { registerSubtitleAdminRoutes } from './http/subtitle-admin-routes.js'
import { registerVideoAdminRoutes } from './http/video-admin-routes.js'
import { registerDriveAdminRoutes } from './http/drive-admin-routes.js'
import { registerDriveMediaRoutes } from './http/drive-media-routes.js'
import { registerMediaRoutes } from './http/media-routes.js'
import { registerPlayerRoutes } from './http/player-routes.js'
import { createSourceApiRuntime } from './http/source-api-runtime.js'
import { DEFAULT_ACCOUNT_LIFECYCLE_SETTINGS, type SettingsAdminService } from './settings/settings-admin-service.js'
import { FileSystemSiteAssetManager, type SiteAssetManager } from './settings/site-assets-service.js'
import { FileSystemVastAssetManager, type VastAssetManager } from './settings/vast-assets-service.js'
import { registerSourceApiRoutes, type SourceApiRouteOptions } from './http/source-api-routes.js'
import { registerStreamingRoutes } from './http/streaming-routes.js'
import { registerLoadBalancerAdminRoutes } from './http/load-balancer-admin-routes.js'
import { registerPluginAdminRoutes } from './http/plugin-admin-routes.js'
import { registerPluginExtensionRoutes } from './http/plugin-extension-routes.js'
import { applyPublicPageHeaders, registerSystemRoutes } from './http/system-routes.js'
import { publicErrors, renderPublicError } from './player/public-page.js'
import { createCountryCodeLookup, type CountryCodeLookup } from './security/geoip-country.js'
import { ShortlinkService, type ShortlinkTransformer } from './shortlinks/shortlink-service.js'
import type { MiscSettingsLoader } from './settings/misc-runtime.js'
import { miscHostOptions } from './settings/misc-settings.js'
import type { HostingSettingsLoader } from './settings/hosting-runtime.js'
import { legacyHostingHosts } from './settings/hosting-settings.js'
import { SubtitleAdminService } from './subtitles/subtitle-admin-service.js'
import { FileSystemSubtitleAssetManager } from './subtitles/subtitle-assets-service.js'
import { SubsceneSubtitleImporter, type SubtitleUrlImporter } from './subtitles/subscene-ingest-service.js'
import { VideoAdminService } from './videos/video-admin-service.js'
import { FileSystemVideoPosterAssetManager } from './videos/video-assets-service.js'
import { VideoCheckerService } from './videos/video-checker-service.js'
import { VideoBulkService } from './videos/video-bulk-service.js'
import { VideoTransferService } from './videos/video-transfer-service.js'
import { DriveSharerService, RecaptchaVerifier } from './drive/drive-sharer-service.js'
import type { DriveAccountAdminService } from './drive/drive-account-admin-service.js'
import { DriveAdminService, DriveApiClient } from './drive/drive-admin-service.js'
import { DriveMediaService } from './drive/drive-media-service.js'
import { DriveBackgroundCoordinator, DriveBackgroundWorker } from './drive/drive-background-worker.js'
import { Security } from './security/security.js'
import { RemoteProviderHttpClient } from './hosting/provider-http.js'
import { StatsWorker } from './background/stats-worker.js'
import { createGeoIpDetailsLookup } from './security/geoip-details.js'
import { GeneralWorker } from './background/general-worker.js'
import { RemoteLoadBalancerHealthProbe } from './background/load-balancer-health-probe.js'
import { FixedFreeProxySource, NodeProxyProbe } from './background/proxy-network.js'
import { ProxyMaintenanceWorker } from './background/proxy-maintenance-worker.js'
import { SourceRefreshWorker } from './background/source-refresh-worker.js'
import { MediaDownloadWorker } from './background/media-download-worker.js'
import { RemoteStream } from './stream/remote-stream.js'
import { ProviderStreamContextRegistry } from './stream/provider-stream-context.js'
import { readFile, statfs } from 'node:fs/promises'
import { PluginBackgroundManager } from './plugins/plugin-background-manager.js'
import { PluginMaintenanceWorker } from './plugins/plugin-maintenance-worker.js'
import { PluginSyncClient } from './plugins/plugin-sync-client.js'
import { SystemActiveConnectionCounter } from './background/active-connections.js'
import { LoadBalancerAdminService } from './load-balancers/load-balancer-admin-service.js'
import { LoadBalancerSelector } from './load-balancers/load-balancer-selector.js'
import { PluginAdminService } from './plugins/plugin-admin-service.js'
import { PluginExtensionRuntime } from './plugins/plugin-extension-runtime.js'
import { NodemailerAccountMailer, type AccountMailer } from './email/smtp-mailer.js'
import { LogAdminService } from './logs/log-admin-service.js'
import { DashboardAdminService, EMPTY_DASHBOARD_ADMIN_STORE } from './dashboard/dashboard-admin-service.js'
import { NodeSystemInspector } from './system/system-inspector.js'
import { FileSystemPrivateCacheManager } from './system/private-cache-manager.js'
import { PrivateAdminService } from './system/private-admin-service.js'
import { registerPrivateAdminRoutes } from './http/private-admin-routes.js'
import { FileSystemSettingsMaintenanceFiles } from './settings/settings-maintenance-files.js'
import { SettingsMaintenanceService } from './settings/settings-maintenance-service.js'
import { registerBootstrapCompatibility, sendLegacyHeadFallback } from './http/bootstrap-compatibility.js'
import { ViewCounterService } from './stats/view-counter-service.js'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))

export type AppDependencies = Readonly<{
  sourceApi?: SourceApiRouteOptions
  auth?: AuthService
  sessions?: SessionAdminService
  users?: UserAdminService
  accounts?: AccountLifecycleService
  accountMailer?: AccountMailer
  accountSettings?: AccountSettingsLoader
  settings?: SettingsAdminService
  siteAssets?: SiteAssetManager
  vastAssets?: VastAssetManager
  subtitles?: SubtitleAdminService
  subtitleUrlImporter?: SubtitleUrlImporter
  videos?: VideoAdminService
  videoBulk?: VideoBulkService
  videoChecker?: VideoCheckerService
  videoTransfer?: VideoTransferService
  countryCodeLookup?: CountryCodeLookup
  shortlinks?: ShortlinkTransformer
  driveSharer?: Pick<DriveSharerService, 'bypass'>
  driveAccounts?: DriveAccountAdminService
  driveAdmin?: DriveAdminService
  driveMedia?: DriveMediaService
  driveBackground?: Pick<DriveBackgroundCoordinator, 'trigger'>
  statsWorker?: StatsWorker
  viewCounter?: Pick<ViewCounterService, 'capture'>
  generalWorker?: GeneralWorker
  sourceRefreshWorker?: SourceRefreshWorker
  mediaDownloadWorker?: MediaDownloadWorker
  recaptchaVerifier?: Pick<RecaptchaVerifier, 'verify'>
  clearRuntimeCache?: () => boolean | Promise<boolean>
  loadBalancers?: LoadBalancerAdminService
  plugins?: PluginAdminService
  pluginExtensions?: PluginExtensionRuntime
  logs?: LogAdminService
  dashboard?: DashboardAdminService
  privateAdmin?: PrivateAdminService
  settingsMaintenance?: SettingsMaintenanceService
}>

export async function buildApp(
  config: AppConfig = loadConfig(),
  dependencies: AppDependencies = {}
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.nodeEnv !== 'test',
    trustProxy: typeof config.trustProxy === 'boolean' ? config.trustProxy : [...config.trustProxy],
    requestIdHeader: 'x-request-id'
  })

  registerBootstrapCompatibility(app)

  await app.register(formbody)
  await app.register(multipart, {
    limits: { fieldNameSize: 100, fieldSize: 100_000, fields: 80, fileSize: 5_242_880, files: 24, parts: 104 }
  })
  await app.register(cookie)

  const authRuntime = createAuthRuntime(app, config)
  const authService = dependencies.auth ?? authRuntime.auth
  const settingsRuntime = dependencies.settings ?? authRuntime.settings
  const publicRoot = path.resolve(currentDirectory, '../public')
  const landingHtml = await readFile(path.join(publicRoot, 'index.html'), 'utf8')
  const cacheRoot = path.resolve(currentDirectory, '../cache')
  const subtitleAssets = new FileSystemSubtitleAssetManager(path.join(publicRoot, 'uploads/subtitles'), config.baseUrl)
  const subtitlesRuntime = dependencies.subtitles ?? new SubtitleAdminService(
    authRuntime.subtitleStore,
    subtitleAssets,
    config.baseUrl
  )
  const subtitleUrlImporter = dependencies.subtitleUrlImporter ?? new SubsceneSubtitleImporter(subtitleAssets)
  const videosRuntime = dependencies.videos ?? new VideoAdminService(
    authRuntime.videoStore,
    new FileSystemVideoPosterAssetManager(path.join(publicRoot, 'uploads/images'), config.baseUrl),
    config.baseUrl,
    { embedSlug: config.slugs.embed, downloadSlug: config.slugs.download }
  )
  const videoTransferRuntime = dependencies.videoTransfer ?? new VideoTransferService(videosRuntime, config.baseUrl)
  const driveHttp = new RemoteProviderHttpClient()
  const recaptchaVerifier = dependencies.recaptchaVerifier ?? new RecaptchaVerifier(driveHttp)
  const driveApi = new DriveApiClient(authRuntime.driveAdminStore, driveHttp)
  const driveMediaRuntime = dependencies.driveMedia ?? new DriveMediaService(
    authRuntime.driveAdminStore,
    driveApi,
    new Security(config.secureSalt),
    config.baseUrl
  )
  const loadDriveSettings = async () => {
    const settings = await settingsRuntime.general(config.baseUrl)
    return Object.freeze({ copy: settings.gdrive_copy === true, copyAll: settings.gdrive_copy_all === true })
  }
  const loadGeneralSettings = async () => await settingsRuntime.general(config.baseUrl)
  const geoIpDetailsLookup = createGeoIpDetailsLookup(
    path.resolve(currentDirectory, '../resources/data/geoip/GeoLite2-Country.mmdb'),
    path.resolve(currentDirectory, '../resources/data/geoip/GeoLite2-ASN.mmdb')
  )
  const defaultLoadBalancerSelector = dependencies.sourceApi === undefined
    ? new LoadBalancerSelector(authRuntime.loadBalancerSelectionStore, geoIpDetailsLookup, config.baseUrl)
    : undefined
  const statsWorkerRuntime = dependencies.statsWorker ?? new StatsWorker(authRuntime.statsWorkerStore, geoIpDetailsLookup)
  const viewCounterRuntime = dependencies.viewCounter ?? new ViewCounterService(authRuntime.viewCounterStore, geoIpDetailsLookup)
  const pluginsRoot = path.resolve(currentDirectory, '../plugins')
  const pluginBackgrounds = new PluginBackgroundManager(pluginsRoot)
  app.addHook('onClose', async () => await pluginBackgrounds.close())
  const pluginAdminRuntime = dependencies.plugins ?? new PluginAdminService(authRuntime.pluginAdminStore, pluginsRoot, pluginBackgrounds)
  const pluginExtensionRuntime = dependencies.pluginExtensions ?? new PluginExtensionRuntime(pluginAdminRuntime.extensionStore(), pluginsRoot)
  const pluginMaintenance = new PluginMaintenanceWorker(
    authRuntime.pluginMaintenanceStore,
    new PluginSyncClient(new RemoteStream(), config.adminDirectory, config.secureSalt),
    pluginBackgrounds,
    pluginsRoot,
    async () => {
      const general = await settingsRuntime.general(config.baseUrl)
      const mainSite = new URL(String(general.main_site))
      return Object.freeze({ loadBalancer: mainSite.toString() !== config.baseUrl.toString(), mainSite })
    }
  )
  const generalWorkerRuntime = dependencies.generalWorker ?? new GeneralWorker(authRuntime.generalWorkerStore, {
    baseUrl: config.baseUrl,
    cacheRoot: path.resolve(currentDirectory, '../cache'),
    temporaryRoot: path.resolve(currentDirectory, '../tmp'),
    uploadsRoot: path.join(publicRoot, 'uploads'),
    healthProbe: new RemoteLoadBalancerHealthProbe(),
    proxyMaintenance: new ProxyMaintenanceWorker(
      authRuntime.proxyMaintenanceStore,
      new FixedFreeProxySource(),
      new NodeProxyProbe()
    ),
    pluginMaintenance,
    activeConnectionCounter: new SystemActiveConnectionCounter(),
    loadCacheMaxAge: async () => {
      const settings = await settingsRuntime.general(config.baseUrl)
      const configured = Number(settings.cache_file_timeout)
      return Number.isSafeInteger(configured) && configured >= 0 ? configured : 10_800
    }
  })
  let supportedHosts = new Set(new ExtractorFactory().supportedHosts()) as ReadonlySet<string>
  const hostingHosts = legacyHostingHosts()
  const loadHostingSettings: HostingSettingsLoader = async () => await settingsRuntime.runtimeHostingSettings(hostingHosts)
  const sourceApiRuntime = dependencies.sourceApi ?? createSourceApiRuntime(app, config, {
    loadHostingSettings,
    loadGeneralSettings,
    gdrive: { privateSources: driveMediaRuntime, loadSettings: loadDriveSettings }
  })
  const providerStreamContexts = sourceApiRuntime.providerContexts ?? new ProviderStreamContextRegistry()
  supportedHosts = sourceApiRuntime.supportedHosts ?? supportedHosts
  const sourceRefreshRuntime = dependencies.sourceRefreshWorker ?? new SourceRefreshWorker(
    authRuntime.sourceRefreshStore,
    sourceApiRuntime.resolve
  )
  const mediaDownloadRuntime = dependencies.mediaDownloadWorker ?? new MediaDownloadWorker(
    authRuntime.mediaDownloadStore,
    new RemoteStream(),
    {
      baseUrl: config.baseUrl,
      cacheRoot,
      bufferSize: config.bufferSize,
      maxDownloadSpeed: config.maxDownloadSpeed,
      freeSpace: async (target) => {
        const details = await statfs(path.dirname(target))
        return Number(details.bavail) * Number(details.bsize)
      },
      loadSettings: async () => {
        const [general, misc] = await Promise.all([
          settingsRuntime.general(config.baseUrl),
          settingsRuntime.miscSettings(supportedHosts)
        ])
        return Object.freeze({
          enabled: general.enable_cache_file === true && general.enable_bg_download === true,
          bypassHosts: misc.bypass_host
        })
      }
    }
  )
  const driveBackgroundRuntime = dependencies.driveBackground ?? new DriveBackgroundCoordinator(
    new DriveBackgroundWorker(authRuntime.driveAdminStore, driveApi),
    loadDriveSettings,
    {
      stats: statsWorkerRuntime,
      general: generalWorkerRuntime,
      sourceRefresh: sourceRefreshRuntime,
      mediaDownload: mediaDownloadRuntime
    }
  )
  const videoBulkRuntime = dependencies.videoBulk ?? new VideoBulkService(videosRuntime, sourceApiRuntime.resolve)
  const videoCheckerRuntime = dependencies.videoChecker ?? new VideoCheckerService(videosRuntime, sourceApiRuntime.resolve)
  const loadMiscSettings: MiscSettingsLoader = async () => await settingsRuntime.miscSettings(supportedHosts)
  const countryCodeLookup = dependencies.countryCodeLookup ?? createCountryCodeLookup(
    path.resolve(currentDirectory, '../resources/data/geoip/GeoLite2-Country.mmdb')
  )
  const loadPlayerSettings = async () => await settingsRuntime.playerSettings({ ...config.slugs, adminDirectory: config.adminDirectory })
  const loadPublicSettings = async () => await settingsRuntime.runtimePublicSettings()
  const shortlinkRuntime = dependencies.shortlinks ?? new ShortlinkService(
    async () => await settingsRuntime.runtimeShortlinkSettings()
  )
  const loadImportFileSize = async (): Promise<number> => {
    const settings = await settingsRuntime.general(config.baseUrl)
    const configured = Number(settings.import_filesize)
    return Number.isSafeInteger(configured) && configured > 0 ? configured : 1024
  }

  const clearRuntimeCache = dependencies.clearRuntimeCache ?? (() => {
    settingsRuntime.clearRuntimeCaches()
    return true
  })
  const privateAdminRuntime = dependencies.privateAdmin ?? new PrivateAdminService(
    authRuntime.privateAdminStore,
    new NodeSystemInspector(path.resolve(currentDirectory, '..')),
    new FileSystemPrivateCacheManager(cacheRoot),
    {
      baseUrl: config.baseUrl,
      loadMainSite: async () => new URL(String((await settingsRuntime.general(config.baseUrl)).main_site)),
      clearRuntimeCache
    }
  )
  const settingsMaintenanceRuntime = dependencies.settingsMaintenance ?? new SettingsMaintenanceService(
    authRuntime.settingsMaintenanceStore,
    new FileSystemSettingsMaintenanceFiles({
      temporaryRoot: path.resolve(currentDirectory, '../tmp'),
      cacheRoot,
      uploadsRoot: path.join(publicRoot, 'uploads')
    }),
    undefined,
    {
      clearRuntimeCache,
      loadBlacklist: async () => (await settingsRuntime.miscSettings(supportedHosts)).word_blacklisted,
      supportedHosts
    }
  )
  const authenticateRequest = async (request: FastifyRequest): Promise<AuthUser | null> => {
    const token = authTokenFromRequest({
      authorization: request.headers.authorization,
      cookie: request.cookies[AUTH_COOKIE_NAME]
    })
    return await authService.authenticate(token, request.headers['user-agent'] ?? '')
  }
  const isAuthenticated = async (request: FastifyRequest): Promise<boolean> => (await authenticateRequest(request))?.status === 1
  const isAdmin = async (request: FastifyRequest): Promise<boolean> => {
    const user = await authenticateRequest(request)
    return user !== null && user.status === 1 && user.role === 0
  }
  await registerPluginExtensionRoutes(app, config, authService, pluginExtensionRuntime)
  await registerSystemRoutes(app, config, authService, clearRuntimeCache, {
    loadPublicSettings,
    isAuthenticated,
    background: driveBackgroundRuntime,
    landingHtml
  })
  await registerPrivateAdminRoutes(app, config, authService, privateAdminRuntime)
  const loadAccountSettings: AccountSettingsLoader = dependencies.accountSettings ?? (
    config.nodeEnv === 'test'
      ? async () => DEFAULT_ACCOUNT_LIFECYCLE_SETTINGS
      : async () => await settingsRuntime.accountLifecycleSettings()
  )
  const accountRuntime = dependencies.accounts ?? new AccountLifecycleService(
    authRuntime.accountLifecycleStore,
    new Security(config.secureSalt),
    dependencies.accountMailer ?? new NodemailerAccountMailer(),
    loadAccountSettings,
    {
      registerUrl: new URL(`/${config.adminDirectory}/register/`, config.baseUrl),
      resetPasswordUrl: new URL(`/${config.adminDirectory}/reset-password/`, config.baseUrl)
    }
  )
  const dashboardRuntime = dependencies.dashboard ?? new DashboardAdminService(
    config.nodeEnv === 'test' ? EMPTY_DASHBOARD_ADMIN_STORE : authRuntime.dashboardStore,
    config.baseUrl,
    config.slugs
  )
  await registerAdminRoutes(
    app,
    config,
    authService,
    dependencies.sessions ?? authRuntime.sessions,
    dependencies.users ?? authRuntime.users,
    dependencies.logs ?? new LogAdminService(path.resolve(currentDirectory, '../tmp/logs')),
    dashboardRuntime,
    async () => (await loadAccountSettings()).enableRegistration,
    async () => config.nodeEnv === 'test' ? 'UTC' : String((await settingsRuntime.general(config.baseUrl)).timezone),
    async () => await privateAdminRuntime.systemStatus()
  )
  await registerAccountRoutes(app, config, authService, accountRuntime, {
    verifyRecaptcha: async (secret, responseToken, remoteIp) => await recaptchaVerifier.verify(secret, responseToken, remoteIp)
  })
  await registerAdminSettingsRoutes(
    app,
    config,
    authService,
    settingsRuntime,
    dependencies.users ?? authRuntime.users,
    dependencies.siteAssets ?? new FileSystemSiteAssetManager(publicRoot, config.adminDirectory),
    dependencies.vastAssets ?? new FileSystemVastAssetManager(path.join(publicRoot, 'uploads'), config.baseUrl),
    settingsMaintenanceRuntime,
    supportedHosts,
    hostingHosts
  )
  await registerSubtitleAdminRoutes(
    app,
    config,
    authService,
    subtitlesRuntime
  )
  const driveAdminRuntime = dependencies.driveAdmin ?? new DriveAdminService(
    authRuntime.driveAdminStore,
    driveApi,
    new Security(config.secureSalt),
    videosRuntime,
    {
      baseUrl: config.baseUrl,
      embedSlug: config.slugs.embed,
      downloadSlug: config.slugs.download,
      requestSlug: config.slugs.request
    }
  )
  await registerDriveAdminRoutes(
    app,
    config,
    authService,
    dependencies.driveAccounts ?? authRuntime.driveAccounts,
    driveAdminRuntime
  )
  const loadBalancerRuntime = dependencies.loadBalancers ?? new LoadBalancerAdminService(authRuntime.loadBalancerAdminStore, {
    hosts: supportedHosts,
    mainSite: async () => new URL(String((await settingsRuntime.general(config.baseUrl)).main_site))
  })
  await registerLoadBalancerAdminRoutes(app, config, authService, loadBalancerRuntime, miscHostOptions(supportedHosts))
  await registerPluginAdminRoutes(app, config, authService, pluginAdminRuntime)
  await registerVideoAdminRoutes(
    app,
    config,
    authService,
    videosRuntime,
    videoTransferRuntime,
    subtitlesRuntime,
    videoBulkRuntime,
    videoCheckerRuntime,
    loadPlayerSettings,
    loadImportFileSize,
    pluginExtensionRuntime,
    subtitleUrlImporter
  )
  const loadAdsSettings = async () => await settingsRuntime.adsSettings()
  const driveSharer = dependencies.driveSharer ?? new DriveSharerService(authRuntime.driveStore, driveHttp)
  const selectDeliveryBaseUrl = sourceApiRuntime.selectDeliveryBaseUrl ?? (defaultLoadBalancerSelector === undefined
    ? undefined
    : async (input: Parameters<NonNullable<SourceApiRouteOptions['selectDeliveryBaseUrl']>>[0]) => await defaultLoadBalancerSelector.select(input))
  await registerPlayerRoutes(app, config, {
    loadAdsSettings,
    loadPlayerSettings,
    loadPublicSettings,
    loadGeneralSettings,
    loadMiscSettings,
    loadHostingSettings,
    countryCodeLookup,
    supportedHosts,
    resolveSavedVideo: async (idOrSlug) => await videosRuntime.savedQuery(idOrSlug),
    shortenUrl: async (target) => await shortlinkRuntime.shorten(target),
    isAuthenticated,
    isAdmin,
    bypassDrive: async (input) => await driveSharer.bypass(input),
    verifyRecaptcha: async (responseToken, remoteIp) => {
      const general = await settingsRuntime.general(config.baseUrl)
      return await recaptchaVerifier.verify(String(general.recaptcha_secret_key), responseToken, remoteIp)
    },
    loadRecaptchaSiteKey: async () => {
      const general = await settingsRuntime.general(config.baseUrl)
      return String(general.recaptcha_site_key)
    },
    capturePublicVideo: async (media, ownerId) => await videosRuntime.capturePublicVideo(media, ownerId),
    captureView: async (input) => await viewCounterRuntime.capture(input),
    resolvePlayback: sourceApiRuntime.resolve,
    providerContexts: providerStreamContexts,
    ...(selectDeliveryBaseUrl === undefined ? {} : { selectDeliveryBaseUrl })
  })
  await registerSourceApiRoutes(app, config, {
    ...sourceApiRuntime,
    providerContexts: providerStreamContexts,
    loadAdsSettings,
    loadPlayerSettings,
    loadMiscSettings,
    loadGeneralSettings,
    countryCodeLookup,
    supportedHosts,
    ...(selectDeliveryBaseUrl === undefined ? {} : { selectDeliveryBaseUrl }),
    resolveSavedVideo: async (idOrSlug) => await videosRuntime.savedQuery(idOrSlug),
    capturePublicVideo: async (media, result) => {
      const settings = await loadPublicSettings()
      if (settings.save_public_video && settings.public_video_user !== '') {
        await videosRuntime.capturePublicVideo(media, settings.public_video_user, result)
      }
    },
    filterResponse: async (response, query) => {
      const base = sourceApiRuntime.filterResponse === undefined ? response : await sourceApiRuntime.filterResponse(response, query)
      return await pluginExtensionRuntime.filterApiResponse(base, query).catch(() => base)
    }
  })
  await registerDriveMediaRoutes(app, driveMediaRuntime)
  await registerMediaRoutes(app, config, { publicRoot, providerContexts: providerStreamContexts })
  await registerStreamingRoutes(app, config, {
    providerContexts: providerStreamContexts,
    customHeaders: async (target) => await settingsRuntime.customHeadersForUrl(target),
    cacheRoot,
    loadCacheSettings: async () => {
      const general = await settingsRuntime.general(config.baseUrl)
      return Object.freeze({
        enabled: general.enable_cache_file === true,
        maxAgeSeconds: Number(general.cache_file_timeout),
        mode: general.cache_mode as 'php' | 'apache' | 'litespeed' | 'nginx'
      })
    },
    maximumBytesPerSecond: config.maxDownloadSpeed
  })

  await app.register(fastifyStatic, {
    root: path.join(publicRoot, 'uploads'),
    prefix: '/uploads/',
    decorateReply: false,
    wildcard: true,
    dotfiles: 'deny',
    setHeaders: (response) => {
      response.header('cache-control', 'public, max-age=300')
      response.header('content-security-policy', "default-src 'none'; sandbox")
      response.header('x-content-type-options', 'nosniff')
    }
  })

  await app.register(fastifyStatic, {
    root: publicRoot,
    prefix: '/',
    decorateReply: false,
    wildcard: false,
    index: false
  })

  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === 'HEAD') return sendLegacyHeadFallback(request, reply)
    const contactUrl = await loadPublicSettings().then((settings) => settings.contact_page_link).catch(() => '')
    applyPublicPageHeaders(reply, true)
    reply.code(404).type('text/html; charset=utf-8')
    return renderPublicError(publicErrors[404], contactUrl === '' ? {} : { contactUrl })
  })

  return app
}
