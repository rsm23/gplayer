import { describe, expect, it, vi } from 'vitest'
import { FixedFreeProxySource, NodeProxyProbe } from '../src/background/proxy-network.js'
import { ProxyMaintenanceWorker, type ProxyMaintenanceConfiguration } from '../src/background/proxy-maintenance-worker.js'
import { parseProxyDefinition } from '../src/settings/misc-settings.js'

class MemoryProxyStore {
  public saved: string[][] = []
  public constructor(public configuration: ProxyMaintenanceConfiguration) {}
  public async loadProxyConfiguration(): Promise<ProxyMaintenanceConfiguration> { return this.configuration }
  public async saveProxyList(proxies: readonly string[]): Promise<void> { this.saved.push([...proxies]) }
}

describe('proxy maintenance worker', () => {
  it('discovers only when the configured pool is sparse, checks unique proxies, and saves only validated results', async () => {
    const store = new MemoryProxyStore({ disabled: false, useConfiguredOnly: false, proxies: ['198.51.100.1:8080'] })
    const source = { list: vi.fn(async () => ['198.51.100.1:8080', '198.51.100.2:443,https', 'not-a-proxy']) }
    const probe = {
      fetchText: vi.fn(async (proxy: Readonly<{ hostname: string }>) => proxy.hostname.endsWith('.1') ? 'status=ok' : '<title>reCAPTCHA</title>')
    }
    const worker = new ProxyMaintenanceWorker(store, source, probe as never, { timeout: 2_000, concurrency: 2 })

    await expect(worker.runOnce()).resolves.toEqual({ disabled: false, discovered: 1, checked: 2, valid: 1 })
    expect(source.list).toHaveBeenCalledWith(2_000)
    expect(probe.fetchText).toHaveBeenCalledTimes(2)
    expect(store.saved).toEqual([
      ['198.51.100.1:8080', '198.51.100.2:443,https'],
      ['198.51.100.1:8080']
    ])
  })

  it('does not scrape or overwrite the stored list while proxy use is disabled', async () => {
    const store = new MemoryProxyStore({ disabled: true, useConfiguredOnly: false, proxies: ['198.51.100.1:8080'] })
    const source = { list: vi.fn(async () => ['198.51.100.2:8080']) }
    const probe = { fetchText: vi.fn(async () => 'ok') }

    await expect(new ProxyMaintenanceWorker(store, source, probe as never).runOnce()).resolves.toEqual({
      disabled: true, discovered: 0, checked: 0, valid: 0
    })
    expect(source.list).not.toHaveBeenCalled()
    expect(probe.fetchText).not.toHaveBeenCalled()
    expect(store.saved).toEqual([])
  })

  it('honors configured-only mode and clears a nonempty pool when every check fails', async () => {
    const store = new MemoryProxyStore({ disabled: false, useConfiguredOnly: true, proxies: ['198.51.100.3:1080,user:pass,socks5'] })
    const source = { list: vi.fn(async () => ['198.51.100.2:8080']) }
    const probe = { fetchText: vi.fn(async () => '') }

    await expect(new ProxyMaintenanceWorker(store, source, probe as never).runOnce()).resolves.toEqual({
      disabled: false, discovered: 0, checked: 1, valid: 0
    })
    expect(source.list).not.toHaveBeenCalled()
    expect(store.saved).toEqual([[]])
  })
})

describe('proxy network contracts', () => {
  it('parses every legacy proxy type with IPv4/IPv6 and optional credentials', () => {
    expect(parseProxyDefinition('198.51.100.8:8080')).toMatchObject({ type: 'http', hostname: '198.51.100.8', port: 8080, username: '' })
    expect(parseProxyDefinition('198.51.100.8:8080,http1.0')).toMatchObject({ type: 'http1.0' })
    expect(parseProxyDefinition('[2001:db8::1]:443,https')).toMatchObject({ type: 'https', hostname: '2001:db8::1', port: 443 })
    expect(parseProxyDefinition('198.51.100.8:1080,user:pass,socks5')).toMatchObject({ type: 'socks5', username: 'user', password: 'pass' })
    expect(parseProxyDefinition('198.51.100.8:1080,socks4')).toMatchObject({ type: 'socks4' })
    expect(parseProxyDefinition('198.51.100.8:1080,socks4a')).toMatchObject({ type: 'socks4a' })
  })

  it('extracts and deduplicates the fixed source textarea with a bounded pinned request', async () => {
    const html = '<div id="raw"><textarea>Updated UTC.\n198.51.100.1:80\r\n198.51.100.1:80 198.51.100.2:443</textarea></div>'
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(html)); controller.close() } })
    const open = vi.fn(async () => ({ status: 200, body }))
    const source = new FixedFreeProxySource({ open } as never)

    await expect(source.list(3_000)).resolves.toEqual(['198.51.100.1:80', '198.51.100.2:443'])
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      url: new URL('https://free-proxy-list.net/'),
      method: 'GET',
      maximumRedirects: 2,
      signal: expect.any(AbortSignal)
    }))
  })

  it('refuses non-HTTPS validation targets before opening a proxy connection', async () => {
    const proxy = parseProxyDefinition('198.51.100.8:8080')
    if (proxy === null) throw new Error('fixture proxy did not parse')
    await expect(new NodeProxyProbe().fetchText(proxy, new URL('http://example.test/'), 100)).rejects.toThrow('HTTPS target')
  })
})
