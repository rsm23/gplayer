import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { loadConfig } from '../src/config.js'
import { Security } from '../src/security/security.js'
import { SettingsAdminService } from '../src/settings/settings-admin-service.js'
import { renderLandingContact } from '../src/http/system-routes.js'
import { redactSensitiveRequestUrl } from '../src/http/request-log.js'

let app: FastifyInstance | undefined
const secureSalt = '1234567890123456'
const systemUserAgent = 'GPlayer system route test'
const adminToken = 'system-admin-token-1234567890'
const memberToken = 'system-member-token-1234567890'
const systemAdmin: AuthUser = Object.freeze({ id: 1, username: 'admin', email: 'admin@gplayer.local', name: 'Admin', role: 0, status: 1, created: 1, updated: 1 })
const systemMember: AuthUser = Object.freeze({ ...systemAdmin, id: 2, username: 'member', email: 'member@gplayer.local', name: 'Member', role: 2 })
const storedSystemAdmin: StoredAuthUser = Object.freeze({ ...systemAdmin, passwordHash: 'admin-password' })
const storedSystemMember: StoredAuthUser = Object.freeze({ ...systemMember, passwordHash: 'member-password' })

class SystemRouteAuthStore implements AuthStore {
  public constructor(private readonly users: readonly StoredAuthUser[] = []) {}
  public async findUserByIdentifier(identifier: string): Promise<StoredAuthUser | null> {
    return this.users.find((user) => user.username === identifier || user.email === identifier) ?? null
  }
  public async createSession(_session: SessionWrite): Promise<void> {}
  public async recordFailedLogin(_session: Omit<SessionWrite, 'expires' | 'state'>): Promise<void> {}
  public async revokeSession(): Promise<boolean> { return true }
  public async findActiveSession(token: string, userAgent: string): Promise<AuthUser | null> {
    if (userAgent !== systemUserAgent) return null
    if (token === adminToken) return systemAdmin
    if (token === memberToken) return systemMember
    return null
  }
}

