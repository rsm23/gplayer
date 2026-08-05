import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { RemoteStream } from '../stream/remote-stream.js'
import { openProxyTargetSocket } from '../stream/proxy-tunnel.js'
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
      const addresses = await lookup(target.hostname, { all: true, verbatim: true })
      const selected = proxy.type === 'socks4' || proxy.type === 'socks4a'
        ? addresses.find((address) => address.family === 4)
        : addresses[0]
      if (selected === undefined || (selected.family !== 4 && selected.family !== 6)) throw new Error('Proxy check target could not be resolved')
      socket = await openProxyTargetSocket(proxy, target, { address: selected.address, family: selected.family }, timeoutMilliseconds)
      return await requestTarget(socket as TLSSocket, target)
    } finally {
      clearTimeout(timer)
      socket?.destroy()
    }
  }
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
