import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isPrivateAddress, RemoteStream } from '../src/stream/remote-stream.js'

const media = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')
let upstream: Server
let upstreamUrl: URL

beforeEach(async () => {
  upstream = createServer((request, response) => {
    if (request.url === '/post') {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          method: request.method,
          body: Buffer.concat(chunks).toString(),
          authorization: request.headers.authorization,
          apiVersion: request.headers['x-api-version'],
          loginTokenCheck: request.headers.filemaillogintokencheck,
          websiteToken: request.headers['x-website-token'],
          captchaToken: request.headers['x-captcha-token'],
          embedParent: request.headers['x-embed-parent'],
          providerOrigin: request.headers['x-origin'],
          signature: request.headers['x-signature'],
          leaked: request.headers['x-not-allowed']
        }))
      })
      return
    }
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/media' }).end()
      return
    }
    if (request.url === '/cookie-redirect') {
      response.writeHead(302, { location: '/cookie-target', 'set-cookie': 'sharepoint-session=fixture; Path=/; Secure' }).end()
      return
    }
    if (request.url === '/cookie-target') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ cookie: request.headers.cookie }))
      return
    }
    if (request.url === '/redirect-cross-origin') {
      const location = new URL('/post', upstreamUrl)
      location.hostname = 'localhost'
      response.writeHead(302, { location: location.toString() }).end()
      return
    }

    if (request.url !== '/media') {
      response.writeHead(404).end()
      return
    }

    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
    if (range) {
      const start = Number(range[1])
      const end = range[2] ? Number(range[2]) : media.length - 1
      if (start >= media.length || end < start) {
        response.writeHead(416, { 'content-range': `bytes */${media.length}` }).end()
        return
      }
      const slice = media.subarray(start, Math.min(end + 1, media.length))
      response.writeHead(206, {
        'accept-ranges': 'bytes',
        'content-length': slice.length,
        'content-range': `bytes ${start}-${start + slice.length - 1}/${media.length}`,
        'content-type': 'video/mp4',
        'x-upstream-secret': 'must-not-pass'
      })
      if (request.method === 'HEAD') response.end()
      else response.end(slice)
      return
    }

    response.writeHead(200, {
      'accept-ranges': 'bytes',
      'content-length': media.length,
      'content-type': 'video/mp4',
      'set-cookie': ['v1st=visitor; Path=/', 'ts=1700000000; Path=/']
    })
    if (request.method === 'HEAD') response.end()
    else response.end(media)
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
  upstreamUrl = new URL(`http://127.0.0.1:${address.port}`)
})

afterEach(async () => {
  upstream.close()
  await once(upstream, 'close')
})

async function body(response: Awaited<ReturnType<RemoteStream['open']>>): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  return Buffer.from(await new Response(response.body).arrayBuffer())
}

