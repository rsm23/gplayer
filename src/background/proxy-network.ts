import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { RemoteStream } from '../stream/remote-stream.js'
import type { ProxyDefinition } from '../settings/misc-settings.js'
import type { FreeProxySource, ProxyProbe } from './proxy-maintenance-worker.js'

const FREE_PROXY_URL = new URL('https://free-proxy-list.net/')
const MAX_SOURCE_BYTES = 2 * 1_024 * 1_024
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024

export class FixedFreeProxySource implements FreeProxySource {
  public constructor(private readonly remote: Pick<RemoteStream, 'open'> = new RemoteStream()) {}

  public async list(timeoutMilliseconds: number): Promise<readonly string[]> {
    const response = await this.remote.open({
      url: FREE_PROXY_URL,
      method: 'GET',
      headers: { origin: FREE_PROXY_URL.origin, referer: FREE_PROXY_URL.toString() },
      maximumRedirects: 2,
      signal: AbortSignal.timeout(timeoutMilliseconds)
    })
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel().catch(() => undefined)
      return Object.freeze([])
    }
    const html = await readWebBody(response.body, MAX_SOURCE_BYTES)
    const rawSection = /<[^>]+id=["']raw["'][^>]*>[\s\S]*?<textarea[^>]*>([\s\S]*?)<\/textarea>/i.exec(html)?.[1]
    if (rawSection === undefined) return Object.freeze([])
    const content = decodeHtml(rawSection).split('UTC.').at(-1) ?? ''
    return Object.freeze([...new Set(content.split(/\s+/).map((value) => value.trim()).filter(Boolean))].slice(0, 500))
  }
}

export class NodeProxyProbe implements ProxyProbe {
  public async fetchText(proxy: ProxyDefinition, target: URL, timeoutMilliseconds: number): Promise<string> {
    if (target.protocol !== 'https:' || target.username !== '' || target.password !== '') throw new Error('Proxy checks require a credential-free HTTPS target')
    let socket: Socket | TLSSocket | undefined
    const timeoutError = new Error(`Proxy check timed out after ${timeoutMilliseconds}ms`)
    const timer = setTimeout(() => socket?.destroy(timeoutError), timeoutMilliseconds)
    try {
      socket = await connectProxy(proxy, timeoutMilliseconds)
      if (proxy.type === 'socks4' || proxy.type === 'socks4a') await openSocks4Tunnel(socket, proxy, target)
      else if (proxy.type === 'socks5') await openSocks5Tunnel(socket, proxy, target)
      else await openHttpTunnel(socket, proxy, target)
      const secure = await secureTarget(socket, target)
      socket = secure
      return await requestTarget(secure, target)
    } finally {
      clearTimeout(timer)
      socket?.destroy()
    }
  }
}

async function connectProxy(proxy: ProxyDefinition, timeoutMilliseconds: number): Promise<Socket | TLSSocket> {
  const socket = proxy.type === 'https'
    ? tlsConnect({ host: proxy.hostname, port: proxy.port, rejectUnauthorized: true })
    : netConnect({ host: proxy.hostname, port: proxy.port })
  const event = proxy.type === 'https' ? 'secureConnect' : 'connect'
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => socket.destroy(new Error(`Proxy connection timed out after ${timeoutMilliseconds}ms`)), timeoutMilliseconds)
    socket.once(event, () => { clearTimeout(timeout); resolve() })
    socket.once('error', (error) => { clearTimeout(timeout); reject(error) })
  })
  return socket
}

async function openHttpTunnel(socket: Socket | TLSSocket, proxy: ProxyDefinition, target: URL): Promise<void> {
  const authority = `${target.hostname}:${target.port || '443'}`
  const version = proxy.type === 'http1.0' ? '1.0' : '1.1'
  const authentication = proxy.username === '' ? '' : `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`
  socket.write(`CONNECT ${authority} HTTP/${version}\r\nHost: ${authority}\r\n${authentication}Connection: keep-alive\r\n\r\n`)
  const header = await readSocketUntil(socket, '\r\n\r\n', 16 * 1_024)
  const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(header)?.[1] ?? 0)
  if (status !== 200) throw new Error(`HTTP proxy rejected CONNECT with status ${status || 'unknown'}`)
}

async function openSocks4Tunnel(socket: Socket | TLSSocket, proxy: ProxyDefinition, target: URL): Promise<void> {
  const port = Number(target.port || 443)
  const hostname = target.hostname
  let address: Buffer
  let suffix = Buffer.alloc(0)
  if (proxy.type === 'socks4a') {
    address = Buffer.from([0, 0, 0, 1])
    suffix = Buffer.from(`${hostname}\0`, 'ascii')
  } else {
    const resolved = isIP(hostname) === 4 ? hostname : (await lookup(hostname, { family: 4 })).address
    address = Buffer.from(resolved.split('.').map(Number))
  }
  const user = Buffer.from(proxy.username, 'utf8')
  socket.write(Buffer.concat([
    Buffer.from([4, 1, port >>> 8, port & 0xff]),
    address,
    user,
    Buffer.from([0]),
    suffix
  ]))
  const reply = await readSocketBytes(socket, 8)
  if (reply[1] !== 90) throw new Error(`SOCKS4 proxy rejected connection with code ${reply[1] ?? 'unknown'}`)
}

