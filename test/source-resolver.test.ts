import { describe, expect, it, vi } from 'vitest'
import {
  SourceResolver,
  type HostingExtractor,
  type HostingExtractorFactory,
  type MediaResult,
  type SourceCacheCriteria,
  type SourceCacheInsert,
  type SourceCacheRecord,
  type SourceCacheRepository
} from '../src/core/source-resolver.js'

class MemorySourceCache implements SourceCacheRepository {
  public record: SourceCacheRecord | null = null
  public readonly finds: SourceCacheCriteria[] = []
  public readonly deletes: SourceCacheCriteria[] = []
  public readonly inserts: SourceCacheInsert[] = []

  public async find(criteria: SourceCacheCriteria): Promise<SourceCacheRecord | null> {
    this.finds.push(criteria)
    return this.record
  }

  public async delete(criteria: SourceCacheCriteria): Promise<void> {
    this.deletes.push(criteria)
    this.record = null
  }

  public async insert(record: SourceCacheInsert): Promise<void> {
    this.inserts.push(record)
  }
}

class FakeExtractor implements HostingExtractor {
  public host = ''
  public downloadable = false
  public hlsMode = false
  public email = ''
  public sourceCalls = 0

  public setHost(host: string): this { this.host = host; return this }
  public setDownloadable(downloadable: boolean): this { this.downloadable = downloadable; return this }
  public setHlsMode(enabled: boolean): this { this.hlsMode = enabled; return this }
  public setEmail(email: string): this { this.email = email; return this }
  public getSources() {
    this.sourceCalls += 1
    return this.hlsMode
      ? [{ file: 'https://cdn.example/master.m3u8', type: 'hls' }]
      : [{ file: 'https://cdn.example/video.mp4', type: 'mp4' }]
  }
  public getTracks() { return [{ file: 'sub.vtt', kind: 'captions' }] }
  public getReferer() { return 'https://origin.example/' }
  public getTitle() { return 'Example' }
  public getEmail() { return this.email }
  public getImage() { return 'poster.jpg' }
  public getCookies() { return ['session=value'] }
  public getFilmstrip() { return 'strip.vtt' }
  public getNetworkInterface() { return '203.0.113.9' }
}

