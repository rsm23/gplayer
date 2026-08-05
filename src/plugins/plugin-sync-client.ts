import { RemoteStream } from '../stream/remote-stream.js'

const MAX_PING_BYTES = 1 * 1_024 * 1_024
const MAX_PLUGIN_BYTES = 100 * 1_024 * 1_024

export class PluginSyncClient {
  public constructor(
    private readonly remote: Pick<RemoteStream, 'open'>,
    private readonly adminDirectory: string,
    private readonly secureSalt: string
  ) {}

  public async ping(mainSite: URL, id: string, timeoutMilliseconds: number): Promise<boolean> {
    const response = await this.request(mainSite, id, 'ping', timeoutMilliseconds)
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel().catch(() => undefined)
      return false
    }
    return (await readBody(response.body, MAX_PING_BYTES)).toString('utf8').trim() === 'ok'
  }

  public async download(mainSite: URL, id: string, timeoutMilliseconds: number): Promise<Buffer> {
    const response = await this.request(mainSite, id, 'download', timeoutMilliseconds)
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`Plugin sync download failed with status ${response.status}`)
    }
    return await readBody(response.body, MAX_PLUGIN_BYTES)
  }

  private async request(mainSite: URL, id: string, action: 'ping' | 'download', timeoutMilliseconds: number) {
    const target = pluginSyncUrl(mainSite, this.adminDirectory, id, this.secureSalt, action)
    return await this.remote.open({
      url: target,
      method: 'GET',
      allowPrivateNetworks: true,
      maximumRedirects: 2,
      signal: AbortSignal.timeout(timeoutMilliseconds)
    })
  }
}

export function pluginSyncUrl(mainSite: URL, adminDirectory: string, id: string, secureSalt: string, action: 'ping' | 'download'): URL {
  if (!/^\d+$/.test(id)) throw new Error('Plugin sync id is invalid')
  const base = new URL(mainSite)
  if (!['http:', 'https:'].includes(base.protocol) || base.username !== '' || base.password !== '') throw new Error('Plugin main-site URL is invalid')
  const cleanAdmin = adminDirectory.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/${cleanAdmin}/plugins/sync/`
  base.search = ''
  base.hash = ''
  base.searchParams.set('id', id)
  base.searchParams.set('secure', secureSalt)
  base.searchParams.set('action', action)
  return base
}

async function readBody(body: ReadableStream<Uint8Array>, maximum: number): Promise<Buffer> {
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) throw new Error('Plugin sync response exceeded its size limit')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}
