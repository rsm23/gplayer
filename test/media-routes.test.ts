import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import {
  createSpriteFilmstripWebVtt,
  normalizeWebVtt,
  registerMediaRoutes,
  repairFilmstripWebVtt
} from '../src/http/media-routes.js'
import { Security } from '../src/security/security.js'

const secureSalt = '1234567890123456'
const posterBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
let upstream: Server
let upstreamUrl: URL
let app: FastifyInstance | undefined

beforeEach(async () => {
  upstream = createServer((request, response) => {
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
})

async function buildMediaApp(allowPrivateNetworks: boolean): Promise<FastifyInstance> {
  const instance = Fastify()
  await registerMediaRoutes(
    instance,
    loadConfig({ NODE_ENV: 'test', SECURE_SALT: secureSalt }),
    { allowPrivateNetworks }
  )
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
