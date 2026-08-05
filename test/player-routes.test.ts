import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { parsePlayerQuery } from '../src/core/player-query.js'
import { Security } from '../src/security/security.js'

let app: FastifyInstance | undefined
const secureSalt = '1234567890123456'

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('player HTTP routes', () => {
  it('creates legacy-shaped player links from form data', async () => {
    app = await buildApp(loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'https://player.example/base/',
      SECURE_SALT: secureSalt
    }))
    const response = await app.inject({
      method: 'POST',
      url: '/ajax/public/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=createPlayer&id=https%3A%2F%2Fstreamwish.to%2Fe%2Fabc&poster=https%3A%2F%2Fimg.example%2Fp.jpg'
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.status).toBe('ok')
    expect(body.result.embed_url).toMatch(/^https:\/\/player\.example\/base\/e\/\?/)
    expect(body.result.download_url).toMatch(/^https:\/\/player\.example\/base\/d\/\?/)
    expect(body.result.request_url).toContain('/base/r/?host=streamhg&id=abc')

    const token = new URL(body.result.embed_url).search.slice(1)
    const parsed = parsePlayerQuery(token, new Security(secureSalt), { secureSalt })
    expect(parsed.media).toEqual({
      host: 'streamhg',
      id: 'abc',
      poster: 'https://img.example/p.jpg'
    })
  })

  it('converts the plaintext request URL into an authenticated embed redirect', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const response = await app.inject({
      method: 'GET',
      url: '/r/?host=vidhide&id=legacy-id&poster='
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toMatch(/^\/e\/\?/)
    const token = response.headers.location?.split('?', 2)[1] ?? ''
    const parsed = parsePlayerQuery(token, new Security(secureSalt), { secureSalt })
    expect(parsed.media).toEqual({ host: 'earnvids', id: 'legacy-id', poster: '' })
  })

  it('renders authenticated direct media with player options and subtitles', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const security = new Security(secureSalt)
    const token = security.encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Flive.m3u8&poster=https%3A%2F%2Fcdn.example%2Fposter.jpg&sub[]=https%3A%2F%2Fcdn.example%2Fen.vtt&lang[]=English')
    const response = await app.inject({
      method: 'GET',
      url: `/e/?${token}&autoplay=1&mute=1&repeat=1`
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
    expect(response.body).toContain('<video id="media-player"')
    expect(response.body).toContain(' autoplay muted loop')
    expect(response.body).toContain('data-source-kind="hls"')
    expect(response.body).toMatch(/data-source="\/hls\/[A-Za-z0-9_,\-]+\/[A-Za-z0-9_,\-]+"/)
    expect(response.body).not.toContain('data-source="https://cdn.example/live.m3u8"')
    expect(response.body).toContain('/assets/vendor/hls.js/1.6.4/hls.min.js')
    expect(response.body).toContain('<track kind="subtitles"')
    expect(response.body).toContain('label="English"')
    expect(response.body).toMatch(/poster="\/poster\/[A-Za-z0-9_,\-]+\.jpg"/)
    expect(response.body).toMatch(/src="\/subtitle\/[A-Za-z0-9_,\-]+\.vtt"/)
    expect(response.body).not.toContain('src="https://cdn.example/en.vtt"')
  })

  it('renders the legacy single-subs field through the WebVTT compatibility route', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const token = new Security(secureSalt).encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4&poster=&subs=https%3A%2F%2Fcdn.example%2Flegacy.srt')
    const response = await app.inject({ method: 'GET', url: `/e/?${token}` })

    expect(response.statusCode).toBe(200)
    expect(response.body).toMatch(/src="\/subtitle\/[A-Za-z0-9_,\-]+\.vtt"/)
    expect(response.body).toContain('label="Subtitle 1"')
  })

  it('renders a safe native provider embed for recognized major hosts', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const token = new Security(secureSalt).encryptURL('host=youtube&id=video-id&poster=')
    const response = await app.inject({ method: 'GET', url: `/e/?${token}` })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('https://www.youtube-nocookie.com/embed/video-id')
    expect(response.body).toContain('sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"')
  })

  it('routes MPEG-DASH manifests through the authenticated proxy and loads Shaka Player', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const token = new Security(secureSalt).encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Flive%2Fmanifest.mpd&poster=')
    const response = await app.inject({ method: 'GET', url: `/e/?${token}` })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('data-source-kind="dash"')
    expect(response.body).toMatch(/data-source="\/mpd\/[A-Za-z0-9_,\-]+\/[A-Za-z0-9_,\-]+"/)
    expect(response.body).toContain('/assets/vendor/shaka-player/4.13.4/shaka-player.compiled.js')
  })

  it('rejects malformed embed tokens without reflecting them', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const response = await app.inject({ method: 'GET', url: '/e/?not-a-valid-token' })

    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('Player unavailable')
    expect(response.body).not.toContain('not-a-valid-token')
  })

  it('renders direct media and subtitle downloads from an authenticated link', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const token = new Security(secureSalt).encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fmedia%2Fmovie.mp4&sub[]=https%3A%2F%2Fcdn.example%2Fcaptions%2Fen.vtt&lang[]=English')
    const response = await app.inject({ method: 'GET', url: `/d/?${token}` })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow')
    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
    expect(response.body).toContain('<h1 id="download-title">movie.mp4</h1>')
    expect(response.body).toContain('href="https://cdn.example/media/movie.mp4"')
    expect(response.body).toContain('Download English')
    expect(response.body).toContain('href="https://cdn.example/captions/en.vtt"')
    expect(response.body).toContain(`href="/e/?${token}"`)
  })

  it('provides authenticated alternative-server switching on download pages', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const security = new Security(secureSalt)
    const token = security.encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fprimary.mp4&ahost=direct&aid=https%3A%2F%2Fbackup.example%2Ffallback.mp4&poster=')
    const response = await app.inject({ method: 'GET', url: `/d/?${token}` })

    expect(response.statusCode).toBe(200)
    const match = response.body.match(/href="(\/d\/\?[^\"]+)">Use alternative server/)
    expect(match?.[1]).toBeDefined()
    const alternativeToken = match?.[1]?.split('?', 2)[1] ?? ''
    const parsed = parsePlayerQuery(alternativeToken.replaceAll('&amp;', '&'), security, { secureSalt })
    expect(parsed.media).toEqual({ host: 'direct', id: 'https://backup.example/fallback.mp4', poster: '' })
  })

  it('links recognized providers to their source page without claiming direct extraction', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const token = new Security(secureSalt).encryptURL('host=streamhg&id=provider-id&poster=')
    const response = await app.inject({ method: 'GET', url: `/d/?${token}` })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('Open source page')
    expect(response.body).toContain('href="https://hglink.to/provider-id"')
    expect(response.body).toContain('Direct-file extraction will be enabled')
  })

  it('rejects malformed download tokens without reflecting them', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const response = await app.inject({ method: 'GET', url: '/d/?malformed-private-value' })

    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('Download unavailable')
    expect(response.body).not.toContain('malformed-private-value')
  })

  it('returns the legacy AJAX failure envelope for bad input', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const response = await app.inject({ method: 'POST', url: '/ajax/public/', payload: {} })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      status: 'fail',
      message: 'Main video URL is required',
      result: null
    })
  })
})
