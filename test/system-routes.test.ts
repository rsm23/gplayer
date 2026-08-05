import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { loadConfig } from '../src/config.js'
import { Security } from '../src/security/security.js'
import { SettingsAdminService } from '../src/settings/settings-admin-service.js'
import { renderLandingContact } from '../src/http/system-routes.js'

let app: FastifyInstance | undefined
const secureSalt = '1234567890123456'
const systemUserAgent = 'GPlayer system route test'
const adminToken = 'system-admin-token-1234567890'
const memberToken = 'system-member-token-1234567890'
const systemAdmin: AuthUser = Object.freeze({ id: 1, username: 'admin', email: 'admin@gplayer.local', name: 'Admin', role: 0, status: 1, created: 1, updated: 1 })
const systemMember: AuthUser = Object.freeze({ ...systemAdmin, id: 2, username: 'member', email: 'member@gplayer.local', name: 'Member', role: 2 })

class SystemRouteAuthStore implements AuthStore {
  public async findUserByIdentifier(): Promise<StoredAuthUser | null> { return null }
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

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('legacy-compatible system routes', () => {
  it('serves the Node landing page and its generator assets', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))

    const page = await app.inject({ method: 'GET', url: '/' })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.body).toContain('One runtime. Every source.')
    expect(page.body).toContain('id="player-form"')
    expect(page.body).toContain('name="id"')
    expect(page.body).toContain('id="product-demo"')
    expect(page.body).toContain('./assets/img/product/gplayer-generator.png')
    expect(page.body).toContain('rel="manifest" href="./manifest.json"')
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

    const [anonymousPage, anonymousGenerator] = await Promise.all([
      app.inject({ method: 'GET', url: '/?generator=1' }),
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

  it.each([
    ['/embed.php?id=abc', '/e/?id=abc'],
    ['/embed2.php?id=abc', '/r/?id=abc']
  ])('preserves old PHP redirect compatibility for %s', async (url, location) => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const response = await app.inject({ method: 'GET', url })
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe(location)
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

    const [twoToken, oneToken] = await Promise.all([
      app.inject({ method: 'GET', url: `/redirect/direct/${origin}/video/file.mp4?download=1` }),
      app.inject({ method: 'GET', url: `/redirect/${origin}/video/file.mp4?download=1` })
    ])

    for (const response of [twoToken, oneToken]) {
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

    const [sitemap, manifest, worker, offline, publicStyle, embedScript] = await Promise.all([
      app.inject({ method: 'GET', url: '/sitemap.xml' }),
      app.inject({ method: 'GET', url: '/manifest.json' }),
      app.inject({ method: 'GET', url: '/sw.js' }),
      app.inject({ method: 'GET', url: '/offline.html' }),
      app.inject({ method: 'GET', url: '/assets/css/gplayer-public.css' }),
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
    expect(embedScript.statusCode).toBe(200)
    expect(embedScript.body).toContain("body.dataset.embedOnly !== 'true'")
    expect(embedScript.body).toContain('window.self !== window.top')
    expect(embedScript.body).toContain('provider.dataset.deferredSource')
    expect(embedScript.body).toContain("/assets/vendor/plyr/3.6.3/plyr-custom.polyfilled.min.js")
    expect(embedScript.body).toContain("/assets/vendor/jwplayer/jwplayer.js")
    expect(embedScript.body).toContain('window.gdPlyr = instance')
    expect(embedScript.body).toContain('window.jwp = instance')
    expect(embedScript.body).toContain("body.dataset.activePlayer = 'native'")
  })
})
