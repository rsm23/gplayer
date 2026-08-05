import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.js'
import { emptyMediaResult, SourceResolver } from '../core/source-resolver.js'
import { Database } from '../database/database.js'
import { MySqlSourceCacheRepository } from '../database/source-cache-repository.js'
import { ExtractorFactory } from '../hosting/extractor-factory.js'
import type { SourceApiRouteOptions } from './source-api-routes.js'

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const DEFAULT_LANGUAGE = 'en;q=0.9'

export function createSourceApiRuntime(
  app: FastifyInstance,
  config: AppConfig
): SourceApiRouteOptions {
  const extractors = new ExtractorFactory()
  const supportedHosts = new Set(extractors.supportedHosts())
  let database: Database | undefined
  let cache: MySqlSourceCacheRepository | undefined

  app.addHook('onClose', async () => {
    await database?.close()
  })

  return {
    supportedHosts,
    resolve: async (query, context) => {
      const host = query.host ?? ''
      const id = query.id ?? ''
      if (!supportedHosts.has(host) || id.length === 0) return emptyMediaResult()

      database ??= new Database(config.database)
      cache ??= new MySqlSourceCacheRepository(database)
      return await new SourceResolver({
        cache,
        extractors,
        clientIp: context.clientIp,
        defaultUserAgent: DEFAULT_USER_AGENT,
        defaultLanguage: DEFAULT_LANGUAGE,
        requestUserAgent: context.userAgent,
        requestLanguage: context.language,
        directHosts: new Set(['direct']),
        downloadableHosts: supportedHosts
      })
        .setQuery({ host, id, ...(query.email === undefined ? {} : { email: query.email }) })
        .setDownload(context.downloadable)
        .getResult()
    }
  }
}
