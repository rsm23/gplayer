import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import {
  createStreamingAccessToken,
  createStreamingProxyPath,
  registerStreamingRoutes,
  rewriteHlsPlaylist,
  rewriteMpdManifest,
  type StreamingRouteOptions
} from '../src/http/streaming-routes.js'
import { Security } from '../src/security/security.js'
import { ProviderStreamContextRegistry } from '../src/stream/provider-stream-context.js'

const secureSalt = '1234567890123456'
const media = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')
const realMp4 = readFileSync(new URL('../resources/uBlock-Origin-Lite-Chrome-Web-Store/web_accessible_resources/noop-1s.mp4', import.meta.url))
let upstream: Server
let upstreamUrl: URL
let app: FastifyInstance | undefined
let lastUpstreamUrl = ''
let lastUpstreamHeaders: import('node:http').IncomingHttpHeaders = {}
let cacheRoot = ''
let upstreamHits = new Map<string, number>()

beforeEach(async () => {
  lastUpstreamUrl = ''
  lastUpstreamHeaders = {}
  upstreamHits = new Map()
  cacheRoot = await mkdtemp(path.join(tmpdir(), 'gplayer-streaming-'))
  upstream = createServer((request, response) => {
    lastUpstreamUrl = request.url ?? ''
    lastUpstreamHeaders = request.headers
    upstreamHits.set(lastUpstreamUrl, (upstreamHits.get(lastUpstreamUrl) ?? 0) + 1)
    if (request.url === '/master.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\nvariant.m3u8\n'
      )
      return
    }
    if (request.url === '/cross-origin-master.m3u8') {
      const child = new URL('/variant.m3u8', upstreamUrl)
      child.hostname = 'localhost'
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(
        `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\n${child}\n`
      )
      return
    }
    if (request.url === '/same-origin-redirect') {
      response.writeHead(302, { location: '/echo-headers' }).end()
      return
    }
    if (request.url === '/cross-origin-redirect') {
      const child = new URL('/echo-headers', upstreamUrl)
      child.hostname = 'localhost'
      response.writeHead(302, { location: child.toString() }).end()
      return
    }
    if (request.url === '/echo-headers') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        cookie: request.headers.cookie,
        origin: request.headers.origin,
        referer: request.headers.referer,
        userAgent: request.headers['user-agent'],
        language: request.headers['accept-language']
      }))
      return
    }
    if (request.url === '/variant.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4.0,\nsegment0.ts?sig=abc\n#EXT-X-ENDLIST\n'
      )
      return
    }
    if (request.url === '/live.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(
        '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nlive-segment.ts\n'
      )
      return
    }
    if (request.url === '/key.bin') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end('0123456789abcdef')
      return
    }
    if (request.url === '/segment0.ts?sig=abc') {
      response.writeHead(200, { 'content-type': 'video/mp2t' }).end(media)
      return
    }
    if (request.url === '/live-segment.ts') {
      response.writeHead(200, { 'content-type': 'video/mp2t' }).end(media)
      return
    }
    if (request.url === '/manifest.mpd') {
      response.writeHead(200, { 'content-type': 'application/dash+xml' }).end(
        '<?xml version="1.0"?><MPD type="static"><Period><BaseURL>dash/</BaseURL><AdaptationSet><Representation id="v1"><SegmentTemplate initialization="init-$RepresentationID$.m4s?token=a&amp;b=c" media="chunk-$Number$.m4s?token=a&amp;b=c"/></Representation></AdaptationSet></Period></MPD>'
      )
      return
    }
    if (request.url === '/dash/chunk-1.m4s?token=a&b=c') {
      response.writeHead(200, { 'content-type': 'video/iso.segment' }).end(media)
      return
    }
    if (request.url === '/video.mp4') {
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
      if (range) {
        const start = Number(range[1])
        const end = range[2] ? Number(range[2]) : media.length - 1
        if (start >= media.length || end < start) {
          response.writeHead(416, { 'content-range': `bytes */${media.length}` }).end()
          return
        }
        const chunk = media.subarray(start, end + 1)
        response.writeHead(206, {
          'accept-ranges': 'bytes',
          'content-length': chunk.length,
          'content-range': `bytes ${start}-${end}/${media.length}`,
          'content-type': 'video/mp4'
        }).end(chunk)
        return
      }
      response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': media.length }).end(media)
      return
    }
    if (request.url === '/real.mp4') {
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
      if (range) {
        const start = Number(range[1])
        const end = Math.min(range[2] ? Number(range[2]) : realMp4.length - 1, realMp4.length - 1)
        const chunk = realMp4.subarray(start, end + 1)
        response.writeHead(206, {
          'accept-ranges': 'bytes',
          'content-length': chunk.length,
          'content-range': `bytes ${start}-${end}/${realMp4.length}`,
          'content-type': 'video/mp4'
        }).end(chunk)
        return
      }
      response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': realMp4.length }).end(realMp4)
      return
    }
    response.writeHead(404).end()
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
  upstreamUrl = new URL(`http://127.0.0.1:${address.port}`)
})

