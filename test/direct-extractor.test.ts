import { describe, expect, it, vi } from 'vitest'
import { DirectExtractor, typeFromContentType } from '../src/hosting/direct.js'
import { ExtractorFactory } from '../src/hosting/extractor-factory.js'

describe('Direct hosting extractor', () => {
  it.each([
    ['https://cdn.example/video.m3u8', 'hls'],
    ['https://cdn.example/manifest.mpd', 'mpd'],
    ['https://cdn.example/video.mp4', 'video/mp4'],
    ['https://cdn.example/video.mkv', 'video/mp4']
  ])('classifies %s without an upstream request', async (url, type) => {
    const probe = vi.fn()
    const extractor = new DirectExtractor(url, probe)

    await expect(extractor.getSources()).resolves.toEqual([{ file: url, type, label: 'Original' }])
    expect(extractor.getTitle()).toBe(url.split('/').at(-1))
    expect(probe).not.toHaveBeenCalled()
  })

  it('uses response content type for extensionless URLs', async () => {
    const probe = vi.fn(async () => ({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      finalUrl: 'https://edge.example/live/index.m3u8',
      networkInterface: '203.0.113.2'
    }))
    const extractor = new DirectExtractor('https://cdn.example/watch?id=1', probe)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://edge.example/live/index.m3u8', type: 'hls', label: 'Original'
    }])
    expect(extractor.getNetworkInterface()).toBe('203.0.113.2')
  })

  it('sniffs HLS and DASH text bodies when content type is inconclusive', async () => {
    const hls = new DirectExtractor('https://cdn.example/hls', async () => ({
      status: 200, contentType: 'text/plain', bodyPrefix: '#EXTM3U\n#EXT-X-VERSION:3'
    }))
    const dash = new DirectExtractor('https://cdn.example/dash', async () => ({
      status: 200, contentType: 'text/xml', bodyPrefix: '<?xml version="1.0"?><MPD>'
    }))

    await expect(hls.getSources()).resolves.toEqual([{
      file: 'https://cdn.example/hls', type: 'hls', label: 'Original'
    }])
    await expect(dash.getSources()).resolves.toEqual([{
      file: 'https://cdn.example/dash', type: 'mpd', label: 'Original'
    }])
  })

  it('uses the legacy Xvs static fallback for an XVFS player page', async () => {
    const extractor = new DirectExtractor('https://player.example/watch/abc', async () => ({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      finalUrl: 'https://player.example/embed/abc',
      bodyPrefix: `<script>jwplayer('v').setup({
        title: 'must not replace the Direct title',
        sources: [
          { file: 'https://media.example/master.m3u8', type: 'application/x-mpegURL', label: 'Auto' },
          { file: 'https://media.example/video.mp4', label: '720p' }
        ]
      })</script>`
    }))

    await expect(extractor.getSources()).resolves.toEqual([
      { file: 'https://media.example/master.m3u8', type: 'hls', label: 'Auto' },
      { file: 'https://media.example/video.mp4', type: 'video/mp4', label: '720p' }
    ])
    expect(extractor.getTitle()).toBe('abc')
    expect(extractor.getReferer()).toBe('')
  })

  it('does not execute or treat unrelated page URLs as Xvs media', async () => {
    const extractor = new DirectExtractor('https://player.example/watch', async () => ({
      status: 200,
      contentType: 'text/html',
      bodyPrefix: `<script>globalThis.pwned = true</script>
        <a href="https://example.test/account">Account</a>`
    }))

    await expect(extractor.getSources()).resolves.toEqual([])
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined()
  })

  it('uses a DNS-pinned provider client for the factory default direct probe', async () => {
    const http = {
      head: vi.fn(async () => ({
        url: new URL('https://player.example/embed/abc'),
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: ''
      })),
      get: vi.fn(async () => ({
        url: new URL('https://player.example/embed/abc'),
        status: 200,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        body: `sources: [{file: 'https://media.example/video.mp4'}]`
      })),
      post: vi.fn()
    }
    const extractor = new ExtractorFactory({ providerHttpClient: http }).create(
      'direct',
      'https://player.example/watch/abc'
    )

    await expect(extractor?.getSources()).resolves.toEqual([
      { file: 'https://media.example/video.mp4', type: 'video/mp4', label: 'Original' }
    ])
    expect(http.head).toHaveBeenCalledWith({ url: new URL('https://player.example/watch/abc') })
    expect(http.get).toHaveBeenCalledWith({ url: new URL('https://player.example/embed/abc') })
  })

  it('does not create a source for invalid URLs or failed probes', async () => {
    await expect(new DirectExtractor('file:///tmp/video.mp4').getSources()).resolves.toEqual([])
    await expect(new DirectExtractor('https://cdn.example/nope', async () => ({ status: 404 })).getSources()).resolves.toEqual([])
    await expect(new DirectExtractor('https://cdn.example/error', async () => { throw new Error('network') }).getSources()).resolves.toEqual([])
  })

  it.each([
    ['application/x-mpegURL', 'hls'],
    ['application/dash+xml', 'mpd'],
    ['video/webm', 'video/mp4'],
    ['audio/mpeg', 'video/mp4'],
    ['application/octet-stream', 'video/mp4'],
    ['text/html', null]
  ])('maps content type %s', (contentType, expected) => {
    expect(typeFromContentType(contentType)).toBe(expected)
  })

  it('registers direct extraction and supports provider extensions', () => {
    const factory = new ExtractorFactory().register('custom', (id) => new DirectExtractor(id))
    expect(factory.supportedHosts()).toEqual([
      'amazon', 'aparat', 'archive', 'blogger', 'cloudmailru', 'custom', 'cyberfile', 'dailymotion', 'direct', 'dood', 'dropbox', 'dropload', 'dzen', 'earnvids', 'facebook', 'filemail', 'filemoon', 'filesfm', 'fileupload', 'fireload',
      'gdrive', 'gofile', 'goodstream', 'googlephotos', 'hexupload', 'hxfile', 'iceyfile', 'krakenfiles', 'lulustream', 'mediacm', 'mediafire', 'mixdrop',
      'mp4upload', 'mstream', 'mymailru', 'navertv', 'nossoplayer', 'okru', 'pcloud', 'pixeldrain', 'rumble', 'savefiles', 'sendvid', 'sibnet', 'soundcloud', 'streama2z', 'streamable', 'streamhg', 'streamtape', 'supervideo',
      'thetube', 'tiktok', 'turboviplay', 'twitch',
      'udrop', 'uqload', 'vidara', 'vidmoly', 'vidoza', 'vidtube', 'vidyard', 'vimeo', 'vk', 'voe', 'vtube', 'vudeo', 'wetransfer', 'yadisk', 'yourupload', 'youtube'
    ])
    expect(factory.create('custom', 'https://cdn.example/a.mp4')).toBeInstanceOf(DirectExtractor)
    expect(factory.create('missing', 'id')).toBeNull()
  })
})
