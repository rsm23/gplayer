import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.js'
import { emptyMediaResult, SourceResolver } from '../core/source-resolver.js'
import { Database } from '../database/database.js'
import { MySqlSourceCacheRepository } from '../database/source-cache-repository.js'
import { ExtractorFactory } from '../hosting/extractor-factory.js'
import { RemoteProviderHttpClient, RuntimeProxyProviderHttpClient } from '../hosting/provider-http.js'
import { ProviderCookieHttpClient, type HostingSettingsLoader } from '../settings/hosting-runtime.js'
import type { SourceApiResolver, SourceApiRouteOptions } from './source-api-routes.js'
import type { DrivePrivateSourceResolver, DriveRuntimeSettingsLoader } from '../drive/drive-media-service.js'
import { MySqlMediaDownloadStore } from '../background/mysql-media-download-store.js'
import { playerMediaCandidates } from '../core/player-query.js'
import { loadRuntimeGeneralSettings, type GeneralSettingsLoader } from '../settings/general-runtime.js'
import type { GeneralSettings } from '../settings/settings-admin-service.js'
import type { RuntimeProxySettings } from '../settings/misc-settings.js'
import { createYoutubeProxyFetch } from '../hosting/youtube.js'

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const DEFAULT_LANGUAGE = 'en;q=0.9'

export function createSourceApiRuntime(
  app: FastifyInstance,
  config: AppConfig,
  options: Readonly<{
    loadHostingSettings?: HostingSettingsLoader
    loadGeneralSettings?: GeneralSettingsLoader
    loadProxySettingsForHost?: (host: string) => Promise<RuntimeProxySettings>
    gdrive?: Readonly<{
      privateSources?: DrivePrivateSourceResolver
      loadSettings?: DriveRuntimeSettingsLoader
    }>
  }> = {}
): SourceApiRouteOptions {
  const providerHttpClient = new RemoteProviderHttpClient()
  const extractors = new ExtractorFactory({
    providerHttpClient,
    ...(options.loadProxySettingsForHost === undefined ? {} : {
      youtubeFetch: createYoutubeProxyFetch(async () => await (options.loadProxySettingsForHost as (host: string) => Promise<RuntimeProxySettings>)('youtube'))
    }),
    ...(options.loadProxySettingsForHost === undefined ? {} : {
      providerProxyHttpClientForHost: (host: string) => {
        const proxyClient = new RuntimeProxyProviderHttpClient(
          async () => await (options.loadProxySettingsForHost as (host: string) => Promise<RuntimeProxySettings>)(host)
        )
        return options.loadHostingSettings === undefined
          ? proxyClient
          : new ProviderCookieHttpClient(host, proxyClient, options.loadHostingSettings)
      }
    }),
    ...(options.loadHostingSettings === undefined ? {} : {
      providerHttpClientForHost: (host: string) => new ProviderCookieHttpClient(host, providerHttpClient, options.loadHostingSettings as HostingSettingsLoader),
      youtubeCookie: async () => (await (options.loadHostingSettings as HostingSettingsLoader)()).cookies.youtube ?? ''
    }),
    ...(options.gdrive === undefined ? {} : { gdrive: options.gdrive })
  })
  const supportedHosts = new Set(extractors.supportedHosts())
  let database: Database | undefined
  let cache: MySqlSourceCacheRepository | undefined
  let serverStore: MySqlMediaDownloadStore | undefined
  let serverId: number | null | undefined

  app.addHook('onClose', async () => {
    await database?.close()
  })

  const resolveSources = async (
    query: Parameters<SourceApiResolver>[0],
    context: Parameters<SourceApiResolver>[1],
    refresh: boolean
  ) => {
    const candidates = playerMediaCandidates(query).filter((candidate) => supportedHosts.has(candidate.host))
    if (candidates.length === 0) return emptyMediaResult()

    const general = await loadRuntimeGeneralSettings(options.loadGeneralSettings, config.baseUrl)
    const googleHlsHosts = googleHlsHostsForRequest(general, context.downloadable)

    database ??= new Database(config.database)
    cache ??= new MySqlSourceCacheRepository(database)
    serverStore ??= new MySqlMediaDownloadStore(database)
    if (serverId === undefined) {
      const value = Number(await serverStore.currentServerId(config.baseUrl.toString()) ?? 0)
      serverId = Number.isSafeInteger(value) && value > 0 ? value : null
    }
    for (const candidate of candidates) {
      const resolver = new SourceResolver({
        cache,
        extractors,
        clientIp: context.clientIp,
        serverId,
        defaultUserAgent: DEFAULT_USER_AGENT,
        defaultLanguage: DEFAULT_LANGUAGE,
        requestUserAgent: context.userAgent,
        requestLanguage: context.language,
        directHosts: new Set(['direct']),
        downloadableHosts: supportedHosts,
        googleHlsHosts
      })
        .setQuery({ host: candidate.host, id: candidate.id, ...(query.email === undefined ? {} : { email: query.email }) })
        .setDownload(context.downloadable)
      const result = refresh ? await resolver.refreshResult() : await resolver.getResult()
      if (result.sources.length > 0) return result
    }
    return emptyMediaResult()
  }

  return {
    supportedHosts,
    invalidateSource: async (identity) => {
      database ??= new Database(config.database)
      cache ??= new MySqlSourceCacheRepository(database)
      return await cache.deleteIdentity(identity)
    },
    resolve: async (query, context) => await resolveSources(query, context, false),
    refresh: async (query, context) => await resolveSources(query, context, true)
  }
}

export function googleHlsHostsForRequest(
  settings: Pick<GeneralSettings, 'gdrive_hls' | 'gphotos_hls'>,
  downloadable: boolean
): ReadonlySet<string> {
  const hosts = new Set<string>()
  if (downloadable) return hosts
  if (settings.gdrive_hls === true) hosts.add('gdrive')
  if (settings.gphotos_hls === true) hosts.add('googlephotos')
  return hosts
}
