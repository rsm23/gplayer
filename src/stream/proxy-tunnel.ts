import { isIP, type Socket, connect as netConnect } from 'node:net'
import { checkServerIdentity, connect as tlsConnect, type PeerCertificate, type TLSSocket } from 'node:tls'
import type { ProxyDefinition } from '../settings/misc-settings.js'

const socketRemainders = new WeakMap<Socket | TLSSocket, Buffer>()

export type ProxyTargetAddress = Readonly<{
  address: string
  family: 4 | 6
}>

export async function openProxyTargetSocket(
  proxy: ProxyDefinition,
  target: URL,
  resolved: ProxyTargetAddress,
  timeoutMilliseconds: number,
  signal?: AbortSignal
): Promise<Socket | TLSSocket> {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error(`Proxy target protocol is unsupported: ${target.protocol}`)
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 120_000) {
    throw new Error('Proxy connection timeout is invalid')
  }
  let socket: Socket | TLSSocket | undefined
  const abort = (): void => { socket?.destroy(abortReason(signal)) }
  const timeoutError = new Error(`Proxy connection timed out after ${timeoutMilliseconds}ms`)
  const timer = setTimeout(() => socket?.destroy(timeoutError), timeoutMilliseconds)
  try {
    socket = await connectProxy(proxy, timeoutMilliseconds, signal)
    if (signal?.aborted === true) throw abortReason(signal)
    signal?.addEventListener('abort', abort, { once: true })
    if (proxy.type === 'socks4' || proxy.type === 'socks4a') await openSocks4Tunnel(socket, proxy, target, resolved)
    else if (proxy.type === 'socks5') await openSocks5Tunnel(socket, proxy, target, resolved)
    else await openHttpTunnel(socket, proxy, target, resolved)
    if (target.protocol === 'http:') return socket
    socket = await secureTarget(socket, target)
    return socket
  } catch (error) {
    socket?.destroy()
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
    clearTimeout(timer)
  }
}

async function connectProxy(proxy: ProxyDefinition, timeoutMilliseconds: number, signal?: AbortSignal): Promise<Socket | TLSSocket> {
  const socket = proxy.type === 'https'
    ? tlsConnect({
        host: proxy.hostname,
        port: proxy.port,
        rejectUnauthorized: true,
        checkServerIdentity: (_hostname, certificate) => verifyCertificateIdentity(proxy.hostname, certificate)
      })
    : netConnect({ host: proxy.hostname, port: proxy.port })
  const event = proxy.type === 'https' ? 'secureConnect' : 'connect'
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { socket.destroy(abortReason(signal)) }
    const cleanup = (): void => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
    const timeout = setTimeout(() => socket.destroy(new Error(`Proxy connection timed out after ${timeoutMilliseconds}ms`)), timeoutMilliseconds)
    socket.once(event, () => { cleanup(); resolve() })
    socket.once('error', (error) => { cleanup(); reject(error) })
    if (signal?.aborted === true) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
  return socket
}

async function openHttpTunnel(
  socket: Socket | TLSSocket,
  proxy: ProxyDefinition,
  target: URL,
  resolved: ProxyTargetAddress
): Promise<void> {
  const authority = targetAuthority(target, resolved.address)
  const version = proxy.type === 'http1.0' ? '1.0' : '1.1'
  const authentication = proxy.username === '' ? '' : `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`
  socket.write(`CONNECT ${authority} HTTP/${version}\r\nHost: ${authority}\r\n${authentication}Connection: keep-alive\r\n\r\n`)
  const header = await readSocketUntil(socket, '\r\n\r\n', 16 * 1_024)
  const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(header)?.[1] ?? 0)
  if (status !== 200) throw new Error(`HTTP proxy rejected CONNECT with status ${status || 'unknown'}`)
}

async function openSocks4Tunnel(
  socket: Socket | TLSSocket,
  proxy: ProxyDefinition,
  target: URL,
  resolved: ProxyTargetAddress
): Promise<void> {
  if (resolved.family !== 4 || isIP(resolved.address) !== 4) throw new Error('SOCKS4 proxy requires an IPv4 target')
  const port = targetPort(target)
  const address = Buffer.from(resolved.address.split('.').map(Number))
  const user = Buffer.from(proxy.username, 'utf8')
  socket.write(Buffer.concat([
    Buffer.from([4, 1, port >>> 8, port & 0xff]),
    address,
    user,
    Buffer.from([0])
  ]))
  const reply = await readSocketBytes(socket, 8)
  if (reply[1] !== 90) throw new Error(`SOCKS4 proxy rejected connection with code ${reply[1] ?? 'unknown'}`)
}

