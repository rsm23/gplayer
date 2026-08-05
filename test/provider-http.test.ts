import { describe, expect, it, vi } from 'vitest'
import {
  ProxyUnavailableError,
  RuntimeProxyProviderHttpClient
} from '../src/hosting/provider-http.js'
import { parseProxyDefinition } from '../src/settings/misc-settings.js'
import type { RemoteStream } from '../src/stream/remote-stream.js'

describe('runtime proxy provider HTTP client', () => {
  it('selects a server-side proxy without placing its credentials in provider headers', async () => {
    const first = parseProxyDefinition('203.0.113.5:1080,socks5')
    const selected = parseProxyDefinition('198.51.100.8:8080,user:secret,http')
    if (first === null || selected === null) throw new Error('Expected proxy fixtures')
    const open = vi.fn(async (request: Parameters<RemoteStream['open']>[0]) => Object.freeze({
      url: new URL(request.url),
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: new Response('proxy fixture').body
    }))
    const client = new RuntimeProxyProviderHttpClient(
      async () => Object.freeze({ disabled: false, proxies: Object.freeze([first, selected]) }),
      { open } as Pick<RemoteStream, 'open'> as RemoteStream,
      () => 0.75
    )

    await expect(client.get({ url: 'https://provider.example/video', headers: { referer: 'https://provider.example/' } })).resolves.toEqual(
      expect.objectContaining({ status: 200, body: 'proxy fixture' })
    )
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0]?.[0].proxy).toBe(selected)
    const headers = new Headers(open.mock.calls[0]?.[0].headers)
    expect(headers.get('proxy-authorization')).toBeNull()
    expect(JSON.stringify(await client.get({ url: 'https://provider.example/again' }))).not.toContain('secret')
  })

  it('fails with a typed unavailable result when proxy use is disabled or empty', async () => {
    const disabled = new RuntimeProxyProviderHttpClient(async () => Object.freeze({ disabled: true, proxies: Object.freeze([]) }))
    await expect(disabled.get({ url: 'https://provider.example/' })).rejects.toBeInstanceOf(ProxyUnavailableError)
  })
})
