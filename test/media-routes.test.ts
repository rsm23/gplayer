import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import {
  createSpriteFilmstripWebVtt,
  createMediaProxyPath,
  normalizeWebVtt,
  registerMediaRoutes,
  repairFilmstripWebVtt,
  type MediaRouteOptions
} from '../src/http/media-routes.js'
import { Security } from '../src/security/security.js'
import { legacyXxh32 } from '../src/background/media-cache-path.js'
import { ProviderStreamContextRegistry } from '../src/stream/provider-stream-context.js'

const secureSalt = '1234567890123456'
const mediaConfig = loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt, BASE_URL: 'https://player.example/' })
const posterBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
let upstream: Server
let upstreamUrl: URL
let app: FastifyInstance | undefined
let publicRoot = ''
let upstreamHits = new Map<string, number>()
let lastUpstreamHeaders: import('node:http').IncomingHttpHeaders = {}

beforeEach(async () => {
  publicRoot = await mkdtemp(path.join(tmpdir(), 'gplayer-public-media-'))
  upstreamHits = new Map()
  lastUpstreamHeaders = {}
  upstream = createServer((request, response) => {
    upstreamHits.set(request.url ?? '', (upstreamHits.get(request.url ?? '') ?? 0) + 1)
    lastUpstreamHeaders = request.headers
    if (request.url === '/poster.png') {
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': posterBytes.length,
        'cache-control': 'public, max-age=60',
        'x-upstream-secret': 'hidden'
      }).end(request.method === 'HEAD' ? undefined : posterBytes)
      return
    }
    if (request.url === '/caption.srt') {
      const subtitle = '1\r\n00:00:01,250 --> 00:00:03,500\r\nHello {\\i1}world{\\i0}\r\n'
      response.writeHead(200, { 'content-type': 'application/x-subrip' }).end(subtitle)
      return
    }
    if (request.url === '/caption.ass') {
      const subtitle = '[Script Info]\n[Events]\nDialogue: 0,0:00:02.10,0:00:04.25,Default,,0,0,0,,First\\Nsecond'
      response.writeHead(200, { 'content-type': 'text/plain' }).end(subtitle)
      return
    }
    if (request.url === '/caption.txt') {
      const subtitle = '[offset:+500]\n[00:01.10] First\n[00:02.20] Second'
      response.writeHead(200, { 'content-type': 'text/plain' }).end(subtitle)
      return
    }
    if (request.url === '/previews/strip.vtt') {
      const filmstrip = 'WEBVTT\r\n\r\n00:00:00.000 --> 00:00:05.000\r\nsprites/sheet.jpg#xywh=0,0,160,90\r\n'
      response.writeHead(200, { 'content-type': 'text/vtt' }).end(filmstrip)
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
  await rm(publicRoot, { recursive: true, force: true })
})

async function buildMediaApp(
  allowPrivateNetworks: boolean,
  options: Omit<MediaRouteOptions, 'allowPrivateNetworks' | 'publicRoot'> = {}
): Promise<FastifyInstance> {
  const instance = Fastify()
  await registerMediaRoutes(
    instance,
    mediaConfig,
    { ...options, allowPrivateNetworks, publicRoot }
  )
  await instance.register(fastifyStatic, {
    root: path.join(publicRoot, 'uploads'),
    prefix: '/uploads/',
    decorateReply: false,
    wildcard: true
  })
  return instance
}

describe('poster, subtitle, and filmstrip routes', () => {
  it('streams an authenticated poster token with safe response headers', async () => {
    app = await buildMediaApp(true)
    const target = new URL('/poster.png', upstreamUrl)
    const token = new Security(secureSalt).encryptURL(target.toString())
    const response = await app.inject({ method: 'GET', url: `/poster/${token}.png` })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('image/png')
    expect(response.headers['cache-control']).toBe('public, max-age=60')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['x-upstream-secret']).toBeUndefined()
    expect(response.rawPayload).toEqual(posterBytes)
  })

  it('keeps legacy query-url poster compatibility', async () => {
    app = await buildMediaApp(true)
    const target = new URL('/poster.png', upstreamUrl)
    const response = await app.inject({ method: 'GET', url: `/poster?url=${encodeURIComponent(target.toString())}` })

    expect(response.statusCode).toBe(200)
    expect(response.rawPayload).toEqual(posterBytes)
  })

  it('accepts frontend filename aliases before authenticated media paths', async () => {
    app = await buildMediaApp(true)
    const security = new Security(secureSalt)
    const posterToken = security.encryptURL(new URL('/poster.png', upstreamUrl).toString())
    const subtitleToken = security.encryptURL(new URL('/caption.srt', upstreamUrl).toString())
    const [poster, subtitle] = await Promise.all([
      app.inject({ method: 'GET', url: `/poster.php/${posterToken}.png` }),
      app.inject({ method: 'GET', url: `/subtitle.custom/${subtitleToken}.vtt` })
    ])

    expect(poster.statusCode).toBe(200)
    expect(poster.rawPayload).toEqual(posterBytes)
    expect(subtitle.statusCode).toBe(200)
    expect(subtitle.body).toContain('WEBVTT')
    expect(subtitle.body).toContain('Hello world')
  })

  it('redirects configured-host posters without proxying the application back into itself', async () => {
    app = await buildMediaApp(false)
    const target = new URL('/uploads/images/local.jpg', mediaConfig.baseUrl)
    const proxy = createMediaProxyPath('poster', target.toString(), new Security(secureSalt)) ?? ''
    const response = await app.inject({ method: 'GET', url: proxy })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe(target.toString())
    expect(upstreamHits.size).toBe(0)
  })

  it('atomically caches poster bytes under the legacy xxh32 path and redirects later requests', async () => {
    app = await buildMediaApp(true)
    const target = new URL('/poster.png', upstreamUrl)
    const proxy = createMediaProxyPath('poster', target.toString(), new Security(secureSalt)) ?? ''

    const first = await app.inject({ method: 'GET', url: proxy })
    const second = await app.inject({ method: 'GET', url: proxy })
    const expected = path.join(publicRoot, 'uploads/images/tmp', `${legacyXxh32(target.toString())}.cache`)

    expect(first.statusCode).toBe(200)
    expect(first.rawPayload).toEqual(posterBytes)
    expect(second.statusCode).toBe(302)
    expect(second.headers.location).toContain(`/uploads/images/tmp/${legacyXxh32(target.toString())}.cache`)
    expect(second.headers.location).not.toContain('gsc=')
    await expect(readFile(expected)).resolves.toEqual(posterBytes)
    const publicResponse = await app.inject({ method: 'GET', url: new URL(second.headers.location ?? '').pathname })
    expect(publicResponse.statusCode).toBe(200)
    expect(publicResponse.rawPayload).toEqual(posterBytes)
    expect(upstreamHits.get('/poster.png')).toBe(1)
  })

  it('normalizes SRT subtitles to WebVTT and removes inline override tags', async () => {
    app = await buildMediaApp(true)
    const target = new URL('/caption.srt', upstreamUrl)
    const token = new Security(secureSalt).encryptURL(target.toString())
    const response = await app.inject({ method: 'GET', url: `/subtitle/${token}.vtt` })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('text/vtt; charset=utf-8')
    expect(response.body).toBe('WEBVTT\n\n1\n00:00:01.250 --> 00:00:03.500\nHello world')
  })

  it('converts ASS dialogue timing and line breaks to WebVTT', async () => {
    app = await buildMediaApp(true)
    const target = new URL('/caption.ass', upstreamUrl)
    const response = await app.inject({ method: 'GET', url: `/subtitle?url=${encodeURIComponent(target.toString())}` })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('00:00:02.100 --> 00:00:04.250')
    expect(response.body).toContain('First\nsecond')
  })

  it('auto-detects and caches legacy TXT subtitle grammars through an authenticated route', async () => {
    app = await buildMediaApp(true)
    const target = new URL('/caption.txt', upstreamUrl)
    const proxy = createMediaProxyPath('subtitle', target.toString(), new Security(secureSalt)) ?? ''

    const first = await app.inject({ method: 'GET', url: proxy })
    const second = await app.inject({ method: 'GET', url: proxy })

    expect(first.statusCode).toBe(200)
    expect(first.body).toBe('WEBVTT\n\n00:00:00.600 --> 00:00:01.700\nFirst\n\n00:00:01.700 --> 00:00:02.700\nSecond')
    expect(second.statusCode).toBe(302)
    expect(second.headers.location).toContain(`/uploads/subtitles/tmp/${legacyXxh32(target.toString())}.cache`)
    expect(upstreamHits.get('/caption.txt')).toBe(1)
  })

  it('converts and caches binary EBU STL through the authenticated subtitle route', async () => {
    const binary = ebuStlFixture()
    const target = new URL('https://media.provider.example/caption.stl')
    const open = vi.fn(async () => ({
      url: target,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      body: new Response(binary).body
    }))
    app = await buildMediaApp(false, { remoteStream: { open } as never })
    const proxy = createMediaProxyPath('subtitle', target.toString(), new Security(secureSalt)) ?? ''

    const first = await app.inject({ method: 'GET', url: proxy })
    const second = await app.inject({ method: 'GET', url: proxy })

    expect(first.statusCode).toBe(200)
    expect(first.body).toBe('WEBVTT\n\n01:00:02.500 --> 01:00:05.000\nCafé\nline two')
    expect(second.statusCode).toBe(302)
    expect(second.headers.location).toContain(`/uploads/subtitles/tmp/${legacyXxh32(target.toString())}.cache`)
    expect(open).toHaveBeenCalledOnce()
  })

  it('persists normalized subtitle output and redirects cache hits without another fetch', async () => {
    app = await buildMediaApp(true)
    const target = new URL('/caption.srt', upstreamUrl)
    const proxy = createMediaProxyPath('subtitle', target.toString(), new Security(secureSalt)) ?? ''

    const first = await app.inject({ method: 'GET', url: proxy })
    const second = await app.inject({ method: 'GET', url: proxy })
    const expected = path.join(publicRoot, 'uploads/subtitles/tmp', `${legacyXxh32(target.toString())}.cache`)

    expect(first.body).toContain('WEBVTT')
    expect(second.statusCode).toBe(302)
    expect(second.headers.location).toContain(`/uploads/subtitles/tmp/${legacyXxh32(target.toString())}.cache`)
    await expect(readFile(expected, 'utf8')).resolves.toBe(first.body)
    const publicResponse = await app.inject({ method: 'GET', url: new URL(second.headers.location ?? '').pathname })
    expect(publicResponse.statusCode).toBe(200)
    expect(publicResponse.body).toBe(first.body)
    expect(upstreamHits.get('/caption.srt')).toBe(1)
  })

  it('rejects malformed authenticated paths without reflecting token material', async () => {
    app = await buildMediaApp(true)
    const response = await app.inject({ method: 'GET', url: '/subtitle/not-private-token.vtt' })

    expect(response.statusCode).toBe(400)
    expect(response.body).toBe('Invalid subtitle link')
    expect(response.body).not.toContain('not-private-token')
  })

  it('blocks private-network proxy targets in the public route configuration', async () => {
    app = await buildMediaApp(false)
    const target = new URL('/poster.png', upstreamUrl)
    const token = new Security(secureSalt).encryptURL(target.toString())
    const response = await app.inject({ method: 'GET', url: `/poster/${token}.png` })

    expect(response.statusCode).toBe(502)
    expect(response.body).toBe('Poster is unavailable')
    expect(response.body).not.toContain('127.0.0.1')
  })

  it('serves authenticated filmstrips and repairs relative sprite URLs', async () => {
    app = await buildMediaApp(true)
    const target = new URL('/previews/strip.vtt', upstreamUrl)
    const token = new Security(secureSalt).encryptURL(target.toString())
    const response = await app.inject({ method: 'GET', url: `/filmstrip/${token}.vtt` })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('text/vtt; charset=utf-8')
    expect(response.body).toContain('WEBVTT\n\n00:00:00.000 --> 00:00:05.000')
    expect(response.body).toContain(`${upstreamUrl.origin}/previews/sprites/sheet.jpg#xywh=0,0,160,90`)
  })

  it('reuses the downloaded custom filmstrip sprite while regenerating VTT per request', async () => {
    const sprite = Buffer.alloc(24)
    posterBytes.copy(sprite)
    sprite.writeUInt32BE(80, 16)
    sprite.writeUInt32BE(88, 20)
    const open = vi.fn(async (request: Readonly<{ url: string | URL }>) => ({
      url: request.url instanceof URL ? request.url : new URL(request.url),
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'image/png' }),
      body: new Response(sprite).body
    }))
    app = await buildMediaApp(false, { remoteStream: { open } as never })
    const target = new URL('https://cdn.mycdn.me/videoPreview.jpg#count=2&frequency=5')
    const proxy = createMediaProxyPath('filmstrip', target.toString(), new Security(secureSalt)) ?? ''

    const first = await app.inject({ method: 'GET', url: proxy })
    const second = await app.inject({ method: 'GET', url: proxy })
    const alternateTarget = new URL(target)
    alternateTarget.hash = 'count=1&frequency=10'
    const alternateProxy = createMediaProxyPath('filmstrip', alternateTarget.toString(), new Security(secureSalt)) ?? ''
    const alternate = await app.inject({ method: 'GET', url: alternateProxy })
    const imageTarget = new URL(target)
    imageTarget.hash = ''
    const expected = path.join(publicRoot, 'uploads/images/cache', `${legacyXxh32(imageTarget.toString())}.jpg`)

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(second.body).toBe(first.body)
    expect(second.body).toContain('videoPreview.jpg#xywh=0,44,80,44')
    expect(alternate.body).toContain('00:00:00.000 --> 00:00:10.000')
    expect(alternate.body).not.toContain('00:00:10.000 -->')
    await expect(readFile(expected)).resolves.toEqual(sprite)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('applies server-only provider headers to provider-owned media without leaking them into redirects', async () => {
    const providerContexts = new ProviderStreamContextRegistry()
    const targets = [
      new URL('/poster.png', upstreamUrl),
      new URL('/caption.srt', upstreamUrl),
      new URL('/previews/strip.vtt', upstreamUrl)
    ]
    const contextToken = providerContexts.register({
      host: 'streamhg',
      targets,
      referer: 'https://embed.example/e/fixture',
      cookies: ['session=media-secret'],
      userAgent: 'Provider Browser',
      language: 'fr-FR'
    }) ?? ''
    app = await buildMediaApp(true, { providerContexts })

    for (const [route, target] of [
      ['poster', targets[0]],
      ['subtitle', targets[1]],
      ['filmstrip', targets[2]]
    ] as const) {
      const proxy = createMediaProxyPath(route, target?.toString() ?? '', new Security(secureSalt), contextToken) ?? ''
      const response = await app.inject({ method: 'GET', url: proxy })
      expect(response.statusCode).toBe(200)
      expect(lastUpstreamHeaders).toMatchObject({
        cookie: 'session=media-secret',
        origin: 'https://embed.example',
        referer: 'https://embed.example/e/fixture',
        'user-agent': 'Provider Browser',
        'accept-language': 'fr-FR'
      })
      expect(response.body).not.toContain('media-secret')

      const cached = await app.inject({ method: 'GET', url: proxy })
      if (route === 'filmstrip') {
        expect(cached.statusCode).toBe(200)
        expect(cached.body).not.toContain('media-secret')
      } else {
        expect(cached.statusCode).toBe(302)
        expect(cached.headers.location).not.toContain(contextToken)
        expect(cached.headers.location).not.toContain('media-secret')
      }
    }
  })

  it('rejects malformed filmstrip tokens without performing a fetch', async () => {
    app = await buildMediaApp(true)
    const response = await app.inject({ method: 'GET', url: '/filmstrip/not-private.vtt' })

    expect(response.statusCode).toBe(400)
    expect(response.body).toBe('Invalid filmstrip link')
  })
})

