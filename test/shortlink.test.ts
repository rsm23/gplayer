import { describe, expect, it } from 'vitest'
import {
  parseShortlinkResponse,
  ShortlinkService,
  type ShortlinkHttpClient,
  type ShortlinkHttpResponse
} from '../src/shortlinks/shortlink-service.js'
import type { RuntimeShortlinkSettings } from '../src/settings/settings-admin-service.js'

class MemoryShortlinkHttpClient implements ShortlinkHttpClient {
  public readonly requests: URL[] = []

  public constructor(
    private readonly response: ShortlinkHttpResponse | Error
  ) {}

  public async get(url: URL): Promise<ShortlinkHttpResponse> {
    this.requests.push(url)
    if (this.response instanceof Error) throw this.response
    return this.response
  }
}

const directTarget = 'https://cdn.example/media/movie one.mp4?download=1'

function runtimeSettings(overrides: Partial<RuntimeShortlinkSettings> = {}): RuntimeShortlinkSettings {
  return {
    disabled: false,
    selected: 'clicksfly_com',
    providers: [{
      id: 'clicksfly_com',
      apiUrl: 'https://clicksfly.com/st?api=%s&url=%s',
      apiKey: 'secret key&value'
    }],
    ...overrides
  }
}

describe('shortlink runtime', () => {
  it('calls only the selected allowlisted provider and parses a JSON destination', async () => {
    const http = new MemoryShortlinkHttpClient({
      status: 200,
      location: '',
      body: JSON.stringify({ data: { short_url: 'https://short.example/abc' } })
    })
    const service = new ShortlinkService(async () => runtimeSettings(), http)

    await expect(service.shorten(directTarget)).resolves.toBe('https://short.example/abc')
    expect(http.requests).toHaveLength(1)
    expect(http.requests[0]?.origin).toBe('https://clicksfly.com')
    expect(http.requests[0]?.pathname).toBe('/st')
    expect(http.requests[0]?.searchParams.get('api')).toBe('secret key&value')
    expect(http.requests[0]?.searchParams.get('url')).toBe(new URL(directTarget).href)
  })

  it('returns direct links without transport when disabled, unconfigured, or invalid', async () => {
    const http = new MemoryShortlinkHttpClient({ status: 200, location: '', body: 'https://short.example/unused' })
    const disabled = new ShortlinkService(async () => runtimeSettings({ disabled: true }), http)
    const unconfigured = new ShortlinkService(async () => runtimeSettings({ providers: [] }), http)

    await expect(disabled.shorten(directTarget)).resolves.toBe(new URL(directTarget).href)
    await expect(unconfigured.shorten(directTarget)).resolves.toBe(new URL(directTarget).href)
    await expect(disabled.shorten('javascript:alert(1)')).resolves.toBe('javascript:alert(1)')
    expect(http.requests).toHaveLength(0)
  })

  it('selects only configured providers in random mode', async () => {
    const http = new MemoryShortlinkHttpClient({ status: 302, location: 'https://short.example/random', body: '' })
    const service = new ShortlinkService(async () => runtimeSettings({
      selected: 'random',
      providers: [
        { id: 'clicksfly_com', apiUrl: 'https://clicksfly.com/st?api=%s&url=%s', apiKey: 'first' },
        { id: 'ouo_io', apiUrl: 'https://ouo.io/qs/%s?s=%s', apiKey: 'second' }
      ]
    }), http, () => 0.99)

    await expect(service.shorten(directTarget)).resolves.toBe('https://short.example/random')
    expect(http.requests[0]?.origin).toBe('https://ouo.io')
    expect(http.requests[0]?.pathname).toBe('/qs/second')
    expect(http.requests[0]?.searchParams.get('s')).toBe(new URL(directTarget).href)
  })

  it('rejects altered provider templates and fails open on transport errors', async () => {
    const alteredHttp = new MemoryShortlinkHttpClient({ status: 200, location: '', body: 'https://short.example/wrong' })
    const altered = new ShortlinkService(async () => runtimeSettings({
      providers: [{ id: 'clicksfly_com', apiUrl: 'https://attacker.example/st?api=%s&url=%s', apiKey: 'secret' }]
    }), alteredHttp)
    const failedHttp = new MemoryShortlinkHttpClient(new Error('offline'))
    const failed = new ShortlinkService(async () => runtimeSettings(), failedHttp)

    await expect(altered.shorten(directTarget)).resolves.toBe(new URL(directTarget).href)
    expect(alteredHttp.requests).toHaveLength(0)
    await expect(failed.shorten(directTarget)).resolves.toBe(new URL(directTarget).href)
  })

  it.each([
    [{ status: 200, location: '', body: 'https://short.example/plain' }, 'https://short.example/plain'],
    [{ status: 201, location: '', body: '{"shortened_url":"https://short.example/json"}' }, 'https://short.example/json'],
    [{ status: 302, location: 'https://short.example/redirect', body: '' }, 'https://short.example/redirect'],
    [{ status: 200, location: '', body: '{"success":false,"url":"https://short.example/ignored"}' }, null],
    [{ status: 200, location: '', body: '{"status":"error","url":"https://short.example/ignored"}' }, null],
    [{ status: 200, location: '', body: '{"url":"javascript:alert(1)"}' }, null],
    [{ status: 200, location: '', body: 'https://user:pass@short.example/private' }, null],
    [{ status: 500, location: 'https://short.example/ignored', body: '' }, null]
  ] as const)('parses bounded provider response forms without accepting unsafe URLs', (response, expected) => {
    expect(parseShortlinkResponse(response)).toBe(expected)
  })
})
