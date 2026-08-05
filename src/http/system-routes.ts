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
import { loadRuntimeGeneralSettings, type GeneralSettingsLoader } from '../settings/general-runtime.js'
import { disqusConfig, disqusCsp, renderDisqus, type DisqusConfig } from '../player/disqus.js'
import type { ProxyMaintenanceResult } from '../background/proxy-maintenance-worker.js'

const DEFAULT_PUBLIC_PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; object-src 'none'"

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
    loadGeneralSettings?: GeneralSettingsLoader
    isAuthenticated?: (request: FastifyRequest) => Promise<boolean>
    background?: Pick<DriveBackgroundCoordinator, 'trigger'>
    proxyMaintenance?: Readonly<{ runOnce(): Promise<ProxyMaintenanceResult> }>
    landingHtml?: string
  }> = {}
): Promise<void> {
  const security = new Security(config.secureSalt)

  app.addHook('onRequest', async (request, reply) => {
    if ((request.method !== 'GET' && request.method !== 'HEAD') || request.url.split('?', 1)[0] !== '/') return
    const settings = await loadRuntimePublicSettings(options.loadPublicSettings)
    if (settings.anonymous_generator || await authenticatedRequest(request, options.isAuthenticated)) return
    applyPublicPageHeaders(reply, true)
    return reply.code(403).type('text/html; charset=utf-8').send(renderPublicError(publicErrors[403], publicNavigation(settings.contact_page_link)))
  })

  const landingHtml = options.landingHtml
  if (landingHtml !== undefined) {
    app.get('/', async (_request, reply) => {
      const [settings, general] = await Promise.all([
        loadRuntimePublicSettings(options.loadPublicSettings),
        loadRuntimeGeneralSettings(options.loadGeneralSettings, config.baseUrl)
      ])
      const comments = disqusConfig(general, config.baseUrl)
      applyPublicPageHeaders(reply, false, comments)
      reply.header('cache-control', settings.anonymous_generator ? 'public, max-age=60' : 'private, no-store').type('text/html; charset=utf-8')
      return renderLandingDisqus(renderLandingContact(landingHtml, settings.contact_page_link), comments)
    })
  }

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

  const cronProxy = async (request: FastifyRequest, reply: FastifyReply) => {
    applyPublicPageHeaders(reply, true)
    reply.type('application/json; charset=utf-8')
    if (!await cronProxyAuthorized(request, auth)) {
      return { status: 'fail', message: 'You are not authorized to access this page!' }
    }
    try {
      const result = await options.proxyMaintenance?.runOnce()
      if (result === undefined || result.valid === 0) {
        if (result?.disabled === true) return { status: 'fail', message: 'The proxy is disabled.' }
        return {
          status: 'fail',
          message: 'Failed to retrieve validated proxy status. If there is a proxy in the proxy list column, the proxy is validated and can be used.'
        }
      }
      return {
        status: 'ok',
        message: 'The proxies has been successfully validated and can be used.',
        result: result.proxies.join('\n')
      }
    } catch {
      return {
        status: 'fail',
        message: 'Failed to retrieve validated proxy status. If there is a proxy in the proxy list column, the proxy is validated and can be used.'
      }
    }
  }
  app.get('/cron-proxy', cronProxy)
  app.get('/cron-proxy/', cronProxy)

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
        const settings = await loadRuntimePublicSettings(options.loadPublicSettings)
        applyPublicPageHeaders(reply)
        reply.header('cache-control', 'public, max-age=300').type('text/html; charset=utf-8')
        return page.render(publicNavigation(settings.contact_page_link))
      })
    }
  }

  for (const error of Object.values(publicErrors)) {
    for (const path of [`/${error.status}`, `/${error.status}/`]) {
      app.get(path, async (_request, reply) => {
        const settings = await loadRuntimePublicSettings(options.loadPublicSettings)
        applyPublicPageHeaders(reply, true)
        reply.code(error.status).type('text/html; charset=utf-8')
        return renderPublicError(error, publicNavigation(settings.contact_page_link))
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
    const query = legacyShimQuery(request.url)
    return query === '' ? reply.code(200).send() : reply.redirect(`/e/?${query}`)
  })

  app.get('/embed2.php', async (request, reply) => {
    const query = legacyShimQuery(request.url)
    return query === '' ? reply.code(200).send() : reply.redirect(`/r/?${query}`)
  })
}

function legacyShimQuery(requestUrl: string): string {
  const index = requestUrl.indexOf('?')
  return index < 0 ? '' : requestUrl.slice(index + 1)
}

function publicNavigation(contactUrl: string): Readonly<{ contactUrl?: string }> {
  if (contactUrl === '') return Object.freeze({})
  try {
    const url = new URL(contactUrl)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === ''
      ? Object.freeze({ contactUrl: url.href })
      : Object.freeze({})
  } catch {
    return Object.freeze({})
  }
}

export function renderLandingContact(html: string, contactUrl: string): string {
  const navigation = publicNavigation(contactUrl)
  if (navigation.contactUrl === undefined) return html.replace('<!-- runtime-contact-link -->', '')
  const escaped = navigation.contactUrl
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
  return html.replace('<!-- runtime-contact-link -->', `<a href="${escaped}">Contact</a>`)
}

export function renderLandingDisqus(html: string, config: DisqusConfig | null): string {
  return html.replace('<!-- runtime-disqus -->', renderDisqus(config))
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

async function cronProxyAuthorized(request: FastifyRequest, auth: AuthService): Promise<boolean> {
  const token = authTokenFromRequest({
    authorization: request.headers.authorization,
    cookie: request.cookies[AUTH_COOKIE_NAME]
  })
  if (token !== '') {
    try {
      const user = await auth.authenticate(token, request.headers['user-agent'] ?? '')
      if (user !== null && user.status === 1 && user.role === 0) return true
    } catch {
      // Basic/query compatibility can still authenticate when session storage is unavailable.
    }
  }
  const credentials = cronProxyCredentials(request)
  if (credentials === null) return false
  try {
    const user = await auth.verifyCredentials(credentials.username, credentials.password)
    return user !== null && user.status === 1 && user.role === 0
  } catch {
    return false
  }
}

function cronProxyCredentials(request: FastifyRequest): Readonly<{ username: string; password: string }> | null {
  const authorization = request.headers.authorization
  const header = Array.isArray(authorization) ? authorization[0] ?? '' : authorization ?? ''
  const basic = header.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i)?.[1]
  if (basic !== undefined && basic.length <= 8_192) {
    try {
      const bytes = Buffer.from(basic, 'base64')
      if (bytes.toString('base64').replace(/=+$/, '') !== basic.replace(/=+$/, '')) return null
      const decoded = bytes.toString('utf8')
      if (!Buffer.from(decoded, 'utf8').equals(bytes)) return null
      const separator = decoded.indexOf(':')
      if (separator > 0) return boundedCronCredentials(decoded.slice(0, separator), decoded.slice(separator + 1))
    } catch {
      return null
    }
  }
  const query = typeof request.query === 'object' && request.query !== null && !Array.isArray(request.query)
    ? request.query as Record<string, unknown>
    : {}
  return boundedCronCredentials(
    typeof query.username === 'string' ? query.username : '',
    typeof query.password === 'string' ? query.password : ''
  )
}

function boundedCronCredentials(username: string, password: string): Readonly<{ username: string; password: string }> | null {
  const identifier = username.trim()
  if (identifier === '' || identifier.length > 254 || password === '' || password.length > 4_096) return null
  return Object.freeze({ username: identifier, password })
}

function cacheToken(request: FastifyRequest): string {
  const query = typeof request.query === 'object' && request.query !== null && !Array.isArray(request.query)
    ? request.query as Record<string, unknown>
    : {}
  const legacyToken = typeof query.token === 'string' ? query.token.trim() : ''
  if (legacyToken !== '') return legacyToken
  return authTokenFromRequest({ authorization: request.headers.authorization, cookie: request.cookies[AUTH_COOKIE_NAME] })
}

export function applyPublicPageHeaders(reply: FastifyReply, noStore = false, disqus: DisqusConfig | null = null): void {
  reply
    .header('content-security-policy', publicPageContentSecurityPolicy(disqus))
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'strict-origin-when-cross-origin')
    .header('x-frame-options', 'SAMEORIGIN')
  if (noStore) {
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex, nofollow')
  }
}

function publicPageContentSecurityPolicy(disqus: DisqusConfig | null): string {
  if (disqus === null) return DEFAULT_PUBLIC_PAGE_CSP
  const sources = disqusCsp(disqus)
  return `default-src 'none'; script-src 'self' ${sources.scripts.join(' ')}; style-src 'self'; connect-src ${sources.connections.join(' ')}; img-src 'self' data: ${sources.images.join(' ')}; frame-src ${sources.frames.join(' ')}; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; object-src 'none'`
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
