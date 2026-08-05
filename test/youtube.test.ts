import { describe, expect, it, vi } from 'vitest'
import { createYoutubeProxyFetch, evaluateYoutubePlayerScript, YoutubeExtractor, type YoutubeClient, type YoutubeVideo } from '../src/hosting/youtube.js'
import { parseProxyDefinition } from '../src/settings/misc-settings.js'

function fixtureVideo(overrides: Partial<YoutubeVideo> = {}): YoutubeVideo {
  return {
    title: 'YouTube fixture',
    image: 'https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg',
    hlsManifestUrl: 'https://manifest.googlevideo.com/api/manifest/hls_playlist/fixture',
    formats: [
      { url: 'https://rr1---sn.example.googlevideo.com/videoplayback?itag=18', itag: 18, label: '360p' },
      { url: 'https://rr1---sn.example.googlevideo.com/videoplayback?itag=22', itag: 22, label: '720p' }
    ],
    captions: [{ url: 'https://www.youtube.com/api/timedtext?lang=en&v=abcdefghijk', label: 'English', language: 'en' }],
    ...overrides
  }
}

function client(video: YoutubeVideo): YoutubeClient {
  return { getVideo: vi.fn(async () => video) }
}

describe('YouTube extractor', () => {
  it('uses HLS for playback and preserves metadata and captions', async () => {
    const extractor = new YoutubeExtractor('abcdefghijk', client(fixtureVideo()))

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://manifest.googlevideo.com/api/manifest/hls_playlist/fixture',
      type: 'hls',
      label: 'Original'
    }])
    await expect(extractor.getTracks()).resolves.toEqual([{
      file: 'https://www.youtube.com/api/timedtext?lang=en&v=abcdefghijk',
      label: 'English',
      srclang: 'en'
    }])
    expect(extractor.getTitle()).toBe('YouTube fixture')
    expect(extractor.getImage()).toBe('https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg')
    expect(extractor.getReferer()).toBe('https://www.youtube.com/')
  })

  it('uses deciphered muxed MP4 formats for downloads and as the VOD fallback', async () => {
    const downloadable = new YoutubeExtractor('abcdefghijk', client(fixtureVideo())).setDownloadable(true)
    const vod = new YoutubeExtractor('abcdefghijk', client(fixtureVideo({ hlsManifestUrl: '' })))
    const expected = [
      { file: 'https://rr1---sn.example.googlevideo.com/videoplayback?itag=18', type: 'video/mp4', label: '360p' },
      { file: 'https://rr1---sn.example.googlevideo.com/videoplayback?itag=22', type: 'video/mp4', label: '720p' }
    ]

    await expect(downloadable.getSources()).resolves.toEqual(expected)
    await expect(vod.getSources()).resolves.toEqual(expected)
    expect(downloadable.getReferer()).toBe('https://youtube.googleapis.com/')
  })

  it('rejects invalid IDs and untrusted media, caption, and image URLs', async () => {
    const getVideo = vi.fn(async () => fixtureVideo())
    await expect(new YoutubeExtractor('../unsafe', { getVideo }).getSources()).resolves.toEqual([])
    expect(getVideo).not.toHaveBeenCalled()

    const extractor = new YoutubeExtractor('abcdefghijk', client(fixtureVideo({
      image: 'https://attacker.test/poster.jpg',
      hlsManifestUrl: 'https://attacker.test/master.m3u8',
      formats: [{ url: 'https://user:secret@rr.googlevideo.com/video.mp4', itag: 18, label: '' }],
      captions: [{ url: 'https://attacker.test/sub.vtt', label: 'Unsafe', language: 'en' }]
    })))
    await expect(extractor.getSources()).resolves.toEqual([])
    await expect(extractor.getTracks()).resolves.toEqual([])
    expect(extractor.getImage()).toBe('https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg')
  })

  it('runs reduced player transforms without Node globals or dynamic code generation', () => {
    expect(evaluateYoutubePlayerScript({
      output: 'return { transformed: value.split(\'\').reverse().join(\'\') };',
      exported: ['transformed']
    }, { value: 'signature' })).toEqual({ transformed: 'erutangis' })
    expect(() => evaluateYoutubePlayerScript({
      output: 'return Function(\'return process\')();',
      exported: []
    }, {})).toThrow(/Code generation from strings disallowed/)
  })

  it('retries non-404 YouTube failures through the server proxy without cross-origin credentials', async () => {
    const proxy = parseProxyDefinition('203.0.113.5:1080,user:secret,socks5')
    if (proxy === null) throw new Error('Expected proxy fixture')
    const directFetch = vi.fn(async () => new Response('direct unavailable', { status: 503 }))
    const open = vi.fn()
      .mockRejectedValueOnce(new Error('temporary proxy failure'))
      .mockResolvedValueOnce(Object.freeze({
        url: new URL('https://www.youtube.com/youtubei/v1/player'),
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: new Response('{"videoDetails":{"videoId":"abcdefghijk"}}').body
      }))
    const proxyFetch = createYoutubeProxyFetch(
      async () => Object.freeze({ disabled: false, proxies: Object.freeze([proxy]) }),
      { open },
      directFetch as typeof fetch,
      () => 0
    )
    const response = await proxyFetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        authorization: 'Bearer server-token',
        cookie: 'SAPISID=server-cookie',
        'content-type': 'application/json',
        'x-youtube-client-version': 'fixture'
      },
      body: '{"videoId":"abcdefghijk"}'
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ videoDetails: { videoId: 'abcdefghijk' } })
    expect(directFetch).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(2)
    expect(open.mock.calls.map((call) => call[0].proxy)).toEqual([proxy, proxy])
    expect(Buffer.from(open.mock.calls[0]?.[0].body).toString()).toContain('abcdefghijk')
    const targetHeaders = new Headers(await open.mock.calls[0]?.[0].headersForTarget(new URL('https://www.youtube.com/next')))
    expect(targetHeaders.get('cookie')).toBe('SAPISID=server-cookie')
    const redirectedHeaders = new Headers(await open.mock.calls[0]?.[0].headersForTarget(new URL('https://youtubei.googleapis.com/youtubei/v1/player')))
    expect(redirectedHeaders.get('authorization')).toBeNull()
    expect(redirectedHeaders.get('cookie')).toBeNull()
    expect(redirectedHeaders.get('x-youtube-client-version')).toBe('fixture')
  })

  it('does not proxy YouTube 404 responses or requests outside fixed provider origins', async () => {
    const directFetch = vi.fn(async () => new Response('missing', { status: 404 }))
    const open = vi.fn()
    const proxyFetch = createYoutubeProxyFetch(
      async () => Object.freeze({ disabled: false, proxies: Object.freeze([]) }),
      { open },
      directFetch as typeof fetch
    )

    await expect(proxyFetch('https://www.youtube.com/watch?v=abcdefghijk')).resolves.toEqual(expect.objectContaining({ status: 404 }))
    expect(open).not.toHaveBeenCalled()
    await expect(proxyFetch('https://attacker.example/video')).rejects.toThrow(/rejected host/)
    expect(directFetch).toHaveBeenCalledTimes(1)
  })
})