describe('Core source resolver parity', () => {
  it('uses all legacy cache dimensions and returns a valid cached result', async () => {
    const cache = new MemorySourceCache()
    const cached = result({ file: 'cached.mp4', type: 'mp4' }, '198.51.100.4', {
      host: 'earnvids', id: 'abc', userAgent: 'Browser UA', language: 'fr-FR'
    })
    cache.record = record(cached)
    const extractor = new FakeExtractor()
    const resolver = createResolver(cache, extractor)
      .setQuery({ host: 'filelions', id: 'abc', email: 'user@example.com' })
      .setDownload(true)

    await expect(resolver.getResult()).resolves.toEqual(cached)
    expect(extractor.sourceCalls).toBe(0)
    expect(cache.finds[0]).toEqual({
      host: 'earnvids',
      hostId: 'abc',
      expiresAfter: 1_700_000_000,
      downloadable: true,
      userAgent: 'Browser UA',
      language: 'fr-FR',
      serverId: 7,
      clientIp: '198.51.100.4'
    })
  })

  it('extracts, formats, and caches on a miss', async () => {
    const cache = new MemorySourceCache()
    const extractor = new FakeExtractor()
    const resolver = createResolver(cache, extractor)
      .setQuery({ host: 'streamwish', id: 'xyz', email: 'user@example.com' })
      .setDownload(true)

    const output = await resolver.getResult()

    expect(output).toEqual(result(
      { file: 'https://cdn.example/video.mp4', type: 'mp4' },
      '198.51.100.4',
      { host: 'streamhg', id: 'xyz', userAgent: 'Default UA', language: 'en;q=0.9' }
    ))
    expect(extractor).toMatchObject({ host: 'Streamhg', downloadable: true, email: 'user@example.com' })
    expect(cache.inserts).toHaveLength(1)
    expect(cache.inserts[0]).toEqual(expect.objectContaining({
      host: 'streamhg',
      hostId: 'xyz',
      downloadable: true,
      serverId: 7,
      created: 1_700_000_000,
      expired: 1_700_007_200,
      userAgent: 'Default UA',
      language: 'en;q=0.9',
      clientIp: '198.51.100.4',
      serverIp: '203.0.113.9'
    }))
  })

  it('forces a browser-scoped refresh before extracting a replacement source', async () => {
    const cache = new MemorySourceCache()
    cache.record = record(result({ file: 'https://cdn.example/stale.mp4', type: 'video/mp4' }))
    const extractor = new FakeExtractor()
    const resolver = createResolver(cache, extractor)
      .setQuery({ host: 'filelions', id: 'refresh-id' })
      .setDownload(true)

    await expect(resolver.refreshResult()).resolves.toMatchObject({
      sources: [{ file: 'https://cdn.example/video.mp4', type: 'mp4' }]
    })

    expect(cache.finds).toHaveLength(0)
    expect(cache.deletes).toEqual([{
      host: 'earnvids',
      hostId: 'refresh-id',
      expiresAfter: 1_700_000_000,
      downloadable: true,
      userAgent: 'Browser UA',
      language: 'fr-FR',
      serverId: 7,
      clientIp: '198.51.100.4'
    }])
    expect(extractor.sourceCalls).toBe(1)
    expect(cache.inserts).toHaveLength(1)
  })

  it('refreshes a cached Google MP4 after HLS mode is enabled', async () => {
    const cache = new MemorySourceCache()
    cache.record = record(result({ file: 'cached.mp4', type: 'video/mp4' }))
    const extractor = new FakeExtractor()
    const resolver = createResolver(cache, extractor, { googleHlsHosts: new Set(['googlephotos']) })
      .setQuery({ host: 'googlephotos', id: 'abc' })

    await expect(resolver.getResult()).resolves.toMatchObject({
      sources: [{ file: 'https://cdn.example/master.m3u8', type: 'hls' }]
    })

    expect(cache.deletes).toHaveLength(1)
    expect(extractor.sourceCalls).toBe(1)
    expect(extractor.hlsMode).toBe(true)
  })

  it('refreshes expiring Google HLS manifests on every HLS-mode resolution', async () => {
    const cache = new MemorySourceCache()
    cache.record = record(result({ file: 'cached.m3u8', type: 'hls' }))
    const extractor = new FakeExtractor()
    const resolver = createResolver(cache, extractor, { googleHlsHosts: new Set(['gdrive']) })
      .setQuery({ host: 'gdrive', id: 'abc' })

    await expect(resolver.getResult()).resolves.toMatchObject({
      sources: [{ file: 'https://cdn.example/master.m3u8', type: 'hls' }]
    })

    expect(cache.deletes).toHaveLength(1)
    expect(extractor.hlsMode).toBe(true)
  })

  it('refreshes a cached Google HLS source after HLS mode is disabled', async () => {
    const cache = new MemorySourceCache()
    cache.record = record(result({ file: 'cached.m3u8', type: 'hls' }))
    const extractor = new FakeExtractor()
    const resolver = createResolver(cache, extractor).setQuery({ host: 'gdrive', id: 'abc' })

    await expect(resolver.getResult()).resolves.toMatchObject({
      sources: [{ file: 'https://cdn.example/video.mp4', type: 'mp4' }]
    })

    expect(cache.deletes).toHaveLength(1)
    expect(extractor.hlsMode).toBe(false)
  })

  it('keeps Google downloads in MP4 mode even when playback HLS is enabled', async () => {
    const cache = new MemorySourceCache()
    cache.record = record(result({ file: 'cached.m3u8', type: 'hls' }))
    const extractor = new FakeExtractor()
    const resolver = createResolver(cache, extractor, {
      googleHlsHosts: new Set(['gdrive']),
      downloadableHosts: new Set(['gdrive'])
    })
      .setQuery({ host: 'gdrive', id: 'abc' })
      .setDownload(true)

    await expect(resolver.getResult()).resolves.toMatchObject({
      sources: [{ file: 'https://cdn.example/video.mp4', type: 'mp4' }]
    })

    expect(cache.deletes).toHaveLength(1)
    expect(extractor).toMatchObject({ downloadable: true, hlsMode: false })
  })

  it('recovers complete results written in the previous wrapper-shaped cache format', async () => {
    const cache = new MemorySourceCache()
    const legacy = result({ file: 'https://cdn.example/video.mp4', type: 'mp4' })
    cache.record = {
      ...record(legacy),
      data: JSON.stringify({ result: legacy, sources: legacy.sources, serverIp: '203.0.113.9' })
    }
    const extractor = new FakeExtractor()
    const resolver = createResolver(cache, extractor).setQuery({ host: 'streamhg', id: 'wrapped' })

    await expect(resolver.getResult()).resolves.toMatchObject({
      tracks: legacy.tracks,
      referer: legacy.referer,
      cookies: legacy.cookies,
      upstream: { host: 'streamhg', id: 'wrapped', userAgent: 'Browser UA', language: 'fr-FR' }
    })
    expect(extractor.sourceCalls).toBe(0)
  })

  it('does not persist empty extractor results', async () => {
    const cache = new MemorySourceCache()
    const extractor = new FakeExtractor()
    vi.spyOn(extractor, 'getSources').mockReturnValue([])
    const resolver = createResolver(cache, extractor).setQuery({ host: 'streamhg', id: 'none' })

    await expect(resolver.getResult()).resolves.toEqual({
      sources: [], tracks: [], referer: '', title: '', email: '', image: '', cookies: [], filmstrip: '', clientip: ''
    })
    expect(cache.inserts).toHaveLength(0)
  })

  it('round-trips every extracted result field through a newly inserted cache record', async () => {
    const cache = new MemorySourceCache()
    const firstExtractor = new FakeExtractor()
    const first = createResolver(cache, firstExtractor).setQuery({ host: 'streamhg', id: 'round-trip', email: 'user@example.com' })
    const extracted = await first.getResult()
    const inserted = cache.inserts[0]
    expect(inserted).toBeDefined()

    cache.record = {
      data: inserted?.data ?? '',
      language: inserted?.language ?? '',
      userAgent: inserted?.userAgent ?? '',
      created: inserted?.created ?? 0,
      expired: inserted?.expired ?? 0
    }
    const cachedExtractor = new FakeExtractor()
    const second = createResolver(cache, cachedExtractor).setQuery({ host: 'streamhg', id: 'round-trip', email: 'user@example.com' })

    await expect(second.getResult()).resolves.toEqual(extracted)
    expect(cachedExtractor.sourceCalls).toBe(0)
    expect(JSON.parse(inserted?.data ?? '{}')).toMatchObject({
      tracks: [{ file: 'sub.vtt', kind: 'captions' }],
      referer: 'https://origin.example/',
      cookies: ['session=value'],
      upstream: { host: 'streamhg', id: 'round-trip', userAgent: 'Default UA', language: 'en;q=0.9' }
    })
  })

  it('enables download extraction only for configured HLS/MP4 hosts', async () => {
    const cache = new MemorySourceCache()
    const extractor = new FakeExtractor()
    const resolver = createResolver(cache, extractor, { downloadableHosts: new Set(['streamhg']) })
      .setQuery({ host: 'youtube', id: 'abc' })
      .setDownload(true)

    await resolver.getResult()

    expect(extractor.downloadable).toBe(false)
    expect(cache.inserts[0]?.downloadable).toBe(false)
  })

  it('uses the default timeout and exact configured host timeout', () => {
    const resolver = createResolver(new MemorySourceCache(), new FakeExtractor())
    expect(resolver.getTimeout('unknown')).toBe(10_800)
    expect(resolver.getTimeout('streamhg')).toBe(7_200)
  })
})