function systemRouteAuth(users: readonly StoredAuthUser[] = []): AuthService {
  return new AuthService(new SystemRouteAuthStore(users), {
    verifyPassword: async (password, hash) => password === hash
  })
}

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('legacy-compatible system routes', () => {
  it('redacts compatibility credentials and tokens from production request-log URLs', () => {
    expect(redactSensitiveRequestUrl('/cron-proxy?username=admin&password=admin-password')).toBe('/cron-proxy?username=admin&password=%5Bredacted%5D')
    expect(redactSensitiveRequestUrl('/clear-cache?token=secret-token&keep=1')).toBe('/clear-cache?token=%5Bredacted%5D&keep=1')
    expect(redactSensitiveRequestUrl('/health-check?sample=1')).toBe('/health-check?sample=1')
  })

  it('serves the Node landing page and its generator assets', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))

    const page = await app.inject({ method: 'GET', url: '/' })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.body).toContain('One runtime. Every source.')
    expect(page.body).toContain('id="player-form"')
    expect(page.body).toContain('enctype="multipart/form-data"')
    expect(page.body).toContain('name="id"')
    expect(page.body).toContain('name="poster-file"')
    expect(page.body).toContain('data-subtitle-file')
    expect(page.body).not.toContain('runtime-recaptcha')
    expect(page.body).toContain('id="product-demo"')
    expect(page.body).toContain('./assets/img/product/gplayer-generator.png')
    expect(page.body).toContain('rel="manifest" href="./manifest.json"')
    expect(page.body).not.toContain('runtime-disqus')
    expect(page.body).not.toContain('gplayer-disqus.js')
    expect(page.body).not.toMatch(/gdplayer\.(?:to|io)/i)
    expect(page.body).not.toMatch(/[–—]/)

    const [style, script] = await Promise.all([
      app.inject({ method: 'GET', url: '/assets/css/gplayer-landing.css' }),
      app.inject({ method: 'GET', url: '/assets/js/gplayer-landing.js' })
    ])
    expect(style.statusCode).toBe(200)
    expect(style.headers['content-type']).toContain('text/css')
    expect(style.body).toContain('prefers-color-scheme: light')
    expect(style.body).toContain('prefers-reduced-motion: reduce')
    expect(script.statusCode).toBe(200)
    expect(script.headers['content-type']).toContain('javascript')
    expect(script.body).toContain("fetch(new URL('ajax/public/', document.baseURI)")
    expect(script.body).toContain('new FormData(form)')
    expect(script.body).toContain("payload.append('sub-file[]'")
    expect(script.body).not.toContain("'content-type': 'application/json'")
    expect(script.body).toContain("github\\.io")
    expect(script.body).toContain("document.querySelector('#product-demo')")
    expect(script.body).not.toMatch(/gdplayer\.(?:to|io)/i)
  })

  it('limits disabled public pages to authenticated sessions', async () => {
    const values = { anonymous_generator: 'false' }
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      auth: new AuthService(new SystemRouteAuthStore()),
      settings: new SettingsAdminService({ getAll: async () => values, upsertMany: async () => {} })
    })

    const [anonymousPage, anonymousIndexAlias, anonymousGenerator] = await Promise.all([
      app.inject({ method: 'GET', url: '/?generator=1' }),
      app.inject({ method: 'GET', url: '/index.php/ignored' }),
      app.inject({
        method: 'POST',
        url: '/ajax/public/',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'action=createPlayer&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4'
      })
    ])
    expect(anonymousPage.statusCode).toBe(403)
    expect(anonymousPage.headers['cache-control']).toBe('no-store')
    expect(anonymousPage.body).toContain('403 Forbidden')
    expect(anonymousIndexAlias.statusCode).toBe(403)
    expect(anonymousIndexAlias.body).toContain('403 Forbidden')
    expect(anonymousGenerator.json()).toEqual({ status: 'fail', message: 'Access denied', result: null })

    const authenticatedHeaders = {
      'user-agent': systemUserAgent,
      cookie: `${AUTH_COOKIE_NAME}=${memberToken}`
    }
    const authenticatedPage = await app.inject({ method: 'GET', url: '/', headers: authenticatedHeaders })
    expect(authenticatedPage.statusCode).toBe(200)
    expect(authenticatedPage.body).toContain('id="player-form"')

    const authenticatedGenerator = await app.inject({
      method: 'POST',
      url: '/ajax/public/',
      headers: { ...authenticatedHeaders, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=createPlayer&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4'
    })
    expect(authenticatedGenerator.json()).toMatchObject({ status: 'ok' })
  })

  it('renders the validated Contact URL into the landing, legal, and error navigation', async () => {
    const values = { contact_page_link: 'https://support.example.test/contact?from=gplayer' }
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({ getAll: async () => values, upsertMany: async () => {} })
    })
    const [landing, terms, missing] = await Promise.all([
      app.inject({ method: 'GET', url: '/' }),
      app.inject({ method: 'GET', url: '/terms/' }),
      app.inject({ method: 'GET', url: '/missing-contact-test' })
    ])
    for (const response of [landing, terms, missing]) {
      expect(response.body).toContain('href="https://support.example.test/contact?from=gplayer"')
      expect(response.body).toContain('>Contact</a>')
      expect(response.body).not.toContain('runtime-contact-link')
    }
    expect(renderLandingContact('before<!-- runtime-contact-link -->after', 'javascript:alert(1)')).toBe('beforeafter')
    expect(renderLandingContact('before<!-- runtime-contact-link -->after', 'https://user:secret@support.example.test/')).toBe('beforeafter')
  })

  it('applies escaped Site Settings branding and colors to every public shell', async () => {
    const values = {
      site_name: '$1 Media & Player',
      site_slogan: 'Stream <everything> safely',
      site_description: 'Media "everywhere" & <fast>',
      custom_color: '123abc',
      custom_color2: 'fedcba',
      pwa_themecolor: '010203'
    }
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({ getAll: async () => values, upsertMany: async () => {} })
    })

    const [landing, dmca, missing, theme] = await Promise.all([
      app.inject({ method: 'GET', url: '/' }),
      app.inject({ method: 'GET', url: '/dmca/' }),
      app.inject({ method: 'GET', url: '/missing-branded-page' }),
      app.inject({ method: 'GET', url: '/runtime-site.css' })
    ])

    expect(landing.body).toContain('<title>$1 Media &amp; Player | Stream &lt;everything&gt; safely</title>')
    expect(landing.body).toContain('content="Media &quot;everywhere&quot; &amp; &lt;fast&gt;"')
    expect(landing.body).toContain('<h1 id="hero-title">Stream &lt;everything&gt; safely</h1>')
    expect(landing.body).toContain('aria-label="$1 Media &amp; Player home"')
    expect(landing.body).toContain('<link rel="stylesheet" href="/runtime-site.css">')
    expect(landing.body).not.toContain('<!-- runtime-site-')
    expect(landing.body).not.toContain('<everything>')

    for (const response of [dmca, missing]) {
      expect(response.body).toContain('| $1 Media &amp; Player</title>')
      expect(response.body).toContain('aria-label="$1 Media &amp; Player home"')
      expect(response.body).toContain('<link rel="stylesheet" href="/runtime-site.css">')
      expect(response.body).toContain('Stream &lt;everything&gt; safely')
    }
    expect(dmca.body).toContain('$1 Media &amp; Player respects the intellectual-property rights')
    expect(missing.statusCode).toBe(404)

    expect(theme.statusCode).toBe(200)
    expect(theme.headers['content-type']).toContain('text/css')
    expect(theme.headers['cache-control']).toBe('public, max-age=60')
    expect(theme.body).toContain('--brand: #123abc;')
    expect(theme.body).toContain('--brand-soft: #fedcba;')
    expect(theme.body).not.toContain('<')
  })

  it('mounts a configured Disqus thread through the bounded local bootstrap and scoped CSP', async () => {
    const values = { disqus_shortname: 'Community-42' }
    app = await buildApp(loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'https://player.example/base/',
      SECURE_SALT: secureSalt
    }), {
      settings: new SettingsAdminService({ getAll: async () => values, upsertMany: async () => {} })
    })

    const page = await app.inject({ method: 'GET', url: '/' })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('data-disqus-shortname="community-42"')
    expect(page.body).toContain('data-disqus-page-url="https://player.example/base/"')
    expect(page.body).toContain('id="disqus_thread"')
    expect(page.body).toContain('src="/assets/js/gplayer-disqus.js"')
    expect(page.body).toContain('https://disqus.com/?ref_noscript')
    expect(page.body).not.toContain('community-42.disqus.com/embed.js')
    expect(page.headers['content-security-policy']).toContain('https://community-42.disqus.com')
    expect(page.headers['content-security-policy']).toContain('https://c.disquscdn.com')
    expect(page.headers['content-security-policy']).toContain("frame-src 'self' https://disqus.com https://*.disqus.com")

    const runtime = await app.inject({ method: 'GET', url: '/assets/js/gplayer-disqus.js' })
    expect(runtime.statusCode).toBe(200)
    expect(runtime.body).toContain('globalThis.disqus_config')
    expect(runtime.body).toContain('`https://${shortname}.disqus.com/embed.js`')
    expect(runtime.body).not.toContain('eval(')
  })

  it('renders a validated reCAPTCHA widget with the exact public-page CSP sources', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({
        getAll: async () => ({ recaptcha_site_key: 'site_key-42' }),
        upsertMany: async () => {}
      })
    })

    const page = await app.inject({ method: 'GET', url: '/' })
    expect(page.body).toContain('class="g-recaptcha" data-sitekey="site_key-42"')
    expect(page.body).toContain('src="https://www.google.com/recaptcha/api.js"')
    expect(page.body).not.toContain('runtime-recaptcha')
    expect(page.headers['content-security-policy']).toContain("connect-src 'self' https://www.google.com")
    expect(page.headers['content-security-policy']).toContain("frame-src 'self' https://www.google.com")
    expect(page.headers['content-security-policy']).toContain('https://www.gstatic.com')
  })

  it('does not reflect malformed Disqus settings or widen the public-page CSP', async () => {
    const payload = 'bad"><script>globalThis.disqusInjected=true</script>'
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({
        getAll: async () => ({ disqus_shortname: payload, recaptcha_site_key: payload }),
        upsertMany: async () => {}
      })
    })

    const page = await app.inject({ method: 'GET', url: '/' })
    expect(page.body).not.toContain('disqusInjected')
    expect(page.body).not.toContain('gplayer-disqus.js')
    expect(page.body).not.toContain('runtime-disqus')
    expect(page.body).not.toContain('g-recaptcha')
    expect(page.headers['content-security-policy']).not.toContain('disqus.com')
    expect(page.headers['content-security-policy']).not.toContain('google.com')
    expect(page.headers['content-security-policy']).toContain("connect-src 'self'")
    expect(page.headers['content-security-policy']).toContain("frame-src 'self'")
  })

  it('serves the health contract', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const response = await app.inject({ method: 'GET', url: '/health-check' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toContain('no-cache')
    expect(response.json()).toEqual(expect.objectContaining({
      connections: expect.any(Number),
      cpu_load_1m: expect.any(Number),
      mem_used_pct: expect.any(Number),
      timestamp: expect.any(Number)
    }))
  })

  it('triggers the Node Drive worker without waiting and coalesces active runs', async () => {
    const trigger = vi.fn()
      .mockReturnValueOnce({ running: true, started: true, jobs: { bg_gdrive: { running: true, started: true }, bg_stats: { running: true, started: true }, bg_general: { running: true, started: true }, bg_get: { running: true, started: true }, bg_download: { running: true, started: true } } })
      .mockReturnValueOnce({ running: true, started: false, jobs: { bg_gdrive: { running: true, started: false }, bg_stats: { running: true, started: false }, bg_general: { running: true, started: false }, bg_get: { running: true, started: false }, bg_download: { running: true, started: false } } })
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      driveBackground: { trigger }
    })
    const first = await app.inject({ method: 'GET', url: '/ping' })
    const second = await app.inject({ method: 'GET', url: '/ping' })
    expect(first.json()).toMatchObject({ running: true, pid: process.pid, bg_gdrive: process.pid, bg_stats: process.pid, bg_general: process.pid, bg_get: process.pid, bg_download: process.pid, background_started: true })
    expect(second.json()).toMatchObject({ running: true, pid: process.pid, bg_gdrive: process.pid, bg_stats: process.pid, bg_general: process.pid, bg_get: process.pid, bg_download: process.pid, background_started: false })
    expect(trigger).toHaveBeenCalledTimes(2)
  })

  it('rejects anonymous and non-administrator cron proxy validation requests without running the worker', async () => {
    const runOnce = vi.fn()
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      auth: systemRouteAuth([storedSystemAdmin, storedSystemMember]),
      proxyMaintenance: { runOnce }
    })

    const [anonymous, memberSession, memberBasic, malformedBasic] = await Promise.all([
      app.inject({ method: 'GET', url: '/cron-proxy' }),
      app.inject({ method: 'GET', url: '/cron-proxy', headers: { 'user-agent': systemUserAgent, cookie: `${AUTH_COOKIE_NAME}=${memberToken}` } }),
      app.inject({ method: 'GET', url: '/cron-proxy', headers: { authorization: `Basic ${Buffer.from('member:member-password').toString('base64')}` } }),
      app.inject({ method: 'GET', url: '/cron-proxy', headers: { authorization: 'Basic not_base64!' } })
    ])

    for (const response of [anonymous, memberSession, memberBasic, malformedBasic]) {
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('application/json')
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow')
      expect(response.json()).toEqual({ status: 'fail', message: 'You are not authorized to access this page!' })
    }
    expect(runOnce).not.toHaveBeenCalled()
  })

  it('runs cron proxy validation for administrator sessions, Basic auth, and query compatibility aliases', async () => {
    const result = Object.freeze({
      disabled: false,
      discovered: 1,
      checked: 2,
      valid: 2,
      proxies: Object.freeze(['198.51.100.7:8080', '198.51.100.8:443,https'])
    })
    const runOnce = vi.fn(async () => result)
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      auth: systemRouteAuth([storedSystemAdmin]),
      proxyMaintenance: { runOnce }
    })

    const expected = {
      status: 'ok',
      message: 'The proxies has been successfully validated and can be used.',
      result: '198.51.100.7:8080\n198.51.100.8:443,https'
    }
    const session = await app.inject({
      method: 'GET',
      url: '/cron-proxy',
      headers: { 'user-agent': systemUserAgent, authorization: `Bearer ${adminToken}` }
    })
    const basic = await app.inject({
      method: 'GET',
      url: '/cron-proxy/',
      headers: { authorization: `Basic ${Buffer.from('admin:admin-password').toString('base64')}` }
    })
    const query = await app.inject({
      method: 'GET',
      url: '/cron-proxy?username=admin&password=admin-password'
    })

    expect(session.json()).toEqual(expected)
    expect(basic.json()).toEqual(expected)
    expect(query.json()).toEqual(expected)
    expect(query.body).not.toContain('admin-password')
    expect(runOnce).toHaveBeenCalledTimes(3)
  })

  it.each([
    [Object.freeze({ disabled: true, discovered: 0, checked: 0, valid: 0, proxies: Object.freeze([]) }), 'The proxy is disabled.'],
    [Object.freeze({ disabled: false, discovered: 0, checked: 1, valid: 0, proxies: Object.freeze([]) }), 'Failed to retrieve validated proxy status. If there is a proxy in the proxy list column, the proxy is validated and can be used.']
  ])('preserves the cron proxy failure contract', async (result, message) => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      auth: systemRouteAuth([storedSystemAdmin]),
      proxyMaintenance: { runOnce: async () => result }
    })
    const response = await app.inject({
      method: 'GET',
      url: '/cron-proxy',
      headers: { authorization: `Basic ${Buffer.from('admin:admin-password').toString('base64')}` }
    })
    expect(response.json()).toEqual({ status: 'fail', message })
  })

  it('clears registered Node runtime caches through the administrator-only legacy controller', async () => {
    const clearRuntimeCache = vi.fn(() => true)
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      auth: new AuthService(new SystemRouteAuthStore()),
      clearRuntimeCache
    })

    const ok = await app.inject({ method: 'GET', url: `/clear-cache/?token=${adminToken}`, headers: { 'user-agent': systemUserAgent } })
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['content-type']).toContain('text/plain')
    expect(ok.headers['cache-control']).toBe('no-store')
    expect(ok.body).toBe('ok')
    expect(clearRuntimeCache).toHaveBeenCalledOnce()

    const member = await app.inject({ method: 'GET', url: '/clear-cache', headers: { 'user-agent': systemUserAgent, cookie: `${AUTH_COOKIE_NAME}=${memberToken}` } })
    const invalid = await app.inject({ method: 'GET', url: '/clear-cache/?token=invalid-token', headers: { 'user-agent': systemUserAgent } })
    expect(member.body).toBe('fail')
    expect(invalid.body).toBe('fail')
    expect(clearRuntimeCache).toHaveBeenCalledOnce()
  })

  it('returns the supplied legacy fail marker when registered cache invalidation fails', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      auth: new AuthService(new SystemRouteAuthStore()),
      clearRuntimeCache: async () => false
    })
    const response = await app.inject({ method: 'GET', url: '/clear-cache', headers: { 'user-agent': systemUserAgent, authorization: `Bearer ${adminToken}` } })
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('fail')
  })

  it('dispatches system views from the first path segment after stripping dot suffixes', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const [index, health, sitemap, terms, serverError, cache] = await Promise.all([
      app.inject({ method: 'GET', url: '/index.php/ignored/path' }),
      app.inject({ method: 'GET', url: '/health-check.json/ignored/path' }),
      app.inject({ method: 'GET', url: '/sitemap.xml/ignored/path' }),
      app.inject({ method: 'GET', url: '/terms.php/ignored/path' }),
      app.inject({ method: 'GET', url: '/500.php/ignored/path' }),
      app.inject({ method: 'GET', url: '/clear-cache.php/ignored/path' })
    ])

    expect(index.statusCode).toBe(200)
    expect(index.body).toContain('id="player-form"')
    expect(health.statusCode).toBe(200)
    expect(health.json()).toEqual(expect.objectContaining({ connections: expect.any(Number), timestamp: expect.any(Number) }))
    expect(sitemap.statusCode).toBe(200)
    expect(sitemap.headers['content-type']).toContain('application/xml')
    expect(terms.statusCode).toBe(200)
    expect(terms.body).toContain('Terms and Conditions')
    expect(serverError.statusCode).toBe(500)
    expect(serverError.body).toContain('500 Internal Server Error')
    expect(cache.statusCode).toBe(200)
    expect(cache.body).toBe('fail')
  })

  it('returns the readable front-controller CORS and OPTIONS contract on every path', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const [bare, preflight, page] = await Promise.all([
      app.inject({ method: 'OPTIONS', url: '/not-a-route' }),
      app.inject({
        method: 'OPTIONS',
        url: '/api',
        headers: {
          origin: 'https://client.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type'
        }
      }),
      app.inject({ method: 'GET', url: '/assets/css/gplayer-public.css' })
    ])

    for (const response of [bare, preflight]) {
      expect(response.statusCode).toBe(204)
      expect(response.body).toBe('')
      expect(response.headers['cache-control']).toBe('no-cache, no-store, no-transform, must-revalidate')
    }
    for (const response of [bare, preflight, page]) {
      expect(response.headers['access-control-allow-methods']).toBe('GET, POST, HEAD, OPTIONS')
      expect(response.headers['access-control-allow-origin']).toBe('*')
      expect(response.headers['access-control-allow-headers']).toBe('*')
      expect(response.headers['access-control-expose-headers']).toBe('*')
    }
  })

  it('uses the legacy empty HEAD response only when no explicit Node route exists', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const [unknown, dashUnknown, explicitError] = await Promise.all([
      app.inject({ method: 'HEAD', url: '/not-a-route' }),
      app.inject({ method: 'HEAD', url: '/compat/mpd/manifest' }),
      app.inject({ method: 'HEAD', url: '/404/' })
    ])

    for (const response of [unknown, dashUnknown]) {
      expect(response.statusCode).toBe(200)
      expect(response.rawPayload).toHaveLength(0)
      expect(response.headers['cache-control']).toBe('no-cache, no-store, no-transform, must-revalidate')
    }
    expect(unknown.headers['content-type']).toBeUndefined()
    expect(dashUnknown.headers['content-type']).toBe('application/dash+xml')
    expect(explicitError.statusCode).toBe(404)
    expect(explicitError.rawPayload).toHaveLength(0)
  })

  it('returns the legacy 404 title', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const response = await app.inject({ method: 'GET', url: '/missing' })
    expect(response.statusCode).toBe(404)
    expect(response.body).toContain('404 Page Not Found')
    expect(response.body).toContain('The page you are looking for was not found.')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow')
    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
  })

  it.each([
    ['/terms', 'Terms &amp; Conditions', 'Eligibility'],
    ['/terms/', 'Terms &amp; Conditions', 'Governing law'],
    ['/privacy/', 'Privacy Policy', 'Information we collect'],
    ['/dmca/', 'DMCA Takedown Policy', 'Counter-notification'],
    ['/changelog/', 'Change Log', 'v4.8.3']
  ])('serves public compatibility page %s', async (url, title, detail) => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const response = await app.inject({ method: 'GET', url })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.headers['cache-control']).toBe('public, max-age=300')
    expect(response.headers['content-security-policy']).toContain("script-src 'self'")
    expect(response.body).toContain(title)
    expect(response.body).toContain(detail)
    expect(response.body).toContain('id="main-content"')
    expect(response.body).toContain('href="/manifest.json"')
  })

  it.each([
    [400, '400 Bad Request', 'The page is disabled.'],
    [401, '401 Unauthorized', 'You are not allowed to access the page.'],
    [403, '403 Forbidden', 'You are not allowed to access the page.'],
    [404, '404 Page Not Found', 'The page you are looking for was not found.'],
    [500, '500 Internal Server Error', 'Please contact admin.'],
    [503, '503 Service Unavailable', 'Please try again later.']
  ] as const)('serves the legacy %i status page and HTTP status', async (status, title, detail) => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const response = await app.inject({ method: 'GET', url: `/${status}/` })

    expect(response.statusCode).toBe(status)
    expect(response.body).toContain(title)
    expect(response.body).toContain(detail)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow')
  })

  it('supports the authenticated legacy redirect path grammars', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const security = new Security(secureSalt)
    const origin = security.encryptURL('https://cdn.example.test/root/')

    const [twoToken, oneToken, dotted] = await Promise.all([
      app.inject({ method: 'GET', url: `/redirect/direct/${origin}/video/file.mp4?download=1` }),
      app.inject({ method: 'GET', url: `/redirect/${origin}/video/file.mp4?download=1` }),
      app.inject({ method: 'GET', url: `/redirect.php/direct/${origin}/video/file.mp4?download=1` })
    ])

    for (const response of [twoToken, oneToken, dotted]) {
      expect(response.statusCode).toBe(302)
      expect(response.headers.location).toBe('https://cdn.example.test/root/video/file.mp4?download=1')
    }
  })

  it('rejects unauthenticated and non-HTTP legacy redirect targets', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const security = new Security(secureSalt)
    const scriptTarget = security.encryptURL('javascript:alert(1)')

    const [malformed, nonHttp] = await Promise.all([
      app.inject({ method: 'GET', url: '/redirect/direct/not-a-token/file.mp4' }),
      app.inject({ method: 'GET', url: `/redirect/direct/${scriptTarget}/file.mp4` })
    ])

    for (const response of [malformed, nonHttp]) {
      expect(response.statusCode).toBe(400)
      expect(response.body).toContain('400 Bad Request')
      expect(response.headers.location).toBeUndefined()
    }
  })

  it('serves the sitemap alias and installable web-app assets', async () => {
    app = await buildApp(loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'https://player.example/base/',
      SECURE_SALT: secureSalt
    }))

    const [sitemap, manifest, worker, offline, publicStyle, embedStyle, embedScript] = await Promise.all([
      app.inject({ method: 'GET', url: '/sitemap.xml' }),
      app.inject({ method: 'GET', url: '/manifest.json' }),
      app.inject({ method: 'GET', url: '/sw.js' }),
      app.inject({ method: 'GET', url: '/offline.html' }),
      app.inject({ method: 'GET', url: '/assets/css/gplayer-public.css' }),
      app.inject({ method: 'GET', url: '/assets/css/gplayer-embed.css' }),
      app.inject({ method: 'GET', url: '/assets/js/gplayer-embed.js' })
    ])

    expect(sitemap.statusCode).toBe(200)
    expect(sitemap.headers['content-type']).toContain('application/xml')
    expect(sitemap.body).toContain('<loc>https://player.example/base/changelog/</loc>')

    expect(manifest.statusCode).toBe(200)
    expect(manifest.json()).toEqual(expect.objectContaining({
      name: 'GPlayer',
      display: 'standalone',
      start_url: './'
    }))
    expect(worker.statusCode).toBe(200)
    expect(worker.body).toContain("gplayer-node-public-v26")
    expect(worker.body).toContain("const OFFLINE_URL = scopedUrl('offline.html')")
    expect(worker.body).toContain('.map(scopedUrl)')
    expect(worker.body).not.toContain('main-v3.9.8')
    expect(offline.statusCode).toBe(200)
    expect(publicStyle.statusCode).toBe(200)
    expect(publicStyle.body).toContain('.public-main')
    expect(publicStyle.body).toContain('color: var(--brand-ink)')
    expect(embedStyle.statusCode).toBe(200)
    expect(embedStyle.body).toContain('[data-gplayer-audio-panel]')
    expect(embedStyle.body).toContain('background: #00638f')
    expect(embedScript.statusCode).toBe(200)
    expect(embedScript.body).toContain("body.dataset.embedOnly !== 'true'")
    expect(embedScript.body).toContain('window.self !== window.top')
    expect(embedScript.body).toContain('provider.dataset.deferredSource')
    expect(embedScript.body).toContain("/assets/vendor/plyr/3.6.3/plyr-custom.polyfilled.min.js")
    expect(embedScript.body).toContain("/assets/vendor/jwplayer/jwplayer.js")
    expect(embedScript.body).toContain('window.gdPlyr = instance')
    expect(embedScript.body).toContain('window.jwp = instance')
    expect(embedScript.body).toContain("body.dataset.activePlayer = 'native'")
    expect(embedScript.body).toContain('tagUrl: vastConfig.schedule[0].tag')
    expect(embedScript.body).toContain('advertising: vastConfig')
    expect(embedScript.body).toContain("import('/assets/vendor/p2p-media-loader-hlsjs/2.2.1/p2p-media-loader-hlsjs.es.min.js')")
    expect(embedScript.body).toContain("body.dataset.p2pTransport = 'hls'")
    expect(embedScript.body).toContain("body.dataset.p2pTransport = 'dash'")
    expect(embedScript.body).toContain('waitForHlsManifest')
    expect(embedScript.body).toContain('body.dataset.playerQuality')
    expect(embedScript.body).toContain('data-gplayer-audio-menu')
    expect(embedScript.body).toContain('shakaPlayer.selectTextTrack(track)')
    expect(embedScript.body).toContain("storage: { enabled: false, key: 'plyr' }")
    expect(embedScript.body).toContain("settings.setAttribute('aria-label', 'Settings')")
  })
})
