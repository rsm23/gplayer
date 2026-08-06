import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { connect as netConnect, createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseProxyDefinition } from '../src/settings/misc-settings.js'
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
          clientId: request.headers['client-id'],
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
        'client-id': 'public-player-client',
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
      clientId: 'public-player-client',
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

  it('lets an internal caller reject a redirect before requesting its target', async () => {
    const allowRedirect = vi.fn(() => false)
    await expect(new RemoteStream().open({
      url: new URL('/redirect', upstreamUrl),
      allowPrivateNetworks: true,
      allowRedirect
    })).rejects.toThrow(/redirect target is not allowed/)
    expect(allowRedirect).toHaveBeenCalledWith(
      new URL('/redirect', upstreamUrl),
      new URL('/media', upstreamUrl)
    )
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

  it('tunnels through a credentialed HTTP proxy without bypassing target validation', async () => {
    const authorities: string[] = []
    const authorizations: Array<string | undefined> = []
    const proxy = createServer()
    proxy.on('connect', (request, client, head) => {
      authorities.push(request.url ?? '')
      authorizations.push(request.headers['proxy-authorization'])
      const [hostname = '', port = ''] = (request.url ?? '').split(':')
      const target = netConnect(Number(port), hostname, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) target.write(head)
        target.pipe(client)
        client.pipe(target)
      })
      target.once('error', () => client.destroy())
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    try {
      const address = proxy.address()
      if (!address || typeof address === 'string') throw new Error('Expected proxy TCP address')
      const definition = parseProxyDefinition(`127.0.0.1:${address.port},proxy-user:proxy-pass,http`)
      if (definition === null) throw new Error('Expected a proxy definition')

      const response = await new RemoteStream().open({
        url: new URL('/media', upstreamUrl),
        allowPrivateNetworks: true,
        proxy: definition
      })
      expect(response.status).toBe(200)
      expect(await body(response)).toEqual(media)
      expect(authorities).toEqual([`127.0.0.1:${upstreamUrl.port}`])
      expect(authorizations).toEqual([`Basic ${Buffer.from('proxy-user:proxy-pass').toString('base64')}`])

      await expect(new RemoteStream().open({
        url: new URL('/media', upstreamUrl),
        proxy: definition
      })).rejects.toThrow(/Private/)
      expect(authorities).toHaveLength(1)
    } finally {
      proxy.close()
      await once(proxy, 'close')
    }
  })

  it('tunnels through a SOCKS4 proxy using the pinned IPv4 target', async () => {
    const observed: Array<Readonly<{ address: string, port: number, username: string }>> = []
    const proxy = createSocks4Proxy(observed)
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    try {
      const address = proxy.address()
      if (!address || typeof address === 'string') throw new Error('Expected SOCKS4 TCP address')
      const definition = parseProxyDefinition(`127.0.0.1:${address.port},fixture-user:ignored,socks4`)
      if (definition === null) throw new Error('Expected a SOCKS4 proxy definition')
      const response = await new RemoteStream().open({
        url: new URL('/media', upstreamUrl),
        allowPrivateNetworks: true,
        proxy: definition
      })

      expect(await body(response)).toEqual(media)
      expect(observed).toEqual([{ address: '127.0.0.1', port: Number(upstreamUrl.port), username: 'fixture-user' }])
    } finally {
      proxy.close()
      await once(proxy, 'close')
    }
  })

  it('authenticates and tunnels through SOCKS5 using the pinned target address', async () => {
    const observed: Array<Readonly<{ address: string, port: number, username: string, password: string }>> = []
    const proxy = createSocks5Proxy(observed)
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    try {
      const address = proxy.address()
      if (!address || typeof address === 'string') throw new Error('Expected SOCKS5 TCP address')
      const definition = parseProxyDefinition(`127.0.0.1:${address.port},fixture-user:fixture-pass,socks5`)
      if (definition === null) throw new Error('Expected a SOCKS5 proxy definition')
      const response = await new RemoteStream().open({
        url: new URL('/media', upstreamUrl),
        allowPrivateNetworks: true,
        proxy: definition
      })

      expect(await body(response)).toEqual(media)
      expect(observed).toEqual([{
        address: '127.0.0.1',
        port: Number(upstreamUrl.port),
        username: 'fixture-user',
        password: 'fixture-pass'
      }])
    } finally {
      proxy.close()
      await once(proxy, 'close')
    }
  })

  it('aborts a stalled proxy handshake before the hard proxy timeout', async () => {
    const proxy = createTcpServer((client) => client.on('data', () => undefined))
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    try {
      const address = proxy.address()
      if (!address || typeof address === 'string') throw new Error('Expected proxy TCP address')
      const definition = parseProxyDefinition(`127.0.0.1:${address.port},http`)
      if (definition === null) throw new Error('Expected an HTTP proxy definition')
      const started = Date.now()
      await expect(new RemoteStream().open({
        url: new URL('/media', upstreamUrl),
        allowPrivateNetworks: true,
        proxy: definition,
        proxyTimeoutMilliseconds: 2_000,
        signal: AbortSignal.timeout(30)
      })).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      proxy.close()
      await once(proxy, 'close')
    }
  })

  it('blocks local targets unless an internal caller explicitly allows them', async () => {
    await expect(new RemoteStream().open({ url: new URL('/media', upstreamUrl) })).rejects.toThrow(/Private/)
    await expect(new RemoteStream().open({ url: 'http://[::1]/media' })).rejects.toThrow(/Private/)
  })

  it.each(['file:///tmp/video.mp4', 'ftp://example.com/video.mp4'])('rejects unsupported protocol %s', async (url) => {
    await expect(new RemoteStream().open({ url })).rejects.toThrow(/Unsupported stream protocol/)
  })
})

