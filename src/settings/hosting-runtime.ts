import type { ProviderHttpClient, ProviderHttpPostRequest, ProviderHttpRequest, ProviderHttpResponse } from '../hosting/provider-http.js'
import { runtimeHostingSettings, type RuntimeHostingSettings } from './hosting-settings.js'

export type HostingSettingsLoader = () => Promise<RuntimeHostingSettings>

export async function loadRuntimeHostingSettings(
  loader: HostingSettingsLoader | undefined,
  supportedHosts: ReadonlySet<string>
): Promise<RuntimeHostingSettings> {
  if (loader === undefined) return runtimeHostingSettings({}, supportedHosts)
  try {
    return await loader()
  } catch {
    return runtimeHostingSettings({}, supportedHosts)
  }
}

export class ProviderCookieHttpClient implements ProviderHttpClient {
  public constructor(
    private readonly host: string,
    private readonly base: ProviderHttpClient,
    private readonly loadSettings: HostingSettingsLoader
  ) {}

  public async get(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    return await this.base.get(await this.withConfiguredCookie(request))
  }

  public async head(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    return await this.base.head(await this.withConfiguredCookie(request))
  }

  public async post(request: ProviderHttpPostRequest): Promise<ProviderHttpResponse> {
    return await this.base.post(await this.withConfiguredCookie(request))
  }

  private async withConfiguredCookie<T extends ProviderHttpPostRequest>(request: T): Promise<T> {
    let configured = ''
    try {
      configured = (await this.loadSettings()).cookies[this.host] ?? ''
    } catch {
      configured = ''
    }
    if (configured === '') return request

    const headers = new Headers(request.headers)
    headers.set('cookie', mergeCookieHeaders(configured, headers.get('cookie') ?? ''))
    return Object.freeze({ ...request, headers }) as T
  }
}

function mergeCookieHeaders(configured: string, requestCookie: string): string {
  const cookies = new Map<string, string>()
  for (const source of [configured, requestCookie]) {
    for (const pair of source.split(';').map((entry) => entry.trim()).filter(Boolean)) {
      const separator = pair.indexOf('=')
      if (separator < 1) continue
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
    }
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
}
