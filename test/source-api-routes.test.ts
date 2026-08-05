import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { buildPlayerQuery, type PlayerMediaQuery } from '../src/core/player-query.js'
import { emptyMediaResult, type MediaResult } from '../src/core/source-resolver.js'
import type { SourceApiResolver } from '../src/http/source-api-routes.js'
import { Security } from '../src/security/security.js'
import { SettingsAdminService } from '../src/settings/settings-admin-service.js'

const secureSalt = 'source-api-route-test-salt'
const config = loadConfig({
  NODE_ENV: 'test',
  SECURE_SALT: secureSalt,
  BASE_URL: 'https://player.example/'
})

describe('legacy player source API routes', () => {
  let app: FastifyInstance
  let resolve: ReturnType<typeof vi.fn<SourceApiResolver>>
  let security: Security

  beforeEach(async () => {
    security = new Security(secureSalt)
    resolve = vi.fn<SourceApiResolver>().mockResolvedValue(mediaResult())
    app = await buildApp(config, { sourceApi: { resolve, supportedHosts: new Set(['direct']) } })
  })

  afterEach(async () => {
    await app.close()
  })

  it('returns the encrypted embed configuration for an authenticated player token', async () => {
    const request = authenticatedRequest({
      host: 'direct',
      id: 'https://cdn.example.test/master.m3u8'
    })
    const response = await app.inject({
      method: 'GET',
      url: `/api-config/${request.queryToken}?p=${request.passwordToken}`,
      headers: { 'user-agent': 'Mozilla/5.0 Safari/605.1.15' }
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/plain')
    const decoded = decryptJson(response.body, request.password)
    expect(decoded).toMatchObject({
      apiURL: 'https://player.example/',
      hosts: ['direct'],
      message: '',
      isSafariIE: true,
      player: 'jwplayer',
      playerVersion: '4.6.6',
      showDownloadButton: true
    })
    expect(decoded).toHaveProperty('torrentList')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('returns the smaller encrypted download-page configuration', async () => {
    const request = authenticatedRequest({ host: 'direct', id: 'https://cdn.example.test/video.mp4' })
    const response = await app.inject({
      method: 'GET',
      url: `/api-config/${request.queryToken}?dl=1&p=${request.passwordToken}`
    })

    expect(decryptJson(response.body, request.password)).toEqual({
      apiURL: 'https://player.example/',
      message: '',
      hosts: ['direct'],
      disableDirectAds: true,
      directAdsLink: '',
      showIframeAds: true,
      productionMode: false
    })
  })

  it('maps persisted VAST, anti-adblock, and direct-ad settings into both legacy configurations', async () => {
    await app.close()
    const values = {
      block_adblocker: 'true',
      disable_vast_ads: 'false',
      vast_client: 'googima',
      vast_xml: '["https://ads.example/pre.xml","https://ads.example/mid.xml","https://ads.example/post.xml"]',
      vast_offset: '["start","15","75%"]',
      vast_skip: '7',
      disable_direct_ads: 'false',
      direct_ads_link: 'https://ads.example/campaign',
      visitads_onplay: 'false',
      show_iframeads: 'false'
    }
    app = await buildApp(config, {
      sourceApi: { resolve, supportedHosts: new Set(['direct']) },
      settings: new SettingsAdminService({
        getAll: async () => values,
        upsertMany: async () => {}
      })
    })
    const request = authenticatedRequest({ host: 'direct', id: 'https://cdn.example.test/video.mp4' })
    const embed = await app.inject({
      method: 'GET',
      url: `/api-config/${request.queryToken}?p=${request.passwordToken}`
    })
    const embedConfig = decryptJson(embed.body, request.password)
    expect(embedConfig).toMatchObject({
      blockADB: true,
      visitAdsOnplay: false,
      showIframeAds: false,
      disableDirectAds: false,
      directAdsLink: 'https://ads.example/campaign',
      vastAds: {
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
      }
    })

    const download = await app.inject({
      method: 'GET',
      url: `/api-config/${request.queryToken}?dl=1&p=${request.passwordToken}`
    })
    expect(decryptJson(download.body, request.password)).toMatchObject({
      disableDirectAds: false,
      directAdsLink: 'https://ads.example/campaign',
      showIframeAds: false
    })
  })

  it('maps the complete player contract into config and source responses', async () => {
    await app.close()
    const values = {
      player: 'plyr',
      player_skin: 'hotstar',
      player_color: '095ae5',
      player_color2: '062794',
      stretching: 'exactfit',
      preload: 'auto',
      default_resolution: 'Original',
      default_audio: 'French',
      default_subtitle: 'English',
      subtitle_color: 'abcdef',
      font_family: 'Verdana',
      edge_style: 'uniform',
      background_opacity: '80',
      background_color: '010203',
      window_opacity: '25',
      window_color: '112233',
      display_title: 'true',
      playback_rate: 'false',
      enable_share_button: 'false',
      enable_download_button: 'false',
      disable_filmstrip: 'true',
      p2p: 'true',
      logo_hide: 'true',
      logo_position: 'bottom-left',
      logo_file: 'https://images.example.test/logo.png',
      logo_open_link: 'https://brand.example.test/',
      logo_margin: '12',
      small_logo_file: 'https://images.example.test/small.png',
      small_logo_link: 'https://brand.example.test/small',
      torrent_tracker: 'wss://tracker.example.test/socket\nwss://tracker2.example.test/',
      text_rewind: 'Back ten',
      text_forward: 'Ahead ten',
      text_download: 'Save {title}',
      pause_on_left: 'true',
      force_default_poster: 'true',
      poster: 'https://images.example.test/configured.jpg',
      slug_embed: 'watch',
      slug_download: 'fetch',
      slug_request: 'request-player'
    }
    app = await buildApp(config, {
      sourceApi: { resolve, supportedHosts: new Set(['direct']) },
      settings: new SettingsAdminService({ getAll: async () => values, upsertMany: async () => {} })
    })
    const request = authenticatedRequest({ host: 'direct', id: 'https://cdn.example.test/video.mp4', poster: 'https://images.example.test/source.jpg' })
    const response = await app.inject({ method: 'GET', url: `/api-config/${request.queryToken}?p=${request.passwordToken}` })
    expect(decryptJson(response.body, request.password)).toMatchObject({
      defaultSubtitle: { key: 'en', value: 'English' },
      defaultAudio: { key: 'fr', value: 'French' },
      backgroundColor: '#010203',
      backgroundOpacity: 80,
      edgeStyle: 'uniform',
      fontFamily: 'Verdana',
      windowColor: '#112233',
      windowOpacity: 25,
      player: 'plyr',
      enableP2P: true,
      preload: 'auto',
      stretching: 'exactfit',
      displayTitle: true,
      displayRateControls: false,
      captionsColor: '#abcdef',
      playerSkin: 'hotstar',
      enableSharer: false,
      logoHide: true,
      logoPosition: 'bottom-left',
      logoImage: 'https://images.example.test/logo.png',
      logoLink: 'https://brand.example.test/',
      torrentList: ['wss://tracker.example.test/socket', 'wss://tracker2.example.test/'],
      smallLogoFile: 'https://images.example.test/small.png',
      smallLogoLink: 'https://brand.example.test/small',
      playerColor: '#095ae5',
      playerColor2: '#062794',
      rgbColor: '9,90,229',
      text_rewind: 'Back ten',
      text_forward: 'Ahead ten',
      text_download: 'Save {title}',
      showDownloadButton: false,
      defaultResolution: 'Original',
      logoMargin: 12,
      pauseOnLeft: true
    })

    const source = await app.inject({
      method: 'POST',
      url: `/api?p=${request.passwordToken}`,
      headers: { 'content-type': 'text/plain' },
      payload: request.body
    })
    const decoded = decryptJson(source.body, request.password)
    expect(decoded.embed_url).toBe(`https://player.example/watch/?${request.queryToken}`)
    expect(decoded.download_url).toBe(`https://player.example/fetch/?${request.queryToken}`)
    expect(decoded.filmstrip).toBe('')
    expect(decoded.poster).toMatch(/^https:\/\/player\.example\/poster\//)
    expect(decoded.poster).not.toContain('source.jpg')
  })

  it('encrypts a successful source response and proxies every public media URL', async () => {
    const request = authenticatedRequest({
      host: 'direct',
      id: 'https://cdn.example.test/master.m3u8',
      poster: 'https://images.example.test/poster.jpg',
      download: '1'
    })
    const response = await app.inject({
      method: 'POST',
      url: `/api?p=${request.passwordToken}`,
      headers: {
        'content-type': 'text/plain',
        'user-agent': 'Test Browser',
        'accept-language': 'fr-FR'
      },
      payload: request.body
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/plain')
    expect(response.headers['cache-control']).toContain('no-store')
    const decoded = decryptJson(response.body, request.password)
    expect(decoded).toMatchObject({
      query: {
        host: 'direct',
        id: 'https://cdn.example.test/master.m3u8',
        poster: 'https://images.example.test/poster.jpg',
        download: '1',
        alt: '-1'
      },
      status: 'ok',
      message: 'Success',
      embed_url: `https://player.example/e/?${request.queryToken}`,
      download_url: `https://player.example/d/?${request.queryToken}`,
      title: 'Example title',
      filmstrip: expect.stringMatching(/^https:\/\/player\.example\/filmstrip\//)
    })
    expect(decoded.poster).toMatch(/^https:\/\/player\.example\/poster\//)
    expect(decoded.sources).toEqual([
      expect.objectContaining({ file: expect.stringMatching(/^https:\/\/player\.example\/hls\//), type: 'hls', label: 'Original' })
    ])
    expect(decoded.tracks).toEqual([
      expect.objectContaining({ file: expect.stringMatching(/^https:\/\/player\.example\/subtitle\//), kind: 'captions', label: 'English' })
    ])
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'direct', download: '1' }),
      expect.objectContaining({ userAgent: 'Test Browser', language: 'fr-FR', downloadable: true })
    )
  })

  it('keeps malformed authentication and empty results as plaintext JSON failures', async () => {
    const request = authenticatedRequest({ host: 'direct', id: 'https://cdn.example.test/video.mp4' })
    const badSalt = await app.inject({
      method: 'POST',
      url: `/api?p=${request.passwordToken}`,
      headers: { 'content-type': 'text/plain' },
      payload: `${request.queryToken}-,not-an-api-salt`
    })
    expect(badSalt.headers['content-type']).toContain('application/json')
    expect(badSalt.json()).toEqual({ status: 'fail', message: 'Not Found' })
    expect(resolve).not.toHaveBeenCalled()

    resolve.mockResolvedValueOnce(emptyMediaResult())
    const empty = await app.inject({
      method: 'POST',
      url: `/api?p=${request.passwordToken}`,
      headers: { 'content-type': 'text/plain' },
      payload: request.body
    })
    expect(empty.headers['content-type']).toContain('application/json')
    expect(empty.json()).toEqual({ status: 'fail', message: 'Not Found' })

    const invalidConfig = await app.inject({ method: 'GET', url: '/api-config/not-a-token?p=bad' })
    expect(invalidConfig.json()).toEqual({ status: 'fail', message: 'Not Found' })
  })

  function authenticatedRequest(media: PlayerMediaQuery) {
    const password = '1700000000'
    const queryToken = security.encryptURL(buildPlayerQuery(media))
    const passwordToken = security.encryptURL(password)
    return {
      password,
      passwordToken,
      queryToken,
      body: `${queryToken}-,${security.encryptApiSalt()}`
    }
  }

  function decryptJson(body: string, password: string): Record<string, any> {
    const decoded = security.decryptResponseStrict(body, password)
    expect(decoded).not.toBeNull()
    return JSON.parse(decoded ?? '{}') as Record<string, any>
  }
})

function mediaResult(): MediaResult {
  return {
    sources: [{ file: 'https://cdn.example.test/master.m3u8', type: 'hls', label: 'Original' }],
    tracks: [{ file: 'https://cdn.example.test/en.vtt', kind: 'captions', label: 'English' }],
    referer: 'https://origin.example.test/',
    title: 'Example title',
    email: '',
    image: 'https://images.example.test/fallback.jpg',
    cookies: [],
    filmstrip: 'https://cdn.example.test/filmstrip.vtt',
    clientip: '127.0.0.1'
  }
}
