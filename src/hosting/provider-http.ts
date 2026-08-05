import { RemoteStream } from '../stream/remote-stream.js'

const MAX_PROVIDER_RESPONSE_BYTES = 5 * 1_024 * 1_024

export type ProviderHttpRequest = Readonly<{
  url: string | URL
  headers?: RequestInit['headers']
  preserveRedirectCookies?: boolean
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

export class RemoteProviderHttpClient implements ProviderHttpClient {
  public constructor(
    private readonly remoteStream = new RemoteStream(),
    private readonly allowPrivateNetworks = false
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

  private async request(method: 'GET' | 'HEAD' | 'POST', request: ProviderHttpPostRequest): Promise<ProviderHttpResponse> {
    const response = await this.remoteStream.open({
      url: request.url,
      method,
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(method === 'POST' && request.body !== undefined ? { body: request.body } : {}),
      ...(request.preserveRedirectCookies === undefined ? {} : { preserveRedirectCookies: request.preserveRedirectCookies }),
      allowPrivateNetworks: this.allowPrivateNetworks,
      includeResponseHeaders: ['set-cookie']
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
