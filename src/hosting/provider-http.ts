import { RemoteStream } from '../stream/remote-stream.js'
import type { ProxyDefinition, RuntimeProxySettings } from '../settings/misc-settings.js'

const MAX_PROVIDER_RESPONSE_BYTES = 5 * 1_024 * 1_024

export type ProviderHttpRequest = Readonly<{
  url: string | URL
  headers?: RequestInit['headers']
  preserveRedirectCookies?: boolean
  signal?: AbortSignal
}>

export type ProviderHttpPostRequest = ProviderHttpRequest & Readonly<{
  body?: string | Uint8Array
}>

export type ProviderHttpResponse = Readonly<{
  url: URL
  status: number
  headers: Headers
  body: string
}>

export interface ProviderHttpClient {
  get(request: ProviderHttpRequest): Promise<ProviderHttpResponse>
  head(request: ProviderHttpRequest): Promise<ProviderHttpResponse>
  post(request: ProviderHttpPostRequest): Promise<ProviderHttpResponse>
}

export type RuntimeProxySettingsLoader = () => Promise<RuntimeProxySettings>

export class ProxyUnavailableError extends Error {
  public constructor() {
    super('No configured outbound proxy is available')
    this.name = 'ProxyUnavailableError'
  }
}

export class RemoteProviderHttpClient implements ProviderHttpClient {
  public constructor(
    private readonly remoteStream = new RemoteStream(),
    private readonly allowPrivateNetworks = false,
    private readonly proxy?: ProxyDefinition
  ) {}

  public async get(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    return await this.request('GET', request)
  }

  public async head(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    return await this.request('HEAD', request)
  }

  public async post(request: ProviderHttpPostRequest): Promise<ProviderHttpResponse> {
    return await this.request('POST', request)
  }

  public async put(request: ProviderHttpPostRequest): Promise<ProviderHttpResponse> {
    return await this.request('PUT', request)
  }

  public async delete(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    return await this.request('DELETE', request)
  }

  private async request(method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE', request: ProviderHttpPostRequest): Promise<ProviderHttpResponse> {
    const response = await this.remoteStream.open({
      url: request.url,
      method,
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(method !== 'GET' && method !== 'HEAD' && request.body !== undefined ? { body: request.body } : {}),
      ...(request.preserveRedirectCookies === undefined ? {} : { preserveRedirectCookies: request.preserveRedirectCookies }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      allowPrivateNetworks: this.allowPrivateNetworks,
      includeResponseHeaders: ['set-cookie'],
      ...(this.proxy === undefined ? {} : { proxy: this.proxy })
    })
    const body = await readLimitedText(
      response.body,
      MAX_PROVIDER_RESPONSE_BYTES,
      response.headers.get('content-type') ?? ''
    )
    return {
      url: response.url,
      status: response.status,
      headers: response.headers,
      body
    }
  }
}

/** Selects one current server-side proxy per request without exposing its credentials to extractors. */
export class RuntimeProxyProviderHttpClient implements ProviderHttpClient {
  public constructor(
    private readonly loadSettings: RuntimeProxySettingsLoader,
    private readonly remoteStream = new RemoteStream(),
    private readonly random: () => number = Math.random
  ) {}

  public async get(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    return await (await this.client()).get(request)
  }

  public async head(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    return await (await this.client()).head(request)
  }

  public async post(request: ProviderHttpPostRequest): Promise<ProviderHttpResponse> {
    return await (await this.client()).post(request)
  }

  private async client(): Promise<RemoteProviderHttpClient> {
    const settings = await this.loadSettings()
    if (settings.disabled || settings.proxies.length === 0) throw new ProxyUnavailableError()
    const sample = this.random()
    const position = Number.isFinite(sample) ? Math.floor(Math.max(0, Math.min(0.9999999999999999, sample)) * settings.proxies.length) : 0
    const proxy = settings.proxies[position]
    if (proxy === undefined) throw new ProxyUnavailableError()
    return new RemoteProviderHttpClient(this.remoteStream, false, proxy)
  }
}

async function readLimitedText(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  contentType: string
): Promise<string> {
  if (body === null) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) throw new Error(`Provider response exceeds the ${limit}-byte limit`)
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  }
  const charset = contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] ?? 'utf-8'
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}
