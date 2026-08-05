import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { Security } from '../src/security/security.js'

let app: FastifyInstance | undefined
const secureSalt = '1234567890123456'

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

    const [sitemap, manifest, worker, offline, publicStyle] = await Promise.all([
      app.inject({ method: 'GET', url: '/sitemap.xml' }),
      app.inject({ method: 'GET', url: '/manifest.json' }),
      app.inject({ method: 'GET', url: '/sw.js' }),
      app.inject({ method: 'GET', url: '/offline.html' }),
      app.inject({ method: 'GET', url: '/assets/css/gplayer-public.css' })
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
    expect(worker.body).toContain("const OFFLINE_URL = scopedUrl('offline.html')")
    expect(worker.body).toContain('.map(scopedUrl)')
    expect(worker.body).not.toContain('main-v3.9.8')
    expect(offline.statusCode).toBe(200)
    expect(publicStyle.statusCode).toBe(200)
    expect(publicStyle.body).toContain('.public-main')
  })
})
