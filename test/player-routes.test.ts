import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { parsePlayerQuery } from '../src/core/player-query.js'
import { P2P_CORE_IMPORT_MAP_CSP_HASH } from '../src/player/embed-page.js'
import { Security } from '../src/security/security.js'
import { SettingsAdminService } from '../src/settings/settings-admin-service.js'
import { AuthService, type AuthStore, type AuthUser } from '../src/auth/auth-service.js'

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

  it('captures generated public videos under the configured account without changing the response contract', async () => {
    const capturePublicVideo = vi.fn(async () => ({ status: 'ok', message: 'saved', id: '44' }))
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({
        getAll: async () => ({ save_public_video: 'true', public_video_user: '7' }),
        upsertMany: async () => {}
      }),
      videos: {
        capturePublicVideo,
        savedQuery: async () => null
      } as never
    })
    const response = await app.inject({
      method: 'POST',
      url: '/ajax/public/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=createPlayer&id=https%3A%2F%2Fcdn.example%2Fpublic.mp4&sub[]=https%3A%2F%2Fcaptions.example%2Fen.vtt&lang[]=English'
    })

    expect(response.json()).toMatchObject({ status: 'ok', message: '', result: { embed_url: expect.any(String) } })
    expect(capturePublicVideo).toHaveBeenCalledWith({
      host: 'direct',
      id: 'https://cdn.example/public.mp4',
      poster: '',
      sub: ['https://captions.example/en.vtt'],
      lang: ['English']
    }, '7')

    capturePublicVideo.mockRejectedValueOnce(new Error('database unavailable'))
    const isolatedFailure = await app.inject({
      method: 'POST',
      url: '/ajax/public/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=createPlayer&id=https%3A%2F%2Fcdn.example%2Fstill-plays.mp4'
    })
    expect(isolatedFailure.json()).toMatchObject({ status: 'ok', message: '', result: { embed_url: expect.any(String) } })
  })

  it('captures signed playback views through both modern and legacy AJAX contracts', async () => {
    const capture = vi.fn(async (): Promise<string | null> => '77')
    const values = { visit_counter: '2', visit_counter_runtime: '12' }
    app = await buildApp(loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'https://player.example/',
      SECURE_SALT: secureSalt
    }), {
      settings: new SettingsAdminService({ getAll: async () => values, upsertMany: async () => {} }),
      viewCounter: { capture },
      videos: {
        savedQuery: async (identity: string) => identity === 'movie-slug'
          ? { host: 'direct', id: 'https://cdn.example.test/movie.mp4', title: 'Movie' }
          : null
      } as never
    })
    const token = new Security(secureSalt).encryptURL('source=db&id=movie-slug')
    const modern = await app.inject({
      method: 'POST',
      url: '/ajax/public/',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Playback Browser' },
      payload: `action=statCounter&data=${encodeURIComponent(token)}`
    })
    const legacy = await app.inject({
      method: 'GET',
      url: `/ajax/?action=statCounter&data=${encodeURIComponent(token)}`,
      headers: { 'user-agent': 'Legacy Playback Browser' }
    })

    expect(modern.json()).toEqual({ status: 'ok', message: 'Total daily visits successfully created', result: '77' })
    expect(legacy.json()).toEqual({ status: 'ok', message: 'Total daily visits successfully created', result: '77' })
    expect(modern.headers['cache-control']).toBe('private, no-store')
    expect(capture).toHaveBeenNthCalledWith(1, {
      media: { source: 'db', id: 'movie-slug' },
      clientIp: '127.0.0.1',
      userAgent: 'Playback Browser',
      maximum: 2
    })
    expect(capture).toHaveBeenNthCalledWith(2, expect.objectContaining({ userAgent: 'Legacy Playback Browser', maximum: 2 }))

    const embed = await app.inject({ method: 'GET', url: `/e/?${token}` })
    expect(embed.body).toContain(`data-view-counter-token="${token}"`)
    expect(embed.body).toContain('data-view-counter-runtime="12"')
    const runtime = await app.inject({ method: 'GET', url: '/assets/js/gplayer-embed.js' })
    expect(runtime.body).toContain("new URLSearchParams({ action: 'statCounter', data: token })")
    expect(runtime.body).toContain("window.fetch('/ajax/public/'")

    capture.mockResolvedValueOnce(null)
    const capped = await app.inject({
      method: 'POST',
      url: '/ajax/public/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `action=statCounter&data=${encodeURIComponent(token)}`
    })
    expect(capped.json()).toEqual({ status: 'fail', message: 'Total daily visits have been exceeded', result: 0 })

    const invalid = await app.inject({ method: 'GET', url: '/ajax/?action=statCounter&data=malformed' })
    expect(invalid.json()).toEqual({ status: 'fail', message: 'Total daily visits have been exceeded', result: 0 })
    expect(capture).toHaveBeenCalledTimes(3)
  })

  it('invalidates signed playback source caches through the recovered public AJAX contract', async () => {
    const invalidateSource = vi.fn(async () => true)
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      sourceApi: {
        resolve: async () => ({ sources: [], tracks: [], referer: '', title: '', email: '', image: '', cookies: [], filmstrip: '', clientip: '' }),
        invalidateSource,
        supportedHosts: new Set(['direct', 'streamhg'])
      }
    })
    const token = new Security(secureSalt).encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4&ahost=streamhg&aid=backup-id')

    const legacy = await app.inject({
      method: 'GET',
      url: `/ajax/public/?action=clearVideoCache&data=${encodeURIComponent(token)}`
    })
    expect(legacy.statusCode).toBe(200)
    expect(legacy.headers['cache-control']).toBe('private, no-store')
    expect(legacy.json()).toEqual({
      status: 'ok',
      message: 'The video cache cleared successfully',
      result: { clear_video_sources: true }
    })
    expect(invalidateSource).toHaveBeenCalledWith({
      host: 'direct',
      id: 'https://cdn.example/movie.mp4'
    })

    const invalid = await app.inject({
      method: 'POST',
      url: '/ajax/public/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=clearVideoCache&data=malformed'
    })
    expect(invalid.json()).toEqual({
      status: 'fail',
      message: 'Failed to clear the cache of the video or the video does not exist',
      result: []
    })
    expect(invalidateSource).toHaveBeenCalledOnce()
  })

  it('consumes custom provider domains, source-page templates, and display names', async () => {
    const values = {
      'custom-hostnames': JSON.stringify({ youtube: ['video.private.example'] }),
      'download-urls': JSON.stringify({ youtube: 'https://watch.example/source/%s' }),
      custom_names: JSON.stringify({ youtube: 'Video server 1' })
    }
    app = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({ getAll: async () => values, upsertMany: async () => {} })
    })
    const generated = await app.inject({
      method: 'POST',
      url: '/ajax/public/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=createPlayer&id=https%3A%2F%2Fvideo.private.example%2Fwatch%3Fv%3Dcustom-id'
    })
    expect(generated.statusCode).toBe(200)
    const result = generated.json().result
    const token = new URL(result.embed_url).search.slice(1)
    expect(parsePlayerQuery(token, new Security(secureSalt), { secureSalt }).media).toEqual({
      host: 'youtube',
      id: 'custom-id',
      poster: ''
    })

    const download = await app.inject({ method: 'GET', url: `/d/?${token}` })
    expect(download.statusCode).toBe(200)
    expect(download.body).toContain('href="https://watch.example/source/custom-id"')
    expect(download.body).toContain('Video server 1 source recognized')
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

  it('enforces disabled public request, subtitle insertion, and download-page settings', async () => {
    const values = {
      enable_request_url: 'false',
      enable_json_subtitles: 'false',
      enable_download_page: 'false',
      enable_download_button: 'true'
    }
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({ getAll: async () => values, upsertMany: async () => {} })
    })
    const generated = await app.inject({
      method: 'POST',
      url: '/ajax/public/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=createPlayer&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4&sub[]=https%3A%2F%2Fcdn.example%2Fen.vtt&lang[]=English&subs=https%3A%2F%2Fcdn.example%2Fcaptions.json'
    })
    const token = new URL(generated.json().result.embed_url).search.slice(1)
    expect(parsePlayerQuery(token, new Security(secureSalt), { secureSalt }).media).toEqual({
      host: 'direct',
      id: 'https://cdn.example/movie.mp4',
      poster: ''
    })

    const request = await app.inject({ method: 'GET', url: '/r/?host=direct&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4' })
    expect(request.statusCode).toBe(403)
    expect(request.json()).toEqual({ status: 'fail', message: 'Access denied', result: null })

    const embed = await app.inject({ method: 'GET', url: `/e/?${token}` })
    expect(embed.statusCode).toBe(200)
    expect(embed.body).not.toContain(`href="/d/?${token}"`)

    const download = await app.inject({ method: 'GET', url: `/d/?${token}` })
    expect(download.statusCode).toBe(403)
    expect(download.body).toContain('The download page is disabled.')
  })

  it('enforces embed-only mode for explicit top-level browser navigation', async () => {
    const values = { embed_only: 'true' }
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({ getAll: async () => values, upsertMany: async () => {} })
    })
    const token = new Security(secureSalt).encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4&poster=')

    const [topLevel, iframe, ambiguousChromium, legacyClient] = await Promise.all([
      app.inject({ method: 'GET', url: `/e/?${token}`, headers: { 'sec-fetch-dest': 'document' } }),
      app.inject({ method: 'GET', url: `/e/?${token}`, headers: { 'sec-fetch-dest': 'iframe' } }),
      app.inject({ method: 'GET', url: `/e/?${token}`, headers: { 'sec-fetch-dest': 'empty' } }),
      app.inject({ method: 'GET', url: `/e/?${token}` })
    ])

    expect(topLevel.statusCode).toBe(403)
    expect(topLevel.body).toContain('available only when embedded')
    expect(topLevel.headers['cache-control']).toBe('private, no-store')
    expect(iframe.statusCode).toBe(200)
    expect(iframe.body).toContain('<video id="media-player"')
    expect(iframe.body).toContain('data-embed-only="true"')
    expect(iframe.body).not.toContain(' src="https://cdn.example/movie.mp4"')
    expect(ambiguousChromium.statusCode).toBe(200)
    expect(legacyClient.statusCode).toBe(200)
    expect(legacyClient.body).toContain('<video id="media-player"')
  })

  it('renders and submits the credentialed Drive sharer with legacy response fields', async () => {
    const values = {
      enable_gsharer: 'true',
      recaptcha_site_key: 'site-key-123',
      recaptcha_secret_key: 'secret-key-123'
    }
    const captchaCalls: Array<readonly [string, string]> = []
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({ getAll: async () => values, upsertMany: async () => {} }),
      driveSharer: {
        bypass: async (input) => input.includes('sourceFileABC')
          ? { id: 'copiedFileXYZ', link: 'https://drive.google.com/file/d/copiedFileXYZ/view' }
          : null
      },
      recaptchaVerifier: {
        verify: async (_secret, responseToken, remoteIp) => {
          captchaCalls.push([responseToken, remoteIp])
          return responseToken === 'captcha-ok'
        }
      }
    })

    const page = await app.inject({ method: 'GET', url: '/sharer/' })
    expect(page.statusCode).toBe(200)
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.headers['content-security-policy']).toContain('https://www.google.com')
    expect(page.headers['content-security-policy']).toContain("connect-src 'self'")
    expect(page.body).toContain('Google Drive Bypass Engine')
    expect(page.body).toContain('id="frmBypassLimit"')
    expect(page.body).toContain('name="gdrive_id"')
    expect(page.body).toContain('data-sitekey="site-key-123"')
    expect(page.body).toContain('/assets/js/gplayer-sharer.js')
    const script = await app.inject({ method: 'GET', url: '/assets/js/gplayer-sharer.js' })
    expect(script.statusCode).toBe(200)
    expect(script.body).toContain("form.getAttribute('action')")

    const rejected = await app.inject({
      method: 'POST',
      url: '/ajax/public/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=gdriveBypassLimit&gdrive_id=sourceFileABC&g-recaptcha-response=captcha-bad'
    })
    expect(rejected.json()).toEqual({
      status: 'fail', message: 'The security code you entered is incorrect! Try again', result: null
    })

    const bypassed = await app.inject({
      method: 'POST',
      url: '/ajax/public/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=gdriveBypassLimit&gdrive_id=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2FsourceFileABC%2Fview&g-recaptcha-response=captcha-ok'
    })
    expect(bypassed.json()).toEqual({
      status: 'ok',
      message: 'The file has been successfully bypassed',
      result: { id: 'copiedFileXYZ', link: 'https://drive.google.com/file/d/copiedFileXYZ/view' }
    })
    expect(captchaCalls).toHaveLength(2)
  })

  it('keeps the Drive sharer disabled by default while allowing an administrator to inspect its page', async () => {
    const admin: AuthUser = Object.freeze({
      id: 1,
      username: 'admin',
      email: 'admin@example.test',
      name: 'Admin',
      role: 0,
      status: 1,
      created: 1,
      updated: 1
    })
    const authStore: AuthStore = {
      findUserByIdentifier: async () => null,
      findActiveSession: async () => admin,
      createSession: async () => {},
      recordFailedLogin: async () => {},
      revokeSession: async () => true
    }
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      auth: new AuthService(authStore),
      settings: new SettingsAdminService({ getAll: async () => ({}), upsertMany: async () => {} })
    })

    const forbidden = await app.inject({ method: 'GET', url: '/sharer/' })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.body).toContain('403 Forbidden')

    const adminPage = await app.inject({
      method: 'GET',
      url: '/sharer/',
      headers: { authorization: 'Bearer admin-token-123', 'user-agent': 'Drive admin test' }
    })
    expect(adminPage.statusCode).toBe(200)
    expect(adminPage.body).toContain('Google Drive Bypass Engine')

    const disabledAction = await app.inject({
      method: 'POST',
      url: '/ajax/public/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=gdriveBypassLimit&gdrive_id=sourceFileABC'
    })
    expect(disabledAction.json()).toEqual({ status: 'fail', message: 'This feature is disabled', result: null })
  })

  it('strips subtitles from enabled plaintext request URLs when public insertion is disabled', async () => {
    const values = { enable_request_url: 'true', enable_json_subtitles: 'false' }
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({ getAll: async () => values, upsertMany: async () => {} })
    })
    const response = await app.inject({
      method: 'GET',
      url: '/r/?host=direct&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4&sub[]=https%3A%2F%2Fcdn.example%2Fen.vtt&lang[]=English&subs=https%3A%2F%2Fcdn.example%2Fcaptions.json'
    })

    expect(response.statusCode).toBe(302)
    const token = response.headers.location?.split('?', 2)[1] ?? ''
    expect(parsePlayerQuery(token, new Security(secureSalt), { secureSalt }).media).toEqual({
      host: 'direct',
      id: 'https://cdn.example/movie.mp4'
    })
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
    expect(response.headers['content-security-policy']).not.toContain("'unsafe-eval'")
    expect(response.headers['content-security-policy']).not.toContain('imasdk.googleapis.com')
    expect(response.body).toContain('<video id="media-player"')
    expect(response.body).toContain(' autoplay muted loop')
    expect(response.body).toContain('data-source-kind="hls"')
    expect(response.body).toMatch(/data-source="\/hls\/[A-Za-z0-9_,\-]+\/[A-Za-z0-9_,\-]+\?gt=[A-Za-z0-9_%\-]+"/)
    expect(response.body).not.toContain('data-source="https://cdn.example/live.m3u8"')
    expect(response.body).toContain('data-player-library="jwplayer"')
    expect(response.body).not.toContain('/assets/vendor/hls.js/1.6.4/hls.min.js')
    expect(response.body).toContain('<track kind="subtitles"')
    expect(response.body).toContain('label="English"')
    expect(response.body).toMatch(/poster="\/poster\/[A-Za-z0-9_,\-]+\.jpg"/)
    expect(response.body).toMatch(/src="\/subtitle\/[A-Za-z0-9_,\-]+\.vtt"/)
    expect(response.body).not.toContain('src="https://cdn.example/en.vtt"')
  })

  it('renders configured analytics on player and download surfaces without executing the compatibility widget', async () => {
    const widgetPayload = '<script>globalThis.compatibilityWidgetExecuted = true</script>'
    const values = {
      google_analytics_id: 'G-ABC1234',
      google_tag_manager: 'GTM-TEST123',
      histats_id: '3590204',
      chat_widget: widgetPayload
    }
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({ getAll: async () => values, upsertMany: async () => {} })
    })
    const token = new Security(secureSalt).encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4&poster=')

    const embed = await app.inject({ method: 'GET', url: `/e/?${token}` })
    expect(embed.statusCode).toBe(200)
    expect(embed.body).toContain('data-google-analytics-id="G-ABC1234"')
    expect(embed.body).toContain('data-google-tag-manager-id="GTM-TEST123"')
    expect(embed.body).toContain('data-histats-id="3590204"')
    expect(embed.body).toContain('src="/assets/js/gplayer-analytics.js"')
    expect(embed.body).toContain('ns.html?id=GTM-TEST123')
    expect(embed.body).toContain('0.gif?3590204&amp;101')
    expect(embed.body).not.toContain(widgetPayload)
    expect(embed.body).not.toContain('compatibilityWidgetExecuted')
    expect(embed.headers['content-security-policy']).toContain('https://www.googletagmanager.com')
    expect(embed.headers['content-security-policy']).toContain('https://s10.histats.com')

    const download = await app.inject({ method: 'GET', url: `/d/?${token}` })
    expect(download.statusCode).toBe(200)
    expect(download.body).toContain('data-google-analytics-id="G-ABC1234"')
    expect(download.body).toContain('ns.html?id=GTM-TEST123')
    expect(download.body).not.toContain(widgetPayload)
    expect(download.headers['content-security-policy']).toContain('https://www.googletagmanager.com')
    expect(download.headers['content-security-policy']).toContain('https://*.histats.com')

    const downloadError = await app.inject({ method: 'GET', url: '/d/?not-a-valid-token' })
    expect(downloadError.statusCode).toBe(400)
    expect(downloadError.body).toContain('data-google-analytics-id=""')
    expect(downloadError.body).toContain('data-google-tag-manager-id=""')
    expect(downloadError.body).toContain('data-histats-id="3590204"')
    expect(downloadError.body).not.toContain('ns.html?id=')
    expect(downloadError.headers['content-security-policy']).not.toContain('googletagmanager.com')
    expect(downloadError.headers['content-security-policy']).toContain('s10.histats.com')

    const runtime = await app.inject({ method: 'GET', url: '/assets/js/gplayer-analytics.js' })
    expect(runtime.statusCode).toBe(200)
    expect(runtime.body).toContain('https://www.googletagmanager.com/gtag/js')
    expect(runtime.body).toContain('https://s10.histats.com/js15_as.js')
    expect(runtime.body).not.toContain('eval(')
  })

  it('keeps malformed analytics settings inert and the default CSP narrow', async () => {
    const payload = 'G-ABC123</meta><script>globalThis.analyticsInjected=true</script>'
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({
        getAll: async () => ({
          google_analytics_id: payload,
          google_tag_manager: 'https://attacker.example/tag.js',
          histats_id: '1&script=bad',
          chat_widget: '<img src=x onerror=alert(1)>'
        }),
        upsertMany: async () => {}
      })
    })
    const token = new Security(secureSalt).encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4&poster=')

    const embed = await app.inject({ method: 'GET', url: `/e/?${token}` })
    expect(embed.body).not.toContain('gplayer-analytics.js')
    expect(embed.body).not.toContain('analyticsInjected')
    expect(embed.body).not.toContain('onerror=')
    expect(embed.headers['content-security-policy']).not.toContain('s10.histats.com')

    const download = await app.inject({ method: 'GET', url: `/d/?${token}` })
    expect(download.body).not.toContain('gplayer-analytics.js')
    expect(download.body).not.toContain('attacker.example')
    expect(download.headers['content-security-policy']).not.toContain('googletagmanager.com')
    expect(download.headers['content-security-policy']).toContain("connect-src 'none'")
  })

  it('consumes direct, popup, banner, and anti-adblock settings in isolated public runtimes', async () => {
    const values = {
      block_adblocker: 'true',
      disable_vast_ads: 'true',
      disable_popup_ads: 'false',
      popup_load_offset: '4',
      popup_ads_link: 'https://ads.example/popup.js',
      popup_ads_code: '<script>globalThis.popupLoaded = true</script>',
      disable_banner_ads: 'false',
      dl_banner_top: '<a href="https://sponsor.example/top">Top sponsor</a>',
      dl_banner_bottom: '<div>Bottom sponsor</div>',
      disable_direct_ads: 'false',
      direct_ads_link: 'https://campaign.example/visit',
      visitads_onplay: 'true',
      show_iframeads: 'true'
    }
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({
        getAll: async () => values,
        upsertMany: async () => {}
      })
    })
    const token = new Security(secureSalt).encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4&poster=')

    const embed = await app.inject({ method: 'GET', url: `/e/?${token}` })
    expect(embed.statusCode).toBe(200)
    expect(embed.headers['content-security-policy']).toContain('https://campaign.example')
    expect(embed.body).toContain('data-block-adblocker="true"')
    expect(embed.body).toContain('data-direct-ad-url="https://campaign.example/visit"')
    expect(embed.body).toContain('data-direct-ad-on-play="true"')
    expect(embed.body).toContain('data-direct-ad-iframe="true"')
    expect(embed.body).toContain('data-popup-frame-url="/ads/frame/popup"')
    expect(embed.body).toContain('data-popup-delay-seconds="4"')
    expect(embed.body).toContain('data-direct-ad-panel')
    expect(embed.body).toContain('data-adblock-notice')
    expect(embed.body).toContain('/assets/js/gplayer-embed.js')

    const popup = await app.inject({ method: 'GET', url: '/ads/frame/popup' })
    expect(popup.statusCode).toBe(200)
    expect(popup.headers['content-security-policy']).toContain('sandbox allow-scripts allow-forms allow-popups')
    expect(popup.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(popup.body).toContain('<script>globalThis.popupLoaded = true</script>')
    expect(popup.body).toContain('src="https://ads.example/popup.js"')

    const download = await app.inject({ method: 'GET', url: `/d/?${token}` })
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-security-policy']).toContain("frame-src 'self'")
    expect(download.headers['content-security-policy']).toContain("script-src 'self'")
    expect(download.body).toContain('src="/ads/frame/download-top"')
    expect(download.body).toContain('src="/ads/frame/download-bottom"')
    expect(download.body).toContain('src="/ads/frame/popup"')
    expect(download.body).toContain('href="https://campaign.example/visit" data-download-target="https://cdn.example/movie.mp4"')
    expect(download.body).toContain('src="/assets/js/gplayer-download.js"')
    expect(download.body).not.toContain('onclick=')
    expect(download.body).not.toContain('Top sponsor')

    const downloadRuntime = await app.inject({ method: 'GET', url: '/assets/js/gplayer-download.js' })
    expect(downloadRuntime.statusCode).toBe(200)
    expect(downloadRuntime.body).toContain("window.open(target.toString(), '_blank', 'noopener,noreferrer')")

    const top = await app.inject({ method: 'GET', url: '/ads/frame/download-top' })
    expect(top.statusCode).toBe(200)
    expect(top.body).toContain('<a href="https://sponsor.example/top">Top sponsor</a>')

    const bait = await app.inject({ method: 'GET', url: '/ads/advertisement.png' })
    expect(bait.statusCode).toBe(200)
    expect(bait.headers['content-type']).toBe('image/png')
    expect(bait.rawPayload.length).toBeGreaterThan(40)
  })

  it('serializes the complete VAST schedule for the local player runtime', async () => {
    const values = {
      player: 'jwplayer',
      disable_vast_ads: 'false',
      vast_client: 'googima',
      vast_xml: '["https://ads.example/pre.xml","https://ads.example/mid.xml","https://ads.example/post.xml"]',
      vast_offset: '["start","15","75%"]',
      vast_skip: '7'
    }
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({
        getAll: async () => values,
        upsertMany: async () => {}
      })
    })
    const token = new Security(secureSalt).encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4')

    const embed = await app.inject({ method: 'GET', url: `/e/?${token}` })
    expect(embed.statusCode).toBe(200)
    expect(embed.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-eval' https://imasdk.googleapis.com")
    expect(embed.headers['content-security-policy']).toContain('http: https: blob:')
    const serialized = embed.body.match(/<script type="application\/json" data-vast-config>([\s\S]*?)<\/script>/)?.[1]
    expect(serialized).toBeDefined()
    expect(JSON.parse(serialized ?? '')).toEqual({
      client: 'googima',
      schedule: [
        { tag: 'https://ads.example/pre.xml', offset: 'preroll' },
        { tag: 'https://ads.example/mid.xml', offset: '00:00:15' },
        { tag: 'https://ads.example/post.xml', offset: '75%' }
      ],
      skipoffset: 7,
      skipmessage: 'Skip XX',
      creativeTimeout: 60_000,
      loadVideoTimeout: 60_000,
      vastLoadTimeout: 60_000,
      requestTimeout: 60_000,
      placement: 'interstitial',
      vpaidmode: 'insecure',
      withCredentials: false,
      omidSupport: 'enabled',
      maxRedirects: 20
    })
  })

  it('activates the bounded P2P transport and tracker CSP only for compatible media', async () => {
    const values = {
      player: 'plyr',
      p2p: 'true',
      torrent_tracker: 'wss://tracker.example/socket\nws://tracker2.example/announce'
    }
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({ getAll: async () => values, upsertMany: async () => {} })
    })
    const security = new Security(secureSalt)
    const hlsToken = security.encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Flive.m3u8')
    const dashToken = security.encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fmanifest.mpd')

    const hls = await app.inject({ method: 'GET', url: `/e/?${hlsToken}` })
    expect(hls.statusCode).toBe(200)
    expect(hls.headers['content-security-policy']).toContain("'sha256-AiLle+FwOAtYz21T4sfz0xDyuDG9d1tL/UAOz35ZmeI='")
    expect(hls.headers['content-security-policy']).toContain('wss://tracker.example')
    expect(hls.headers['content-security-policy']).toContain('ws://tracker2.example')
    expect(hls.body).toContain('/assets/vendor/p2p-media-loader-core/2.2.1/p2p-media-loader-core.es.min.js')
    const importMap = hls.body.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1] ?? ''
    const importMapHash = `'sha256-${createHash('sha256').update(importMap).digest('base64')}'`
    expect(importMapHash).toBe(P2P_CORE_IMPORT_MAP_CSP_HASH)
    expect(hls.headers['content-security-policy']).toContain(importMapHash)
    const serialized = hls.body.match(/<script type="application\/json" data-p2p-config>([\s\S]*?)<\/script>/)?.[1]
    expect(JSON.parse(serialized ?? '')).toEqual({
      swarmId: expect.stringMatching(/^[a-f0-9]{64}$/),
      trackers: ['wss://tracker.example/socket', 'ws://tracker2.example/announce']
    })

    const dash = await app.inject({ method: 'GET', url: `/e/?${dashToken}` })
    expect(dash.statusCode).toBe(200)
    expect(dash.headers['content-security-policy']).not.toContain(P2P_CORE_IMPORT_MAP_CSP_HASH)
    expect(dash.body).toContain('/assets/vendor/p2p-media-loader-shaka/0.6.2/p2p-media-loader-shaka.min.js')

    const mp4Token = security.encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fvideo.mp4')
    const mp4 = await app.inject({ method: 'GET', url: `/e/?${mp4Token}` })
    expect(mp4.statusCode).toBe(200)
    expect(mp4.headers['content-security-policy']).not.toContain(P2P_CORE_IMPORT_MAP_CSP_HASH)
    expect(mp4.headers['content-security-policy']).not.toContain('tracker.example')
    expect(mp4.body).not.toContain('data-p2p-config')
  })

  it('uses configured player slugs, embed markup, query policy, and native presentation settings', async () => {
    const values = {
      slug_embed: 'watch',
      slug_download: 'fetch',
      slug_request: 'request-player',
      iframe_code: '<iframe class="custom-player" title="{title}" src="{embed_url}"></iframe>',
      allow_public_qry: 'false',
      autoplay: 'true',
      mute: 'true',
      repeat: 'true',
      preload: 'auto',
      stretching: 'exactfit',
      display_title: 'true',
      fake_play_button: 'true',
      continue_watching: 'true',
      pause_on_left: 'true',
      player_color: '095ae5',
      player_color2: '062794',
      poster: 'https://images.example/default.jpg',
      force_default_poster: 'true',
      logo_file: 'https://images.example/logo.png',
      logo_open_link: 'https://brand.example/',
      logo_position: 'bottom-left',
      logo_margin: '12',
      small_logo_file: 'https://images.example/small.png',
      small_logo_link: 'https://brand.example/small',
      enable_share_button: 'true',
      enable_download_button: 'false',
      hide_hostname: 'true',
      text_download: 'Save {title}'
    }
    app = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({ getAll: async () => values, upsertMany: async () => {} })
    })
    const generated = await app.inject({
      method: 'POST',
      url: '/ajax/public/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=createPlayer&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4'
    })
    const result = generated.json().result
    expect(result.embed_url).toMatch(/^https:\/\/player\.example\/watch\/\?/)
    expect(result.download_url).toMatch(/^https:\/\/player\.example\/fetch\/\?/)
    expect(result.request_url).toContain('/request-player/?host=direct')
    expect(result.embed_code).toBe(`<iframe class="custom-player" title="" src="${result.embed_url}"></iframe>`)

    const token = new URL(result.embed_url).search.slice(1)
    const embed = await app.inject({ method: 'GET', url: `/watch/?${token}&autoplay=0&mute=0&repeat=0` })
    expect(embed.statusCode).toBe(200)
    expect(embed.body).toContain(' autoplay muted loop')
    expect(embed.body).toContain('class="player-stretch-exactfit"')
    expect(embed.body).toContain('preload="auto"')
    expect(embed.body).toContain('data-pause-on-left="true"')
    expect(embed.body).toContain('data-continue-watching="true"')
    expect(embed.body).toContain('data-player-fake-play')
    expect(embed.body).toContain('data-player-title')
    expect(embed.body).toContain('https://images.example/logo.png')
    expect(embed.body).toContain('https://images.example/small.png')
    expect(embed.body).toContain('data-player-share')
    expect(embed.body).not.toContain(`href="/fetch/?${token}"`)
    expect(embed.body).toMatch(/poster="\/poster\/[A-Za-z0-9_,\-]+\.jpg"/)

    const requestRedirect = await app.inject({ method: 'GET', url: '/request-player/?host=direct&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4' })
    expect(requestRedirect.statusCode).toBe(302)
    expect(requestRedirect.headers.location).toMatch(/^\/watch\/\?/)

    const download = await app.inject({ method: 'GET', url: `/fetch/?${token}` })
    expect(download.statusCode).toBe(200)
    expect(download.body).toContain('Save movie.mp4')
    expect(download.body).toContain(`href="/watch/?${token}"`)
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

  it('renders extracted providers through signed proxies and publishes an ordered fatal-error fallback', async () => {
    const resolve = vi.fn(async () => ({
      sources: [
        { file: 'https://media.provider.example/master.m3u8', type: 'hls', label: 'Auto' },
        { file: 'https://media.provider.example/1080.mp4', type: 'video/mp4', label: '1080p' }
      ],
      tracks: [{ file: 'https://media.provider.example/en.vtt', label: 'English', language: 'en', default: true }],
      referer: 'https://provider.example/embed/primary-id',
      title: 'Resolved provider title',
      email: '',
      image: 'https://media.provider.example/poster.jpg',
      cookies: [{ name: 'private_session', value: 'must-not-leak' }],
      filmstrip: 'https://media.provider.example/thumbnails.vtt',
      clientip: '127.0.0.1',
      upstream: {
        host: 'streamhg',
        id: 'primary-id',
        userAgent: 'Provider Runtime',
        language: 'en;q=0.9'
      }
    }))
    app = await buildApp(loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'https://player.example/',
      SECURE_SALT: secureSalt
    }), {
      sourceApi: { resolve, supportedHosts: new Set(['streamhg', 'direct']) }
    })
    const security = new Security(secureSalt)
    const token = security.encryptURL('host=streamhg&id=primary-id&ahost=direct&aid=https%3A%2F%2Fbackup.example%2Ffallback.mp4&poster=')
    const response = await app.inject({
      method: 'GET',
      url: `/e/?${token}`,
      headers: { 'user-agent': 'Playback Browser', 'accept-language': 'fr-FR,fr;q=0.9' }
    })

    expect(response.statusCode).toBe(200)
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ host: 'streamhg', id: 'primary-id', ahost: 'direct' }), {
      clientIp: '127.0.0.1',
      userAgent: 'Playback Browser',
      language: 'fr-FR,fr;q=0.9',
      downloadable: false
    })
    expect(response.body).toContain('data-source-kind="hls"')
    expect(response.body).toMatch(/data-source="https:\/\/player\.example\/hls\//)
    expect(response.body).toContain('Resolved provider title')
    expect(response.body).toMatch(/poster="https:\/\/player\.example\/poster\//)
    expect(response.body).toMatch(/src="https:\/\/player\.example\/subtitle\//)
    expect(response.body).toContain('data-player-servers')
    expect(response.body).toContain('<span>StreamHG</span>')
    expect(response.body).toContain('>Direct URL</a>')
    expect(response.body).not.toContain('private_session')
    expect(response.body).not.toContain('must-not-leak')

    const filmstrip = response.body.match(/<script type="application\/json" data-filmstrip-config>([\s\S]*?)<\/script>/)?.[1] ?? ''
    expect(JSON.parse(filmstrip)).toEqual({ file: expect.stringMatching(/^https:\/\/player\.example\/filmstrip\//) })

    const serialized = response.body.match(/<script type="application\/json" data-playback-sources>([\s\S]*?)<\/script>/)?.[1] ?? ''
    expect(JSON.parse(serialized)).toEqual([
      expect.objectContaining({ type: 'hls', label: 'Auto', default: true }),
      expect.objectContaining({ type: 'mp4', label: '1080p', default: false })
    ])
    const fallbackUrl = response.body.match(/data-player-fallback-url="([^"]+)"/)?.[1] ?? ''
    expect(fallbackUrl).toMatch(/^\/e\/\?/)
    expect(parsePlayerQuery(new URL(fallbackUrl, 'https://player.example/').search.slice(1), security, { secureSalt }).media).toEqual({
      host: 'direct',
      id: 'https://backup.example/fallback.mp4',
      poster: ''
    })

    const runtime = await app.inject({ method: 'GET', url: '/assets/js/gplayer-embed.js' })
    expect(response.body).toContain('data-player-cache-token=')
    const cacheToken = response.body.match(/data-player-cache-token="([^"]+)"/)?.[1] ?? ''
    expect(parsePlayerQuery(cacheToken, security, { secureSalt }).media).toEqual({ host: 'streamhg', id: 'primary-id' })
    expect(runtime.body).toContain("instance.on('error', recoverFromPlaybackFailure)")
    expect(runtime.body).toContain("video.addEventListener('error', recoverFromPlaybackFailure)")
    expect(runtime.body).toContain('window.location.replace(fallbackUrl)')
    expect(runtime.body).toContain("new URLSearchParams({ action: 'clearVideoCache', data: cacheToken })")
    expect(runtime.body).toContain("window.fetch('/ajax/public/'")
    expect(runtime.body).toContain('window.location.reload()')
    expect(runtime.body).toContain("window.location.hash = cacheRetryHash")
    expect(runtime.body).toContain("video.addEventListener('canplay', clearCacheRefreshAttempt, { once: true })")
    expect(runtime.body).toContain("kind: 'thumbnails'")
    expect(runtime.body).toContain('previewThumbnails: { enabled: true')
  })

  it('randomly rotates the bounded alternative set without rendering the manual server picker', async () => {
    const resolve = vi.fn(async (query: { host?: string; id?: string }) => ({
      sources: [{ file: 'https://media.provider.example/video.mp4', type: 'video/mp4', label: '720p' }],
      tracks: [],
      referer: '',
      title: 'Randomized source',
      email: '',
      image: '',
      cookies: [],
      filmstrip: '',
      clientip: '127.0.0.1',
      upstream: {
        host: query.host ?? '',
        id: query.id ?? '',
        userAgent: 'Provider Runtime',
        language: 'en'
      }
    }))
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({
        getAll: async () => ({ load_balancer_rand: 'true' }),
        upsertMany: async () => {}
      }),
      sourceApi: { resolve, supportedHosts: new Set(['streamhg', 'direct']) }
    })
    const security = new Security(secureSalt)
    const token = security.encryptURL('host=streamhg&id=primary-id&ahost=direct&aid=https%3A%2F%2Fbackup.example%2Ffallback.mp4&poster=')
    const response = await app.inject({ method: 'GET', url: `/e/?${token}` })

    expect(response.statusCode).toBe(200)
    const selected = resolve.mock.calls[0]?.[0]
    expect([
      ['streamhg', 'primary-id'],
      ['direct', 'https://backup.example/fallback.mp4']
    ]).toContainEqual([selected?.host, selected?.id])
    expect(response.body).not.toContain('data-player-servers')
    const fallbackUrl = response.body.match(/data-player-fallback-url="([^"]+)"/)?.[1] ?? ''
    const fallback = parsePlayerQuery(new URL(fallbackUrl, 'https://player.example/').search.slice(1), security, { secureSalt }).media
    expect(fallback?.host).not.toBe(selected?.host)
  })

  it('enforces misc host and embed-origin policies while retaining direct no-referer compatibility', async () => {
    const values = {
      disable_host: '["youtube"]',
      domain_whitelisted: 'allowed.example',
      domain_blacklisted: 'blocked.example',
      link_blacklisted: 'allowed.example/blocked-path',
      word_blacklisted: 'forbidden'
    }
    app = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({ getAll: async () => values, upsertMany: async () => {} })
    })
    const security = new Security(secureSalt)
    const direct = security.encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4&poster=')
    const youtube = security.encryptURL('host=youtube&id=video-id&poster=')

    const allowed = await app.inject({ method: 'GET', url: `/e/?${direct}`, headers: { referer: 'https://allowed.example/watch' } })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.body).toContain('<video id="media-player"')

    const missingReferer = await app.inject({ method: 'GET', url: `/e/?${direct}` })
    expect(missingReferer.statusCode).toBe(200)

    const internalRedirect = await app.inject({ method: 'GET', url: `/e/?${direct}`, headers: { referer: 'https://player.example/request-player/?host=direct' } })
    expect(internalRedirect.statusCode).toBe(200)

    const disabledAlternative = security.encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4&ahost=youtube&aid=video-id&poster=')
    const mainStillAvailable = await app.inject({ method: 'GET', url: `/e/?${disabledAlternative}`, headers: { referer: 'https://allowed.example/watch' } })
    expect(mainStillAvailable.statusCode).toBe(200)

    for (const referer of ['https://unknown.example/watch', 'https://blocked.example/watch', 'https://allowed.example/blocked-path/']) {
      const blocked = await app.inject({ method: 'GET', url: `/e/?${direct}`, headers: { referer } })
      expect(blocked.statusCode).toBe(403)
      expect(blocked.body).toContain('not allowed')
    }

    const disabled = await app.inject({ method: 'GET', url: `/e/?${youtube}`, headers: { referer: 'https://allowed.example/watch' } })
    expect(disabled.statusCode).toBe(403)

    const forbiddenTitle = security.encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fforbidden-movie.mp4&poster=')
    expect((await app.inject({ method: 'GET', url: `/e/?${forbiddenTitle}`, headers: { referer: 'https://allowed.example/watch' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: `/d/?${forbiddenTitle}` })).statusCode).toBe(403)

    const generator = await app.inject({
      method: 'POST',
      url: '/ajax/public/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=createPlayer&id=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Dvideo-id'
    })
    expect(generator.json()).toMatchObject({ status: 'fail', message: 'This video host is disabled' })
  })

  it('enforces country, VPN, and blocked-browser policy on public player routes', async () => {
    const values = {
      banned_countries: '["FR"]',
      block_vpn: 'true',
      block_vpn_list: '198.51.100.0/24'
    }
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({ getAll: async () => values, upsertMany: async () => {} }),
      countryCodeLookup: async () => 'FR'
    })
    const token = new Security(secureSalt).encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4&poster=')
    const response = await app.inject({ method: 'GET', url: `/e/?${token}`, headers: { 'user-agent': 'VLC/3.0' } })
    expect(response.statusCode).toBe(403)
    expect(response.body).toContain('not allowed')
  })

  it('routes MPEG-DASH manifests through the authenticated proxy and loads Shaka Player', async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }))
    const token = new Security(secureSalt).encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Flive%2Fmanifest.mpd&poster=')
    const response = await app.inject({ method: 'GET', url: `/e/?${token}` })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('data-source-kind="dash"')
    expect(response.body).toMatch(/data-source="\/mpd\/[A-Za-z0-9_,\-]+\/[A-Za-z0-9_,\-]+\?gt=[A-Za-z0-9_%\-]+"/)
    expect(response.body).toContain('data-player-library="jwplayer"')
    expect(response.body).not.toContain('/assets/vendor/shaka-player/4.13.4/shaka-player.compiled.js')
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

  it('shortens only valid download destinations while preserving watch and alternative routes', async () => {
    const transformed: string[] = []
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      shortlinks: {
        shorten: async (target) => {
          transformed.push(target)
          return target.includes('/captions/') ? 'https://short.example/subtitle' : 'https://short.example/media'
        }
      }
    })
    const security = new Security(secureSalt)
    const token = security.encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fmedia%2Fmovie.mp4&ahost=direct&aid=https%3A%2F%2Fbackup.example%2Ffallback.mp4&sub[]=javascript%3Aalert(1)&sub[]=https%3A%2F%2Fcdn.example%2Fcaptions%2Ffr.vtt&lang[]=Wrong&lang[]=French')
    const response = await app.inject({ method: 'GET', url: `/d/?${token}` })

    expect(response.statusCode).toBe(200)
    expect(transformed).toEqual([
      'https://cdn.example/media/movie.mp4',
      'https://cdn.example/captions/fr.vtt'
    ])
    expect(response.body).toContain('href="https://short.example/media"')
    expect(response.body).toContain('href="https://short.example/subtitle"')
    expect(response.body).toContain('Download French')
    expect(response.body).not.toContain('Download Wrong')
    expect(response.body).toContain(`href="/e/?${token}"`)
    expect(response.body).toMatch(/href="\/d\/\?[^\"]+">Use alternative server/)
    expect(response.body).not.toContain('href="https://backup.example/fallback.mp4"')
  })

  it('hides disabled watch and subtitle downloads without transforming hidden destinations', async () => {
    const transformed: string[] = []
    const values = {
      enable_download_page: 'true',
      show_sub_download: 'false',
      show_watch_button: 'false'
    }
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      settings: new SettingsAdminService({ getAll: async () => values, upsertMany: async () => {} }),
      shortlinks: {
        shorten: async (target) => {
          transformed.push(target)
          return 'https://short.example/media'
        }
      }
    })
    const token = new Security(secureSalt).encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fmovie.mp4&ahost=direct&aid=https%3A%2F%2Fbackup.example%2Ffallback.mp4&sub[]=https%3A%2F%2Fcdn.example%2Fen.vtt&lang[]=English')
    const response = await app.inject({ method: 'GET', url: `/d/?${token}` })

    expect(response.statusCode).toBe(200)
    expect(transformed).toEqual(['https://cdn.example/movie.mp4'])
    expect(response.body).toContain('href="https://short.example/media"')
    expect(response.body).not.toContain('Watch video')
    expect(response.body).not.toContain('Download English')
    expect(response.body).toContain('Use alternative server')
  })

  it('caps per-page shortlink provider work while leaving every remaining destination direct', async () => {
    const transformed: string[] = []
    app = await buildApp(loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }), {
      shortlinks: {
        shorten: async (target) => {
          transformed.push(target)
          return target
        }
      }
    })
    const query = new URLSearchParams({ host: 'direct', id: 'https://cdn.example/movie.mp4' })
    for (let index = 1; index <= 25; index += 1) query.append('sub[]', `https://cdn.example/captions/${index}.vtt`)
    const token = new Security(secureSalt).encryptURL(query.toString())
    const response = await app.inject({ method: 'GET', url: `/d/?${token}` })

    expect(response.statusCode).toBe(200)
    expect(transformed).toHaveLength(20)
    expect(transformed[0]).toBe('https://cdn.example/movie.mp4')
    expect(transformed.at(-1)).toBe('https://cdn.example/captions/19.vtt')
    expect(response.body).toContain('href="https://cdn.example/captions/25.vtt"')
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

  it('resolves downloadable MP4 renditions across ordered providers without exposing extractor credentials', async () => {
    const resolve = vi.fn(async (query: { host?: string; id?: string }, context: { clientIp: string; userAgent: string; language: string; downloadable: boolean }) => query.host === 'streamhg'
      ? {
          sources: [{ file: 'https://primary.example/master.m3u8', type: 'hls', label: 'Auto' }],
          tracks: [],
          referer: 'https://primary.example/embed',
          title: 'Primary stream',
          email: '',
          image: '',
          cookies: [],
          filmstrip: '',
          clientip: context.clientIp,
          upstream: { host: 'streamhg', id: query.id ?? '', userAgent: context.userAgent, language: context.language }
        }
      : {
          sources: [
            { file: 'https://download.example/video-720.mp4', type: 'video/mp4', label: '720p' },
            { file: 'https://download.example/video-1080.mp4', type: 'video/mp4', label: '1080p' }
          ],
          tracks: [{ file: 'https://download.example/en.vtt', kind: 'captions', label: 'English' }],
          referer: 'https://download.example/embed',
          title: 'Resolved download title',
          email: '',
          image: '',
          cookies: [{ name: 'provider_session', value: 'never-render-this' }],
          filmstrip: '',
          clientip: context.clientIp,
          upstream: { host: 'direct', id: query.id ?? '', userAgent: context.userAgent, language: context.language }
        })
    app = await buildApp(loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'https://player.example/',
      SECURE_SALT: secureSalt
    }), {
      sourceApi: { resolve, supportedHosts: new Set(['streamhg', 'direct']) }
    })
    const security = new Security(secureSalt)
    const token = security.encryptURL('host=streamhg&id=primary-id&ahost=direct&aid=https%3A%2F%2Fbackup.example%2Ffallback.mp4&sub[]=https%3A%2F%2Fcaller.example%2Ffr.vtt&lang[]=French&poster=')
    const response = await app.inject({
      method: 'GET',
      url: `/d/?${token}`,
      headers: { 'user-agent': 'Download Browser', 'accept-language': 'fr-FR,fr;q=0.9' }
    })

    expect(response.statusCode).toBe(200)
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(resolve.mock.calls.map(([query]) => query.host)).toEqual(['streamhg', 'direct'])
    for (const call of resolve.mock.calls) {
      expect(call[1]).toEqual({
        clientIp: '127.0.0.1',
        userAgent: 'Download Browser',
        language: 'fr-FR,fr;q=0.9',
        downloadable: true
      })
    }
    expect(response.body).toContain('Resolved download title')
    expect(response.body).toContain('Download 720p Video')
    expect(response.body).toContain('Download 1080p Video')
    expect(response.body).toContain('Download English Subtitle')
    expect(response.body).toContain('Download French Subtitle')
    expect(response.body.match(/<small>Subtitle file<\/small>/g)).toHaveLength(2)
    expect(response.body.match(/href="https:\/\/player\.example\/stream-vid\//g)).toHaveLength(2)
    expect(response.body.match(/href="https:\/\/player\.example\/subtitle\//g)).toHaveLength(2)
    expect(response.body).toContain('data-download-servers')
    expect(response.body).toContain('<span aria-current="page">Direct URL</span>')
    expect(response.body).not.toContain('Open source page')
    expect(response.body).not.toContain('Direct-file extraction will be enabled')
    expect(response.body).not.toContain('provider_session')
    expect(response.body).not.toContain('never-render-this')
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
