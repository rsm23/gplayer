import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { freemem, loadavg, totalmem } from 'node:os'
import { AUTH_COOKIE_NAME, authTokenFromRequest, type AuthService } from '../auth/auth-service.js'
import type { AppConfig } from '../config.js'
import {
  publicErrors,
  renderChangelogPage,
  renderDmcaPage,
  renderPrivacyPage,
  renderPublicNavigationItems,
  renderPublicError,
  renderPublicThemeCss,
  renderTermsPage,
  type PublicNavigationOptions
} from '../player/public-page.js'
import { Security } from '../security/security.js'
import { loadRuntimePublicSettings, type PublicSettingsLoader } from '../settings/public-runtime.js'
import type { DriveBackgroundCoordinator } from '../drive/drive-background-worker.js'
import { loadRuntimeGeneralSettings, type GeneralSettingsLoader } from '../settings/general-runtime.js'
import { disqusConfig, disqusCsp, renderDisqus, type DisqusConfig } from '../player/disqus.js'
import type { ProxyMaintenanceResult } from '../background/proxy-maintenance-worker.js'
import { registerLegacyFrontendAliases } from './legacy-frontend-routes.js'
import { loadRuntimeSiteSettings, type SiteSettingsLoader } from '../settings/site-runtime.js'
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '../settings/settings-admin-service.js'
import type { AccountSettingsLoader } from '../auth/account-lifecycle-service.js'

