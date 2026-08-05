import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { parsePlayerQuery } from '../src/core/player-query.js'
import { Security } from '../src/security/security.js'
import { SettingsAdminService } from '../src/settings/settings-admin-service.js'

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
    expect(download.body).toContain('src="/ads/frame/download-top"')
    expect(download.body).toContain('src="/ads/frame/download-bottom"')
    expect(download.body).toContain('src="/ads/frame/popup"')
    expect(download.body).not.toContain('Top sponsor')

    const top = await app.inject({ method: 'GET', url: '/ads/frame/download-top' })
    expect(top.statusCode).toBe(200)
    expect(top.body).toContain('<a href="https://sponsor.example/top">Top sponsor</a>')

    const bait = await app.inject({ method: 'GET', url: '/ads/advertisement.png' })
    expect(bait.statusCode).toBe(200)
    expect(bait.headers['content-type']).toBe('image/png')
    expect(bait.rawPayload.length).toBeGreaterThan(40)
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
