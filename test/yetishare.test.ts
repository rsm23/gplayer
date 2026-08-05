import { describe, expect, it } from 'vitest'
import type { ProviderHttpClient, ProviderHttpPostRequest, ProviderHttpRequest, ProviderHttpResponse } from '../src/hosting/provider-http.js'
import { parseYetiSharePage, YetiShareExtractor } from '../src/hosting/yetishare.js'

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

describe('shared YetiShare compatibility parser', () => {
  it('extracts HTML5 media, captions, poster, and title with relative URL resolution', () => {
    const output = parseYetiSharePage(`
      <meta property="og:title" content="Public &amp; safe title">
      <video poster="/thumbs/poster.jpg">
        <source src="//cdn.example.test/master.m3u8" type="application/x-mpegURL" data-res="Auto">
        <source src="media/720.mp4" type="video/mp4" label="720p">
        <track src="/captions/en.vtt" srclang="en" label="English">
      </video>
    `, 'https://files.example.test/abc123')

    expect(output.sources).toEqual([
      { file: 'https://cdn.example.test/master.m3u8', type: 'hls', label: 'Auto' },
      { file: 'https://files.example.test/media/720.mp4', type: 'video/mp4', label: '720p' }
    ])
    expect(output.tracks).toEqual([{
      file: 'https://files.example.test/captions/en.vtt', label: 'English', kind: 'captions'
    }])
    expect(output.image).toBe('https://files.example.test/thumbs/poster.jpg')
    expect(output.title).toBe('Public & safe title')
  })

  it('reads static player source arrays and explicit direct-download links without executing scripts', () => {
    const output = parseYetiSharePage(`
      <script>
        const player = {sources: [
          {src: "https:\/\/cdn.example.test\/manifest.mpd", type: "application/dash+xml", label: "DASH"},
          {file: "https://cdn.example.test/video.mp4", height: "1080p"}
        ]};
      </script>
      <a class="download-file" href="https://cdn.example.test/backup.webm?download_token=token">Download</a>
      <h1>Fixture file.mp4</h1>
    `, 'https://files.example.test/id')

    expect(output.sources).toEqual([
      { file: 'https://cdn.example.test/manifest.mpd', type: 'mpd', label: 'DASH' },
      { file: 'https://cdn.example.test/video.mp4', type: 'video/mp4', label: '1080p' },
      { file: 'https://cdn.example.test/backup.webm?download_token=token', type: 'video/mp4', label: 'Original' }
    ])
    expect(output.title).toBe('Fixture file.mp4')
  })

  it('loads the visible provider page contract and retains only cookie name/value pairs', async () => {
    const headers = new Headers()
    headers.append('set-cookie', 'filehosting=session-token; Path=/; Secure; HttpOnly')
    const http = new FixtureHttpClient([response(`
      <meta property="og:video" content="https://cdn.example.test/video.mp4">
      <meta property="og:image" content="https://cdn.example.test/poster.jpg">
      <title>Provider title</title>
    `, headers, 'https://files.example.test/final-id')])
    const extractor = new YetiShareExtractor('video-id', http, {
      pageUrl: (id) => `https://files.example.test/${id}`
    })

    await expect(extractor.getSources()).resolves.toEqual([{
      file: 'https://cdn.example.test/video.mp4', type: 'video/mp4', label: 'Original'
    }])
    expect(extractor.getTitle()).toBe('Provider title')
    expect(extractor.getImage()).toBe('https://cdn.example.test/poster.jpg')
    expect(extractor.getReferer()).toBe('https://files.example.test/final-id')
    expect(extractor.getCookies()).toEqual(['filehosting=session-token'])
    expect(http.requests).toEqual([{
      url: new URL('https://files.example.test/video-id'),
      headers: { referer: 'https://files.example.test' }
    }])
  })

  it('rejects executable, credential-bearing, and intermediate countdown links', () => {
    const output = parseYetiSharePage(`
      <video src="javascript:alert(1)"></video>
      <source src="https://user:secret@cdn.example.test/video.mp4">
      <a class="download-page-bottom-download-btn" href="/video-id?d=1">Continue</a>
      <a download href="data:text/html,unsafe">Unsafe</a>
    `, 'https://files.example.test/video-id')

    expect(output.sources).toEqual([])
  })
})

function response(body: string, headers = new Headers(), url = 'https://files.example.test/fixture'): ProviderHttpResponse {
  return { url: new URL(url), status: 200, headers, body }
}
