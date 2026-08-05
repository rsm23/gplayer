import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { buildPlayerQuery, type PlayerMediaQuery } from '../src/core/player-query.js'
import { emptyMediaResult, type MediaResult } from '../src/core/source-resolver.js'
import type { SourceApiResolver } from '../src/http/source-api-routes.js'
import { Security } from '../src/security/security.js'

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
