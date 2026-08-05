import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import {
  createStreamingProxyPath,
  registerStreamingRoutes,
  rewriteHlsPlaylist,
  rewriteMpdManifest
} from '../src/http/streaming-routes.js'
import { Security } from '../src/security/security.js'

const secureSalt = '1234567890123456'
const media = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')
let upstream: Server
let upstreamUrl: URL
let app: FastifyInstance | undefined
let lastUpstreamUrl = ''
let lastUpstreamHeaders: import('node:http').IncomingHttpHeaders = {}

beforeEach(async () => {
  lastUpstreamUrl = ''
  lastUpstreamHeaders = {}
  upstream = createServer((request, response) => {
    lastUpstreamUrl = request.url ?? ''
    lastUpstreamHeaders = request.headers
    if (request.url === '/master.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\nvariant.m3u8\n'
      )
      return
    }
    if (request.url === '/variant.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4.0,\nsegment0.ts?sig=abc\n#EXT-X-ENDLIST\n'
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
})

async function buildStreamingApp(
  allowPrivateNetworks = true,
  customHeaders?: (target: URL) => RequestInit['headers'] | Promise<RequestInit['headers']>
): Promise<FastifyInstance> {
  const instance = Fastify()
  await registerStreamingRoutes(
    instance,
    loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }),
    { allowPrivateNetworks, ...(customHeaders === undefined ? {} : { customHeaders }) }
  )
  return instance
}

describe('authenticated streaming routes', () => {
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

  it('preserves byte-range semantics for MP4 streams', async () => {
    app = await buildStreamingApp()
    const target = new URL('/video.mp4', upstreamUrl)
    const path = createStreamingProxyPath('stream-vid', target, new Security(secureSalt))
    const response = await app.inject({ method: 'GET', url: path, headers: { range: 'bytes=4-9' } })

    expect(response.statusCode).toBe(206)
    expect(response.headers['content-range']).toBe(`bytes 4-9/${media.length}`)
    expect(response.rawPayload).toEqual(media.subarray(4, 10))
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
})
