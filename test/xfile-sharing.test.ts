import { describe, expect, it } from 'vitest'
import { ExtractorFactory } from '../src/hosting/extractor-factory.js'
import type { ProviderHttpClient, ProviderHttpPostRequest, ProviderHttpRequest, ProviderHttpResponse } from '../src/hosting/provider-http.js'
import {
  parseXFileSharingContent,
  unpackPackerScripts,
  XFileSharingExtractor
} from '../src/hosting/xfile-sharing.js'

class FixtureHttpClient implements ProviderHttpClient {
  public readonly requests: ProviderHttpRequest[] = []

  public constructor(private readonly responses: ProviderHttpResponse[]) {}

  public async get(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    return await this.respond(request)
  }

  public async head(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    return await this.respond(request)
  }

  public async post(request: ProviderHttpPostRequest): Promise<ProviderHttpResponse> {
    return await this.respond(request)
  }

  private async respond(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('Unexpected provider request')
    return response
  }
}

describe('shared XFileSharing compatibility parser', () => {
  it('extracts JW sources, tracks, poster, and title without evaluating scripts', () => {
    const output = parseXFileSharingContent(`
      <script>jwplayer('v').setup({
        title: "Embed title",
        image: "https:\\/\\/img.example.test\\/poster.jpg",
        sources: [
          { file: "https://cdn.example.test/master.m3u8", type: "hls", label: "Auto" },
          { file: "https://cdn.example.test/720.mp4", type: "video/mp4", label: "720p" }
        ],
        tracks: [{ file: "https://cdn.example.test/en.vtt", label: "English", kind: "captions" }]
      });</script>
    `)

    expect(output.sources).toEqual([
      { file: 'https://cdn.example.test/master.m3u8', type: 'hls', label: 'Auto' },
      { file: 'https://cdn.example.test/720.mp4', type: 'video/mp4', label: '720p' }
    ])
    expect(output.tracks).toEqual([{
      file: 'https://cdn.example.test/en.vtt', label: 'English', kind: 'captions'
    }])
    expect(output.image).toBe('https://img.example.test/poster.jpg')
    expect(output.title).toBe('Embed title')
  })

  it('unpacks canonical Dean Edwards payloads using static token replacement', () => {
    const packed = `eval(function(p,a,c,k,e,d){e=function(c){return c.toString(a)};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('0({1:[{2:"3"}],4:"5"});',6,6,'jwplayer|sources|file|https://cdn.example.test/video.m3u8|image|https://img.example.test/poster.jpg'.split('|'),0,{}))`
    const unpacked = unpackPackerScripts(packed)
    const output = parseXFileSharingContent(unpacked)

    expect(unpacked).toContain('jwplayer({sources:')
    expect(output.sources).toEqual([{
      file: 'https://cdn.example.test/video.m3u8', type: 'hls', label: 'Original'
    }])
    expect(output.image).toBe('https://img.example.test/poster.jpg')
  })

  it('loads provider and separate title pages from a visible subclass contract', async () => {
    const http = new FixtureHttpClient([
      response('<script>setup({sources:[{file:"https://cdn.example.test/video.mp4"}]})</script>'),
      response('<main><h1 class="h5">Public file title</h1></main>')
    ])
    const extractor = new XFileSharingExtractor('video-id', http, {
      embedUrl: (id) => `https://video.example.test/embed-${id}.html`,
      titleUrl: (id) => `https://video.example.test/${id}`
    })

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://cdn.example.test/video.mp4', type: 'video/mp4', label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('Public file title')
    expect(http.requests.map((request) => String(request.url))).toEqual([
      'https://video.example.test/embed-video-id.html',
      'https://video.example.test/video-id'
    ])
  })

  it('rejects executable and credential-bearing source values', () => {
    const output = parseXFileSharingContent(`sources: [
      {file: "javascript:alert(1)"},
      {file: "https://user:secret@cdn.example.test/video.mp4"}
    ]`)
    expect(output.sources).toEqual([])
  })

  it('does not treat arbitrary error-page assets as media sources', () => {
    const output = parseXFileSharingContent(`
      <link href="https://fonts.googleapis.com/css2?family=Inter">
      <script src="https://cdn.tailwindcss.com"></script>
      <a href="https://provider.example.test/login">Sign in</a>
    `)
    expect(output.sources).toEqual([])
  })

  it.each([
    ['vidara', 'https://vidara.to/e/video-id', 'https://vidara.to/v/video-id', 'https://vidara.to/e/video-id'],
    ['nossoplayer', 'https://nossoplayeronlinehd.org/tv/video-id', null, 'https://rdcplayer.online/']
  ])('registers the inferred %s generic-extractor contract', async (host, embedUrl, titleUrl, referer) => {
    const responses = [
      response('<script>setup({sources:[{file:"https://cdn.example.test/video.mp4"}]})</script>', embedUrl),
      ...(titleUrl === null ? [] : [response('<h1>Provider title</h1>', titleUrl)])
    ]
    const http = new FixtureHttpClient(responses)
    const extractor = new ExtractorFactory({ providerHttpClient: http }).create(host, 'video-id')
    expect(extractor).not.toBeNull()
    if (extractor === null) throw new Error(`Missing ${host} extractor`)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://cdn.example.test/video.mp4', type: 'video/mp4', label: 'Original'
    }])
    expect(extractor.getReferer()).toBe(referer)
    expect(new Headers(http.requests[0]?.headers).get('referer')).toBe(host === 'nossoplayer' ? referer : 'https://vidara.to')
    expect(http.requests.map((request) => String(request.url))).toEqual([
      embedUrl,
      ...(titleUrl === null ? [] : [titleUrl])
    ])
  })

  it.each([
    ['earnvids', 'https://morencius.com/embed/video-id', 'https://morencius.com/file/video-id'],
    ['fileupload', 'https://www.file-upload.org/embed-video-id.html', 'https://www.file-upload.org/video-id'],
    ['goodstream', 'https://goodstream.one/video-id', 'https://goodstream.one/video-id'],
    ['hexupload', 'https://hexupload.net/embed-video-id.html', 'https://hexupload.net/video-id'],
    ['krakenfiles', 'https://krakenfiles.com/embed-video/video-id', 'https://krakenfiles.com/view/video-id/file.html'],
    ['lulustream', 'https://luluvdo.com/e/video-id', 'https://luluvdo.com/d/video-id'],
    ['mediacm', 'https://media.cm/e/video-id', 'https://media.cm/video-id'],
    ['mixdrop', 'https://mixdrop.ag/e/video-id', 'https://mixdrop.ag/f/video-id'],
    ['mp4upload', 'https://www.mp4upload.com/embed-video-id.html', 'https://www.mp4upload.com/video-id'],
    ['sendvid', 'https://sendvid.com/embed/video-id', 'https://sendvid.com/video-id'],
    ['supervideo', 'https://supervideo.cc/e/video-id', 'https://supervideo.cc/video-id'],
    ['thetube', 'https://www.the.tube/video-id', 'https://www.the.tube/video-id'],
    ['uqload', 'https://uqload.net/embed-video-id.html', null],
    ['vidmoly', 'https://vidmoly.biz/embed-video-id.html', null],
    ['vidoza', 'https://videzz.net/embed-video-id.html', 'https://videzz.net/video-id'],
    ['vtube', 'https://vtube.network/embed-video-id.html', 'https://vtube.network/video-id.html']
  ])('registers the visible %s URL contract', async (host, embedUrl, titleUrl) => {
    const responses = [
      response('<script>setup({sources:[{file:"https://cdn.example.test/video.mp4"}]})</script>'),
      ...(titleUrl === null ? [] : [response('<h1>Provider title</h1>')])
    ]
    const http = new FixtureHttpClient(responses)
    const extractor = new ExtractorFactory({ providerHttpClient: http }).create(host, 'video-id')

    expect(extractor).not.toBeNull()
    if (extractor === null) throw new Error(`Missing ${host} extractor`)
    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://cdn.example.test/video.mp4', type: 'video/mp4', label: 'Original'
    }])
    expect(http.requests.map((request) => String(request.url))).toEqual([
      embedUrl,
      ...(titleUrl === null ? [] : [titleUrl])
    ])
  })
})

function response(body: string, url = 'https://video.example.test/fixture'): ProviderHttpResponse {
  return {
    url: new URL(url),
    status: 200,
    headers: new Headers({ 'content-type': 'text/html' }),
    body
  }
}