async function openSocks5Tunnel(socket: Socket | TLSSocket, proxy: ProxyDefinition, target: URL): Promise<void> {
  const hasCredentials = proxy.username !== ''
  socket.write(hasCredentials ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]))
  const greeting = await readSocketBytes(socket, 2)
  if (greeting[0] !== 5 || greeting[1] === 255) throw new Error('SOCKS5 proxy did not accept an authentication method')
  if (greeting[1] === 2) {
    const username = Buffer.from(proxy.username, 'utf8')
    const password = Buffer.from(proxy.password, 'utf8')
    if (username.length === 0 || username.length > 255 || password.length > 255) throw new Error('SOCKS5 credentials exceed protocol limits')
    socket.write(Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]))
    const authenticated = await readSocketBytes(socket, 2)
    if (authenticated[1] !== 0) throw new Error('SOCKS5 proxy authentication failed')
  } else if (greeting[1] !== 0) {
    throw new Error(`SOCKS5 proxy selected unsupported authentication method ${greeting[1] ?? 'unknown'}`)
  }

  const hostname = Buffer.from(target.hostname, 'ascii')
  if (hostname.length === 0 || hostname.length > 255) throw new Error('SOCKS5 target hostname exceeds protocol limits')
  const port = Number(target.port || 443)
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, hostname.length]), hostname, Buffer.from([port >>> 8, port & 0xff])]))
  const reply = await readSocketBytes(socket, 4)
  if (reply[0] !== 5 || reply[1] !== 0) throw new Error(`SOCKS5 proxy rejected connection with code ${reply[1] ?? 'unknown'}`)
  const addressLength = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await readSocketBytes(socket, 1))[0] ?? 0 : 0
  if (addressLength === 0) throw new Error('SOCKS5 proxy returned an invalid address type')
  await readSocketBytes(socket, addressLength + 2)
}

async function secureTarget(socket: Socket | TLSSocket, target: URL): Promise<TLSSocket> {
  const secure = tlsConnect({ socket, servername: target.hostname, rejectUnauthorized: true })
  await new Promise<void>((resolve, reject) => {
    secure.once('secureConnect', resolve)
    secure.once('error', reject)
  })
  return secure
}

async function requestTarget(socket: TLSSocket, target: URL): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const request = httpsRequest(target, {
      method: 'GET',
      agent: false,
      createConnection: () => socket,
      headers: { accept: '*/*', 'accept-encoding': 'identity', connection: 'close', 'user-agent': 'GPlayer/0.1 proxy-check' }
    })
    request.once('error', reject)
    request.once('response', (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += value.length
        if (size > MAX_RESPONSE_BYTES) response.destroy(new Error('Proxy check response exceeded the size limit'))
        else chunks.push(value)
      })
      response.once('error', reject)
      response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    request.end()
  })
}

async function readSocketBytes(socket: Socket | TLSSocket, length: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk)
      size += chunk.length
      if (size < length) return
      cleanup()
      const combined = Buffer.concat(chunks)
      const remainder = combined.subarray(length)
      if (remainder.length > 0) socket.unshift(remainder)
      resolve(combined.subarray(0, length))
    }
    const onError = (error: Error): void => { cleanup(); reject(error) }
    const onEnd = (): void => { cleanup(); reject(new Error('Proxy closed the connection unexpectedly')) }
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('end', onEnd)
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('end', onEnd)
  })
}

async function readSocketUntil(socket: Socket | TLSSocket, marker: string, maximum: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let content = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      content = Buffer.concat([content, chunk])
      if (content.length > maximum) {
        cleanup()
        reject(new Error('Proxy response header exceeded the size limit'))
        return
      }
      const index = content.indexOf(marker)
      if (index < 0) return
      cleanup()
      const end = index + Buffer.byteLength(marker)
      const remainder = content.subarray(end)
      if (remainder.length > 0) socket.unshift(remainder)
      resolve(content.subarray(0, end).toString('latin1'))
    }
    const onError = (error: Error): void => { cleanup(); reject(error) }
    const onEnd = (): void => { cleanup(); reject(new Error('Proxy closed the connection unexpectedly')) }
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('end', onEnd)
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('end', onEnd)
  })
}

async function readWebBody(body: ReadableStream<Uint8Array>, maximum: number): Promise<string> {
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) throw new Error('Remote proxy source exceeded the size limit')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    reader.releaseLock()
  }
}

function decodeHtml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
}
