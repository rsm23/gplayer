import { createCipheriv, webcrypto } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AparatExtractor } from '../src/hosting/aparat.js'
import { AmazonExtractor } from '../src/hosting/amazon.js'
import { ArchiveExtractor } from '../src/hosting/archive.js'
import { BloggerExtractor, parseBloggerBootstrap, parseBloggerRpcResponse } from '../src/hosting/blogger.js'
import { CloudMailRuExtractor, parseCloudMailPage } from '../src/hosting/cloudmailru.js'
import { DailymotionExtractor } from '../src/hosting/dailymotion.js'
import { DoodExtractor } from '../src/hosting/dood.js'
import { DropboxExtractor } from '../src/hosting/dropbox.js'
import { DzenExtractor, parseDzenParams } from '../src/hosting/dzen.js'
import { FilesFmExtractor } from '../src/hosting/filesfm.js'
import { FilemailExtractor } from '../src/hosting/filemail.js'
import { decryptFilemoonPlayback, filemoonProofLeadingZeroBits, FilemoonExtractor, solveFilemoonProof } from '../src/hosting/filemoon.js'
import { FireloadExtractor, parseFireloadPage } from '../src/hosting/fireload.js'
import { GdriveExtractor, parseGdriveVideoInfo } from '../src/hosting/gdrive.js'
import { GofileExtractor } from '../src/hosting/gofile.js'
import { GooglePhotosExtractor, parseGooglePhotosPage } from '../src/hosting/googlephotos.js'
import { HxFileExtractor, parseHxFileEmbed, parseHxFileMetadata } from '../src/hosting/hxfile.js'
import { MediaFireExtractor } from '../src/hosting/mediafire.js'
import { MStreamExtractor, parseMStreamPage } from '../src/hosting/mstream.js'
import { MyMailRuExtractor } from '../src/hosting/mymailru.js'
import { NaverTvExtractor, parseNaverPageProps } from '../src/hosting/navertv.js'
import { OkruExtractor, parseOkruOptions } from '../src/hosting/okru.js'
import { PCloudExtractor } from '../src/hosting/pcloud.js'
import { PixeldrainExtractor } from '../src/hosting/pixeldrain.js'
import type { ProviderHttpClient, ProviderHttpPostRequest, ProviderHttpRequest, ProviderHttpResponse } from '../src/hosting/provider-http.js'
import { RumbleExtractor } from '../src/hosting/rumble.js'
import { normalizeSibnetId, SibnetExtractor } from '../src/hosting/sibnet.js'
import { SoundcloudExtractor } from '../src/hosting/soundcloud.js'
import { parseStreamableVideoObject, StreamableExtractor } from '../src/hosting/streamable.js'
import { StreamtapeExtractor } from '../src/hosting/streamtape.js'
import { parseTiktokItem, TiktokExtractor } from '../src/hosting/tiktok.js'
import { TurboVipPlayExtractor } from '../src/hosting/turboviplay.js'
import { parseVimeoPlayerConfig, VimeoExtractor } from '../src/hosting/vimeo.js'
import { parseVkResponse, VkExtractor } from '../src/hosting/vk.js'
import { VidyardExtractor } from '../src/hosting/vidyard.js'
import { decodeVoePayload, parseVoePage, parseVoeRedirect, VoeExtractor } from '../src/hosting/voe.js'
import { VudeoExtractor } from '../src/hosting/vudeo.js'
import { parseWetransferTarget, WetransferExtractor } from '../src/hosting/wetransfer.js'
import { YourUploadExtractor } from '../src/hosting/yourupload.js'
import { parseYandexDiskPage, YandexDiskExtractor } from '../src/hosting/yadisk.js'

class FixtureHttpClient implements ProviderHttpClient {
  public readonly requests: ProviderHttpRequest[] = []
  public readonly methods: Array<'GET' | 'HEAD' | 'POST'> = []

  public constructor(private readonly responses: ProviderHttpResponse[]) {}

  public async get(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.methods.push('GET')
    return await this.respond(request)
  }

  public async head(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.methods.push('HEAD')
    return await this.respond(request)
  }

  public async post(request: ProviderHttpPostRequest): Promise<ProviderHttpResponse> {
    this.methods.push('POST')
    return await this.respond(request)
  }

  private async respond(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('Unexpected provider request')
    return response
  }
}