function createSocks4Proxy(observed: Array<Readonly<{ address: string, port: number, username: string }>>): TcpServer {
  return createTcpServer((client) => {
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const userEnd = buffered.indexOf(0, 8)
      if (buffered.length < 9 || userEnd < 0) return
      client.off('data', onData)
      if (buffered[0] !== 4 || buffered[1] !== 1) {
        client.destroy()
        return
      }
      const port = buffered.readUInt16BE(2)
      const address = [...buffered.subarray(4, 8)].join('.')
      const username = buffered.subarray(8, userEnd).toString('utf8')
      observed.push(Object.freeze({ address, port, username }))
      connectProxyTarget(client, address, port, buffered.subarray(userEnd + 1), Buffer.from([0, 90, 0, 0, 0, 0, 0, 0]))
    }
    client.on('data', onData)
  })
}

function createSocks5Proxy(observed: Array<Readonly<{ address: string, port: number, username: string, password: string }>>): TcpServer {
  return createTcpServer((client) => {
    let buffered = Buffer.alloc(0)
    let state: 'greeting' | 'authentication' | 'request' = 'greeting'
    let username = ''
    let password = ''
    const consume = (): void => {
      if (state === 'greeting') {
        if (buffered.length < 2) return
        const length = 2 + (buffered[1] ?? 0)
        if (buffered.length < length) return
        const methods = buffered.subarray(2, length)
        buffered = buffered.subarray(length)
        if (!methods.includes(2)) {
          client.end(Buffer.from([5, 255]))
          return
        }
        state = 'authentication'
        client.write(Buffer.from([5, 2]))
      }
      if (state === 'authentication') {
        if (buffered.length < 2) return
        const usernameLength = buffered[1] ?? 0
        if (buffered.length < 3 + usernameLength) return
        const passwordLength = buffered[2 + usernameLength] ?? 0
        const length = 3 + usernameLength + passwordLength
        if (buffered.length < length) return
        username = buffered.subarray(2, 2 + usernameLength).toString('utf8')
        password = buffered.subarray(3 + usernameLength, length).toString('utf8')
        buffered = buffered.subarray(length)
        state = 'request'
        client.write(Buffer.from([1, 0]))
      }
      if (state !== 'request' || buffered.length < 10) return
      if (buffered[0] !== 5 || buffered[1] !== 1 || buffered[3] !== 1) {
        client.destroy()
        return
      }
      client.off('data', onData)
      const address = [...buffered.subarray(4, 8)].join('.')
      const port = buffered.readUInt16BE(8)
      observed.push(Object.freeze({ address, port, username, password }))
      connectProxyTarget(client, address, port, buffered.subarray(10), Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
    }
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      consume()
    }
    client.on('data', onData)
  })
}

function connectProxyTarget(client: Socket, address: string, port: number, remainder: Buffer, success: Buffer): void {
  const target = netConnect(port, address, () => {
    client.write(success)
    if (remainder.length > 0) target.write(remainder)
    target.pipe(client)
    client.pipe(target)
  })
  target.once('error', () => client.destroy())
  client.once('error', () => target.destroy())
}

describe('isPrivateAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1'])('marks %s private', (address) => {
    expect(isPrivateAddress(address)).toBe(true)
  })

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('marks %s public', (address) => {
    expect(isPrivateAddress(address)).toBe(false)
  })
})
