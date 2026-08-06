import { describe, expect, it } from 'vitest'
import { ExtractorFactory } from '../src/hosting/extractor-factory.js'
import type { ProviderHttpClient, ProviderHttpPostRequest, ProviderHttpRequest, ProviderHttpResponse } from '../src/hosting/provider-http.js'
import { parseTwitchTarget, TwitchExtractor } from '../src/hosting/twitch.js'

class FixtureHttpClient implements ProviderHttpClient {
  public readonly requests: Array<Readonly<{ method: string; request: ProviderHttpPostRequest }>> = []

  public constructor(private readonly responses: ProviderHttpResponse[]) {}

  public async get(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    return await this.respond('GET', request)
  }

  public async head(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    return await this.respond('HEAD', request)
  }

  public async post(request: ProviderHttpPostRequest): Promise<ProviderHttpResponse> {
    return await this.respond('POST', request)
  }

  private async respond(method: string, request: ProviderHttpPostRequest): Promise<ProviderHttpResponse> {
    this.requests.push(Object.freeze({ method, request }))
    const response = this.responses.shift()
    if (response === undefined) throw new Error('Unexpected Twitch provider request')
    return response
  }
}

describe('Twitch extractor', () => {
  it.each([
    ['pgl', { kind: 'channel', id: 'pgl' }],
    ['https://www.twitch.tv/PGL', { kind: 'channel', id: 'pgl' }],
    ['videos/123456', { kind: 'vod', id: '123456' }],
    ['https://www.twitch.tv/videos/123456?filter=archives', { kind: 'vod', id: '123456' }],
    ['https://example.test/pgl', null],
    ['../../admin', null]
  ])('normalizes target %s', (input, expected) => {
    expect(parseTwitchTarget(input)).toEqual(expected)
  })

  it('registers live-channel playback through a bounded server-side token request', async () => {
    const token = { signature: 'a'.repeat(40), value: '{"channel":"pgl","expires":4102444800}' }
    const http = new FixtureHttpClient([response({ data: { streamPlaybackAccessToken: token } })])
    const extractor = new ExtractorFactory({
      providerHttpClient: http,
      twitch: { clientId: 'fixture-client', random: () => 0.25 }
    }).create('twitch', 'pgl')
    expect(extractor).not.toBeNull()
    if (extractor === null) throw new Error('Missing Twitch extractor')

    const sources = await extractor.getSources()
    expect(sources).toHaveLength(1)
    const source = new URL(String(sources[0]?.file))
    expect(source.origin).toBe('https://usher.ttvnw.net')
    expect(source.pathname).toBe('/api/channel/hls/pgl.m3u8')
    expect(source.searchParams.get('sig')).toBe(token.signature)
    expect(source.searchParams.get('token')).toBe(token.value)
    expect(source.searchParams.get('p')).toBe('250000')
    expect(sources[0]).toEqual(expect.objectContaining({ type: 'hls', label: 'Live' }))
    expect(extractor.getReferer()).toBe('https://www.twitch.tv/')
    expect(extractor.getTitle()).toBe('pgl')

    expect(http.requests).toHaveLength(1)
    expect(http.requests[0]?.method).toBe('POST')
    expect(String(http.requests[0]?.request.url)).toBe('https://gql.twitch.tv/gql')
    const headers = new Headers(http.requests[0]?.request.headers)
    expect(headers.get('client-id')).toBe('fixture-client')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('origin')).toBe('https://www.twitch.tv')
    const body = JSON.parse(String(http.requests[0]?.request.body))
    expect(body.variables).toEqual({ isLive: true, login: 'pgl', isVod: false, vodID: '', playerType: 'site' })
    expect(body.query).toContain('streamPlaybackAccessToken')
  })

  it('builds the VOD playlist contract with VOD-specific token parameters', async () => {
    const token = { signature: 'b'.repeat(40), value: '{"vod_id":"123456"}' }
    const http = new FixtureHttpClient([response({ data: { videoPlaybackAccessToken: token } })])
    const extractor = new TwitchExtractor('videos/123456', http, { random: () => 0 })
    const sources = await extractor.getSources()
    const source = new URL(String(sources[0]?.file))

    expect(source.pathname).toBe('/vod/123456.m3u8')
    expect(source.searchParams.get('nauthsig')).toBe(token.signature)
    expect(source.searchParams.get('nauth')).toBe(token.value)
    expect(source.searchParams.has('sig')).toBe(false)
    expect(source.searchParams.has('token')).toBe(false)
    const body = JSON.parse(String(http.requests[0]?.request.body))
    expect(body.variables).toEqual({ isLive: false, login: '', isVod: true, vodID: '123456', playerType: 'site' })
  })

  it('fails closed for malformed tokens and cross-origin token responses', async () => {
    const malformed = new TwitchExtractor('pgl', new FixtureHttpClient([
      response({ data: { streamPlaybackAccessToken: { signature: 'short', value: 'token' } } })
    ]))
    await expect(malformed.getSources()).resolves.toEqual([])

    const redirected = new TwitchExtractor('pgl', new FixtureHttpClient([
      response({ data: { streamPlaybackAccessToken: { signature: 'c'.repeat(40), value: 'token' } } }, 'https://attacker.test/gql')
    ]))
    await expect(redirected.getSources()).resolves.toEqual([])
  })
})

function response(payload: unknown, url = 'https://gql.twitch.tv/gql'): ProviderHttpResponse {
  return Object.freeze({
    url: new URL(url),
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload)
  })
}
