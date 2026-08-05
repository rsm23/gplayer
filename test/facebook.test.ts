import { describe, expect, it } from 'vitest'
import { FacebookExtractor, parseFacebookPage } from '../src/hosting/facebook.js'
import type { ProviderHttpClient, ProviderHttpPostRequest, ProviderHttpRequest, ProviderHttpResponse } from '../src/hosting/provider-http.js'

class FixtureHttpClient implements ProviderHttpClient {
  public readonly requests: ProviderHttpRequest[] = []
  public constructor(private readonly responses: ProviderHttpResponse[]) {}
  public async get(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('Unexpected provider request')
    return response
  }
  public async head(_request: ProviderHttpRequest): Promise<ProviderHttpResponse> { throw new Error('Unexpected HEAD') }
  public async post(_request: ProviderHttpPostRequest): Promise<ProviderHttpResponse> { throw new Error('Unexpected POST') }
}

function response(body: string, url = 'https://www.facebook.com/example/videos/123'): ProviderHttpResponse {
  return { body, url: new URL(url), status: 200, headers: new Headers({ 'content-type': 'text/html' }) }
}

describe('Facebook extractor', () => {
  it('parses current and legacy source aliases without executing page scripts', () => {
    const parsed = parseFacebookPage(`<html><head>
      <meta property="og:title" content="Fixture &amp; demo | Facebook">
      <meta name="twitter:image" content="https://scontent.example.fbcdn.net/poster.jpg?a=1&amp;b=2">
      </head><script>VideoConfig = {"videoData":[{
        "dash_manifest_url":"https:\/\/video.example.fbcdn.net\/master.mpd?token=dash",
        "hd_src":"https:\/\/video.example.fbcdn.net\/hd.mp4?sig=abc\\u00253D",
        "sd_src":"https:\/\/video.example.fbcdn.net\/sd.mp4",
        "captions_url":"https:\/\/video.example.fbcdn.net\/captions.vtt"
      }]}; globalThis.pwned = true</script></html>`)

    expect(parsed).toEqual({
      sources: [
        { file: 'https://video.example.fbcdn.net/master.mpd?token=dash', type: 'mpd', label: 'Original' },
        { file: 'https://video.example.fbcdn.net/hd.mp4?sig=abc%3D', type: 'video/mp4', label: 'HD' },
        { file: 'https://video.example.fbcdn.net/sd.mp4', type: 'video/mp4', label: 'SD' }
      ],
      tracks: [{ file: 'https://video.example.fbcdn.net/captions.vtt', label: 'Default', kind: 'captions' }],
      title: 'Fixture & demo',
      image: 'https://scontent.example.fbcdn.net/poster.jpg?a=1&b=2'
    })
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined()
  })

  it('uses the public plugin VideoConfig when the normal page only has metadata', async () => {
    const http = new FixtureHttpClient([
      response(`<meta name="twitter:title" content="Public clip | Facebook">
        <meta name="twitter:image" content="https://scontent.example.fbcdn.net/poster.jpg">`),
      response(`<script>VideoConfig={"videoData":[{
        "hd_src":"https:\/\/video.example.fbcdn.net\/hd.mp4",
        "sd_src":"https:\/\/video.example.fbcdn.net\/sd.mp4"
      }]}</script>`, 'https://www.facebook.com/plugins/video.php?fixture')
    ])
    const extractor = new FacebookExtractor('example/videos/123', http)

    await expect(extractor.getSources()).resolves.toEqual([
      { file: 'https://video.example.fbcdn.net/hd.mp4', type: 'video/mp4', label: 'HD' },
      { file: 'https://video.example.fbcdn.net/sd.mp4', type: 'video/mp4', label: 'SD' }
    ])
    expect(extractor.getTitle()).toBe('Public clip')
    expect(extractor.getImage()).toBe('https://scontent.example.fbcdn.net/poster.jpg')
    expect(extractor.getReferer()).toBe('https://www.facebook.com/')
    expect(http.requests.map((request) => String(request.url))).toEqual([
      'https://www.facebook.com/example/videos/123',
      'https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fexample%2Fvideos%2F123&show_text=0&width=560'
    ])
  })

  it('rejects unsafe identifiers, redirects, assets, and upstream failures', async () => {
    const unused = new FixtureHttpClient([])
    await expect(new FacebookExtractor('../admin', unused).getSources()).resolves.toEqual([])
    expect(unused.requests).toEqual([])

    const redirect = new FacebookExtractor('example/videos/123', new FixtureHttpClient([
      response('"hd_src":"https:\/\/video.example.fbcdn.net\/hd.mp4"', 'https://attacker.test/')
    ]))
    await expect(redirect.getSources()).resolves.toEqual([])

    expect(parseFacebookPage(`
      "hd_src":"https:\/\/attacker.test\/video.mp4",
      "sd_src":"https:\/\/user:secret@video.example.fbcdn.net\/video.mp4",
      <meta property="og:image" content="javascript:alert(1)">
    `).sources).toEqual([])
  })
})
