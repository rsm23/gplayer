import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { freemem, loadavg, totalmem } from 'node:os'
import { AUTH_COOKIE_NAME, authTokenFromRequest, type AuthService } from '../auth/auth-service.js'
import type { AppConfig } from '../config.js'
import {
  publicErrors,
  renderChangelogPage,
  renderDmcaPage,
  renderPrivacyPage,
  renderPublicError,
  renderTermsPage
} from '../player/public-page.js'
import { Security } from '../security/security.js'
import { loadRuntimePublicSettings, type PublicSettingsLoader } from '../settings/public-runtime.js'
import type { DriveBackgroundCoordinator } from '../drive/drive-background-worker.js'

const publicPageCsp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; object-src 'none'"

function memoryUsagePercent(): number {
  const total = totalmem()
  const free = freemem()
  return total > 0 ? Math.round(((total - free) / total) * 10_000) / 100 : 0
}

async function activeConnections(app: FastifyInstance): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    app.server.getConnections((error, count) => {
      if (error) reject(error)
      else resolve(count)
    })
  })
}

export async function registerSystemRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  clearRuntimeCache: () => boolean | Promise<boolean>,
  options: Readonly<{
    loadPublicSettings?: PublicSettingsLoader
    isAuthenticated?: (request: FastifyRequest) => Promise<boolean>
    background?: Pick<DriveBackgroundCoordinator, 'trigger'>
  }> = {}
): Promise<void> {
  const security = new Security(config.secureSalt)

  app.addHook('onRequest', async (request, reply) => {
    if ((request.method !== 'GET' && request.method !== 'HEAD') || request.url.split('?', 1)[0] !== '/') return
    const settings = await loadRuntimePublicSettings(options.loadPublicSettings)
    if (settings.anonymous_generator || await authenticatedRequest(request, options.isAuthenticated)) return
    applyPublicPageHeaders(reply, true)
    return reply.code(403).type('text/html; charset=utf-8').send(renderPublicError(publicErrors[403]))
  })

  app.get('/ping', async (_request, reply) => {
    reply.header('cache-control', 'no-cache')
    const background = options.background?.trigger()
    const jobs = background?.jobs
    return {
      running: true,
      pid: process.pid,
      ...(background === undefined ? {} : {
        bg_gdrive: (jobs?.bg_gdrive?.running ?? background.running) ? process.pid : false,
        ...(jobs?.bg_stats === undefined ? {} : { bg_stats: jobs.bg_stats.running ? process.pid : false }),
        ...(jobs?.bg_general === undefined ? {} : { bg_general: jobs.bg_general.running ? process.pid : false }),
        ...(jobs?.bg_get === undefined ? {} : { bg_get: jobs.bg_get.running ? process.pid : false }),
        ...(jobs?.bg_download === undefined ? {} : { bg_download: jobs.bg_download.running ? process.pid : false }),
        background_started: background.started
      })
    }
  })

  app.get('/health-check', async (_request, reply) => {
    reply.header('cache-control', 'no-cache')
    return {
      connections: await activeConnections(app),
      cpu_load_1m: process.platform === 'win32' ? 0 : loadavg()[0] ?? 0,
      mem_used_pct: memoryUsagePercent(),
      timestamp: Math.floor(Date.now() / 1_000)
    }
  })

  const clearCache = async (request: FastifyRequest, reply: FastifyReply) => {
    applyPublicPageHeaders(reply, true)
    reply.type('text/plain; charset=utf-8')
    try {
      const user = await auth.authenticate(cacheToken(request), request.headers['user-agent'] ?? '')
      if (user === null || user.role !== 0 || user.status !== 1) return 'fail'
      return await clearRuntimeCache() ? 'ok' : 'fail'
    } catch {
      return 'fail'
    }
  }
  app.get('/clear-cache', clearCache)
  app.get('/clear-cache/', clearCache)

  const sitemap = async (_request: unknown, reply: FastifyReply) => {
    const baseUrl = config.baseUrl.toString().replace(/\/$/, '')
    const paths = ['', '/sharer/', '/changelog/', '/terms/', '/privacy/']
    const priorities = ['1.00', '0.80', '0.80', '0.80', '0.80']
    const urls = paths.map((path, index) => `  <url>\n    <loc>${baseUrl}${path}</loc>\n    <priority>${priorities[index]}</priority>\n  </url>`).join('\n')
    reply.type('application/xml; charset=UTF-8')
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`
  }
  app.get('/sitemap', sitemap)
  app.get('/sitemap.xml', sitemap)

  const pages = [
    { paths: ['/changelog', '/changelog/'], render: renderChangelogPage },
    { paths: ['/terms', '/terms/'], render: renderTermsPage },
    { paths: ['/privacy', '/privacy/'], render: renderPrivacyPage },
    { paths: ['/dmca', '/dmca/'], render: renderDmcaPage }
  ] as const

  for (const page of pages) {
    for (const path of page.paths) {
      app.get(path, async (_request, reply) => {
        applyPublicPageHeaders(reply)
        reply.header('cache-control', 'public, max-age=300').type('text/html; charset=utf-8')
        return page.render()
      })
    }
  }

  for (const error of Object.values(publicErrors)) {
    for (const path of [`/${error.status}`, `/${error.status}/`]) {
      app.get(path, async (_request, reply) => {
        applyPublicPageHeaders(reply, true)
        reply.code(error.status).type('text/html; charset=utf-8')
        return renderPublicError(error)
      })
    }
  }

  app.get('/redirect/*', async (request, reply) => {
    const target = parseLegacyRedirect(request.url, security)
    if (target === null) {
      applyPublicPageHeaders(reply, true)
      reply.code(400).type('text/html; charset=utf-8')
      return renderPublicError(publicErrors[400])
    }
    return reply.redirect(target.href)
  })

  app.get('/embed.php', async (request, reply) => {
    const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''
    return reply.redirect(`/e/${query}`)
  })

  app.get('/embed2.php', async (request, reply) => {
    const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''
    return reply.redirect(`/r/${query}`)
  })
}

async function authenticatedRequest(
  request: FastifyRequest,
  authenticate: ((request: FastifyRequest) => Promise<boolean>) | undefined
): Promise<boolean> {
  if (authenticate === undefined) return false
  try {
    return await authenticate(request)
  } catch {
    return false
  }
}

function cacheToken(request: FastifyRequest): string {
  const query = typeof request.query === 'object' && request.query !== null && !Array.isArray(request.query)
    ? request.query as Record<string, unknown>
    : {}
  const legacyToken = typeof query.token === 'string' ? query.token.trim() : ''
  if (legacyToken !== '') return legacyToken
  return authTokenFromRequest({ authorization: request.headers.authorization, cookie: request.cookies[AUTH_COOKIE_NAME] })
}

export function applyPublicPageHeaders(reply: FastifyReply, noStore = false): void {
  reply
    .header('content-security-policy', publicPageCsp)
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'strict-origin-when-cross-origin')
    .header('x-frame-options', 'SAMEORIGIN')
  if (noStore) {
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex, nofollow')
  }
}

function parseLegacyRedirect(requestUrl: string, security: Security): URL | null {
  const pathAndQuery = requestUrl.slice('/redirect/'.length)
  const queryIndex = pathAndQuery.indexOf('?')
  const rawPath = queryIndex < 0 ? pathAndQuery : pathAndQuery.slice(0, queryIndex)
  const rawQuery = queryIndex < 0 ? '' : pathAndQuery.slice(queryIndex)
  const segments = rawPath.split('/')

  // 4.8.3 used a leading routing segment before the encrypted origin. Accept
  // both that shape and the older one-token shape for existing generated links.
  const tokenIndexes = segments.length > 1 ? [1, 0] : [0]
  for (const tokenIndex of tokenIndexes) {
    const token = segments[tokenIndex]
    if (token === undefined || token.length === 0) continue
    const origin = security.decryptURLStrict(token)
    if (origin === null || !isSafeRedirectOrigin(origin)) continue

    const suffix = segments.slice(tokenIndex + 1).join('/')
    try {
      const target = new URL(origin + suffix + rawQuery)
      if (target.protocol !== 'http:' && target.protocol !== 'https:') continue
      if (target.username || target.password) continue
      return target
    } catch {
      continue
    }
  }
  return null
}

function isSafeRedirectOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}
