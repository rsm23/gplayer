import { describe, expect, it, vi } from 'vitest'
import { evaluateYoutubePlayerScript, YoutubeExtractor, type YoutubeClient, type YoutubeVideo } from '../src/hosting/youtube.js'

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
})