afterEach(async () => {
  await app?.close()
  app = undefined
  upstream.close()
  await once(upstream, 'close')
  await rm(cacheRoot, { recursive: true, force: true })
})

async function buildStreamingApp(
  allowPrivateNetworks = true,
  customHeaders?: (target: URL) => RequestInit['headers'] | Promise<RequestInit['headers']>,
  routeOptions: Omit<StreamingRouteOptions, 'allowPrivateNetworks' | 'customHeaders'> = {}
): Promise<FastifyInstance> {
  const instance = Fastify()
  await registerStreamingRoutes(
    instance,
    loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }),
    { ...routeOptions, allowPrivateNetworks, ...(customHeaders === undefined ? {} : { customHeaders }) }
  )
  return instance
}

describe('authenticated streaming routes', () => {
  it('binds top-level manifests and MP4 streams to the requesting client while leaving encrypted child segments usable', async () => {
    const accessSettings = async () => ({ disableValidation: false, p2p: false, downloadPageEnabled: true })
    app = await buildStreamingApp(true, undefined, { loadAccessSettings: accessSettings })
    const security = new Security(secureSalt)
    const manifestTarget = new URL('/master.m3u8', upstreamUrl)
    const videoTarget = new URL('/video.mp4', upstreamUrl)

    const unsignedManifest = createStreamingProxyPath('hls', manifestTarget, security)
    const unsignedVideo = createStreamingProxyPath('stream-vid', videoTarget, security)
    expect((await app.inject({ method: 'GET', url: unsignedManifest })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: unsignedVideo })).statusCode).toBe(403)

    const accessToken = createStreamingAccessToken('127.0.0.1', security) ?? ''
    expect(accessToken).not.toBe('')
    const manifestPath = createStreamingProxyPath('hls', manifestTarget, security, {
      host: 'direct', id: 'bound-fixture', accessToken
    })
    const master = await app.inject({ method: 'GET', url: manifestPath })
    expect(master.statusCode).toBe(200)
    const childPath = master.body.split('\n').find((line) => line.startsWith('/hls/')) ?? ''
    expect(childPath).toContain('gt=')
    expect((await app.inject({ method: 'GET', url: childPath })).statusCode).toBe(200)

    const segmentPath = createStreamingProxyPath('stream-ts', new URL('/segment0.ts?sig=abc', upstreamUrl), security)
    expect((await app.inject({ method: 'GET', url: segmentPath })).statusCode).toBe(200)

    const foreignToken = createStreamingAccessToken('192.0.2.44', security) ?? ''
    const stolen = createStreamingProxyPath('stream-vid', videoTarget, security, {
      host: 'direct', id: 'stolen-fixture', accessToken: foreignToken
    })
    expect((await app.inject({ method: 'GET', url: stolen })).statusCode).toBe(403)
  })

  it('retains the bounded legacy ASN, administrator, Smart TV, P2P, download, and disable-validation exemptions', async () => {
    const security = new Security(secureSalt)
    const target = new URL('/master.m3u8', upstreamUrl)
    const foreignToken = createStreamingAccessToken('192.0.2.44', security) ?? ''
    const access = { disableValidation: false, p2p: false, downloadPageEnabled: true }
    const validateAdminToken = vi.fn(async (token: string) => token === 'active-admin-token')
    app = await buildStreamingApp(true, undefined, {
      loadAccessSettings: async () => access,
      geoIpDetailsLookup: async (ip) => ({ asn: ip === '127.0.0.1' || ip === '192.0.2.44' ? 64_496 : null, organization: '', country: '', continent: '' }),
      validateAdminToken
    })

    const asnBound = createStreamingProxyPath('hls', target, security, {
      host: 'direct', id: 'asn-fixture', accessToken: foreignToken
    })
    expect((await app.inject({ method: 'GET', url: asnBound })).statusCode).toBe(200)

    const adminBound = createStreamingProxyPath('hls', target, security, {
      host: 'direct', id: 'admin-fixture', accessToken: 'active-admin-token'
    })
    expect((await app.inject({ method: 'GET', url: adminBound, headers: { 'user-agent': 'Admin browser' } })).statusCode).toBe(200)
    expect(validateAdminToken).toHaveBeenCalledWith('active-admin-token', 'Admin browser')

    const unsigned = createStreamingProxyPath('hls', target, security)
    expect((await app.inject({ method: 'GET', url: unsigned, headers: { 'user-agent': 'Mozilla/5.0 (SMART-TV; Tizen 7.0)' } })).statusCode).toBe(200)

    access.p2p = true
    expect((await app.inject({ method: 'GET', url: unsigned })).statusCode).toBe(200)
    access.p2p = false
    access.disableValidation = true
    expect((await app.inject({ method: 'GET', url: unsigned })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/hls/not-a-token/not-a-target' })).statusCode).toBe(400)
    access.disableValidation = false
    access.downloadPageEnabled = false
    const download = createStreamingProxyPath('stream-vid', new URL('/video.mp4', upstreamUrl), security, {
      host: 'direct', id: 'download-fixture', downloadable: true
    })
    expect((await app.inject({ method: 'GET', url: download })).statusCode).toBe(200)
  })

  it('rewrites an HLS master and its child playlist into authenticated local routes', async () => {
    app = await buildStreamingApp()
    const security = new Security(secureSalt)
    const target = new URL('/master.m3u8', upstreamUrl)
    const path = createStreamingProxyPath('hls', target, security)
    const master = await app.inject({ method: 'GET', url: path })

    expect(master.statusCode).toBe(200)
    expect(master.headers['content-type']).toBe('application/vnd.apple.mpegurl; charset=utf-8')
    const variantPath = master.body.split('\n').find((line) => line.startsWith('/hls/'))
    expect(variantPath).toBeDefined()

    const variant = await app.inject({ method: 'GET', url: variantPath ?? '' })
    expect(variant.statusCode).toBe(200)
    expect(variant.body).toContain('#EXT-X-ENDLIST')
    expect(variant.body).toMatch(/URI="\/stream-ts\/[A-Za-z0-9_,\-]+\/[A-Za-z0-9_,\-]+"/)
    expect(variant.body).toMatch(/\/stream-ts\/[A-Za-z0-9_,\-]+\/[A-Za-z0-9_,\-]+/)
  })

  it('serves rewritten HLS segments through the binary proxy', async () => {
    app = await buildStreamingApp()
    const security = new Security(secureSalt)
    const playlist = rewriteHlsPlaylist(
      '#EXTM3U\n#EXTINF:4.0,\nsegment0.ts?sig=abc\n#EXT-X-ENDLIST\n',
      new URL('/variant.m3u8', upstreamUrl),
      security,
      { host: 'direct', id: 'fixture' }
    )
    const segmentPath = playlist.split('\n').find((line) => line.startsWith('/stream-ts/'))
    const response = await app.inject({ method: 'GET', url: segmentPath ?? '' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('video/mp2t')
    expect(response.rawPayload).toEqual(media)
    expect(lastUpstreamUrl).toBe('/segment0.ts?sig=abc')
  })

  it('propagates live HLS state to child resources and never persists the live manifest', async () => {
    app = await buildStreamingApp(true, undefined, {
      cacheRoot,
      loadCacheSettings: async () => ({ enabled: true, maxAgeSeconds: 3_600, mode: 'php' })
    })
    const target = new URL('/live.m3u8', upstreamUrl)
    const manifestPath = createStreamingProxyPath('hls', target, new Security(secureSalt), { host: 'direct', id: 'live-fixture' })

    const first = await app.inject({ method: 'GET', url: manifestPath })
    const second = await app.inject({ method: 'GET', url: manifestPath })
    const segmentPath = first.body.split('\n').find((line) => line.startsWith('/stream-ts/')) ?? ''

    expect(first.statusCode).toBe(200)
    expect(first.headers['x-gplayer-live']).toBe('1')
    expect(first.headers['cache-control']).toBe('no-store')
    expect(segmentPath).toContain('gl=1')
    expect(second.headers['x-cache']).toBeUndefined()
    expect(upstreamHits.get('/live.m3u8')).toBe(2)

    const segment = await app.inject({ method: 'GET', url: segmentPath })
    expect(segment.statusCode).toBe(200)
    expect(segment.headers['cache-control']).toBe('public, max-age=60')
    expect(segment.rawPayload).toEqual(media)
  })

  it('persists static manifests and segments under the configured legacy-compatible file cache', async () => {
    app = await buildStreamingApp(true, undefined, {
      cacheRoot,
      loadCacheSettings: async () => ({ enabled: true, maxAgeSeconds: 3_600, mode: 'php' })
    })
    const security = new Security(secureSalt)
    const manifestPath = createStreamingProxyPath('hls', new URL('/master.m3u8', upstreamUrl), security, { host: 'direct', id: 'cache-fixture' })

    const firstManifest = await app.inject({ method: 'GET', url: manifestPath })
    const secondManifest = await app.inject({ method: 'GET', url: manifestPath })
    expect(firstManifest.statusCode).toBe(200)
    expect(secondManifest.headers['x-cache']).toBe('HIT')
    expect(secondManifest.body).toBe(firstManifest.body)
    expect(upstreamHits.get('/master.m3u8')).toBe(1)

    const segmentPath = createStreamingProxyPath('stream-ts', new URL('/segment0.ts?sig=abc', upstreamUrl), security, { host: 'direct', id: 'cache-fixture' })
    const firstSegment = await app.inject({ method: 'GET', url: segmentPath })
    const secondSegment = await app.inject({ method: 'GET', url: segmentPath })
    expect(firstSegment.rawPayload).toEqual(media)
    expect(secondSegment.rawPayload).toEqual(media)
    expect(secondSegment.headers['x-cache']).toBe('HIT')
    expect(secondSegment.headers['content-type']).toBe('video/mp2t')
    expect(upstreamHits.get('/segment0.ts?sig=abc')).toBe(1)
  })

  it('rebinds cached manifests to the current provider context without caching credentials', async () => {
    const providerContexts = new ProviderStreamContextRegistry()
    const target = new URL('/cross-origin-master.m3u8', upstreamUrl)
    const firstToken = providerContexts.register({ host: 'direct', targets: [target], cookies: ['session=first'] }) ?? ''
    app = await buildStreamingApp(true, undefined, {
      providerContexts,
      cacheRoot,
      loadCacheSettings: async () => ({ enabled: true, maxAgeSeconds: 3_600, mode: 'php' })
    })
    const security = new Security(secureSalt)
    const firstAccessToken = createStreamingAccessToken('192.0.2.10', security) ?? ''
    const firstPath = createStreamingProxyPath('hls', target, security, {
      host: 'direct', id: 'context-cache', contextToken: firstToken, accessToken: firstAccessToken
    })
    const first = await app.inject({ method: 'GET', url: firstPath })
    expect(first.body).toContain(`gsc=${firstToken}`)
    expect(first.body).toContain('gt=')
    const cachedFiles = (await readdir(path.join(cacheRoot, 'files'), { recursive: true }))
      .filter((file) => file.endsWith('.cache'))
    const cachedManifest = await readFile(path.join(cacheRoot, 'files', cachedFiles[0] ?? ''), 'utf8')
    expect(cachedManifest).toContain('gsc=__GPLAYER_PROVIDER_CONTEXT__')
    expect(cachedManifest).toContain('gt=__GPLAYER_STREAM_ACCESS__')
    expect(cachedManifest).not.toContain(firstToken)
    expect(cachedManifest).not.toContain(firstAccessToken)
    expect(cachedManifest).not.toContain('session=first')

    const secondToken = providerContexts.register({ host: 'direct', targets: [target], cookies: ['session=second'] }) ?? ''
    const secondAccessToken = createStreamingAccessToken('192.0.2.11', security) ?? ''
    const secondPath = createStreamingProxyPath('hls', target, security, {
      host: 'direct', id: 'context-cache', contextToken: secondToken, accessToken: secondAccessToken
    })
    const second = await app.inject({ method: 'GET', url: secondPath })
    expect(second.headers['x-cache']).toBe('HIT')
    expect(second.body).toContain(`gsc=${secondToken}`)
    expect(second.body).toContain(`gt=${encodeURIComponent(secondAccessToken)}`)
    expect(second.body).not.toContain(firstToken)
    expect(second.body).not.toContain(encodeURIComponent(firstAccessToken))
    expect(upstreamHits.get('/cross-origin-master.m3u8')).toBe(1)

    const childPath = second.body.split('\n').find((line) => line.startsWith('/hls/')) ?? ''
    expect((await app.inject({ method: 'GET', url: childPath })).statusCode).toBe(200)
    expect(lastUpstreamHeaders.cookie).toBe('session=second')
  })

  it.each([
    ['apache', 'x-sendfile'],
    ['litespeed', 'x-litespeed-location'],
    ['nginx', 'x-accel-redirect']
  ] as const)('emits the configured %s cache offload header on a cache hit', async (mode, header) => {
    app = await buildStreamingApp(true, undefined, {
      cacheRoot,
      loadCacheSettings: async () => ({ enabled: true, maxAgeSeconds: 3_600, mode })
    })
    const target = new URL('/segment0.ts?sig=abc', upstreamUrl)
    const proxyPath = createStreamingProxyPath('stream-ts', target, new Security(secureSalt), { host: 'direct', id: `${mode}-fixture` })

    expect((await app.inject({ method: 'GET', url: proxyPath })).rawPayload).toEqual(media)
    const cached = await app.inject({ method: 'GET', url: proxyPath })

    expect(cached.statusCode).toBe(200)
    expect(cached.headers[header]).toBeDefined()
    expect(cached.headers['x-cache-server']).toBe('HIT')
    if (mode !== 'apache') expect(cached.headers[header]).toMatch(/^\/cache-files\//)
    expect(upstreamHits.get('/segment0.ts?sig=abc')).toBe(1)
  })

  it('preserves byte-range semantics for MP4 streams', async () => {
    app = await buildStreamingApp()
    const target = new URL('/video.mp4', upstreamUrl)
    const path = createStreamingProxyPath('stream-vid', target, new Security(secureSalt))
    const response = await app.inject({ method: 'GET', url: path, headers: { range: 'bytes=4-9' } })

    expect(response.statusCode).toBe(206)
    expect(response.headers['content-range']).toBe(`bytes 4-9/${media.length}`)
    expect(response.rawPayload).toEqual(media.subarray(4, 10))
  })

  it('streams a real ISO media fixture byte-for-byte, including a bounded range', async () => {
    app = await buildStreamingApp()
    const target = new URL('/real.mp4', upstreamUrl)
    const proxyPath = createStreamingProxyPath('stream-vid', target, new Security(secureSalt))

    const complete = await app.inject({ method: 'GET', url: proxyPath })
    const partial = await app.inject({ method: 'GET', url: proxyPath, headers: { range: 'bytes=8-63' } })

    expect(complete.statusCode).toBe(200)
    expect(complete.rawPayload).toEqual(realMp4)
    expect(complete.rawPayload.subarray(4, 8).toString('ascii')).toBe('ftyp')
    expect(partial.statusCode).toBe(206)
    expect(partial.headers['content-range']).toBe(`bytes 8-63/${realMp4.length}`)
    expect(partial.rawPayload).toEqual(realMp4.subarray(8, 64))
  })

  it('preserves an upstream unsatisfied-range response', async () => {
    app = await buildStreamingApp()
    const target = new URL('/video.mp4', upstreamUrl)
    const proxyPath = createStreamingProxyPath('stream-vid', target, new Security(secureSalt))
    const response = await app.inject({ method: 'GET', url: proxyPath, headers: { range: 'bytes=999-' } })

    expect(response.statusCode).toBe(416)
    expect(response.headers['content-range']).toBe(`bytes */${media.length}`)
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('applies the configured upstream receive-speed limit without changing bytes', async () => {
    app = await buildStreamingApp(true, undefined, { maximumBytesPerSecond: 180 })
    const target = new URL('/video.mp4', upstreamUrl)
    const proxyPath = createStreamingProxyPath('stream-vid', target, new Security(secureSalt))
    const started = Date.now()
    const response = await app.inject({ method: 'GET', url: proxyPath })

    expect(response.rawPayload).toEqual(media)
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
  })

  it('applies server-controlled custom headers to the validated upstream target', async () => {
    app = await buildStreamingApp(true, async (target) => target.pathname.endsWith('/video.mp4')
      ? { Referer: 'https://app.example/', 'X-Playback-Token': 'server-secret', Host: 'attacker.example' }
      : {})
    const target = new URL('/video.mp4', upstreamUrl)
    const path = createStreamingProxyPath('stream-vid', target, new Security(secureSalt))
    const response = await app.inject({ method: 'GET', url: path })

    expect(response.statusCode).toBe(200)
    expect(lastUpstreamHeaders.referer).toBe('https://app.example/')
    expect(lastUpstreamHeaders['x-playback-token']).toBe('server-secret')
    expect(lastUpstreamHeaders.host).not.toBe('attacker.example')
  })

  it('keeps extractor headers server-side across child manifests and segments', async () => {
    const providerContexts = new ProviderStreamContextRegistry()
    const target = new URL('/master.m3u8', upstreamUrl)
    const contextToken = providerContexts.register({
      host: 'streamhg',
      targets: [target],
      referer: 'https://embed.example/e/fixture',
      cookies: ['session=provider-secret'],
      userAgent: 'Provider Browser',
      language: 'fr-FR'
    }) ?? ''
    app = await buildStreamingApp(true, undefined, { providerContexts })
    const path = createStreamingProxyPath('hls', target, new Security(secureSalt), {
      host: 'streamhg', id: 'fixture', contextToken
    })

    expect(path).not.toContain('provider-secret')
    const master = await app.inject({
      method: 'GET',
      url: path,
      headers: { 'user-agent': 'Untrusted Browser', 'accept-language': 'de-DE' }
    })
    expect(lastUpstreamHeaders).toMatchObject({
      cookie: 'session=provider-secret',
      origin: 'https://embed.example',
      referer: 'https://embed.example/e/fixture',
      'user-agent': 'Provider Browser',
      'accept-language': 'fr-FR'
    })

    const variantPath = master.body.split('\n').find((line) => line.startsWith('/hls/')) ?? ''
    expect(variantPath).toContain(`gsc=${contextToken}`)
    const variant = await app.inject({ method: 'GET', url: variantPath })
    expect(lastUpstreamHeaders.cookie).toBe('session=provider-secret')
    const segmentPath = variant.body.split('\n').find((line) => line.startsWith('/stream-ts/')) ?? ''
    expect(segmentPath).toContain(`gsc=${contextToken}`)
    expect((await app.inject({ method: 'GET', url: segmentPath })).statusCode).toBe(200)
    expect(lastUpstreamHeaders.cookie).toBe('session=provider-secret')
  })

  it('applies provider context to ranged MP4 requests without exposing it downstream', async () => {
    const providerContexts = new ProviderStreamContextRegistry()
    const target = new URL('/video.mp4', upstreamUrl)
    const contextToken = providerContexts.register({
      host: 'direct',
      targets: [target],
      cookies: ['session=range-secret'],
      referer: 'https://embed.example/range'
    }) ?? ''
    app = await buildStreamingApp(true, undefined, { providerContexts })
    const path = createStreamingProxyPath('stream-vid', target, new Security(secureSalt), {
      host: 'direct', id: 'range-fixture', contextToken
    })

    const response = await app.inject({ method: 'GET', url: path, headers: { range: 'bytes=4-9' } })
    expect(response.statusCode).toBe(206)
    expect(response.rawPayload).toEqual(media.subarray(4, 10))
    expect(lastUpstreamHeaders).toMatchObject({ range: 'bytes=4-9', cookie: 'session=range-secret' })
    expect(response.headers).not.toHaveProperty('set-cookie')
    expect(response.body).not.toContain('range-secret')
  })

  it('authorizes a cross-origin child declared by an authenticated manifest', async () => {
    const providerContexts = new ProviderStreamContextRegistry()
    const target = new URL('/cross-origin-master.m3u8', upstreamUrl)
    const contextToken = providerContexts.register({ host: 'direct', targets: [target], cookies: ['session=manifest-secret'] }) ?? ''
    app = await buildStreamingApp(true, undefined, { providerContexts })
    const path = createStreamingProxyPath('hls', target, new Security(secureSalt), { host: 'direct', id: 'cross-child', contextToken })

    const master = await app.inject({ method: 'GET', url: path })
    const childPath = master.body.split('\n').find((line) => line.startsWith('/hls/')) ?? ''
    const child = await app.inject({ method: 'GET', url: childPath })

    expect(child.statusCode).toBe(200)
    expect(lastUpstreamUrl).toBe('/variant.m3u8')
    expect(lastUpstreamHeaders.cookie).toBe('session=manifest-secret')
  })

  it('rejects a stolen context token on unrelated targets and strips it across redirects', async () => {
    const providerContexts = new ProviderStreamContextRegistry()
    const authorized = new URL('/same-origin-redirect', upstreamUrl)
    const contextToken = providerContexts.register({
      host: 'direct',
      targets: [authorized],
      referer: 'https://embed.example/e/fixture',
      cookies: ['session=redirect-secret'],
      userAgent: 'Provider Browser'
    }) ?? ''
    app = await buildStreamingApp(true, undefined, { providerContexts })
    const security = new Security(secureSalt)
    const identity = { host: 'direct', id: 'redirect-fixture', contextToken }

    const sameOrigin = await app.inject({
      method: 'GET',
      url: createStreamingProxyPath('stream-vid', authorized, security, identity)
    })
    expect(JSON.parse(sameOrigin.body)).toMatchObject({ cookie: 'session=redirect-secret', userAgent: 'Provider Browser' })

    const crossOriginTarget = new URL('/cross-origin-redirect', upstreamUrl)
    const crossOrigin = await app.inject({
      method: 'GET',
      url: createStreamingProxyPath('stream-vid', crossOriginTarget, security, identity)
    })
    expect(JSON.parse(crossOrigin.body)).not.toHaveProperty('cookie')
    expect(JSON.parse(crossOrigin.body)).not.toHaveProperty('referer')

    const unrelated = new URL('/echo-headers', upstreamUrl)
    unrelated.hostname = 'localhost'
    const stolen = await app.inject({
      method: 'GET',
      url: createStreamingProxyPath('stream-vid', unrelated, security, identity)
    })
    expect(JSON.parse(stolen.body)).not.toHaveProperty('cookie')
    expect(JSON.parse(stolen.body)).not.toHaveProperty('referer')
  })

  it('applies configured custom headers after provider context headers', async () => {
    const providerContexts = new ProviderStreamContextRegistry()
    const target = new URL('/echo-headers', upstreamUrl)
    const contextToken = providerContexts.register({
      host: 'direct',
      targets: [target],
      referer: 'https://provider.example/',
      cookies: ['session=provider']
    }) ?? ''
    app = await buildStreamingApp(true, async () => ({
      Referer: 'https://custom.example/',
      Cookie: 'session=custom'
    }), { providerContexts })
    const path = createStreamingProxyPath('stream-vid', target, new Security(secureSalt), {
      host: 'direct', id: 'custom-fixture', contextToken
    })

    const response = await app.inject({ method: 'GET', url: path })
    expect(JSON.parse(response.body)).toMatchObject({
      cookie: 'session=custom',
      referer: 'https://custom.example/'
    })
  })

  it('rewrites DASH templates while leaving placeholders outside encrypted tokens', async () => {
    app = await buildStreamingApp()
    const security = new Security(secureSalt)
    const target = new URL('/manifest.mpd', upstreamUrl)
    const manifestPath = createStreamingProxyPath('mpd', target, security)
    const response = await app.inject({ method: 'GET', url: manifestPath })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/dash+xml; charset=utf-8')
    expect(response.body).toContain('$Number$')
    expect(response.body).toContain('$RepresentationID$')
    expect(response.body).toContain('/stream-seg/')
    expect(response.body).toContain('token=a&amp;b=c')

    const encodedTemplate = response.body.match(/media="([^"]+)"/)?.[1] ?? ''
    const segmentPath = encodedTemplate.replaceAll('&amp;', '&').replace('$Number$', '1')
    const segment = await app.inject({ method: 'GET', url: segmentPath })
    expect(segment.statusCode).toBe(200)
    expect(segment.rawPayload).toEqual(media)
    expect(lastUpstreamUrl).toBe('/dash/chunk-1.m4s?token=a&b=c')
  })

  it('propagates provider context through DASH templates and segment requests', async () => {
    const providerContexts = new ProviderStreamContextRegistry()
    const target = new URL('/manifest.mpd', upstreamUrl)
    const contextToken = providerContexts.register({
      host: 'direct',
      targets: [target],
      cookies: ['session=dash-secret'],
      referer: 'https://embed.example/dash'
    }) ?? ''
    app = await buildStreamingApp(true, undefined, { providerContexts })
    const manifestPath = createStreamingProxyPath('mpd', target, new Security(secureSalt), {
      host: 'direct', id: 'dash-context', contextToken
    })

    const response = await app.inject({ method: 'GET', url: manifestPath })
    const template = (response.body.match(/media="([^"]+)"/)?.[1] ?? '')
      .replaceAll('&amp;', '&')
      .replace('$Number$', '1')
    expect(template).toContain(`gsc=${contextToken}`)
    expect((await app.inject({ method: 'GET', url: template })).statusCode).toBe(200)
    expect(lastUpstreamHeaders.cookie).toBe('session=dash-secret')
  })

  it('rejects malformed tokens without reflecting them', async () => {
    app = await buildStreamingApp()
    const response = await app.inject({ method: 'GET', url: '/hls/private-token/also-private' })

    expect(response.statusCode).toBe(400)
    expect(response.body).toBe('Invalid stream link')
    expect(response.body).not.toContain('private-token')
  })

  it('blocks private-network targets in the production route configuration', async () => {
    app = await buildStreamingApp(false)
    const path = createStreamingProxyPath('stream-vid', new URL('/video.mp4', upstreamUrl), new Security(secureSalt))
    const response = await app.inject({ method: 'GET', url: path })

    expect(response.statusCode).toBe(502)
    expect(response.body).toBe('Stream resource is unavailable')
  })
})

describe('manifest rewriting', () => {
  it('rewrites HLS prefetch resources while preserving legacy direct-transport CDNs', () => {
    const output = rewriteHlsPlaylist(
      [
        '#EXTM3U',
        '#EXT-X-PREFETCH:next.ts?token=fixture',
        'https://video.tiktokcdn.com/direct.ts',
        '#EXT-X-KEY:METHOD=AES-128,URI="https://edge.cloudfront-net.online/key.bin"',
        ''
      ].join('\n'),
      new URL('https://cdn.example/live/index.m3u8'),
      new Security(secureSalt),
      { host: 'direct', id: 'fixture', live: true }
    )

    expect(output).toMatch(/#EXT-X-PREFETCH:\/stream-ts\/.+gl=1/)
    expect(output).toContain('https://video.tiktokcdn.com/direct.ts')
    expect(output).toContain('URI="https://edge.cloudfront-net.online/key.bin"')
  })

  it('keeps non-HTTP HLS key schemes unchanged', () => {
    const output = rewriteHlsPlaylist(
      '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://license"\n',
      new URL('https://cdn.example/master.m3u8'),
      new Security(secureSalt),
      { host: 'direct', id: 'fixture' }
    )
    expect(output).toContain('URI="skd://license"')
  })

  it('leaves DASH URN attributes unchanged', () => {
    const output = rewriteMpdManifest(
      '<MPD><ContentProtection href="urn:mpeg:dash:mp4protection:2011"/></MPD>',
      new URL('https://cdn.example/manifest.mpd'),
      new Security(secureSalt),
      { host: 'direct', id: 'fixture' }
    )
    expect(output).toContain('href="urn:mpeg:dash:mp4protection:2011"')
  })

  it('rewrites file-valued DASH BaseURL elements as ranged resources, not directories', () => {
    const output = rewriteMpdManifest(
      '<MPD><Period><Representation><BaseURL>video.mp4</BaseURL><SegmentBase indexRange="0-100"/></Representation></Period></MPD>',
      new URL('https://cdn.example/manifest.mpd'),
      new Security(secureSalt),
      { host: 'direct', id: 'fixture' }
    )
    const value = output.match(/<BaseURL>([^<]+)<\/BaseURL>/)?.[1] ?? ''
    expect(value).toMatch(/^\/stream-seg\/[A-Za-z0-9_,\-]+\/[A-Za-z0-9_,\-]+$/)
    expect(value).not.toMatch(/\/$/)
  })

  it('rewrites the complete recovered DASH URL-attribute set', () => {
    const output = rewriteMpdManifest(
      '<MPD type="dynamic"><ProgramInformation moreInformationURL="docs/info.html"/><Period xlink:href="period.mpd"><UTCTiming value="https://time.example/utc"/><Representation FBPredictedMedia="predicted.m4s" reportingUrl="reporting.bin"><SegmentTemplate media="chunk-$Number$.m4s"/></Representation></Period></MPD>',
      new URL('https://cdn.example/dash/manifest.mpd'),
      new Security(secureSalt),
      { host: 'direct', id: 'fixture', live: true }
    )

    expect(output).toMatch(/moreInformationURL="\/redirect\//)
    expect(output).toMatch(/xlink:href="\/mpd\/.+gl=1/)
    expect(output).toMatch(/value="\/stream-seg\/.+gl=1/)
    expect(output).toMatch(/FBPredictedMedia="\/stream-seg\//)
    expect(output).toMatch(/reportingUrl="\/stream-seg\//)
    expect(output).toContain('$Number$')
  })

  it('repairs the recovered duration-only DASH fragment shape', () => {
    const output = rewriteMpdManifest(
      '<Period duration="PT4S"><AdaptationSet/></Period>',
      new URL('https://cdn.example/dash/manifest.mpd'),
      new Security(secureSalt),
      { host: 'direct', id: 'fixture' }
    )

    expect(output).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(output).toContain('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"')
    expect(output).toContain('mediaPresentationDuration="PT4S"')
    expect(output.endsWith('</MPD>')).toBe(true)
  })
})