async function openSocks5Tunnel(
  socket: Socket | TLSSocket,
  proxy: ProxyDefinition,
  target: URL,
  resolved: ProxyTargetAddress
): Promise<void> {
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

  const address = proxyAddress(resolved)
  const port = targetPort(target)
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >>> 8, port & 0xff])]))
  const reply = await readSocketBytes(socket, 4)
  if (reply[0] !== 5 || reply[1] !== 0) throw new Error(`SOCKS5 proxy rejected connection with code ${reply[1] ?? 'unknown'}`)
  const addressLength = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await readSocketBytes(socket, 1))[0] ?? 0 : 0
  if (addressLength === 0) throw new Error('SOCKS5 proxy returned an invalid address type')
  await readSocketBytes(socket, addressLength + 2)
}

function proxyAddress(resolved: ProxyTargetAddress): Buffer {
  if (resolved.family === 4 && isIP(resolved.address) === 4) {
    return Buffer.from([1, ...resolved.address.split('.').map(Number)])
  }
  if (resolved.family !== 6 || isIP(resolved.address) !== 6) throw new Error('SOCKS5 target address is invalid')
  const bytes = ipv6Bytes(resolved.address)
  return Buffer.concat([Buffer.from([4]), bytes])
}

function ipv6Bytes(value: string): Buffer {
  const normalized = value.toLowerCase().split('%')[0] ?? ''
  const halves = normalized.split('::')
  if (halves.length > 2) throw new Error('SOCKS5 target IPv6 address is invalid')
  const left = ipv6Groups(halves[0] ?? '')
  const right = ipv6Groups(halves[1] ?? '')
  const missing = 8 - left.length - right.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) throw new Error('SOCKS5 target IPv6 address is invalid')
  const groups = [...left, ...Array.from({ length: missing }, () => 0), ...right]
  if (groups.length !== 8) throw new Error('SOCKS5 target IPv6 address is invalid')
  const result = Buffer.alloc(16)
  groups.forEach((group, index) => result.writeUInt16BE(group, index * 2))
  return result
}

function ipv6Groups(value: string): number[] {
  if (value === '') return []
  const groups = value.split(':')
  const mapped = groups.at(-1)
  if (mapped !== undefined && isIP(mapped) === 4) {
    const octets = mapped.split('.').map(Number)
    groups.splice(-1, 1, ((octets[0] ?? 0) << 8 | (octets[1] ?? 0)).toString(16), ((octets[2] ?? 0) << 8 | (octets[3] ?? 0)).toString(16))
  }
  return groups.map((group) => {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) throw new Error('SOCKS5 target IPv6 address is invalid')
    return Number.parseInt(group, 16)
  })
}

async function secureTarget(socket: Socket | TLSSocket, target: URL): Promise<TLSSocket> {
  const hostname = normalizedUrlHostname(target)
  const secure = tlsConnect({
    socket,
    ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
    rejectUnauthorized: true,
    checkServerIdentity: (_servername, certificate) => verifyCertificateIdentity(hostname, certificate)
  })
  await new Promise<void>((resolve, reject) => {
    secure.once('secureConnect', resolve)
    secure.once('error', reject)
  })
  return secure
}

function verifyCertificateIdentity(hostname: string, certificate: PeerCertificate): Error | undefined {
  return checkServerIdentity(hostname, certificate)
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('Proxy request aborted')
}

function normalizedUrlHostname(url: URL): string {
  const hostname = url.hostname
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function targetPort(target: URL): number {
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Proxy target port is invalid')
  return port
}

function targetAuthority(target: URL, address: string): string {
  const host = isIP(address) === 6 ? `[${address}]` : address
  return `${host}:${targetPort(target)}`
}

async function readSocketBytes(socket: Socket | TLSSocket, length: number): Promise<Buffer> {
  const existing = socketRemainders.get(socket) ?? Buffer.alloc(0)
  socketRemainders.delete(socket)
  if (existing.length >= length) {
    const remainder = existing.subarray(length)
    if (remainder.length > 0) socketRemainders.set(socket, remainder)
    return existing.subarray(0, length)
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = existing.length === 0 ? [] : [existing]
    let size = existing.length
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk)
      size += chunk.length
      if (size < length) return
      cleanup()
      const combined = Buffer.concat(chunks)
      const remainder = combined.subarray(length)
      if (remainder.length > 0) socketRemainders.set(socket, remainder)
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
  const existing = socketRemainders.get(socket) ?? Buffer.alloc(0)
  socketRemainders.delete(socket)
  return await new Promise<string>((resolve, reject) => {
    let content = existing
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
      if (remainder.length > 0) socketRemainders.set(socket, remainder)
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
    if (content.length > 0) onData(Buffer.alloc(0))
  })
}
