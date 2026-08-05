import { describe, expect, it } from 'vitest'
import { ProviderStreamContextRegistry } from '../src/stream/provider-stream-context.js'

describe('ProviderStreamContextRegistry', () => {
  it('keeps normalized provider headers behind an opaque origin-scoped token', () => {
    const registry = new ProviderStreamContextRegistry()
    const token = registry.register({
      host: 'streamhg',
      targets: ['https://media.example/master.m3u8'],
      referer: 'https://embed.example/e/fixture',
      cookies: ['session=hello%20world; Path=/', 'session=replaced', 'encoded=hello%20world', 'bad\r\nname=value'],
      userAgent: 'Provider Browser',
      language: 'fr-FR'
    })

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(token).not.toContain('session')
    expect(Object.fromEntries(registry.headersForTarget(token ?? '', new URL('https://media.example/segment.ts')))).toEqual({
      'accept-language': 'fr-FR',
      cookie: 'session=replaced; encoded=hello world',
      origin: 'https://embed.example',
      referer: 'https://embed.example/e/fixture',
      'user-agent': 'Provider Browser'
    })
    expect([...registry.headersForTarget(token ?? '', new URL('https://unrelated.example/segment.ts'))]).toEqual([])
  })

  it.each(['dood', 'mp4upload'])('omits the derived Origin header for %s', (host) => {
    const registry = new ProviderStreamContextRegistry()
    const token = registry.register({
      host,
      targets: ['https://media.example/video.mp4'],
      referer: 'https://embed.example/e/fixture'
    }) ?? ''

    const headers = registry.headersForTarget(token, new URL('https://media.example/video.mp4'))
    expect(headers.get('referer')).toBe('https://embed.example/e/fixture')
    expect(headers.has('origin')).toBe(false)
  })

  it('authorizes child origins only when an authorized manifest discovered them', () => {
    const registry = new ProviderStreamContextRegistry()
    const token = registry.register({
      host: 'direct',
      targets: ['https://manifest.example/master.m3u8'],
      cookies: ['authorization=secret']
    }) ?? ''

    expect(registry.authorizeManifestResource(
      token,
      new URL('https://unrelated.example/forged.m3u8'),
      new URL('https://child.example/segment.ts')
    )).toBe(false)
    expect(registry.authorizeManifestResource(
      token,
      new URL('https://manifest.example/master.m3u8'),
      new URL('https://child.example/segment.ts')
    )).toBe(true)
    expect(registry.headersForTarget(token, new URL('https://child.example/segment.ts')).get('cookie')).toBe('authorization=secret')
  })

  it('expires entries and evicts the oldest entry at the configured bound', () => {
    let now = 10_000
    const registry = new ProviderStreamContextRegistry({ ttlMilliseconds: 1_000, maximumEntries: 1, now: () => now })
    const first = registry.register({ host: 'direct', targets: ['https://first.example/video.mp4'], cookies: ['a=1'] }) ?? ''
    const second = registry.register({ host: 'direct', targets: ['https://second.example/video.mp4'], cookies: ['b=2'] }) ?? ''

    expect([...registry.headersForTarget(first, new URL('https://first.example/video.mp4'))]).toEqual([])
    expect(registry.headersForTarget(second, new URL('https://second.example/video.mp4')).get('cookie')).toBe('b=2')
    now += 1_000
    expect([...registry.headersForTarget(second, new URL('https://second.example/video.mp4'))]).toEqual([])
  })
})