const DEFAULT_PUBLIC_PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; object-src 'none'"

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
    loadSiteSettings?: SiteSettingsLoader
    loadAccountSettings?: AccountSettingsLoader
    isAuthenticated?: (request: FastifyRequest) => Promise<boolean>
    background?: Pick<DriveBackgroundCoordinator, 'trigger'>
    proxyMaintenance?: Readonly<{ runOnce(): Promise<ProxyMaintenanceResult> }>
    landingHtml?: string
  }> = {}
): Promise<void> {
  const security = new Security(config.secureSalt)

  app.addHook('onRequest', async (request, reply) => {
    if ((request.method !== 'GET' && request.method !== 'HEAD') || !isLegacyIndexRequest(request.url)) return
    const [settings, site, registrationEnabled] = await Promise.all([
      loadRuntimePublicSettings(options.loadPublicSettings),
      loadRuntimeSiteSettings(options.loadSiteSettings),
      loadFrontendRegistration(options.loadAccountSettings)
    ])
    const authenticated = await authenticatedRequest(request, options.isAuthenticated)
    if (settings.anonymous_generator || authenticated) return
    applyPublicPageHeaders(reply, true)
    return reply.code(403).type('text/html; charset=utf-8').send(renderPublicError(
      publicErrors[403],
      publicNavigation(settings.contact_page_link, site, frontendNavigation(config, settings.enable_gsharer, authenticated, registrationEnabled))
    ))
  })

  app.get('/runtime-site.css', async (_request, reply) => {
    const site = await loadRuntimeSiteSettings(options.loadSiteSettings)
    return reply
      .header('cache-control', 'public, max-age=60')
      .header('x-content-type-options', 'nosniff')
      .type('text/css; charset=utf-8')
      .send(renderPublicThemeCss(site))
  })

  const landingHtml = options.landingHtml
  if (landingHtml !== undefined) {
    const landing = async (_request: FastifyRequest, reply: FastifyReply) => {
      const [settings, general, site, registrationEnabled, authenticated] = await Promise.all([
        loadRuntimePublicSettings(options.loadPublicSettings),
        loadRuntimeGeneralSettings(options.loadGeneralSettings, config.baseUrl),
        loadRuntimeSiteSettings(options.loadSiteSettings),
        loadFrontendRegistration(options.loadAccountSettings),
        authenticatedRequest(_request, options.isAuthenticated)
      ])
      const navigation = publicNavigation(
        settings.contact_page_link,
        site,
        frontendNavigation(config, settings.enable_gsharer, authenticated, registrationEnabled)
      )
      const comments = disqusConfig(general, config.baseUrl)
      const recaptchaSiteKey = validRecaptchaSiteKey(String(general.recaptcha_site_key))
      applyPublicPageHeaders(reply, false, comments, recaptchaSiteKey !== '')
      reply.header('cache-control', authenticated || !settings.anonymous_generator ? 'private, no-store' : 'public, max-age=60').type('text/html; charset=utf-8')
      return renderLandingRecaptcha(
        renderLandingDisqus(renderLandingContact(renderLandingNavigation(renderLandingSite(landingHtml, site), navigation), settings.contact_page_link), comments),
        recaptchaSiteKey
      )
    }
    app.get('/', landing)
    registerLegacyFrontendAliases(app, ['index'], landing)
  }

  const ping = async (_request: FastifyRequest, reply: FastifyReply) => {
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
  }
  registerLegacyFrontendAliases(app, ['ping'], ping)

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
  registerLegacyFrontendAliases(app, ['cron-proxy'], cronProxy)

  const healthCheck = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-cache')
    return {
      connections: await activeConnections(app),
      cpu_load_1m: process.platform === 'win32' ? 0 : loadavg()[0] ?? 0,
      mem_used_pct: memoryUsagePercent(),
      timestamp: Math.floor(Date.now() / 1_000)
    }
  }
  registerLegacyFrontendAliases(app, ['health-check'], healthCheck)

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
  registerLegacyFrontendAliases(app, ['clear-cache'], clearCache)

  const sitemap = async (_request: unknown, reply: FastifyReply) => {
    const baseUrl = config.baseUrl.toString().replace(/\/$/, '')
    const paths = ['', '/sharer/', '/changelog/', '/terms/', '/privacy/']
    const priorities = ['1.00', '0.80', '0.80', '0.80', '0.80']
    const urls = paths.map((path, index) => `  <url>\n    <loc>${baseUrl}${path}</loc>\n    <priority>${priorities[index]}</priority>\n  </url>`).join('\n')
    reply.type('application/xml; charset=UTF-8')
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`
  }
  registerLegacyFrontendAliases(app, ['sitemap'], sitemap)

  const pages = [
    { alias: 'changelog', render: renderChangelogPage },
    { alias: 'terms', render: renderTermsPage },
    { alias: 'privacy', render: renderPrivacyPage },
    { alias: 'dmca', render: renderDmcaPage }
  ] as const

  for (const page of pages) {
    registerLegacyFrontendAliases(app, [page.alias], async (request, reply) => {
      const [settings, site, registrationEnabled, authenticated] = await Promise.all([
        loadRuntimePublicSettings(options.loadPublicSettings),
        loadRuntimeSiteSettings(options.loadSiteSettings),
        loadFrontendRegistration(options.loadAccountSettings),
        authenticatedRequest(request, options.isAuthenticated)
      ])
      applyPublicPageHeaders(reply)
      reply.header('cache-control', authenticated ? 'private, no-store' : 'public, max-age=300').type('text/html; charset=utf-8')
      return page.render(publicNavigation(
        settings.contact_page_link,
        site,
        frontendNavigation(config, settings.enable_gsharer, authenticated, registrationEnabled)
      ))
    })
  }

  for (const error of Object.values(publicErrors)) {
    registerLegacyFrontendAliases(app, [String(error.status)], async (request, reply) => {
      const [settings, site, registrationEnabled, authenticated] = await Promise.all([
        loadRuntimePublicSettings(options.loadPublicSettings),
        loadRuntimeSiteSettings(options.loadSiteSettings),
        loadFrontendRegistration(options.loadAccountSettings),
        authenticatedRequest(request, options.isAuthenticated)
      ])
      applyPublicPageHeaders(reply, true)
      reply.code(error.status).type('text/html; charset=utf-8')
      return renderPublicError(error, publicNavigation(
        settings.contact_page_link,
        site,
        frontendNavigation(config, settings.enable_gsharer, authenticated, registrationEnabled)
      ))
    })
  }

  registerLegacyFrontendAliases(app, ['redirect'], async (request, reply) => {
    const target = parseLegacyRedirect(request.url, security)
    if (target === null) {
      const [settings, site, registrationEnabled, authenticated] = await Promise.all([
        loadRuntimePublicSettings(options.loadPublicSettings),
        loadRuntimeSiteSettings(options.loadSiteSettings),
        loadFrontendRegistration(options.loadAccountSettings),
        authenticatedRequest(request, options.isAuthenticated)
      ])
      applyPublicPageHeaders(reply, true)
      reply.code(400).type('text/html; charset=utf-8')
      return renderPublicError(publicErrors[400], publicNavigation(
        settings.contact_page_link,
        site,
        frontendNavigation(config, settings.enable_gsharer, authenticated, registrationEnabled)
      ))
    }
    return reply.redirect(target.href)
  })
}

function isLegacyIndexRequest(requestUrl: string): boolean {
  const path = requestUrl.split('?', 1)[0] ?? ''
  if (path === '/') return true
  const firstSegment = path.split('/')[1] ?? ''
  return firstSegment.split('.', 1)[0] === 'index'
}

function publicNavigation(
  contactUrl: string,
  site: SiteSettings = DEFAULT_SITE_SETTINGS,
  frontend: Pick<PublicNavigationOptions, 'sharerEnabled' | 'account'> = {}
): PublicNavigationOptions {
  const base = { site, ...frontend }
  if (contactUrl === '') return Object.freeze(base)
  try {
    const url = new URL(contactUrl)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === ''
      ? Object.freeze({ ...base, contactUrl: url.href })
      : Object.freeze(base)
  } catch {
    return Object.freeze(base)
  }
}

function frontendNavigation(
  config: AppConfig,
  sharerEnabled: boolean,
  authenticated: boolean,
  registrationEnabled: boolean
): Pick<PublicNavigationOptions, 'sharerEnabled' | 'account'> {
  return Object.freeze({
    sharerEnabled,
    account: Object.freeze({
      adminBase: `/${config.adminDirectory}`,
      authenticated,
      registrationEnabled
    })
  })
}

async function loadFrontendRegistration(loader: AccountSettingsLoader | undefined): Promise<boolean> {
  if (loader === undefined) return false
  try {
    return (await loader()).enableRegistration
  } catch {
    return false
  }
}

export function renderLandingSite(html: string, site: SiteSettings): string {
  const siteName = escapeHtml(site.site_name)
  const siteSlogan = escapeHtml(site.site_slogan)
  const siteDescription = escapeHtml(site.site_description)
  const title = `${site.site_name} | ${site.site_slogan}`
  let rendered = replaceRuntimeMarker(html, 'title', escapeHtml(title))
  rendered = replaceRuntimeMarker(rendered, 'name', siteName)
  rendered = replaceRuntimeMarker(rendered, 'slogan', siteSlogan)
  rendered = replaceRuntimeMarker(rendered, 'description', siteDescription)
  rendered = replaceRuntimeMeta(rendered, 'title', title)
  rendered = replaceRuntimeMeta(rendered, 'description', site.site_description)
  rendered = replaceRuntimeMeta(rendered, 'theme-color', `#${site.pwa_themecolor}`)
  rendered = rendered.replaceAll('<!-- runtime-site-stylesheet -->', '<link rel="stylesheet" href="/runtime-site.css">')
  return rendered.replace(
    /(<a\b[^>]*\bdata-runtime-site-home-label\b[^>]*\baria-label=")[^"]*(")/gu,
    (_match, prefix: string, suffix: string) => `${prefix}${escapeHtmlAttribute(`${site.site_name} home`)}${suffix}`
  )
}

export function renderLandingNavigation(html: string, navigation: PublicNavigationOptions): string {
  return html.replace('<!-- runtime-public-navigation -->', renderPublicNavigationItems(navigation))
}

function replaceRuntimeMarker(html: string, marker: string, value: string): string {
  const opening = `<!-- runtime-site-${marker} -->`
  const closing = `<!-- /runtime-site-${marker} -->`
  let rendered = html
  while (true) {
    const start = rendered.indexOf(opening)
    if (start < 0) return rendered
    const end = rendered.indexOf(closing, start + opening.length)
    if (end < 0) return rendered
    rendered = `${rendered.slice(0, start)}${value}${rendered.slice(end + closing.length)}`
  }
}

function replaceRuntimeMeta(html: string, marker: string, value: string): string {
  const pattern = new RegExp(`(<meta data-runtime-site-${marker} content=")[^"]*(")`, 'gu')
  return html.replace(pattern, (_match, prefix: string, suffix: string) => `${prefix}${escapeHtmlAttribute(value)}${suffix}`)
}

function escapeHtml(value: string): string {
  return escapeHtmlAttribute(value).replaceAll("'", '&#39;')
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
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

export function renderLandingRecaptcha(html: string, siteKey: string): string {
  const key = validRecaptchaSiteKey(siteKey)
  if (key === '') return html.replace('<!-- runtime-recaptcha -->', '')
  return html.replace(
    '<!-- runtime-recaptcha -->',
    `<div class="g-recaptcha" data-sitekey="${key}"></div><script src="https://www.google.com/recaptcha/api.js" async defer></script>`
  )
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

export function applyPublicPageHeaders(
  reply: FastifyReply,
  noStore = false,
  disqus: DisqusConfig | null = null,
  recaptcha = false
): void {
  reply
    .header('content-security-policy', publicPageContentSecurityPolicy(disqus, recaptcha))
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'strict-origin-when-cross-origin')
    .header('x-frame-options', 'SAMEORIGIN')
  if (noStore) {
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex, nofollow')
  }
}

function publicPageContentSecurityPolicy(disqus: DisqusConfig | null, recaptcha: boolean): string {
  if (disqus === null && !recaptcha) return DEFAULT_PUBLIC_PAGE_CSP
  const sources = disqus === null ? null : disqusCsp(disqus)
  const scripts = ["'self'", ...(sources?.scripts ?? []), ...(recaptcha ? ['https://www.google.com', 'https://www.gstatic.com'] : [])]
  const styles = ["'self'", ...(recaptcha ? ["'unsafe-inline'", 'https://www.gstatic.com'] : [])]
  const connections = ["'self'", ...(sources?.connections ?? []), ...(recaptcha ? ['https://www.google.com'] : [])]
  const images = ["'self'", 'data:', ...(sources?.images ?? []), ...(recaptcha ? ['https://www.google.com', 'https://www.gstatic.com'] : [])]
  const frames = ["'self'", ...(sources?.frames ?? []), ...(recaptcha ? ['https://www.google.com'] : [])]
  return `default-src 'none'; script-src ${uniqueSources(scripts)}; style-src ${uniqueSources(styles)}; connect-src ${uniqueSources(connections)}; img-src ${uniqueSources(images)}; frame-src ${uniqueSources(frames)}; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; object-src 'none'`
}

function uniqueSources(values: readonly string[]): string {
  return [...new Set(values)].join(' ')
}

function validRecaptchaSiteKey(value: string): string {
  const key = value.trim()
  return key.length <= 4_096 && /^[A-Za-z0-9_-]+$/u.test(key) ? key : ''
}

function parseLegacyRedirect(requestUrl: string, security: Security): URL | null {
  const prefix = requestUrl.match(/^\/redirect(?:\.[^/?]*)?(?:\/|(?=\?|$))/u)?.[0]
  if (prefix === undefined) return null
  const pathAndQuery = requestUrl.slice(prefix.length)
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