describe('recoverable provider adapters', () => {
  it('ports Pixeldrain media, thumbnail, and optional file metadata', async () => {
    const http = new FixtureHttpClient([jsonResponse({ name: 'Conference recording.mp4' })])
    const extractor = new PixeldrainExtractor('pixel-id', http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://pixeldrain.com/api/file/pixel-id',
      type: 'video/mp4',
      label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('Conference recording.mp4')
    expect(extractor.getImage()).toBe('https://pixeldrain.com/api/file/pixel-id/thumbnail')
    expect(String(http.requests[0]?.url)).toBe('https://pixeldrain.com/api/file/pixel-id/info')
  })

  it('ports Vidyard HLS playback and downloadable MP4 profiles', async () => {
    const payload = {
      payload: {
        chapters: [{
          name: 'Product demo',
          thumbnailUrls: { normal: 'https://cdn.vidyard.test/poster.jpg' },
          sources: {
            mp4: [
              { url: 'https://cdn.vidyard.test/720.mp4', mimeType: 'video/mp4', profile: '720p' },
              { url: 'https://cdn.vidyard.test/1080.mp4', mimeType: 'video/mp4', profile: '1080p' }
            ],
            hls: [
              { url: 'https://cdn.vidyard.test/legacy.m3u8' },
              { url: 'https://cdn.vidyard.test/master.m3u8' }
            ]
          }
        }]
      }
    }
    const playback = new VidyardExtractor('video-id?campaign=1', new FixtureHttpClient([jsonResponse(payload)]))
    await expect(playback.getSources()).resolves.toEqual([{
      file: 'https://cdn.vidyard.test/master.m3u8', type: 'hls', label: 'Original'
    }])
    expect(playback.getTitle()).toBe('Product demo')
    expect(playback.getImage()).toBe('https://cdn.vidyard.test/poster.jpg')
    expect(playback.getReferer()).toBe('https://share.vidyard.com/watch/video-id')

    const download = new VidyardExtractor('video-id', new FixtureHttpClient([jsonResponse(payload)]))
      .setDownloadable(true)
    await expect(download.getSources()).resolves.toEqual([
      { file: 'https://cdn.vidyard.test/720.mp4', type: 'video/mp4', label: '720p' },
      { file: 'https://cdn.vidyard.test/1080.mp4', type: 'video/mp4', label: '1080p' }
    ])
  })

  it('ports Dailymotion cookie bootstrap, metadata, poster, and subtitles', async () => {
    const pageHeaders = new Headers()
    pageHeaders.append('set-cookie', 'v1st=visitor-token; Path=/; Secure')
    pageHeaders.append('set-cookie', 'ts=1700000000; Path=/; Secure')
    const http = new FixtureHttpClient([
      response('', pageHeaders),
      jsonResponse({
        qualities: { auto: [{ url: 'https://proxy.dmcdn.test/master.m3u8' }] },
        title: 'Daily motion clip',
        thumbnails: { 120: 'https://img.dmcdn.test/small.jpg', 720: 'https://img.dmcdn.test/large.jpg' },
        subtitles: {
          data: [
            { urls: ['https://sub.dmcdn.test/en.vtt'], label: 'English' },
            { urls: [], label: 'Empty' }
          ]
        }
      })
    ])
    const extractor = new DailymotionExtractor('daily-id', http, { uniqueId: () => 'view-id' })

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://proxy.dmcdn.test/master.m3u8', type: 'hls', label: 'Original'
    }])
    await expect(extractor.getTracks()).resolves.toEqual([{
      file: 'https://sub.dmcdn.test/en.vtt', label: 'English'
    }])
    expect(extractor.getTitle()).toBe('Daily motion clip')
    expect(extractor.getImage()).toBe('https://img.dmcdn.test/large.jpg')
    expect(extractor.getCookies()).toEqual(['v1st=visitor-token', 'ts=1700000000'])

    const metadataRequest = http.requests[1]
    expect(String(metadataRequest?.url)).toContain('/player/metadata/video/daily-id?')
    expect(String(metadataRequest?.url)).toContain('dmViewId=view-id')
    expect(new Headers(metadataRequest?.headers).get('cookie')).toBe('v1st=visitor-token; ts=1700000000')
  })

  it('returns empty sources for malformed provider payloads', async () => {
    const dailymotionHeaders = new Headers({ 'set-cookie': 'v1st=visitor; Path=/, ts=1; Path=/' })
    const dailymotion = new DailymotionExtractor('id', new FixtureHttpClient([
      response('', dailymotionHeaders),
      response('{not-json')
    ]))
    const vidyard = new VidyardExtractor('id', new FixtureHttpClient([jsonResponse({ payload: {} })]))

    await expect(dailymotion.getSources()).resolves.toEqual([])
    await expect(vidyard.getSources()).resolves.toEqual([])
  })

  it('ports Dropbox share IDs and existing download-query links', async () => {
    const shared = new DropboxExtractor('share-id/movie.mp4', new FixtureHttpClient([response('share page')]))
    await expect(shared.getSources()).resolves.toEqual([{
      file: 'https://www.dropbox.com/s/share-id/movie.mp4?dl=1', type: 'video/mp4', label: 'Original'
    }])
    expect(shared.getTitle()).toBe('movie.mp4')

    const linked = new DropboxExtractor(
      'https://www.dropbox.com/s/share-id/movie.mp4?dl=0',
      new FixtureHttpClient([response('share page')])
    )
    await expect(linked.getSources()).resolves.toEqual([{
      file: 'https://www.dropbox.com/s/share-id/movie.mp4?dl=1', type: 'video/mp4', label: 'Original'
    }])
  })

  it('ports Vudeo setup fields from the recoverable embed contract', async () => {
    const html = '<script>player.setup({sources: ["https://cdn.vudeo.test/movie.mp4"], poster: "https://cdn.vudeo.test/poster.jpg", title: "Movie title"});</script>'
    const extractor = new VudeoExtractor('vudeo-id', new FixtureHttpClient([response(html)]))

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://cdn.vudeo.test/movie.mp4', type: 'video/mp4', label: 'Original'
    }])
    expect(extractor.getImage()).toBe('https://cdn.vudeo.test/poster.jpg')
    expect(extractor.getTitle()).toBe('Movie title')
  })

  it('ports YourUpload Open Graph video metadata', async () => {
    const html = '<meta property="og:video" content="https://cdn.yourupload.test/movie.mp4"><meta property="og:image" content="https://cdn.yourupload.test/poster.jpg"><meta property="og:title" content="Upload title">'
    const extractor = new YourUploadExtractor('upload-id', new FixtureHttpClient([response(html)]))

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://cdn.yourupload.test/movie.mp4', type: 'video/mp4', label: 'Original'
    }])
    expect(extractor.getImage()).toBe('https://cdn.yourupload.test/poster.jpg')
    expect(extractor.getTitle()).toBe('Upload title')
  })

  it('ports Fireload fresh signed media plus Open Graph metadata', async () => {
    const html = `<meta property='og:title' content='Fixture movie.mp4 - shared via Fireload'>
      <meta content='https://www.fireload.com/poster.jpg' property='og:image'>
      <script>window.Fl = {"dlink":"https://www.fireload.com/abc123/Fixture%20movie.mp4?pt=signed%3D","dwait":"0"}</script>`
    expect(parseFireloadPage(html)).toEqual({
      file: 'https://www.fireload.com/abc123/Fixture%20movie.mp4?pt=signed%3D',
      title: 'Fixture movie.mp4 - shared via Fireload',
      image: 'https://www.fireload.com/poster.jpg'
    })
    const http = new FixtureHttpClient([
      response(html, new Headers(), 'https://www.fireload.com/abc123/Fixture%20movie.mp4')
    ])
    const extractor = new FireloadExtractor('abc123', http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://www.fireload.com/abc123/Fixture%20movie.mp4?pt=signed%3D',
      type: 'video/mp4',
      label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('Fixture movie.mp4 - shared via Fireload')
    expect(extractor.getImage()).toBe('https://www.fireload.com/poster.jpg')
    expect(extractor.getReferer()).toBe('https://www.fireload.com/abc123')
    expect(String(http.requests[0]?.url)).toBe('https://www.fireload.com/abc123')
  })

  it('rejects unsafe Fireload identifiers, redirects, and signed media hosts', async () => {
    const unsafeMedia = '<script>window.Fl={"dlink":"https://attacker.test/abc123/movie.mp4?pt=signed"}</script>'
    await expect(new FireloadExtractor('abc123', new FixtureHttpClient([
      response(unsafeMedia, new Headers(), 'https://www.fireload.com/abc123/movie.mp4')
    ])).getSources()).resolves.toEqual([])
    await expect(new FireloadExtractor('abc123', new FixtureHttpClient([
      response('<script>window.Fl={"dlink":"https://www.fireload.com/abc123/movie.mp4"}</script>', new Headers(), 'https://attacker.test/')
    ])).getSources()).resolves.toEqual([])
    await expect(new FireloadExtractor('../unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
  })

  it('ports Google Photos media variants, poster, redirect filtering, and download referer', async () => {
    const mediaBase = 'https://lh3.googleusercontent.com/pw/media-token'
    const html = `<meta property="og:video" content="${mediaBase}=w600-h315-k-no-m18">`
    expect(parseGooglePhotosPage(html)).toEqual({
      mediaBase,
      image: `${mediaBase}=s1024-k-rw-no`
    })
    const http = new FixtureHttpClient([
      response(html, new Headers(), 'https://photos.google.com/share/share-id?key=share-key'),
      response('', new Headers(), 'https://edge.googlevideo.com/videoplayback?itag=18'),
      response('', new Headers(), 'https://edge.googlevideo.com/videoplayback?itag=22'),
      response('', new Headers(), `${mediaBase}=m37`)
    ])
    const extractor = new GooglePhotosExtractor('share-id?key=share-key', http).setDownloadable(true)

    await expect(extractor.getSources()).resolves.toEqual([
      { file: `${mediaBase}=m18`, type: 'video/mp4', label: '360p' },
      { file: `${mediaBase}=m22`, type: 'video/mp4', label: '720p' }
    ])
    expect(extractor.getImage()).toBe(`${mediaBase}=s1024-k-rw-no`)
    expect(extractor.getReferer()).toBe('https://youtube.googleapis.com/')
    expect(http.methods).toEqual(['GET', 'HEAD', 'HEAD', 'HEAD'])
    expect(http.requests.map((request) => String(request.url))).toEqual([
      'https://photos.google.com/share/share-id?key=share-key',
      `${mediaBase}=m18`,
      `${mediaBase}=m22`,
      `${mediaBase}=m37`
    ])
  })

  it('supports Google Photos short IDs and rejects unsafe pages, media, and identifiers', async () => {
    const mediaBase = 'https://lh3.googleusercontent.com/pw/media-token'
    const short = new FixtureHttpClient([
      response(`<div data-url="${mediaBase}=m18"></div>`, new Headers(), 'https://photos.google.com/share/resolved?key=key'),
      response('', new Headers(), 'https://edge.googlevideo.com/videoplayback?itag=18'),
      response('', new Headers(), `${mediaBase}=m22`),
      response('', new Headers(), `${mediaBase}=m37`)
    ])
    await expect(new GooglePhotosExtractor('short-id', short).getSources()).resolves.toEqual([{
      file: `${mediaBase}=m18`, type: 'video/mp4', label: '360p'
    }])
    expect(String(short.requests[0]?.url)).toBe('https://photos.app.goo.gl/short-id')

    expect(parseGooglePhotosPage('<meta property="og:video" content="https://attacker.test/movie=m18">')).toBeNull()
    await expect(new GooglePhotosExtractor('short-id', new FixtureHttpClient([
      response('<meta property="og:video" content="https://lh3.googleusercontent.com/pw/media=m18">', new Headers(), 'https://attacker.test/')
    ])).getSources()).resolves.toEqual([])
    await expect(new GooglePhotosExtractor('../unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
  })

  it('prefers the Google Photos HLS manifest for playback and falls back to MP4 renditions', async () => {
    const mediaBase = 'https://lh3.googleusercontent.com/pw/hls-media-token'
    const html = `<meta property="og:video" content="${mediaBase}=m22">`
    const hls = new FixtureHttpClient([
      response(html, new Headers(), 'https://photos.google.com/share/share-id?key=share-key'),
      response(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n360/index.m3u8\n',
        new Headers({ 'content-type': 'application/vnd.apple.mpegurl' }),
        'https://manifest.googlevideo.com/api/manifest/hls_variant/file/index.m3u8'
      )
    ])
    const preferred = new GooglePhotosExtractor('share-id?key=share-key', hls).setHlsMode(true)

    await expect(preferred.getSources()).resolves.toEqual([{
      file: `${mediaBase}=mm,hls`, type: 'hls', label: 'Original'
    }])
    expect(hls.methods).toEqual(['GET', 'GET'])

    const fallback = new GooglePhotosExtractor('share-id?key=share-key', new FixtureHttpClient([
      response(html, new Headers(), 'https://photos.google.com/share/share-id?key=share-key'),
      response('manifest unavailable', new Headers(), `${mediaBase}=mm,hls`),
      response('', new Headers(), 'https://edge.googlevideo.com/videoplayback?itag=18'),
      response('', new Headers(), `${mediaBase}=m22`),
      response('', new Headers(), `${mediaBase}=m37`)
    ])).setHlsMode(true)
    await expect(fallback.getSources()).resolves.toEqual([{
      file: `${mediaBase}=m18`, type: 'video/mp4', label: '360p'
    }])
  })

  it('ports Blogger batchexecute sources, labels, title, and poster without browser execution', async () => {
    const bootstrapHtml = '<script>window.WIZ_global_data = {"FdrFJe":"-123456789","cfb2h":"boq_bloggeruiserver_20260805.01_p0"};</script>'
    expect(parseBloggerBootstrap(bootstrapHtml)).toEqual({
      sessionId: '-123456789', buildLabel: 'boq_bloggeruiserver_20260805.01_p0'
    })
    const payload = [1, null, [
      ['https://rr1.googlevideo.com/videoplayback?itag=18&sig=fixture', [18]],
      ['https://rr1.googlevideo.com/videoplayback?itag=22&sig=fixture', [22]]
    ], 'https://i9.ytimg.com/vi_blogger/id/1.jpg', 'Blogger fixture', 'video-id', false]
    const rpcBody = bloggerRpcFixture(payload)
    expect(parseBloggerRpcResponse(rpcBody)).toEqual({
      sources: [
        { file: 'https://rr1.googlevideo.com/videoplayback?itag=18&sig=fixture', type: 'video/mp4', label: '360p' },
        { file: 'https://rr1.googlevideo.com/videoplayback?itag=22&sig=fixture', type: 'video/mp4', label: '720p' }
      ],
      image: 'https://i9.ytimg.com/vi_blogger/id/1.jpg',
      title: 'Blogger fixture'
    })
    const token = 'blogger_fixture_token_12345'
    const http = new FixtureHttpClient([
      response(bootstrapHtml, new Headers(), `https://www.blogger.com/video.g?token=${token}`),
      response(rpcBody, new Headers({ 'content-type': 'application/json' }), 'https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute')
    ])
    const extractor = new BloggerExtractor(token, http)

    await expect(extractor.getSources()).resolves.toEqual([
      { file: 'https://rr1.googlevideo.com/videoplayback?itag=18&sig=fixture', type: 'video/mp4', label: '360p' },
      { file: 'https://rr1.googlevideo.com/videoplayback?itag=22&sig=fixture', type: 'video/mp4', label: '720p' }
    ])
    expect(extractor.getTitle()).toBe('Blogger fixture')
    expect(extractor.getImage()).toBe('https://i9.ytimg.com/vi_blogger/id/1.jpg')
    expect(extractor.getReferer()).toBe('https://www.blogger.com/')
    expect(http.methods).toEqual(['GET', 'POST'])
    const rpc = new URL(String(http.requests[1]?.url))
    expect(rpc.searchParams.get('rpcids')).toBe('WcwnYd')
    expect(rpc.searchParams.get('f.sid')).toBe('-123456789')
    expect(String((http.requests[1] as ProviderHttpPostRequest).body)).toContain(encodeURIComponent(token))
    expect(new Headers(http.requests[1]?.headers).get('x-same-domain')).toBe('1')
  })

  it('resolves Blogspot player URLs and rejects malformed Blogger sessions and media', async () => {
    const token = 'blogger_fixture_token_12345'
    const blogPage = `<iframe src="https://www.blogger.com/video.g?token=${token}&amp;autoplay=1"></iframe>`
    const bootstrapHtml = '<script>WIZ_global_data={"FdrFJe":"42","cfb2h":"boq_bloggeruiserver_build"}</script>'
    const unsafePayload = [1, null, [['https://attacker.test/video.mp4', [18]]], 'https://attacker.test/poster.jpg', 'Unsafe']
    const http = new FixtureHttpClient([
      response(blogPage, new Headers(), 'https://fixture.blogspot.com/post.html'),
      response(bootstrapHtml, new Headers(), `https://www.blogger.com/video.g?token=${token}`),
      response(bloggerRpcFixture(unsafePayload), new Headers(), 'https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute')
    ])
    await expect(new BloggerExtractor('https://fixture.blogspot.com/post.html', http).getSources()).resolves.toEqual([])
    expect(http.methods).toEqual(['GET', 'GET', 'POST'])
    expect(parseBloggerBootstrap('<script>WIZ_global_data={"FdrFJe":"bad","cfb2h":"bad"}</script>')).toBeNull()
    expect(parseBloggerRpcResponse('not a batchexecute response')).toBeNull()
    await expect(new BloggerExtractor('https://attacker.test/post', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
  })

  it('ports Yandex Disk adaptive HLS, title, preview, and referer metadata', async () => {
    const payload = {
      rootResourceId: 'root-id',
      resources: {
        'root-id': {
          type: 'file',
          name: 'Yandex fixture.mp4',
          meta: { defaultPreview: 'https://downloader.disk.yandex.com/preview/poster?token=fixture' },
          videoStreams: {
            videos: [
              { dimension: '360p', url: 'https://streaming.disk.yandex.net/hls/360/index.m3u8' },
              { dimension: 'adaptive', url: 'https://streaming.disk.yandex.net/hls/adaptive/index.m3u8' }
            ]
          }
        }
      }
    }
    const html = `<script type="application/json" id="store-prefetch">${JSON.stringify(payload)}</script>`
    expect(parseYandexDiskPage(html)).toEqual({
      title: 'Yandex fixture.mp4',
      image: 'https://downloader.disk.yandex.com/preview/poster?token=fixture&crop=1&size=640x320',
      hls: 'https://streaming.disk.yandex.net/hls/adaptive/index.m3u8'
    })
    const http = new FixtureHttpClient([
      response(html, new Headers(), 'https://disk.yandex.com/i/share-id')
    ])
    const extractor = new YandexDiskExtractor('share-id', http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://streaming.disk.yandex.net/hls/adaptive/index.m3u8', type: 'hls', label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('Yandex fixture.mp4')
    expect(extractor.getImage()).toBe('https://downloader.disk.yandex.com/preview/poster?token=fixture&crop=1&size=640x320')
    expect(extractor.getReferer()).toBe('https://disk.yandex.com/')
    expect(String(http.requests[0]?.url)).toBe('https://disk.yandex.com/i/share-id')
  })

  it('ports Yandex Disk public downloads and rejects unsafe pages, media, and identifiers', async () => {
    const payload = {
      rootResourceId: 'root-id',
      resources: { 'root-id': { type: 'file', name: 'Download.mp4', meta: {}, videoStreams: { videos: [] } } }
    }
    const html = `<script id="store-prefetch" type="application/json">${JSON.stringify(payload)}</script>`
    const http = new FixtureHttpClient([
      response(html, new Headers(), 'https://disk.yandex.com/i/share-id'),
      response(
        JSON.stringify({ href: 'https://downloader.disk.yandex.com/disk/file.mp4?token=fixture' }),
        new Headers({ 'content-type': 'application/json' }),
        'https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=fixture'
      )
    ])
    const extractor = new YandexDiskExtractor('share-id', http).setDownloadable(true)
    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://downloader.disk.yandex.com/disk/file.mp4?token=fixture', type: 'video/mp4', label: 'Original'
    }])
    expect(String(http.requests[1]?.url)).toBe(
      'https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=https%3A%2F%2Fdisk.yandex.com%2Fi%2Fshare-id'
    )

    expect(parseYandexDiskPage('<script id="store-prefetch">{bad-json}</script>')).toBeNull()
    const unsafePayload = { rootResourceId: 'root', resources: { root: { type: 'file', videoStreams: { videos: [{ dimension: 'adaptive', url: 'https://attacker.test/a.m3u8' }] } } } }
    expect(parseYandexDiskPage(`<script id="store-prefetch">${JSON.stringify(unsafePayload)}</script>`)?.hls).toBe('')
    await expect(new YandexDiskExtractor('../unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
  })

  it('ports VK structured HLS/DASH/MP4 sources plus title and poster metadata', async () => {
    const payload = {
      payload: [0, ['Fallback title', {
        player: {
          params: [{
            md_title: 'VK fixture',
            jpg: 'https://sun9.userapi.com/poster.jpg',
            url240: 'https://vkvd.test/240.mp4',
            url720: 'https://vkvd.test/720.mp4',
            dash_uni: 'https://vkvd.test/manifest.mpd',
            hls: 'https://vkvd.test/master.m3u8',
            hls_ondemand: 'https://vkvd.test/ondemand.m3u8'
          }]
        }
      }]]
    }
    expect(parseVkResponse(JSON.stringify(payload))).toEqual({
      playbackSources: [{ file: 'https://vkvd.test/ondemand.m3u8', type: 'hls', label: 'Original' }],
      downloadSources: [
        { file: 'https://vkvd.test/240.mp4', type: 'video/mp4', label: '240p' },
        { file: 'https://vkvd.test/720.mp4', type: 'video/mp4', label: '720p' }
      ],
      image: 'https://sun9.userapi.com/poster.jpg',
      title: 'VK fixture'
    })
    const http = new FixtureHttpClient([
      response(JSON.stringify(payload), new Headers({ 'content-type': 'application/json; charset=windows-1251' }), 'https://vk.com/al_video.php?act=show')
    ])
    const extractor = new VkExtractor('video-92828753_171333475', http)
    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://vkvd.test/ondemand.m3u8', type: 'hls', label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('VK fixture')
    expect(extractor.getImage()).toBe('https://sun9.userapi.com/poster.jpg')
    expect(extractor.getReferer()).toBe('https://vk.com/')
    expect(http.methods).toEqual(['POST'])
    expect(String((http.requests[0] as ProviderHttpPostRequest).body)).toContain('video=-92828753_171333475')

    const download = new VkExtractor('-92828753_171333475', new FixtureHttpClient([
      response(JSON.stringify(payload), new Headers(), 'https://vk.com/al_video.php?act=show')
    ])).setDownloadable(true)
    await expect(download.getSources()).resolves.toHaveLength(2)
  })

  it('ports VK HTML source fallback and rejects restricted, malformed, and unsafe responses', async () => {
    const html = '<video id="video_player" poster="https://sun9.userapi.com/poster.jpg">' +
      '<source src="https://vkvd.test/video.mp4?type=1"><source src="https://vkvd.test/video.mp4?type=3"></video>'
    expect(parseVkResponse(JSON.stringify({ payload: [0, ['Markup title', html]] }))).toEqual({
      playbackSources: [{ file: 'https://vkvd.test/video.mp4?type=3', type: 'video/mp4', label: '720p' }],
      downloadSources: [
        { file: 'https://vkvd.test/video.mp4?type=1', type: 'video/mp4', label: '360p' },
        { file: 'https://vkvd.test/video.mp4?type=3', type: 'video/mp4', label: '720p' }
      ],
      image: 'https://sun9.userapi.com/poster.jpg',
      title: 'Markup title'
    })
    expect(parseVkResponse(JSON.stringify({ payload: [0, ['Restricted', false, { is_restricted: true }]] }))).toBeNull()
    expect(parseVkResponse('{bad-json')).toBeNull()
    await expect(new VkExtractor('unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
    await expect(new VkExtractor('-1_2', new FixtureHttpClient([
      response(JSON.stringify({ payload: [0, [{ player: { params: [{ hls: 'https://user:pass@attacker.test/a.m3u8' }] } }]] }), new Headers(), 'https://vk.com/al_video.php')
    ])).getSources()).resolves.toEqual([])
  })

  it('ports MStream SharePoint downloads, names, transformed posters, and cookie-aware loading', async () => {
    const html = `<script>window.item = {"name":"SharePoint fixture.mp4",
      "downloadUrl":"https:\\/\\/tenant.sharepoint.com\\/personal\\/media.mp4?download=1\\u0026token=fixture",
      "transformUrl":"https:\\/\\/publiccdn.sharepointonline.com\\/transform?asset=fixture\\u0026format=jpg"};</script>`
    expect(parseMStreamPage(html)).toEqual({
      file: 'https://tenant.sharepoint.com/personal/media.mp4?download=1&token=fixture',
      title: 'SharePoint fixture.mp4',
      image: 'https://publiccdn.sharepointonline.com/transform?asset=fixture&format=jpg&width=1024&height=720'
    })
    const http = new FixtureHttpClient([
      response(html, new Headers(), 'https://tenant.sharepoint.com/:v:/g/personal/share-id')
    ])
    const url = 'https://tenant.sharepoint.com/:v:/g/personal/share-id?e=fixture'
    const extractor = new MStreamExtractor(url, http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://tenant.sharepoint.com/personal/media.mp4?download=1&token=fixture',
      type: 'video/mp4',
      label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('SharePoint fixture.mp4')
    expect(extractor.getImage()).toBe('https://publiccdn.sharepointonline.com/transform?asset=fixture&format=jpg&width=1024&height=720')
    expect(extractor.getReferer()).toBe(url)
    expect(http.requests[0]?.preserveRedirectCookies).toBe(true)
  })

  it('rejects unsafe MStream inputs, final redirects, and media payloads', async () => {
    expect(parseMStreamPage('<script>{"downloadUrl":"https://attacker.test/file.mp4"}</script>')).toBeNull()
    await expect(new MStreamExtractor('https://attacker.test/share', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
    await expect(new MStreamExtractor(
      'https://tenant.sharepoint.com/share',
      new FixtureHttpClient([response('{"downloadUrl":"https://tenant.sharepoint.com/file.mp4"}', new Headers(), 'https://attacker.test/')])
    ).getSources()).resolves.toEqual([])
    await expect(new MStreamExtractor(
      'https://tenant.sharepoint.com/share',
      new FixtureHttpClient([response('{"downloadUrl":"https://user:secret@tenant.sharepoint.com/file.mp4"}', new Headers(), 'https://tenant.sharepoint.com/share')])
    ).getSources()).resolves.toEqual([])
  })

  it('ports Rumble embed discovery, HLS, MP4 profiles, and captions', async () => {
    const payload = {
      i: 'https://img.rumble.test/poster.jpg',
      title: 'Rumble clip',
      ua: {
        hls: { auto: { url: 'https://cdn.rumble.test/master.m3u8' } },
        mp4: {
          720: { url: 'https://cdn.rumble.test/720.mp4' },
          1080: { url: 'https://cdn.rumble.test/1080.mp4' }
        }
      },
      c: { en: { path: 'https://cdn.rumble.test/en.vtt', language: 'English' } }
    }
    const playbackHttp = new FixtureHttpClient([
      response('<script>window.data={"video":"v123"}</script>'),
      jsonResponse(payload)
    ])
    const playback = new RumbleExtractor('video-slug', playbackHttp)
    await expect(playback.getSources()).resolves.toEqual([{
      file: 'https://cdn.rumble.test/master.m3u8', type: 'hls', label: 'Original'
    }])
    await expect(playback.getTracks()).resolves.toEqual([{
      file: 'https://cdn.rumble.test/en.vtt', label: 'English'
    }])
    expect(playback.getTitle()).toBe('Rumble clip')
    expect(playback.getImage()).toBe('https://img.rumble.test/poster.jpg')
    expect(String(playbackHttp.requests[1]?.url)).toContain('v=v123')

    const download = new RumbleExtractor('video-slug', new FixtureHttpClient([
      response('<script>window.data={"video":"v123"}</script>'),
      jsonResponse(payload)
    ])).setDownloadable(true)
    await expect(download.getSources()).resolves.toEqual([
      { file: 'https://cdn.rumble.test/720.mp4', type: 'video/mp4', label: '720p' },
      { file: 'https://cdn.rumble.test/1080.mp4', type: 'video/mp4', label: '1080p' }
    ])
  })

  it('ports PCloud public metadata and stops after the HLS variant', async () => {
    const publinkData = {
      code: 'public-code',
      metadata: { name: 'Shared recording' },
      variants: [
        { hosts: ['c1.pcloud.test'], path: '/video/720.mp4', height: 720 },
        { hosts: ['c2.pcloud.test'], path: '/video/master.m3u8' },
        { hosts: ['c3.pcloud.test'], path: '/video/unreachable.mp4', height: 1080 }
      ]
    }
    const html = `<script>window.publinkData = ${JSON.stringify(publinkData)};\n</script>`
    const extractor = new PCloudExtractor('public-code', new FixtureHttpClient([response(html)]))

    await expect(extractor.getSources()).resolves.toEqual([
      { file: 'https://c1.pcloud.test/video/720.mp4', type: 'video/mp4', label: '720p' },
      { file: 'https://c2.pcloud.test/video/master.m3u8', type: 'hls', label: 'Original' }
    ])
    expect(extractor.getTitle()).toBe('Shared recording')
    expect(extractor.getImage()).toContain('getpubthumb?code=public-code')
  })

  it('ports the PCloud direct-download fallback', async () => {
    const html = '<script>publinkData = {"metadata":{"name":"File"},"downloadlink":"https:\\/\\/c1.pcloud.test\\/movie.mp4"};\n</script>'
    const extractor = new PCloudExtractor('public-code', new FixtureHttpClient([response(html)]))

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://c1.pcloud.test/movie.mp4', type: 'video/mp4', label: 'Original'
    }])
  })

  it('ports MediaFire download anchors and labels', async () => {
    const pageUrl = new URL('https://www.mediafire.com/file/media-id')
    const html = '<a class="input popsok" href="https://download.mediafire.test/movie.mp4?x=1&amp;y=2"><span class="dl-btn-label">Movie file.mp4</span></a>'
    const extractor = new MediaFireExtractor('media-id', new FixtureHttpClient([response(html, new Headers(), pageUrl)]))

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://download.mediafire.test/movie.mp4?x=1&y=2', type: 'video/mp4', label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('Movie file.mp4')
  })

  it('ports TurboVipPlay source, embed-domain referer, poster, and title assignments', async () => {
    const html = `
      <title>Turbo fixture</title>
      <script>
        urlPlay = 'https://cdn.turbo.test/master.m3u8';
        domainEmbed = "embed-one.test, embed-two.test";
        urlPoster = 'https://cdn.turbo.test/poster.jpg';
      </script>
    `
    const http = new FixtureHttpClient([response(html)])
    const extractor = new TurboVipPlayExtractor('turbo-id', http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://cdn.turbo.test/master.m3u8', type: 'hls', label: 'Original'
    }])
    expect(extractor.getReferer()).toBe('https://embed-one.test/')
    expect(extractor.getImage()).toBe('https://cdn.turbo.test/poster.jpg')
    expect(extractor.getTitle()).toBe('Turbo fixture')
    expect(String(http.requests[0]?.url)).toBe('https://emturbovid.com/t/turbo-id')
  })

  it('rejects unsafe TurboVipPlay assignment values', async () => {
    const html = `<script>urlPlay='javascript:alert(1)'; domainEmbed='user:pass@bad.test'; urlPoster='data:image/png,x';</script>`
    const extractor = new TurboVipPlayExtractor('turbo-id', new FixtureHttpClient([response(html)]))

    await expect(extractor.getSources()).resolves.toEqual([])
    expect(extractor.getReferer()).toBe('')
    expect(extractor.getImage()).toBe('')
  })

  it('ports Dzen embedded SSR stream metadata from the static params payload', async () => {
    const payload = {
      ssrData: {
        exportResponse: {
          content: {
            title: 'Dzen fixture',
            thumbnail: 'https://img.dzen.test/poster.jpg',
            streams: [
              { url: 'https://cdn.dzen.test/master.m3u8', type: 'application/x-mpegURL' },
              { url: 'https://cdn.dzen.test/video.mp4', type: 'video/mp4' }
            ]
          }
        }
      }
    }
    const html = `<script>params=(${JSON.stringify(payload)});</script>`
    const http = new FixtureHttpClient([response(html)])
    const extractor = new DzenExtractor('dzen-id', http)

    expect(parseDzenParams(html)).toEqual(payload)
    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://cdn.dzen.test/master.m3u8', type: 'hls', label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('Dzen fixture')
    expect(extractor.getImage()).toBe('https://img.dzen.test/poster.jpg')
    expect(String(http.requests[0]?.url)).toBe('https://dzen.ru/embed/dzen-id')
  })

  it('preserves Dzen direct-media IDs without a provider request', async () => {
    const http = new FixtureHttpClient([])
    const extractor = new DzenExtractor('https://cdn.dzen.test/folder/stream.mpd', http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://cdn.dzen.test/folder/stream.mpd', type: 'mpd', label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('stream.mpd')
    expect(http.requests).toEqual([])
  })

  it('ports Files.fm cache-key media and poster URL transformations', async () => {
    const html = `
      <meta property="og:image" content="https://files.fm/thumb_show.php?i=poster&amp;view">
      <script>
        const strHttpCacheKey = strHttpCacheKey + '&cache=fixture';
        const data = {"item_name":"Files fixture.mp4","picture_url":"https:\/\/files.fm\/thumb_show.php?i=video&view"};
      </script>
    `
    const pageUrl = new URL('https://files.fm/u/public-id')
    const http = new FixtureHttpClient([response(html, new Headers(), pageUrl)])
    const extractor = new FilesFmExtractor(pageUrl.toString(), http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://files.fm/thumb_video/video&cache=fixture', type: 'video/mp4', label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('Files fixture.mp4')
    expect(extractor.getImage()).toBe('https://files.fm/thumb_video_picture.php?i=poster')
    expect(extractor.getReferer()).toBe('https://files.fm/u/public-id')
    expect(String(http.requests[0]?.url)).toBe('https://files.fm/u/public-id')
  })

  it('rejects non-HTTP Files.fm IDs and unsafe derived media URLs', async () => {
    const noRequest = new FixtureHttpClient([])
    await expect(new FilesFmExtractor('file:///tmp/video', noRequest).getSources()).resolves.toEqual([])
    expect(noRequest.requests).toEqual([])

    const unsafe = new FilesFmExtractor('https://files.fm/u/id', new FixtureHttpClient([
      response('<script>data={"picture_url":"javascript:alert(1)","item_name":"Bad"}</script>')
    ]))
    await expect(unsafe.getSources()).resolves.toEqual([])
  })

  it('ports Sibnet shell-page media, title, poster, and legacy ID normalization', async () => {
    const html = `
      <meta content="Sibnet fixture" property="og:title">
      <meta content="/thumbs/poster.jpg" property="og:image">
      <script>player.src([{src: "/videos/file.mp4"}]);</script>
    `
    const http = new FixtureHttpClient([response(html)])
    const extractor = new SibnetExtractor('video12345-fixture', http)

    expect(normalizeSibnetId('video12345-fixture')).toBe('12345')
    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://video.sibnet.ru/videos/file.mp4', type: 'video/mp4', label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('Sibnet fixture')
    expect(extractor.getImage()).toBe('https://video.sibnet.ru/thumbs/poster.jpg')
    expect(extractor.getReferer()).toBe('https://video.sibnet.ru/shell.php?videoid=12345')
    expect(String(http.requests[0]?.url)).toBe('https://video.sibnet.ru/shell.php?videoid=12345')
  })

  it('rejects unsafe Sibnet player source values', async () => {
    const extractor = new SibnetExtractor('12345', new FixtureHttpClient([
      response('<script>player.src([{src: "javascript:alert(1)"}]);</script>')
    ]))
    await expect(extractor.getSources()).resolves.toEqual([])
  })

  it('ports the Gofile account, website-token, bootstrap, and content protocol', async () => {
    const http = new FixtureHttpClient([
      jsonResponse({ data: { token: 'account-token' } }),
      jsonResponse({ data: { token: 'website-account-token' } }),
      response('<!doctype html><title>File manager</title>'),
      jsonResponse({
        status: 'ok',
        data: {
          children: {
            child: {
              name: 'Gofile fixture.mp4',
              thumbnail: 'https://store.gofile.test/thumb.jpg',
              link: 'https://store.gofile.test/video.mp4'
            }
          }
        }
      })
    ])
    const extractor = new GofileExtractor('content-id', http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://store.gofile.test/video.mp4', type: 'video/mp4', label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('Gofile fixture.mp4')
    expect(extractor.getImage()).toBe('https://store.gofile.test/thumb.jpg')
    expect(extractor.getCookies()).toEqual(['accountToken=website-account-token'])
    expect(http.methods).toEqual(['POST', 'GET', 'GET', 'GET'])
    expect(http.requests.map((request) => String(request.url))).toEqual([
      'https://api.gofile.io/accounts',
      'https://api.gofile.io/accounts/website',
      'https://gofile.io/contents/filemanager.html',
      'https://api.gofile.io/contents/content-id?contentFilter=&page=1&pageSize=1000&sortField=name&sortDirection=1'
    ])
    expect(new Headers(http.requests[1]?.headers).get('authorization')).toBe('Bearer account-token')
    expect(new Headers(http.requests[2]?.headers).get('cookie')).toBe('accountToken=website-account-token')
    expect(new Headers(http.requests[3]?.headers).get('authorization')).toBe('Bearer website-account-token')
    expect(new Headers(http.requests[3]?.headers).get('x-bl')).toBe('en')
    expect(new Headers(http.requests[3]?.headers).get('x-website-token')).toHaveLength(64)
  })

  it('rejects malformed Gofile tokens and unsafe child links', async () => {
    const malformedTokenHttp = new FixtureHttpClient([
      jsonResponse({ data: { token: 'token\r\nInjected: yes' } })
    ])
    await expect(new GofileExtractor('id', malformedTokenHttp).getSources()).resolves.toEqual([])
    expect(malformedTokenHttp.requests).toHaveLength(1)

    const unsafeLink = new GofileExtractor('id', new FixtureHttpClient([
      jsonResponse({ data: { token: 'account-token' } }),
      jsonResponse({ data: { token: 'website-token' } }),
      response('bootstrap'),
      jsonResponse({
        status: 'ok',
        data: { children: { first: { link: 'https://user:secret@store.gofile.test/video.mp4' } } }
      })
    ]))
    await expect(unsafeLink.getSources()).resolves.toEqual([])
  })

  it('ports Dood pass_md5 tokenization, cookies, poster, title, and filmstrip', async () => {
    const pageHeaders = new Headers()
    pageHeaders.append('set-cookie', 'dood_session=session-token; Path=/; Secure')
    const html = `
      <title>Dood fixture - DoodStream</title>
      <meta property="og:image" content="https://img.dood.test/poster.jpg">
      <script>
        const pass = '/pass_md5/hash-token';
        function makeUrl(a) { return a + "&token=provider-token&expiry="; }
        const player = { thumbnails: { vtt: '//img.dood.test/get_slides/video-id.vtt' } };
      </script>
    `
    const http = new FixtureHttpClient([
      response(html, pageHeaders, 'https://playmogo.com/e/video-id'),
      response('https://cdn.dood.test/video.mp4?signature=', new Headers(), 'https://playmogo.com/pass_md5/hash-token')
    ])
    const extractor = new DoodExtractor('video-id', http, {
      randomToken: () => 'ABCdef1234',
      now: () => 1_700_000_000_000
    })

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://cdn.dood.test/video.mp4?signature=ABCdef1234&token=provider-token&expiry=1700000000',
      type: 'video/mp4',
      label: 'Original'
    }])
    expect(extractor.getReferer()).toBe('https://playmogo.com/')
    expect(extractor.getCookies()).toEqual(['dood_session=session-token'])
    expect(extractor.getImage()).toBe('https://img.dood.test/poster.jpg')
    expect(extractor.getTitle()).toBe('Dood fixture')
    expect(extractor.getFilmstrip()).toBe('https://img.dood.test/get_slides/video-id.vtt')
    expect(http.requests.map((request) => String(request.url))).toEqual([
      'https://playmogo.com/e/video-id',
      'https://playmogo.com/pass_md5/hash-token'
    ])
    expect(new Headers(http.requests[1]?.headers).get('referer')).toBe('https://playmogo.com/')
    expect(new Headers(http.requests[1]?.headers).get('cookie')).toBe('dood_session=session-token')
  })

  it('rejects unsafe Dood provider token fragments and pass responses', async () => {
    const unsafeToken = new DoodExtractor('id', new FixtureHttpClient([
      response(`<script>const p='/pass_md5/hash'; function f(a){return a + "&token=bad\nvalue";}</script>`, new Headers(), 'https://playmogo.com/e/id')
    ]), { randomToken: () => 'ABCdef1234', now: () => 0 })
    await expect(unsafeToken.getSources()).resolves.toEqual([])

    const unsafeResponse = new DoodExtractor('id', new FixtureHttpClient([
      response(`<script>const p='/pass_md5/hash'; function f(a){return a + "&token=ok";}</script>`, new Headers(), 'https://playmogo.com/e/id'),
      response('javascript:alert(1)', new Headers(), 'https://playmogo.com/pass_md5/hash')
    ]), { randomToken: () => 'ABCdef1234', now: () => 0 })
    await expect(unsafeResponse.getSources()).resolves.toEqual([])
  })

  it('ports Streamtape redirect probing, metadata, and filtered captions', async () => {
    const html = `
      <meta property="og:title" content="Streamtape fixture">
      <meta property="og:image" content="https://img.streamtape.test/poster.jpg">
      <video>
        <track kind="captions" src="/captions/en.vtt" label="English">
        <track kind="captions" src="/captions/upload.vtt" label="Upload your subtitle">
      </video>
      <script>document.querySelector('#robotlink').innerHTML = '//streamtape.test/get_video?id=video-id&amp;expires=1700000000&amp;token=fixture';</script>
    `
    const headHeaders = new Headers({ 'content-length': '123456' })
    const http = new FixtureHttpClient([
      response(html, new Headers(), 'https://tapeadvertisement.com/e/video-id'),
      response('', headHeaders, 'https://cdn.streamtape.test/video.mp4')
    ])
    const extractor = new StreamtapeExtractor('video-id', http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://cdn.streamtape.test/video.mp4', type: 'video/mp4', label: 'Original'
    }])
    await expect(extractor.getTracks()).resolves.toEqual([{
      file: 'https://tapeadvertisement.com/captions/en.vtt', label: 'English'
    }])
    expect(extractor.getTitle()).toBe('Streamtape fixture')
    expect(extractor.getImage()).toBe('https://img.streamtape.test/poster.jpg')
    expect(http.methods).toEqual(['GET', 'HEAD'])
    expect(String(http.requests[0]?.url)).toBe('https://tapeadvertisement.com/e/video-id')
    expect(String(http.requests[1]?.url)).toBe('https://tapeadvertisement.com/get_video?id=video-id&expires=1700000000&token=fixture&stream=1')
    expect(new Headers(http.requests[1]?.headers).get('range')).toBe('bytes=0-')
  })

  it.each(['7975278', '7975279'])('rejects Streamtape blocked-response size %s', async (size) => {
    const html = `<video></video><script>x.innerHTML = '//streamtape.test/get_video?id=id&amp;token=fixture';</script>`
    const extractor = new StreamtapeExtractor('id', new FixtureHttpClient([
      response(html, new Headers(), 'https://tapeadvertisement.com/e/id'),
      response('', new Headers({ 'content-length': size }), 'https://cdn.streamtape.test/blocked.mp4')
    ]))

    await expect(extractor.getSources()).resolves.toEqual([])
  })

  it('ports Amazon Drive share discovery and typed video/image assets', async () => {
    const http = new FixtureHttpClient([
      jsonResponse({ nodeInfo: { id: 'node-id' } }),
      jsonResponse({
        count: 1,
        data: [{
          name: 'Amazon fixture',
          assets: [
            {
              status: 'AVAILABLE',
              tempLink: 'https://content.amazon.test/video.mp4',
              ownerId: 'video-owner',
              contentProperties: { contentType: 'video/mp4', video: { height: 1080 } }
            },
            {
              status: 'AVAILABLE',
              tempLink: 'https://content.amazon.test/poster.jpg',
              ownerId: 'image-owner',
              contentProperties: { contentType: 'image/jpeg' }
            }
          ]
        }]
      })
    ])
    const extractor = new AmazonExtractor('share-id', http, { now: () => 1_700_000_000_000 })

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://content.amazon.test/video.mp4?ownerId=video-owner',
      type: 'video/mp4',
      label: '1080p'
    }])
    expect(extractor.getTitle()).toBe('Amazon fixture')
    expect(extractor.getImage()).toBe('https://content.amazon.test/poster.jpg?ownerId=image-owner')
    expect(http.requests.map((request) => String(request.url))).toEqual([
      'https://www.amazon.com/drive/v1/shares/share-id?shareId=share-id&resourceVersion=V2&ContentType=JSON&_=1700000000',
      'https://www.amazon.com/drive/v1/nodes/node-id/children?asset=ALL&limit=1&searchOnFamily=false&tempLink=true&shareId=share-id&offset=0&resourceVersion=V2&ContentType=JSON&_=1700000000'
    ])
  })

  it('ports Amazon Drive node fallback and rejects credential-bearing links', async () => {
    const fallback = new AmazonExtractor('share-id', new FixtureHttpClient([
      jsonResponse({ nodeInfo: { id: 'node-id' } }),
      jsonResponse({
        count: 1,
        data: [{
          name: 'Fallback',
          tempLink: 'https://content.amazon.test/fallback.mp4',
          ownerId: 'owner',
          contentProperties: { video: { height: '720' } }
        }]
      })
    ]), { now: () => 0 })
    await expect(fallback.getSources()).resolves.toEqual([{
      file: 'https://content.amazon.test/fallback.mp4?ownerId=owner', type: 'video/mp4', label: '720p'
    }])

    const unsafe = new AmazonExtractor('share-id', new FixtureHttpClient([
      jsonResponse({ nodeInfo: { id: 'node-id' } }),
      jsonResponse({
        count: 1,
        data: [{
          tempLink: 'https://user:secret@content.amazon.test/video.mp4',
          ownerId: 'owner',
          contentProperties: { video: { height: 720 } }
        }]
      })
    ]), { now: () => 0 })
    await expect(unsafe.getSources()).resolves.toEqual([])
  })

  it('ports OK.ru HLS/DASH playback, MP4 downloads, captions, and filmstrip metadata', async () => {
    const metadata = {
      movie: {
        title: 'OK fixture',
        subtitleTracks: [
          { url: '//cdn.ok.test/en.vtt', language: 'en' },
          { url: 'javascript:alert(1)', language: 'bad' }
        ],
        collageInfo: { url: 'https://img.ok.test/collage.jpg', count: 12, frequency: 5 }
      },
      videos: [
        { name: 'sd', url: 'https://cdn.ok.test/480.mp4' },
        { name: 'full', url: 'https://cdn.ok.test/1080.mp4' }
      ],
      hlsMasterPlaylistUrl: 'https://cdn.ok.test/master.m3u8',
      dashSepUrl: 'https://cdn.ok.test/manifest.mpd'
    }
    const options = {
      poster: 'https://img.ok.test/poster.jpg',
      flashvars: { metadata: JSON.stringify(metadata) }
    }
    const encodedOptions = JSON.stringify(options).replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    const html = `<div data-options="${encodedOptions}"></div>`

    expect(parseOkruOptions(html)).toEqual(options)
    const playbackHttp = new FixtureHttpClient([response(html)])
    const playback = new OkruExtractor('video-id', playbackHttp)
    await expect(playback.getSources()).resolves.toEqual([
      { file: 'https://cdn.ok.test/master.m3u8', type: 'hls', label: 'Original' },
      { file: 'https://cdn.ok.test/manifest.mpd', type: 'mpd', label: 'Original' }
    ])
    await expect(playback.getTracks()).resolves.toEqual([{
      file: 'https://cdn.ok.test/en.vtt', label: 'English'
    }])
    expect(playback.getTitle()).toBe('OK fixture')
    expect(playback.getImage()).toBe('https://img.ok.test/poster.jpg')
    expect(playback.getFilmstrip()).toBe('https://img.ok.test/collage.jpg#count=12&frequency=5')
    expect(String(playbackHttp.requests[0]?.url)).toBe('https://ok.ru/videoembed/video-id')

    const download = new OkruExtractor('video-id', new FixtureHttpClient([response(html)]))
      .setDownloadable(true)
    await expect(download.getSources()).resolves.toEqual([
      { file: 'https://cdn.ok.test/480.mp4', type: 'video/mp4', label: '480p' },
      { file: 'https://cdn.ok.test/1080.mp4', type: 'video/mp4', label: '1080p' }
    ])
  })

  it('falls back to OK.ru MP4 sources and rejects unsafe URLs', async () => {
    const metadata = {
      movie: { title: 'Fallback' },
      videos: [
        { name: 'hd', url: 'https://cdn.ok.test/720.mp4' },
        { name: 'full', url: 'https://user:secret@cdn.ok.test/1080.mp4' }
      ],
      hlsManifestUrl: 'javascript:alert(1)'
    }
    const options = { flashvars: { metadata } }
    const html = `<div data-options="${JSON.stringify(options).replaceAll('"', '&quot;')}"></div>`
    const extractor = new OkruExtractor('video-id', new FixtureHttpClient([response(html)]))

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://cdn.ok.test/720.mp4', type: 'video/mp4', label: '720p'
    }])
  })

  it('ports the SoundCloud player, widget, resolve, and transcoding request chain', async () => {
    const page = '<meta property="twitter:player" content="https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack">'
    const player = '<script src="https://w.soundcloud.com/player/old.js"></script><script src="https://w.soundcloud.com/player/assets/widget.js"></script>'
    const http = new FixtureHttpClient([
      response(page, new Headers(), 'https://soundcloud.com/artist/track'),
      response(player, new Headers(), 'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack'),
      response('{"client_id":"client-id-123"}', new Headers(), 'https://w.soundcloud.com/player/assets/widget.js'),
      jsonResponse({
        title: 'Sound fixture',
        artwork_url: 'https://i1.sndcdn.com/artworks-large.jpg',
        media: {
          transcodings: [{
            url: 'https://api-v2.soundcloud.test/media/transcoding',
            format: { protocol: 'hls' }
          }]
        }
      }),
      jsonResponse({ url: 'https://cf-hls-media.sndcdn.test/master.m3u8' })
    ])
    const extractor = new SoundcloudExtractor('https://soundcloud.com/artist/track', http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://cf-hls-media.sndcdn.test/master.m3u8', type: 'hls', label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('Sound fixture')
    expect(extractor.getImage()).toBe('https://i1.sndcdn.com/artworks-original.jpg')
    expect(extractor.getReferer()).toBe('https://twitter.com/')
    expect(http.methods).toEqual(['GET', 'GET', 'GET', 'GET', 'GET'])
    expect(http.requests.map((request) => String(request.url))).toEqual([
      'https://soundcloud.com/artist/track',
      'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack',
      'https://w.soundcloud.com/player/assets/widget.js',
      'https://api-widget.soundcloud.com/resolve?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack&format=json&client_id=client-id-123&app_version=1781686444',
      'https://api-v2.soundcloud.test/media/transcoding?client_id=client-id-123'
    ])
    expect(new Headers(http.requests[1]?.headers).get('referer')).toBe('https://twitter.com/')
    expect(new Headers(http.requests[2]?.headers).get('referer')).toBe('https://twitter.com/')
  })

  it('rejects encrypted SoundCloud transcodings without requesting their endpoint', async () => {
    const page = '<meta name="twitter:player" content="https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack">'
    const http = new FixtureHttpClient([
      response(page),
      response('<script src="https://w.soundcloud.com/widget.js"></script>'),
      response('{"client_id":"fixture_client"}'),
      jsonResponse({
        media: {
          transcodings: [{
            url: 'https://api-v2.soundcloud.test/encrypted',
            format: { protocol: 'encrypted_hls' }
          }]
        }
      })
    ])
    const extractor = new SoundcloudExtractor('https://soundcloud.com/artist/track', http)

    await expect(extractor.getSources()).resolves.toEqual([])
    expect(http.requests).toHaveLength(4)
  })

  it('ports Streamable signed MP4 variants, metadata, and playback selection', async () => {
    const video = {
      title: 'Streamable fixture',
      original_name: 'fallback.mp4',
      poster_url: '//cdn.streamable.test/poster.jpg?token=fixture',
      files: {
        'mp4-mobile': {
          url: '//cdn.streamable.test/mobile.mp4?token=fixture',
          height: 360,
          status: 2
        },
        mp4: {
          url: '//cdn.streamable.test/original.mp4?token=fixture',
          height: 1080,
          status: 2
        }
      }
    }
    const html = `<script>var videoObject = ${JSON.stringify(video)};</script>`
    expect(parseStreamableVideoObject(html)).toEqual(video)
    const http = new FixtureHttpClient([
      response(html, new Headers(), 'https://streamable.com/e/stream-id')
    ])
    const extractor = new StreamableExtractor('stream-id', http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://cdn.streamable.test/original.mp4?token=fixture',
      type: 'video/mp4',
      label: '1080p'
    }])
    expect(extractor.getTitle()).toBe('Streamable fixture')
    expect(extractor.getImage()).toBe('https://cdn.streamable.test/poster.jpg?token=fixture')
    expect(String(http.requests[0]?.url)).toBe('https://streamable.com/e/stream-id')

    const download = new StreamableExtractor('stream-id', new FixtureHttpClient([response(html)]))
      .setDownloadable(true)
    await expect(download.getSources()).resolves.toEqual([
      { file: 'https://cdn.streamable.test/original.mp4?token=fixture', type: 'video/mp4', label: '1080p' },
      { file: 'https://cdn.streamable.test/mobile.mp4?token=fixture', type: 'video/mp4', label: '360p' }
    ])
  })

  it('rejects malformed and unsafe Streamable media objects', async () => {
    const html = `<script>var videoObject = ${JSON.stringify({
      files: {
        pending: { url: 'https://cdn.streamable.test/pending.mp4', height: 720, status: 1 },
        unsafe: { url: 'https://user:secret@cdn.streamable.test/unsafe.mp4', height: 1080, status: 2 }
      }
    })};</script>`
    const extractor = new StreamableExtractor('stream-id', new FixtureHttpClient([response(html)]))

    await expect(extractor.getSources()).resolves.toEqual([])
    await expect(new StreamableExtractor('../unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
    expect(parseStreamableVideoObject('var videoObject = {not-json};')).toBeNull()
  })

  it('ports Aparat HLS playback, downloadable renditions, title, and poster metadata', async () => {
    const attributes = {
      title: 'Aparat fixture',
      big_poster: 'https://static.aparat.test/poster.jpg',
      hls_link: 'https://stream.aparat.test/master.m3u8',
      file_link_all: [
        { profile: '144p', urls: ['https://stream.aparat.test/144.mp4'] },
        { profile: '720p', urls: ['https://stream.aparat.test/720.mp4'] }
      ]
    }
    const payload = { data: { type: 'VideoShow', attributes } }
    const playbackHttp = new FixtureHttpClient([jsonResponse(payload)])
    const playback = new AparatExtractor('video-id', playbackHttp)

    await expect(playback.getSources()).resolves.toEqual([{
      file: 'https://stream.aparat.test/master.m3u8', type: 'hls', label: 'Original'
    }])
    expect(playback.getTitle()).toBe('Aparat fixture')
    expect(playback.getImage()).toBe('https://static.aparat.test/poster.jpg')
    expect(playback.getReferer()).toBe('https://www.aparat.com/')
    expect(String(playbackHttp.requests[0]?.url)).toBe(
      'https://www.aparat.com/api/fa/v1/video/video/show/videohash/video-id'
    )

    const download = new AparatExtractor('video-id', new FixtureHttpClient([jsonResponse(payload)]))
      .setDownloadable(true)
    await expect(download.getSources()).resolves.toEqual([
      { file: 'https://stream.aparat.test/144.mp4', type: 'video/mp4', label: '144p' },
      { file: 'https://stream.aparat.test/720.mp4', type: 'video/mp4', label: '720p' }
    ])
  })

  it('follows bounded Aparat legacy redirects and rejects unsafe media links', async () => {
    const http = new FixtureHttpClient([
      jsonResponse({ data: [], meta: { redirectUid: 'redirect-id' } }),
      jsonResponse({ data: [{ attributes: { uid: 'current-id' } }], meta: { status: 410 } }),
      jsonResponse({
        data: {
          attributes: {
            title: 'Redirected',
            file_link_all: [
              { profile: '360p', urls: ['https://stream.aparat.test/360.mp4'] },
              { profile: '1080p', urls: ['https://user:secret@stream.aparat.test/unsafe.mp4'] }
            ],
            hls_link: 'javascript:alert(1)'
          }
        }
      })
    ])
    const extractor = new AparatExtractor('old-id', http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://stream.aparat.test/360.mp4', type: 'video/mp4', label: '360p'
    }])
    expect(http.requests.map((request) => String(request.url))).toEqual([
      'https://www.aparat.com/api/fa/v1/video/video/show/videohash/old-id',
      'https://www.aparat.com/api/fa/v1/video/video/show/videohash/redirect-id',
      'https://www.aparat.com/api/fa/v1/video/video/show/videohash/current-id'
    ])
    await expect(new AparatExtractor('../unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
  })

  it('ports Vimeo player configuration, HLS playback, MP4 downloads, and captions', async () => {
    const config = {
      request: {
        files: {
          hls: {
            default_cdn: 'preferred',
            cdns: {
              preferred: { url: 'https://vod.vimeo.test/master.m3u8' },
              fallback: { url: 'https://fallback.vimeo.test/master.m3u8' }
            }
          },
          progressive: [
            { url: 'https://vod.vimeo.test/360.mp4', height: 360, quality: '360p' },
            { url: 'https://vod.vimeo.test/1080.mp4', height: 1080, quality: '1080p' }
          ]
        },
        text_tracks: [
          { url: 'https://text.vimeo.test/en.vtt', label: 'English' },
          { url: 'javascript:alert(1)', label: 'Unsafe' }
        ]
      },
      video: {
        title: 'Vimeo fixture',
        thumbnail_url: 'https://img.vimeo.test/poster.jpg'
      }
    }
    const html = `<script>window.playerConfig = ${JSON.stringify(config)};</script>`
    expect(parseVimeoPlayerConfig(html)).toEqual(config)
    const playbackHttp = new FixtureHttpClient([response(html)])
    const playback = new VimeoExtractor('259411563?h=private-hash', playbackHttp)

    await expect(playback.getSources()).resolves.toEqual([{
      file: 'https://vod.vimeo.test/master.m3u8', type: 'hls', label: 'Original'
    }])
    await expect(playback.getTracks()).resolves.toEqual([{
      file: 'https://text.vimeo.test/en.vtt', label: 'English'
    }])
    expect(playback.getTitle()).toBe('Vimeo fixture')
    expect(playback.getImage()).toBe('https://img.vimeo.test/poster.jpg')
    expect(playback.getReferer()).toBe('https://vimeo.com/')
    expect(String(playbackHttp.requests[0]?.url)).toBe(
      'https://player.vimeo.com/video/259411563?h=private-hash'
    )

    const download = new VimeoExtractor('259411563', new FixtureHttpClient([response(html)]))
      .setDownloadable(true)
    await expect(download.getSources()).resolves.toEqual([
      { file: 'https://vod.vimeo.test/360.mp4', type: 'video/mp4', label: '360p' },
      { file: 'https://vod.vimeo.test/1080.mp4', type: 'video/mp4', label: '1080p' }
    ])
  })

  it('falls back to Vimeo progressive media and rejects malformed configurations', async () => {
    const config = {
      request: {
        files: {
          hls: { default_cdn: 'unsafe', cdns: { unsafe: { url: 'https://user:secret@vod.vimeo.test/a.m3u8' } } },
          progressive: [
            { url: 'https://vod.vimeo.test/240.mp4', height: 240 },
            { url: 'https://vod.vimeo.test/720.mp4', height: 720 }
          ]
        }
      }
    }
    const extractor = new VimeoExtractor(
      '259411563',
      new FixtureHttpClient([response(`window.playerConfig=${JSON.stringify(config)}`)])
    )
    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://vod.vimeo.test/720.mp4', type: 'video/mp4', label: '720p'
    }])
    await expect(new VimeoExtractor('../unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
    expect(parseVimeoPlayerConfig('window.playerConfig = {not-json};')).toBeNull()
  })

  it('ports TikTok universal-data media, metadata, captions, and legacy URL decoding', async () => {
    const item = {
      desc: 'TikTok fixture',
      video: {
        playAddr: 'https://video.tiktok.test/clip.mp4?signature=a%2Fb%3D',
        definition: '720p',
        cover: 'https://image.tiktok.test/poster.jpg?signature=c%2Fd%3D',
        subtitleInfos: [
          {
            Url: 'https://text.tiktok.test/en.vtt?signature=e%2Ff%3D',
            LanguageName: 'English'
          },
          { Url: 'javascript:alert(1)', LanguageName: 'Unsafe' }
        ]
      }
    }
    const payload = {
      __DEFAULT_SCOPE__: {
        'webapp.video-detail': { itemInfo: { itemStruct: item } }
      }
    }
    const html = `<script type="application/json" id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify(payload)}</script>`
    expect(parseTiktokItem(html)).toEqual(item)
    const http = new FixtureHttpClient([response(html)])
    const extractor = new TiktokExtractor('@creator/video/1234567890', http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://video.tiktok.test/clip.mp4?signature=a/b=',
      type: 'video/mp4',
      label: '720p'
    }])
    await expect(extractor.getTracks()).resolves.toEqual([{
      file: 'https://text.tiktok.test/en.vtt?signature=e/f=', label: 'English'
    }])
    expect(extractor.getTitle()).toBe('TikTok fixture')
    expect(extractor.getImage()).toBe('https://image.tiktok.test/poster.jpg?signature=c/d=')
    expect(extractor.getReferer()).toBe('https://www.tiktok.com/')
    expect(String(http.requests[0]?.url)).toBe('https://www.tiktok.com/@creator/video/1234567890')
  })

  it('rejects missing or unsafe TikTok payloads and page identifiers', async () => {
    const unsafePayload = {
      __DEFAULT_SCOPE__: {
        'webapp.video-detail': {
          itemInfo: { itemStruct: { video: { playAddr: 'https://user:secret@video.tiktok.test/a.mp4' } } }
        }
      }
    }
    const unsafeHtml = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify(unsafePayload)}</script>`
    await expect(new TiktokExtractor('@creator/video/1', new FixtureHttpClient([response(unsafeHtml)]))
      .getSources()).resolves.toEqual([])
    await expect(new TiktokExtractor('../unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
    expect(parseTiktokItem('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{bad-json}</script>')).toBeNull()
  })

  it('ports Internet Archive media, captions, thumbnail, and item metadata', async () => {
    const http = new FixtureHttpClient([jsonResponse({
      metadata: { title: ['Archive fixture'] },
      files: [
        { name: 'movie-360.mp4', format: 'h.264 IA', source: 'derivative', height: '360' },
        { name: 'movie original.mp4', format: 'MPEG4', source: 'original', height: '1080' },
        { name: 'audio.mp3', format: 'VBR MP3', source: 'derivative' },
        { name: 'captions/en file.vtt', title: 'English' },
        { name: '__ia_thumb.jpg', format: 'Item Tile', source: 'original' },
        { name: 'metadata.xml', format: 'Metadata' }
      ]
    })])
    const extractor = new ArchiveExtractor('archive_id-1', http)

    await expect(extractor.getSources()).resolves.toEqual([
      { file: 'https://archive.org/download/archive_id-1/movie-360.mp4', type: 'video/mp4', label: '360p' },
      { file: 'https://archive.org/download/archive_id-1/movie%20original.mp4', type: 'video/mp4', label: '1080p' },
      { file: 'https://archive.org/download/archive_id-1/audio.mp3', type: 'video/mp4', label: 'VBR MP3' }
    ])
    await expect(extractor.getTracks()).resolves.toEqual([{
      file: 'https://archive.org/download/archive_id-1/captions/en%20file.vtt', label: 'English'
    }])
    expect(extractor.getTitle()).toBe('Archive fixture')
    expect(extractor.getImage()).toBe('https://archive.org/download/archive_id-1/__ia_thumb.jpg')
    expect(extractor.getReferer()).toBe('https://archive.org/')
    expect(String(http.requests[0]?.url)).toBe('https://archive.org/metadata/archive_id-1')
  })

  it('rejects private, unsafe-path, unsupported, and malformed Archive entries', async () => {
    const extractor = new ArchiveExtractor('archive-id', new FixtureHttpClient([jsonResponse({
      metadata: { description: 'Fallback title' },
      files: [
        { name: 'private.mp4', private: true, height: 720 },
        { name: '../unsafe.mp4', height: 1080 },
        { name: 'document.pdf' },
        { name: 'stream/master.m3u8', format: 'HLS' }
      ]
    })]))
    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://archive.org/download/archive-id/stream/master.m3u8', type: 'hls', label: 'HLS'
    }])
    expect(extractor.getTitle()).toBe('Fallback title')
    await expect(new ArchiveExtractor('../unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
  })

  it('ports Filemail public transfer metadata and playable download URLs', async () => {
    const http = new FixtureHttpClient([jsonResponse({
      responsestatus: 'OK',
      data: {
        id: 'transfer-id',
        subject: 'Transfer subject',
        files: [
          {
            fileid: 'file-1',
            filename: 'Filemail fixture.mp4',
            filesize: 1234,
            downloadurl: 'https://files.filemail.test/download?fileid=file-1'
          },
          {
            fileid: 'file-2',
            filename: 'captions.srt',
            downloadurl: 'https://files.filemail.test/download?fileid=file-2'
          }
        ]
      }
    })])
    const extractor = new FilemailExtractor('track-id', http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://files.filemail.test/download?fileid=file-1&skipcheck=true&skipreg=true',
      type: 'video/mp4',
      label: 'Filemail fixture.mp4'
    }])
    expect(extractor.getTitle()).toBe('Filemail fixture.mp4')
    expect(extractor.getReferer()).toBe('https://www.filemail.com/')
    expect(String(http.requests[0]?.url)).toBe(
      'https://api.filemail.com/transfer?trackid=track-id&fprops=fileid%2Cfilesize%2Cfilename%2Cdownloadurl&fileslimit=-1'
    )
    expect(new Headers(http.requests[0]?.headers).get('x-api-version')).toBe('2.0')
    expect(new Headers(http.requests[0]?.headers).get('filemaillogintokencheck')).toBe('true')
  })

  it('rejects expired, blocked, unsafe, and non-media Filemail transfers', async () => {
    const expired = new FilemailExtractor('track-id', new FixtureHttpClient([jsonResponse({
      data: { isexpired: true, files: [{ filename: 'video.mp4', downloadurl: 'https://files.test/a.mp4' }] }
    })]))
    await expect(expired.getSources()).resolves.toEqual([])

    const filtered = new FilemailExtractor('track-id', new FixtureHttpClient([jsonResponse({
      data: {
        subject: 'Filtered',
        files: [
          { filename: 'unsafe.mp4', downloadurl: 'https://user:secret@files.test/a.mp4' },
          { filename: 'document.pdf', downloadurl: 'https://files.test/document.pdf' },
          { filename: 'stream.m3u8', downloadurl: 'https://files.test/stream.m3u8' }
        ]
      }
    })]))
    await expect(filtered.getSources()).resolves.toEqual([{
      file: 'https://files.test/stream.m3u8?skipcheck=true&skipreg=true', type: 'hls', label: 'stream.m3u8'
    }])
    expect(filtered.getTitle()).toBe('stream.m3u8')
    await expect(new FilemailExtractor('../unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
  })

  it('ports My Mail.ru public metadata sources, captions, title, and poster', async () => {
    const http = new FixtureHttpClient([jsonResponse({
      meta: {
        title: 'Mail.ru fixture',
        poster: '//img.mail.test/poster.jpg'
      },
      videos: [
        { key: '720p', url: '//cdn.mail.test/720.mp4?video_key=fixture' },
        { key: 'Adaptive', url: 'https://cdn.mail.test/master.m3u8' }
      ],
      subtitles: [
        { url: '//cdn.mail.test/en.vtt', language: 'English' },
        { url: 'javascript:alert(1)', language: 'Unsafe' }
      ]
    })])
    const extractor = new MyMailRuExtractor('84530788950872688', http)

    await expect(extractor.getSources()).resolves.toEqual([
      { file: 'https://cdn.mail.test/720.mp4?video_key=fixture', type: 'video/mp4', label: '720p' },
      { file: 'https://cdn.mail.test/master.m3u8', type: 'hls', label: 'Adaptive' }
    ])
    await expect(extractor.getTracks()).resolves.toEqual([{
      file: 'https://cdn.mail.test/en.vtt', label: 'English'
    }])
    expect(extractor.getTitle()).toBe('Mail.ru fixture')
    expect(extractor.getImage()).toBe('https://img.mail.test/poster.jpg')
    expect(extractor.getReferer()).toBe('https://my.mail.ru/video/embed/84530788950872688')
    expect(String(http.requests[0]?.url)).toBe('https://my.mail.ru/+/video/meta/84530788950872688')
  })

  it('rejects private, malformed, unsafe, and invalid-ID My Mail.ru results', async () => {
    const privateVideo = new MyMailRuExtractor('1', new FixtureHttpClient([jsonResponse({
      isPrivate: true,
      videos: [{ key: '720p', url: 'https://cdn.mail.test/video.mp4' }]
    })]))
    await expect(privateVideo.getSources()).resolves.toEqual([])

    const unsafeVideo = new MyMailRuExtractor('2', new FixtureHttpClient([jsonResponse({
      videos: [{ key: '720p', url: 'https://user:secret@cdn.mail.test/video.mp4' }]
    })]))
    await expect(unsafeVideo.getSources()).resolves.toEqual([])
    await expect(new MyMailRuExtractor('../unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
  })

  it('ports Cloud Mail.ru signed HLS discovery, title, poster, and referer', async () => {
    const settings = {
      request: { weblink: 'rvni/fixture-id' },
      dispatcher: {
        videowl_view: {
          url: 'https://cloclo58.cloud.mail.ru/videowl/view/signed-token/g/no'
        }
      },
      params: {
        serverSideFolders: {
          name: 'Cloud Mail fixture.mp4',
          weblink: 'rvni/fixture-id',
          kind: 'file',
          type: 'file'
        }
      }
    }
    const html = `<script>window.cloudSettings=${JSON.stringify(settings)};"html" + "fragment"</script>`
    expect(parseCloudMailPage(html)).toEqual({
      weblink: 'rvni/fixture-id',
      title: 'Cloud Mail fixture.mp4',
      hlsBaseUrl: 'https://cloclo58.cloud.mail.ru/videowl/view/signed-token/g/no'
    })
    const http = new FixtureHttpClient([response(html, new Headers(), 'https://cloud.mail.ru/public/rvni/fixture-id')])
    const extractor = new CloudMailRuExtractor('public/rvni/fixture-id', http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://cloclo58.cloud.mail.ru/videowl/view/signed-token/g/no/0p/cnZuaS9maXh0dXJlLWlk.m3u8?double_encode=1',
      type: 'hls',
      label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('Cloud Mail fixture.mp4')
    expect(extractor.getImage()).toBe('https://thumb.cloud.mail.ru/weblink/thumb/vxw0/rvni/fixture-id')
    expect(extractor.getReferer()).toBe('https://cloud.mail.ru/')
    expect(String(http.requests[0]?.url)).toBe('https://cloud.mail.ru/public/rvni/fixture-id')
  })

  it('rejects malformed, mismatched, unsafe, and invalid Cloud Mail.ru payloads', async () => {
    const unsafe = `<script>window.cloudSettings=${JSON.stringify({
      request: { weblink: 'rvni/other-id' },
      dispatcher: { videowl_view: { url: 'https://user:secret@cloclo.test/videowl/view/token/g/no' } },
      params: { serverSideFolders: { name: 'Unsafe.mp4', kind: 'file' } }
    })}</script>`
    await expect(new CloudMailRuExtractor(
      'public/rvni/fixture-id',
      new FixtureHttpClient([response(unsafe, new Headers(), 'https://cloud.mail.ru/public/rvni/fixture-id')])
    ).getSources()).resolves.toEqual([])
    await expect(new CloudMailRuExtractor('../unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
    expect(parseCloudMailPage('<script>window.cloudSettings={bad-json}</script>')).toBeNull()
  })

  it('ports Naver TV page discovery, HLS/MP4 playback, captions, title, and poster', async () => {
    const pageProps = {
      vodInfo: {
        clip: {
          title: 'Naver fixture',
          thumbnailImageUrl: 'https://img.naver.test/poster.jpg',
          videoId: 'VIDEO-ID'
        },
        play: { inKey: 'play-key', playable: 'PLAYABLE' }
      }
    }
    const page = `<script type="application/json" id="__NEXT_DATA__">${JSON.stringify({
      props: { pageProps }
    })}</script>`
    expect(parseNaverPageProps(page)).toEqual(pageProps)
    const playback = {
      streams: [{
        type: 'HLS',
        source: 'https://vod.naver.test/master.m3u8',
        keys: [{ name: '__gda__', value: 'signed-value' }]
      }],
      videos: {
        list: [
          { source: 'https://vod.naver.test/360.mp4', encodingOption: { name: '360P', height: 360 } },
          { source: 'https://vod.naver.test/1080.mp4', encodingOption: { name: '1080P', height: 1080 } }
        ]
      },
      captions: {
        list: [
          { source: 'https://text.naver.test/en.vtt', label: 'English' },
          { source: 'javascript:alert(1)', label: 'Unsafe' }
        ]
      }
    }
    const http = new FixtureHttpClient([response(page), jsonResponse(playback)])
    const extractor = new NaverTvExtractor('v/43949318/list/67096', http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://vod.naver.test/master.m3u8?__gda__=signed-value', type: 'hls', label: 'Original'
    }])
    await expect(extractor.getTracks()).resolves.toEqual([{
      file: 'https://text.naver.test/en.vtt', label: 'English'
    }])
    expect(extractor.getTitle()).toBe('Naver fixture')
    expect(extractor.getImage()).toBe('https://img.naver.test/poster.jpg')
    expect(extractor.getReferer()).toBe('https://tv.naver.com/v/43949318/list/67096')
    expect(http.requests.map((request) => String(request.url))).toEqual([
      'https://tv.naver.com/v/43949318/list/67096',
      'https://apis.naver.com/rmcnmv/rmcnmv/vod/play/v2.0/VIDEO-ID?key=play-key'
    ])

    const download = new NaverTvExtractor('v/43949318', new FixtureHttpClient([response(page), jsonResponse(playback)]))
      .setDownloadable(true)
    await expect(download.getSources()).resolves.toEqual([
      { file: 'https://vod.naver.test/360.mp4', type: 'video/mp4', label: '360P' },
      { file: 'https://vod.naver.test/1080.mp4', type: 'video/mp4', label: '1080P' }
    ])
  })

  it('supports static Naver live playback bodies and rejects unsafe identifiers and sources', async () => {
    const page = `<script id="__NEXT_DATA__">${JSON.stringify({
      props: {
        pageProps: {
          liveInfo: {
            playable: 'PLAYABLE',
            live: { title: 'Live fixture', thumbnailImageUrl: 'https://img.naver.test/live.jpg' },
            playbackBody: JSON.stringify({
              streams: [{ type: 'HLS', source: 'https://live.naver.test/live.m3u8' }]
            })
          }
        }
      }
    })}</script>`
    const live = new NaverTvExtractor('l/141965', new FixtureHttpClient([response(page)]))
    await expect(live.getSources()).resolves.toEqual([{
      file: 'https://live.naver.test/live.m3u8', type: 'hls', label: 'Original'
    }])
    expect(live.getTitle()).toBe('Live fixture')

    await expect(new NaverTvExtractor('../unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
    expect(parseNaverPageProps('<script id="__NEXT_DATA__">{bad-json}</script>')).toBeNull()
  })

  it('ports HxFile packed embed media plus title-page metadata without script execution', async () => {
    const key = '_0xabc123'
    const decoded = `var player=jwplayer("player");player.setup({
      image:"https://img.hx.test/embed.jpg",
      sources:[{type:"video/mp4",file:"https://cdn.hx.test/video?token=fixture"}]
    });`
    let encrypted = ''
    for (let index = 0; index < decoded.length; index++) {
      encrypted += String.fromCharCode(decoded.charCodeAt(index) ^ key.charCodeAt(index % key.length))
    }
    const encoded = Buffer.from(encrypted, 'utf8').toString('base64')
    const embed = `<script>var payload="${encoded}";var ${key}=decoder();var decoded=base64(payload);</script>`
    expect(parseHxFileEmbed(embed)).toEqual({
      sources: [{ file: 'https://cdn.hx.test/video?token=fixture', type: 'video/mp4', label: 'Original' }],
      image: 'https://img.hx.test/embed.jpg'
    })
    const titlePage = `<span class="dfilename">HxFile &amp; fixture.mp4</span>
      <img class="d-block rounded" src="https://img.hx.test/title.jpg"
        onError="this.src='https://hxfile.co/images/no-preview.jpg'">`
    expect(parseHxFileMetadata(titlePage)).toEqual({
      title: 'HxFile & fixture.mp4', image: 'https://img.hx.test/title.jpg'
    })
    const http = new FixtureHttpClient([
      response(embed, new Headers(), 'https://hxfile.co/embed-fixtureid123.html'),
      response(titlePage, new Headers(), 'https://hxfile.co/fixtureid123.html')
    ])
    const extractor = new HxFileExtractor('fixtureid123', http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://cdn.hx.test/video?token=fixture', type: 'video/mp4', label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('HxFile & fixture.mp4')
    expect(extractor.getImage()).toBe('https://img.hx.test/title.jpg')
    expect(extractor.getReferer()).toBe('https://hxfile.co/fixtureid123')
    expect(http.requests.map((request) => String(request.url))).toEqual([
      'https://hxfile.co/embed-fixtureid123.html',
      'https://hxfile.co/fixtureid123'
    ])
  })

  it('rejects malformed payloads, unsafe HxFile media, redirects, and identifiers', async () => {
    expect(parseHxFileEmbed('<script>var payload="not-base64";var _0xabc=decoder()</script>')).toBeNull()
    const key = '_0xabc123'
    const decoded = 'var player=jwplayer("player");player.setup({sources:[{file:"https://user:secret@cdn.test/a.mp4"}]});'
    let encrypted = ''
    for (let index = 0; index < decoded.length; index++) {
      encrypted += String.fromCharCode(decoded.charCodeAt(index) ^ key.charCodeAt(index % key.length))
    }
    const encoded = Buffer.from(encrypted, 'utf8').toString('base64')
    const unsafe = `<script>var payload="${encoded}";var ${key}=decoder()</script>`
    expect(parseHxFileEmbed(unsafe)?.sources).toEqual([])
    await expect(new HxFileExtractor(
      'fixtureid123',
      new FixtureHttpClient([response(unsafe, new Headers(), 'https://attacker.test/embed-fixtureid123.html')])
    ).getSources()).resolves.toEqual([])
    await expect(new HxFileExtractor('../unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
  })

  it('ports the current VOE redirect, encoded HLS payload, metadata, and captions without browser execution', async () => {
    const id = 'ifprbv97b4u7'
    const target = `https://jessicachoosemake.com/e/${id}`
    const payload = {
      file_code: id,
      title: '',
      thumbnail: '',
      source: 'https://ugc-cdn.voe.test/engine/hls2/fixture/master.m3u8?token=fixture',
      fallback: [{ file: 'https://ugc-cdn.voe.test/movie.mp4' }],
      captions: [
        { file: '/captions/en.vtt', label: 'English', kind: 'captions', default: true },
        { id: 'https://subtitles.voe.test/fr.vtt', label: 'Français' },
        { id: 'off', label: 'Off' }
      ]
    }
    const page = `<meta name="og:title" content="VOE &amp; fixture">
      <meta name="og:image" content="https://jessicachoosemake.com/cache/poster.jpg">
      <script>var source='https://decoy.test/big-buck-bunny.mp4'</script>
      <script type="application/json">${JSON.stringify([encodedVoePayload(payload)])}</script>`
    expect(parseVoeRedirect(`window.location.href = '${target}'`, id)?.toString()).toBe(target)
    expect(decodeVoePayload(encodedVoePayload(payload))).toEqual(payload)
    expect(parseVoePage(page, new URL(target))).toEqual({
      source: 'https://ugc-cdn.voe.test/engine/hls2/fixture/master.m3u8?token=fixture',
      title: 'VOE & fixture',
      image: 'https://jessicachoosemake.com/cache/poster.jpg',
      tracks: [
        { file: 'https://jessicachoosemake.com/captions/en.vtt', label: 'English', kind: 'captions', default: true },
        { file: 'https://subtitles.voe.test/fr.vtt', label: 'Français' }
      ]
    })

    const shell = `<script>window.location.href = '${target}';</script>`
    const http = new FixtureHttpClient([
      response(shell, new Headers(), `https://voe.sx/e/${id}`),
      response(page, new Headers(), target)
    ])
    const extractor = new VoeExtractor(id, http)
    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://ugc-cdn.voe.test/engine/hls2/fixture/master.m3u8?token=fixture',
      type: 'hls',
      label: 'Original'
    }])
    await expect(extractor.getTracks()).resolves.toEqual([
      { file: 'https://jessicachoosemake.com/captions/en.vtt', label: 'English', kind: 'captions', default: true },
      { file: 'https://subtitles.voe.test/fr.vtt', label: 'Français' }
    ])
    expect(extractor.getTitle()).toBe('VOE & fixture')
    expect(extractor.getImage()).toBe('https://jessicachoosemake.com/cache/poster.jpg')
    expect(extractor.getReferer()).toBe(`https://voe.sx/e/${id}`)
    expect(http.requests.map((request) => String(request.url))).toEqual([
      `https://voe.sx/e/${id}`,
      target
    ])
  })

  it('rejects VOE decoys, malformed payloads, unknown redirect hosts, and unsafe identifiers', async () => {
    expect(parseVoeRedirect(
      "window.location.href='https://attacker.test/e/ifprbv97b4u7'",
      'ifprbv97b4u7'
    )).toBeNull()
    expect(decodeVoePayload('not-a-provider-payload')).toBeNull()
    expect(parseVoePage(
      `<meta name="og:title" content="Decoy"><script>var source='https://decoy.test/video.m3u8'</script>`,
      new URL('https://jessicachoosemake.com/e/ifprbv97b4u7')
    )).toBeNull()
    const unsafePayload = `<script type="application/json">${JSON.stringify([encodedVoePayload({
      source: 'javascript:alert(1)', captions: []
    })])}</script>`
    expect(parseVoePage(
      unsafePayload,
      new URL('https://jessicachoosemake.com/e/ifprbv97b4u7')
    )).toBeNull()
    await expect(new VoeExtractor('../unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])

    const unknownRedirect = new VoeExtractor('ifprbv97b4u7', new FixtureHttpClient([
      response(
        "<script>window.location.href='https://attacker.test/e/ifprbv97b4u7'</script>",
        new Headers(),
        'https://voe.sx/e/ifprbv97b4u7'
      )
    ]))
    await expect(unknownRedirect.getSources()).resolves.toEqual([])
  })

  it('ports Google Drive public video info, labels, metadata, and playback aliases', async () => {
    const id = '1225BQ0G3QbioqbP7H5q5u8EqklWDKnDC'
    const body = new URLSearchParams({
      status: 'ok',
      title: 'Drive fixture.mp4',
      iurl: 'https://lh3.googleusercontent.com/drive-poster',
      fmt_stream_map: [
        '18|https://rr1---sn.googlevideo.com/videoplayback?id=fixture&itag=18',
        '22|https://rr1---sn.googlevideo.com/videoplayback?id=fixture&itag=22'
      ].join(',')
    }).toString()
    expect(parseGdriveVideoInfo(body)).toEqual({
      title: 'Drive fixture.mp4',
      image: 'https://lh3.googleusercontent.com/drive-poster',
      sources: [
        { file: 'https://rr1---sn.googlevideo.com/videoplayback?id=fixture&itag=18', type: 'video/mp4', label: '360p' },
        { file: 'https://rr1---sn.googlevideo.com/videoplayback?id=fixture&itag=22', type: 'video/mp4', label: '720p' }
      ]
    })

    const http = new FixtureHttpClient([
      response(body, new Headers({ 'content-type': 'text/plain' }), `https://docs.google.com/u/0/get_video_info?docid=${id}`)
    ])
    const extractor = new GdriveExtractor(`https://drive.google.com/file/d/${id}/view`, http)
    await expect(extractor.getSources()).resolves.toEqual([
      { file: 'https://rr1---sn.googlevideo.com/videoplayback?id=fixture&itag=18', type: 'video/mp4', label: '360p' },
      { file: 'https://rr1---sn.googlevideo.com/videoplayback?id=fixture&itag=22', type: 'video/mp4', label: '720p' },
      { file: 'https://rr1---sn.googlevideo.com/videoplayback?id=fixture&itag=18', type: 'video/mp4', label: 'Default' },
      { file: 'https://rr1---sn.googlevideo.com/videoplayback?id=fixture&itag=22', type: 'video/mp4', label: 'Original' }
    ])
    expect(extractor.getTitle()).toBe('Drive fixture.mp4')
    expect(extractor.getImage()).toBe('https://lh3.googleusercontent.com/drive-poster')
    expect(extractor.getReferer()).toBe('https://youtube.googleapis.com/')
    expect(String(http.requests[0]?.url)).toBe(`https://docs.google.com/u/0/get_video_info?docid=${id}`)

    const download = new GdriveExtractor(id, new FixtureHttpClient([
      response(body, new Headers(), `https://docs.google.com/u/0/get_video_info?docid=${id}`)
    ])).setDownloadable(true)
    await expect(download.getSources()).resolves.toHaveLength(2)
  })

  it('rejects denied, malformed, redirected, and unsafe Google Drive video info', async () => {
    expect(parseGdriveVideoInfo('status=fail&errorcode=150&reason=Permission+denied')).toBeNull()
    expect(parseGdriveVideoInfo(new URLSearchParams({
      status: 'ok',
      fmt_stream_map: '18|https://attacker.test/video.mp4,22|https://user:secret@rr.googlevideo.com/video.mp4',
      iurl: 'javascript:alert(1)'
    }).toString())).toEqual({ sources: [], image: '', title: '' })
    await expect(new GdriveExtractor('../unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
    await expect(new GdriveExtractor(
      '1225BQ0G3QbioqbP7H5q5u8EqklWDKnDC',
      new FixtureHttpClient([response('status=ok', new Headers(), 'https://attacker.test/get_video_info')])
    ).getSources()).resolves.toEqual([])
  })

  it('prefers a safe Google Drive HLS manifest for playback but retains MP4 downloads', async () => {
    const id = '1225BQ0G3QbioqbP7H5q5u8EqklWDKnDC'
    const hlsFile = 'https://manifest.googlevideo.com/api/manifest/hls_variant/fixture/file/index.m3u8'
    const body = new URLSearchParams({
      status: 'ok',
      title: 'Drive HLS fixture.mp4',
      hlsvp: hlsFile,
      fmt_stream_map: '18|https://rr1---sn.googlevideo.com/videoplayback?id=fixture&itag=18'
    }).toString()
    expect(parseGdriveVideoInfo(body)).toMatchObject({
      hls: { file: hlsFile, type: 'hls', label: 'Original' },
      sources: [{ file: 'https://rr1---sn.googlevideo.com/videoplayback?id=fixture&itag=18', type: 'video/mp4', label: '360p' }]
    })

    const playback = new GdriveExtractor(id, new FixtureHttpClient([
      response(body, new Headers(), `https://docs.google.com/u/0/get_video_info?docid=${id}`)
    ])).setHlsMode(true)
    await expect(playback.getSources()).resolves.toEqual([{
      file: hlsFile, type: 'hls', label: 'Original'
    }])

    const download = new GdriveExtractor(id, new FixtureHttpClient([
      response(body, new Headers(), `https://docs.google.com/u/0/get_video_info?docid=${id}`)
    ])).setHlsMode(true).setDownloadable(true)
    await expect(download.getSources()).resolves.toEqual([{
      file: 'https://rr1---sn.googlevideo.com/videoplayback?id=fixture&itag=18', type: 'video/mp4', label: '360p'
    }])

    const unsafe = new URLSearchParams({ status: 'ok', hlsvp: 'https://attacker.test/master.m3u8' }).toString()
    expect(parseGdriveVideoInfo(unsafe)).toEqual({ sources: [], image: '', title: '' })
  })

  it('uses encrypted local Drive media for downloads and private-source fallback', async () => {
    const id = '1225BQ0G3QbioqbP7H5q5u8EqklWDKnDC'
    const privateSource = Object.freeze({
      file: 'https://player.example/gdrive-media/encrypted-token',
      type: 'video/mp4' as const,
      label: 'Original' as const,
      proxy: false as const,
      title: 'Private fixture.mp4',
      image: `https://drive.google.com/thumbnail?id=${id}`
    })
    const privateSources = {
      enqueue: vi.fn(async () => {}),
      resolve: vi.fn(async () => privateSource)
    }
    const downloadHttp = new FixtureHttpClient([])
    const download = new GdriveExtractor(id, downloadHttp, {
      privateSources,
      loadSettings: async () => ({ copy: true, copyAll: false })
    }).setEmail('drive@example.test').setDownloadable(true)

    await expect(download.getSources()).resolves.toEqual([privateSource])
    expect(downloadHttp.requests).toEqual([])
    expect(privateSources.enqueue).toHaveBeenCalledWith(id)
    expect(privateSources.resolve).toHaveBeenCalledWith(id, 'drive@example.test', false)
    expect(download.getTitle()).toBe('Private fixture.mp4')

    privateSources.enqueue.mockClear()
    privateSources.resolve.mockClear()
    const fallback = new GdriveExtractor(id, new FixtureHttpClient([
      response('status=fail&reason=Permission+denied', new Headers(), `https://docs.google.com/u/0/get_video_info?docid=${id}`)
    ]), {
      privateSources,
      loadSettings: async () => ({ copy: true, copyAll: true })
    })
    await expect(fallback.getSources()).resolves.toEqual([privateSource])
    expect(privateSources.enqueue).toHaveBeenCalledWith(id)
    expect(privateSources.resolve).toHaveBeenCalledWith(id, '', true)
  })

  it('ports short and normal WeTransfer links through the public single-file download API', async () => {
    const transferId = '28233e56f7e285d4d6f8a59ed09e7ed220231202025133'
    const securityHash = '988349'
    const pageUrl = `https://wetransfer.com/downloads/${transferId}/${securityHash}`
    expect(parseWetransferTarget(pageUrl)).toEqual({
      kind: 'normal', transferId, securityHash, referer: pageUrl
    })

    const http = new FixtureHttpClient([
      response('', new Headers(), pageUrl),
      response(JSON.stringify({
        id: transferId,
        display_name: 'Feature transfer',
        items: [{ id: 'file-item-1', item_type: 'file', name: 'Feature cut.mp4', size: 1234 }]
      }), new Headers({ 'content-type': 'application/json' }),
      `https://wetransfer.com/api/v4/transfers/${transferId}/prepare-download`),
      response(JSON.stringify({
        direct_link: 'https://download.wetransfer.com/eu2/fixture/Feature%20cut.mp4?token=signed'
      }), new Headers({ 'content-type': 'application/json' }),
      `https://wetransfer.com/api/v4/transfers/${transferId}/download`)
    ])
    const extractor = new WetransferExtractor('https://we.tl/t-zs8Z2GNUup', http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://download.wetransfer.com/eu2/fixture/Feature%20cut.mp4?token=signed',
      type: 'video/mp4',
      label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('Feature cut.mp4')
    expect(extractor.getReferer()).toBe(pageUrl)
    expect(http.methods).toEqual(['HEAD', 'POST', 'POST'])
    expect(JSON.parse(String((http.requests[1] as ProviderHttpPostRequest).body))).toEqual({ security_hash: securityHash })
    expect(JSON.parse(String((http.requests[2] as ProviderHttpPostRequest).body))).toEqual({
      security_hash: securityHash,
      intent: 'single_file',
      file_ids: ['file-item-1']
    })
  })

  it('ports public WeTransfer Collect item links and their signed one-file downloads', async () => {
    const collectionId = 'st14uem2oftiwluzn20240605100613'
    const itemId = 'sve5t63r2nfwvwouu20240605100616'
    const apiOrigin = 'https://api.wetransfermobile.com'
    const http = new FixtureHttpClient([
      response(JSON.stringify({ id: collectionId, total_items: 1 }), new Headers({ 'content-type': 'application/json' }),
        `${apiOrigin}/v2/web/collections/${collectionId}/public`),
      response(JSON.stringify([{
        id: itemId,
        content_identifier: 'file',
        name: 'Collect reel.m3u8',
        size: 4567
      }]), new Headers({ 'content-type': 'application/json' }),
      `${apiOrigin}/v2/web/collections/${collectionId}/public/items?offset=0`),
      response(JSON.stringify({
        download_url: 'https://d20xtzwzcl0ceb.cloudfront.net/collect/Collect%20reel.m3u8?signature=fixture'
      }), new Headers({ 'content-type': 'application/json' }),
      `${apiOrigin}/v2/web/downloads/${collectionId}/public`)
    ])
    const extractor = new WetransferExtractor(`board/${collectionId}/${itemId}`, http)

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://d20xtzwzcl0ceb.cloudfront.net/collect/Collect%20reel.m3u8?signature=fixture',
      type: 'hls',
      label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('Collect reel.m3u8')
    expect(extractor.getReferer()).toBe(`https://collect.wetransfer.com/board/${collectionId}/${itemId}`)
    expect(http.methods).toEqual(['GET', 'GET', 'POST'])
    expect(JSON.parse(String((http.requests[2] as ProviderHttpPostRequest).body))).toEqual({ file_ids: [itemId] })
    const collectHeaders = new Headers(http.requests[0]?.headers)
    expect(collectHeaders.get('x-origin')).toBe('https://collect.wetransfer.com')
    expect(collectHeaders.get('x-signature')).toBe('1b24adbf8359e427ceaf4c0dcdee43d631355131fad534bdf3a9bac160a71')
  })

  it('recognizes retired Portals links while rejecting malformed or cross-provider WeTransfer inputs', async () => {
    expect(parseWetransferTarget('reviews/review-id?item=item-id')).toEqual({
      kind: 'portals',
      reviewId: 'review-id',
      itemId: 'item-id',
      referer: 'https://portals.wetransfer.com/reviews/review-id?item=item-id'
    })
    await expect(new WetransferExtractor(
      'reviews/review-id?item=item-id',
      new FixtureHttpClient([])
    ).getSources()).resolves.toEqual([])
    await expect(new WetransferExtractor(
      'https://attacker.test/downloads/transfer-id/security-hash',
      new FixtureHttpClient([])
    ).getSources()).resolves.toEqual([])
    await expect(new WetransferExtractor('../unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
  })

  it('ports FileMoon metadata, proof verification, AES-GCM playback, captions, and timesliders', async () => {
    const playback = encryptedFilemoonPlayback({
      sources: [
        { url: 'https://cdn.filemoon.test/master.m3u8?token=fixture', mime_type: 'application/vnd.apple.mpegurl', label: '1080p' },
        { url: 'https://cdn.filemoon.test/movie.mp4', mime_type: 'video/mp4', height: 720 }
      ],
      tracks: [{ url: 'https://cdn.filemoon.test/en.vtt', language: 'en', title: 'English', kind: 'captions', default: true }],
      poster_url: 'https://img-place.com/filemoon123_live.jpg'
    })
    const http = new FixtureHttpClient([
      response(JSON.stringify({
        code: 'filemoon123',
        title: 'FileMoon fixture',
        poster_url: 'https://img-place.com/filemoon123_xt.jpg',
        embed_frame_url: 'https://q8y5z.com/embed-key/filemoon123'
      }), new Headers({ 'content-type': 'application/json' }), 'https://filemoon.to/api/videos/filemoon123/embed/details'),
      response(JSON.stringify({ captcha_required: true }), new Headers({ 'content-type': 'application/json' }), 'https://q8y5z.com/api/videos/filemoon123/embed/settings'),
      response(JSON.stringify({
        challenge_id: 'device-challenge', nonce: 'device-nonce'
      }), new Headers({ 'content-type': 'application/json' }), 'https://q8y5z.com/api/videos/access/challenge'),
      response(JSON.stringify({
        token: 'device-token', viewer_id: 'viewer-id', device_id: 'device-id', confidence: 0.35
      }), new Headers({ 'content-type': 'application/json' }), 'https://q8y5z.com/api/videos/access/attest'),
      response(JSON.stringify({
        pow_nonce: 'nonce', pow_difficulty: 12, pow_token: 'proof-token', expires_in: 1800
      }), new Headers({ 'content-type': 'application/json' }), 'https://q8y5z.com/api/videos/filemoon123/embed/captcha'),
      response(JSON.stringify({ status: 'ok', token: 'captcha-token' }), new Headers({ 'content-type': 'application/json' }), 'https://q8y5z.com/api/videos/filemoon123/embed/captcha/verify'),
      response(JSON.stringify({ playback }), new Headers({ 'content-type': 'application/json' }), 'https://q8y5z.com/api/videos/filemoon123/embed/playback')
    ])
    const extractor = new FilemoonExtractor('filemoon123', http, {
      solveProof: async (nonce, difficulty) => nonce === 'nonce' && difficulty === 12 ? '42' : null
    })

    await expect(extractor.getSources()).resolves.toEqual([
      { file: 'https://cdn.filemoon.test/master.m3u8?token=fixture', type: 'hls', label: '1080p' },
      { file: 'https://cdn.filemoon.test/movie.mp4', type: 'video/mp4', label: '720p' }
    ])
    await expect(extractor.getTracks()).resolves.toEqual([{
      file: 'https://cdn.filemoon.test/en.vtt', label: 'English', kind: 'captions', default: true
    }])
    expect(extractor.getTitle()).toBe('FileMoon fixture')
    expect(extractor.getImage()).toBe('https://img-place.com/filemoon123_live.jpg')
    expect(extractor.getReferer()).toBe('https://q8y5z.com/embed-key/filemoon123')
    expect(extractor.getFilmstrip()).toBe('https://q8y5z.com/api/videos/filemoon123/embed/timeslider')
    expect(http.methods).toEqual(['GET', 'GET', 'POST', 'POST', 'POST', 'POST', 'POST'])
    const attestation = JSON.parse(String((http.requests[3] as ProviderHttpPostRequest).body))
    expect(attestation).toMatchObject({
      viewer_id: '', device_id: '', challenge_id: 'device-challenge', nonce: 'device-nonce',
      client: { user_agent: expect.stringContaining('GPlayer/0.1 Node.js/') },
      storage: {}, attributes: { entropy: 'low' }
    })
    const publicKey = await webcrypto.subtle.importKey(
      'jwk', attestation.public_key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
    )
    await expect(webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      Uint8Array.from(Buffer.from(attestation.signature, 'base64url')),
      new TextEncoder().encode('device-nonce')
    )).resolves.toBe(true)
    expect(JSON.parse(String((http.requests[5] as ProviderHttpPostRequest).body))).toEqual({
      pow_token: 'proof-token',
      solution: '42',
      fingerprint: { token: 'device-token', viewer_id: 'viewer-id', device_id: 'device-id', confidence: 0.35 }
    })
    expect(new Headers(http.requests[6]?.headers).get('x-captcha-token')).toBe('captcha-token')
    expect(new Headers(http.requests[6]?.headers).get('x-embed-parent')).toBe('https://filemoon.to/e/filemoon123')
    expect(JSON.parse(String((http.requests[6] as ProviderHttpPostRequest).body))).toEqual({
      fingerprint: { token: 'device-token', viewer_id: 'viewer-id', device_id: 'device-id', confidence: 0.35 }
    })
  })

  it('implements FileMoon playback decryption and the current memory-hard proof protocol', async () => {
    const envelope = encryptedFilemoonPlayback({ sources: [{ url: 'https://cdn.test/live.m3u8' }] })
    await expect(decryptFilemoonPlayback(envelope)).resolves.toEqual({
      sources: [{ url: 'https://cdn.test/live.m3u8' }]
    })
    expect(filemoonProofLeadingZeroBits('fixture-nonce:0')).toBe(2)
    const solution = await solveFilemoonProof('fixture-nonce', 4, 5_000)
    expect(solution).not.toBeNull()
    expect(filemoonProofLeadingZeroBits(`fixture-nonce:${solution}`)).toBeGreaterThanOrEqual(4)
  })

  it('rejects unsafe FileMoon identities, embed origins, media, and encrypted payloads', async () => {
    await expect(new FilemoonExtractor('../unsafe', new FixtureHttpClient([])).getSources()).resolves.toEqual([])
    const unsafeEmbed = new FilemoonExtractor('safe-code', new FixtureHttpClient([
      response(JSON.stringify({
        title: 'Unsafe', embed_frame_url: 'https://attacker.test/e/safe-code'
      }), new Headers(), 'https://filemoon.to/api/videos/safe-code/embed/details')
    ]))
    await expect(unsafeEmbed.getSources()).resolves.toEqual([])
    await expect(decryptFilemoonPlayback({
      version: '1', key_parts: ['bad'], iv: 'bad', payload: 'bad'
    })).resolves.toBeNull()
  })
})

function encryptedFilemoonPlayback(payload: unknown): Record<string, unknown> {
  const firstHalf = Buffer.from('0123456789abcdef')
  const secondHalf = Buffer.from('fedcba9876543210')
  const key = Buffer.concat([firstHalf, secondHalf])
  const iv = Buffer.from('fixture-iv12')
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()])
  const keyParts = Array.from({ length: 30 }, () => Buffer.from('x').toString('base64url'))
  keyParts[0] = firstHalf.toString('base64url')
  keyParts[29] = secondHalf.toString('base64url')
  return {
    version: '1',
    key_parts: keyParts,
    iv: iv.toString('base64url'),
    payload: encrypted.toString('base64url')
  }
}

function encodedVoePayload(payload: unknown): string {
  const inner = Buffer.from(JSON.stringify(payload), 'latin1').toString('base64')
  const reversed = [...inner].reverse().join('')
  const shifted = Array.from(reversed, (character) => String.fromCharCode(character.charCodeAt(0) + 3)).join('')
  const outer = Buffer.from(shifted, 'latin1').toString('base64')
  const markers = ['@$', '^^', '~@', '%?', '*~', '!!', '#&']
  const chunks = outer.match(/.{1,24}/g) ?? []
  const marked = chunks.map((chunk, index) => `${chunk}${index === chunks.length - 1 ? '' : markers[index % markers.length]}`).join('')
  return marked.replace(/[A-Za-z]/g, (character) => {
    const base = character <= 'Z' ? 65 : 97
    return String.fromCharCode(base + (character.charCodeAt(0) - base + 13) % 26)
  })
}

function jsonResponse(body: unknown): ProviderHttpResponse {
  return response(JSON.stringify(body), new Headers({ 'content-type': 'application/json' }))
}

function bloggerRpcFixture(payload: unknown): string {
  return `)]}'\n\n123\n${JSON.stringify([['wrb.fr', 'WcwnYd', JSON.stringify(payload), null, null, null, 'generic']])}`
}

function response(
  body: string,
  headers = new Headers(),
  url: string | URL = new URL('https://provider.example.test/fixture')
): ProviderHttpResponse {
  return {
    url: new URL(url),
    status: 200,
    headers,
    body
  }
}