describe('subtitle format compatibility', () => {
  it('converts YouTube timed-text XML', () => {
    const output = normalizeWebVtt(
      '<transcript><text start="1.5" dur="2.25">Tom &amp; Jerry</text></transcript>',
      new URL('https://www.youtube.com/api/timedtext?lang=en')
    )
    expect(output).toContain('00:00:01.500 --> 00:00:03.750')
    expect(output).toContain('Tom & Jerry')
  })

  it('converts TTML cue markup', () => {
    const output = normalizeWebVtt(
      '<tt><body><p begin="00:00:05.000" end="00:00:07.500">Line<br/>two</p></body></tt>',
      new URL('https://cdn.example/caption.ttml')
    )
    expect(output).toContain('00:00:05.000 --> 00:00:07.500')
    expect(output).toContain('Line\ntwo')
  })
})

describe('filmstrip format compatibility', () => {
  it('repairs Dood CDN sprite paths onto the dedicated image host', () => {
    const output = repairFilmstripWebVtt(
      'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\n/slides/sheet.jpg#xywh=0,0,120,68',
      new URL('https://i.doodcdn.co/vtt/preview.vtt')
    )

    expect(output).toContain('https://img.doodcdn.co/slides/sheet.jpg#xywh=0,0,120,68')
  })

  it('creates legacy image-sprite cue sheets from fragment metadata', () => {
    const png = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
    png.writeUInt32BE(80, 16)
    png.writeUInt32BE(88, 20)

    const output = createSpriteFilmstripWebVtt(
      png,
      new URL('https://mycdn.me/videoPreview.jpg#count=2&frequency=5'),
      80,
      44
    )

    expect(output).toContain('00:00:00.000 --> 00:00:05.000')
    expect(output).toContain('videoPreview.jpg#xywh=0,0,80,44')
    expect(output).toContain('00:00:05.000 --> 00:00:10.000')
    expect(output).toContain('videoPreview.jpg#xywh=0,44,80,44')
  })
})

function ebuStlFixture(): Buffer {
  const result = Buffer.alloc(1_024 + 128, 0x20)
  result.write('850STL30', 0, 'ascii')
  const offset = 1_024
  result[offset + 3] = 0xff
  result.set([1, 0, 2, 15], offset + 5)
  result.set([1, 0, 5, 0], offset + 9)
  result.fill(0x8f, offset + 16, offset + 128)
  result.set(Buffer.from([0x43, 0x61, 0x66, 0xc2, 0x65, 0x8a, 0x6c, 0x69, 0x6e, 0x65, 0x20, 0x74, 0x77, 0x6f]), offset + 16)
  return result
}