describe('RemoteStream', () => {
  it('forwards byte ranges and exposes only media response headers', async () => {
    const response = await new RemoteStream().open({
      url: new URL('/media', upstreamUrl),
      headers: { range: 'bytes=5-12', cookie: 'private-cookie' },
      allowPrivateNetworks: true
    })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 5-12/${media.length}`)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.has('x-upstream-secret')).toBe(false)
    expect(await body(response)).toEqual(media.subarray(5, 13))
  })

  it('supports HEAD without returning a body', async () => {
    const response = await new RemoteStream().open({
      url: new URL('/media', upstreamUrl),
      method: 'HEAD',
      allowPrivateNetworks: true
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(media.length))
    expect(response.body).toBeNull()
  })

  it('supports bounded internal POST data and filters provider request headers', async () => {
    const response = await new RemoteStream().open({
      url: new URL('/post', upstreamUrl),
      method: 'POST',
      headers: {
        authorization: 'Bearer provider-token',
        'content-type': 'application/json',
        filemaillogintokencheck: 'true',
        'x-api-version': '2.0',
        'x-captcha-token': 'captcha-token',
        'x-embed-parent': 'https://filemoon.to/e/fixture',
        'x-origin': 'https://collect.wetransfer.com',
        'x-signature': 'collect-signature',
        'x-website-token': 'website-token',
        'x-not-allowed': 'secret'
      },
      body: '{"fixture":true}',
      allowPrivateNetworks: true
    })

    expect(JSON.parse((await body(response)).toString())).toEqual({
      method: 'POST',
      body: '{"fixture":true}',
      authorization: 'Bearer provider-token',
      apiVersion: '2.0',
      loginTokenCheck: 'true',
      websiteToken: 'website-token',
      captchaToken: 'captcha-token',
      embedParent: 'https://filemoon.to/e/fixture',
      providerOrigin: 'https://collect.wetransfer.com',
      signature: 'collect-signature'
    })
  })

  it.each(['PUT', 'DELETE'] as const)('supports internal %s mutations with request bodies', async (method) => {
    const response = await new RemoteStream().open({
      url: new URL('/post', upstreamUrl),
      method,
      headers: { 'content-type': 'application/json' },
      body: '{"title":"fixture"}',
      allowPrivateNetworks: true
    })

    expect(JSON.parse((await body(response)).toString())).toEqual({
      method,
      body: '{"title":"fixture"}'
    })
  })

  it.each(['PUT', 'DELETE'] as const)('blocks cross-origin %s redirects', async (method) => {
    await expect(new RemoteStream().open({
      url: new URL('/redirect-cross-origin', upstreamUrl),
      method,
      body: '{}',
      allowPrivateNetworks: true
    })).rejects.toThrow(/Cross-origin mutation/)
  })

  it('keeps provider cookies private unless an internal caller requests them', async () => {
    const ordinary = await new RemoteStream().open({
      url: new URL('/media', upstreamUrl),
      method: 'HEAD',
      allowPrivateNetworks: true
    })
    expect(ordinary.headers.getSetCookie()).toEqual([])

    const provider = await new RemoteStream().open({
      url: new URL('/media', upstreamUrl),
      method: 'HEAD',
      allowPrivateNetworks: true,
      includeResponseHeaders: ['set-cookie']
    })
    expect(provider.headers.getSetCookie()).toEqual([
      'v1st=visitor; Path=/',
      'ts=1700000000; Path=/'
    ])
  })

  it('follows relative redirects and revalidates each target', async () => {
    const response = await new RemoteStream().open({
      url: new URL('/redirect', upstreamUrl),
      allowPrivateNetworks: true
    })
    expect(response.url.pathname).toBe('/media')
    expect(await body(response)).toEqual(media)
  })

  it('optionally preserves response cookies across same-origin provider redirects', async () => {
    const response = await new RemoteStream().open({
      url: new URL('/cookie-redirect', upstreamUrl),
      allowPrivateNetworks: true,
      preserveRedirectCookies: true
    })
    expect(JSON.parse((await body(response)).toString())).toEqual({ cookie: 'sharepoint-session=fixture' })
  })

  it('strips provider credentials before following a cross-origin redirect', async () => {
    const response = await new RemoteStream().open({
      url: new URL('/redirect-cross-origin', upstreamUrl),
      headers: {
        authorization: 'Bearer provider-token',
        cookie: 'session=secret',
        'x-website-token': 'website-token'
      },
      allowPrivateNetworks: true
    })

    expect(JSON.parse((await body(response)).toString())).toEqual({ method: 'GET', body: '' })
  })

  it('pins the validated address while preserving the original Host header', async () => {
    const hostnameUrl = new URL(upstreamUrl)
    hostnameUrl.hostname = 'localhost'
    const response = await new RemoteStream().open({
      url: new URL('/media', hostnameUrl),
      allowPrivateNetworks: true
    })

    expect(response.status).toBe(200)
    expect(await body(response)).toEqual(media)
  })

  it('blocks local targets unless an internal caller explicitly allows them', async () => {
    await expect(new RemoteStream().open({ url: new URL('/media', upstreamUrl) })).rejects.toThrow(/Private/)
  })

  it.each(['file:///tmp/video.mp4', 'ftp://example.com/video.mp4'])('rejects unsupported protocol %s', async (url) => {
    await expect(new RemoteStream().open({ url })).rejects.toThrow(/Unsupported stream protocol/)
  })
})

describe('isPrivateAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '::1', 'fc00::1', 'fe80::1'])('marks %s private', (address) => {
    expect(isPrivateAddress(address)).toBe(true)
  })

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('marks %s public', (address) => {
    expect(isPrivateAddress(address)).toBe(false)
  })
})
