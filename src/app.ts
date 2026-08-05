import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import formbody from '@fastify/formbody'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { createAuthRuntime } from './auth/auth-runtime.js'
import type { AuthService } from './auth/auth-service.js'
import type { SessionAdminService } from './auth/session-admin-service.js'
import type { UserAdminService } from './auth/user-admin-service.js'
import { loadConfig, type AppConfig } from './config.js'
import { ExtractorFactory } from './hosting/extractor-factory.js'
import { registerAdminRoutes } from './http/admin-routes.js'
import { registerAdminSettingsRoutes } from './http/admin-settings-routes.js'
import { registerMediaRoutes } from './http/media-routes.js'
import { registerPlayerRoutes } from './http/player-routes.js'
import { createSourceApiRuntime } from './http/source-api-runtime.js'
import type { SettingsAdminService } from './settings/settings-admin-service.js'
import { FileSystemSiteAssetManager, type SiteAssetManager } from './settings/site-assets-service.js'
import { FileSystemVastAssetManager, type VastAssetManager } from './settings/vast-assets-service.js'
import { registerSourceApiRoutes, type SourceApiRouteOptions } from './http/source-api-routes.js'
import { registerStreamingRoutes } from './http/streaming-routes.js'
import { applyPublicPageHeaders, registerSystemRoutes } from './http/system-routes.js'
import { publicErrors, renderPublicError } from './player/public-page.js'
import { createCountryCodeLookup, type CountryCodeLookup } from './security/geoip-country.js'
import type { MiscSettingsLoader } from './settings/misc-runtime.js'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))

export type AppDependencies = Readonly<{
  sourceApi?: SourceApiRouteOptions
  auth?: AuthService
  sessions?: SessionAdminService
  users?: UserAdminService
  settings?: SettingsAdminService
  siteAssets?: SiteAssetManager
  vastAssets?: VastAssetManager
  countryCodeLookup?: CountryCodeLookup
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

  await app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
    exposedHeaders: ['content-length', 'content-range', 'accept-ranges']
  })

  await app.register(formbody)
  await app.register(multipart, {
    limits: { fieldNameSize: 100, fieldSize: 10_000, fields: 16, fileSize: 5_242_880, files: 1, parts: 17 }
  })
  await app.register(cookie)

  const authRuntime = createAuthRuntime(app, config)
  const settingsRuntime = dependencies.settings ?? authRuntime.settings
  const publicRoot = path.resolve(currentDirectory, '../public')
  const sourceApiRuntime = dependencies.sourceApi ?? createSourceApiRuntime(app, config)
  const supportedHosts = sourceApiRuntime.supportedHosts ?? new Set(new ExtractorFactory().supportedHosts())
  const loadMiscSettings: MiscSettingsLoader = async () => await settingsRuntime.miscSettings(supportedHosts)
  const countryCodeLookup = dependencies.countryCodeLookup ?? createCountryCodeLookup(
    path.resolve(currentDirectory, '../resources/data/geoip/GeoLite2-Country.mmdb')
  )

  await registerSystemRoutes(app, config)
  await registerAdminRoutes(
    app,
    config,
    dependencies.auth ?? authRuntime.auth,
    dependencies.sessions ?? authRuntime.sessions,
    dependencies.users ?? authRuntime.users
  )
  await registerAdminSettingsRoutes(
    app,
    config,
    dependencies.auth ?? authRuntime.auth,
    settingsRuntime,
    dependencies.users ?? authRuntime.users,
    dependencies.siteAssets ?? new FileSystemSiteAssetManager(publicRoot, config.adminDirectory),
    dependencies.vastAssets ?? new FileSystemVastAssetManager(path.join(publicRoot, 'uploads'), config.baseUrl),
    supportedHosts
  )
  const loadAdsSettings = async () => await settingsRuntime.adsSettings()
  const loadPlayerSettings = async () => await settingsRuntime.playerSettings({ ...config.slugs, adminDirectory: config.adminDirectory })
  await registerPlayerRoutes(app, config, { loadAdsSettings, loadPlayerSettings, loadMiscSettings, countryCodeLookup, supportedHosts })
  await registerSourceApiRoutes(app, config, {
    ...sourceApiRuntime,
    loadAdsSettings,
    loadPlayerSettings,
    loadMiscSettings,
    countryCodeLookup,
    supportedHosts
  })
  await registerMediaRoutes(app, config)
  await registerStreamingRoutes(app, config, {
    customHeaders: async (target) => await settingsRuntime.customHeadersForUrl(target)
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
    wildcard: false
  })

  app.setNotFoundHandler(async (_request, reply) => {
    applyPublicPageHeaders(reply, true)
    reply.code(404).type('text/html; charset=utf-8')
    return renderPublicError(publicErrors[404])
  })

  return app
}