function createResolver(
  cache: MemorySourceCache,
  extractor: FakeExtractor,
  overrides: Partial<Parameters<typeof resolverOptions>[0]> = {}
): SourceResolver {
  return new SourceResolver(resolverOptions({ cache, extractor, ...overrides }))
}

function resolverOptions(options: {
  cache: SourceCacheRepository
  extractor: FakeExtractor
  directHosts?: ReadonlySet<string>
  downloadableHosts?: ReadonlySet<string>
  googleHlsHosts?: ReadonlySet<string>
}) {
  const factory: HostingExtractorFactory = { create: () => options.extractor }
  return {
    cache: options.cache,
    extractors: factory,
    clientIp: '198.51.100.4',
    serverId: 7,
    defaultUserAgent: 'Default UA',
    defaultLanguage: 'en;q=0.9',
    requestUserAgent: 'Browser UA',
    requestLanguage: 'fr-FR',
    directHosts: options.directHosts ?? new Set(['earnvids']),
    downloadableHosts: options.downloadableHosts ?? new Set(['earnvids', 'streamhg']),
    googleHlsHosts: options.googleHlsHosts ?? new Set(),
    timeoutHosts: { streamhg: 7_200 },
    now: () => 1_700_000_000_000
  }
}

function result(
  source: Record<string, unknown>,
  clientip = '198.51.100.4',
  upstream?: MediaResult['upstream']
): MediaResult {
  return {
    sources: [source],
    tracks: [{ file: 'sub.vtt', kind: 'captions' }],
    referer: 'https://origin.example/',
    title: 'Example',
    email: 'user@example.com',
    image: 'poster.jpg',
    cookies: ['session=value'],
    filmstrip: 'strip.vtt',
    clientip,
    ...(upstream === undefined ? {} : { upstream })
  }
}

function record(data: MediaResult): SourceCacheRecord {
  return {
    data: JSON.stringify(data),
    language: 'fr-FR',
    userAgent: 'Browser UA',
    created: 1_699_999_000,
    expired: 1_700_001_000
  }
}
