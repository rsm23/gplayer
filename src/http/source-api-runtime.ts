import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.js'
import { emptyMediaResult, SourceResolver } from '../core/source-resolver.js'
import { Database } from '../database/database.js'
import { MySqlSourceCacheRepository } from '../database/source-cache-repository.js'
import { ExtractorFactory } from '../hosting/extractor-factory.js'
import { RemoteProviderHttpClient } from '../hosting/provider-http.js'
import { ProviderCookieHttpClient, type HostingSettingsLoader } from '../settings/hosting-runtime.js'
import type { SourceApiRouteOptions } from './source-api-routes.js'
import type { DrivePrivateSourceResolver, DriveRuntimeSettingsLoader } from '../drive/drive-media-service.js'
import { MySqlMediaDownloadStore } from '../background/mysql-media-download-store.js'
import { playerMediaCandidates } from '../core/player-query.js'

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const DEFAULT_LANGUAGE = 'en;q=0.9'

export function createSourceApiRuntime(
  app: FastifyInstance,
  config: AppConfig,
  options: Readonly<{
    loadHostingSettings?: HostingSettingsLoader
    gdrive?: Readonly<{
      privateSources?: DrivePrivateSourceResolver
      loadSettings?: DriveRuntimeSettingsLoader
    }>
  }> = {}
): SourceApiRouteOptions {
  const providerHttpClient = new RemoteProviderHttpClient()
  const extractors = new ExtractorFactory({
    providerHttpClient,
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

  return {
    supportedHosts,
    resolve: async (query, context) => {
      const candidates = playerMediaCandidates(query).filter((candidate) => supportedHosts.has(candidate.host))
      if (candidates.length === 0) return emptyMediaResult()

      database ??= new Database(config.database)
      cache ??= new MySqlSourceCacheRepository(database)
      serverStore ??= new MySqlMediaDownloadStore(database)
      if (serverId === undefined) {
        const value = Number(await serverStore.currentServerId(config.baseUrl.toString()) ?? 0)
        serverId = Number.isSafeInteger(value) && value > 0 ? value : null
      }
      for (const candidate of candidates) {
        const result = await new SourceResolver({
          cache,
          extractors,
          clientIp: context.clientIp,
          serverId,
          defaultUserAgent: DEFAULT_USER_AGENT,
          defaultLanguage: DEFAULT_LANGUAGE,
          requestUserAgent: context.userAgent,
          requestLanguage: context.language,
          directHosts: new Set(['direct']),
          downloadableHosts: supportedHosts
        })
          .setQuery({ host: candidate.host, id: candidate.id, ...(query.email === undefined ? {} : { email: query.email }) })
          .setDownload(context.downloadable)
          .getResult()
        if (result.sources.length > 0) return result
      }
      return emptyMediaResult()
    }
  }
}
