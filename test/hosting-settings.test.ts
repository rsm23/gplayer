import { describe, expect, it } from 'vitest'
import { ExtractorFactory } from '../src/hosting/extractor-factory.js'
import type { ProviderHttpClient, ProviderHttpPostRequest, ProviderHttpRequest, ProviderHttpResponse } from '../src/hosting/provider-http.js'
import { renderDownloadPage } from '../src/player/download-page.js'
import { PlayerLinkGenerator } from '../src/player/link-generator.js'
import { Security } from '../src/security/security.js'
import { ProviderCookieHttpClient, loadRuntimeHostingSettings } from '../src/settings/hosting-runtime.js'
import { hostingSettings, parseHostingSettingsSubmission, runtimeHostingSettings } from '../src/settings/hosting-settings.js'

const supportedHosts = new Set(new ExtractorFactory().supportedHosts())

class CaptureHttpClient implements ProviderHttpClient {
  public readonly requests: Array<ProviderHttpRequest & Readonly<{ method: string }>> = []

  public async get(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    return await this.capture('GET', request)
  }

  public async head(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    return await this.capture('HEAD', request)
  }

  public async post(request: ProviderHttpPostRequest): Promise<ProviderHttpResponse> {
    return await this.capture('POST', request)
  }

  private async capture(method: string, request: ProviderHttpPostRequest): Promise<ProviderHttpResponse> {
    this.requests.push(Object.freeze({ ...request, method }))
    return Object.freeze({ url: new URL(request.url), status: 200, headers: new Headers(), body: '' })
  }
}

describe('Hosting Settings compatibility contract', () => {
  it('builds one sorted provider record for every registered extractor', () => {
    const values = hostingSettings({}, supportedHosts)
    expect(values.providers).toHaveLength(69)
    expect(values.providers.map(({ host }) => host)).toContain('direct')
    expect(values.providers.find(({ host }) => host === 'gdrive')).toEqual(expect.objectContaining({
      label: 'Google Drive',
      cookieConfigured: false,
      downloadUrl: 'https://drive.google.com/file/d/%s/view'
    }))
  })

  it('loads safe overrides while keeping cookie values out of the administrator model', () => {
    const raw = {
      'custom-hostnames': JSON.stringify({ youtube: ['video.private.example'] }),
      'download-urls': JSON.stringify({ youtube: 'https://watch.example/%s' }),
      custom_names: JSON.stringify({ youtube: 'Primary video' }),
      cookie_youtube: 'SID=server-secret; PREF=private'
    }
    const admin = hostingSettings(raw, supportedHosts)
    const youtube = admin.providers.find(({ host }) => host === 'youtube')
    expect(youtube).toEqual(expect.objectContaining({
      cookieConfigured: true,
      customHostnames: 'video.private.example',
      downloadUrl: 'https://watch.example/%s',
      customName: 'Primary video'
    }))
    expect(JSON.stringify(admin)).not.toContain('server-secret')
    expect(runtimeHostingSettings(raw, supportedHosts).cookies.youtube).toBe('SID=server-secret; PREF=private')
  })

  it('serializes exact legacy map keys and write-only provider cookies', () => {
    const result = parseHostingSettingsSubmission({
      'custom-hostnames[youtube]': 'video.private.example\nmedia.private.example',
      'download-urls[youtube]': 'https://watch.example/video/%s',
      'custom_names[youtube]': 'Primary video',
      cookie_youtube: 'SID=new-secret; PREF=hd',
      attacker: 'ignored'
    }, { cookie_youtube: 'SID=old-secret' }, supportedHosts)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(Object.fromEntries(result.entries.map(({ key, value }) => [key, value]))).toEqual({
      'custom-hostnames': JSON.stringify({ youtube: ['video.private.example', 'media.private.example'] }),
      'download-urls': JSON.stringify({ youtube: 'https://watch.example/video/%s' }),
      custom_names: JSON.stringify({ youtube: 'Primary video' }),
      cookie_youtube: 'SID=new-secret; PREF=hd'
    })
  })

  it('preserves blank cookies, supports explicit removal, and rejects ambiguous replacement', () => {
    const raw = { cookie_youtube: 'SID=stored' }
    const preserved = parseHostingSettingsSubmission({
      'download-urls[youtube]': 'https://watch.example/%s',
      cookie_youtube: ''
    }, raw, supportedHosts)
    expect(preserved.status).toBe('ok')
    if (preserved.status === 'ok') expect(preserved.entries.map(({ key }) => key)).not.toContain('cookie_youtube')

    const cleared = parseHostingSettingsSubmission({ clear_cookie_youtube: 'true' }, raw, supportedHosts)
    expect(cleared).toEqual({ status: 'ok', entries: [{ key: 'cookie_youtube', value: '' }] })
    expect(parseHostingSettingsSubmission({ cookie_youtube: 'SID=new', clear_cookie_youtube: 'true' }, raw, supportedHosts)).toEqual({
      status: 'invalid',
      message: 'Choose either a replacement Youtube cookie or clear the stored cookie'
    })
  })

  it('atomically rejects unknown hosts, unsafe cookies, domains, and URL templates', () => {
    expect(parseHostingSettingsSubmission({ 'custom_names[unknown]': 'Server' }, {}, supportedHosts).status).toBe('invalid')
    expect(parseHostingSettingsSubmission({ cookie_youtube: 'SID=value\r\nX-Injected: yes' }, {}, supportedHosts).status).toBe('invalid')
    expect(parseHostingSettingsSubmission({ 'custom-hostnames[youtube]': 'https://video.example/path' }, {}, supportedHosts).status).toBe('invalid')
    expect(parseHostingSettingsSubmission({ 'download-urls[youtube]': 'https://watch.example/no-placeholder' }, {}, supportedHosts).status).toBe('invalid')
    expect(parseHostingSettingsSubmission({ 'download-urls[youtube]': 'https://watch.example/%s/%s' }, {}, supportedHosts).status).toBe('invalid')
  })

  it('uses configured domains and templates in generated and rendered links', () => {
    const runtime = runtimeHostingSettings({
      'custom-hostnames': JSON.stringify({ youtube: ['video.private.example'] }),
      'download-urls': JSON.stringify({ youtube: 'https://watch.example/video/%s' }),
      custom_names: JSON.stringify({ youtube: 'Primary video' })
    }, supportedHosts)
    const generated = new PlayerLinkGenerator(new Security('1234567890123456'), {
      baseUrl: new URL('https://player.example/'),
      embedSlug: 'e',
      downloadSlug: 'd',
      requestSlug: 'r',
      hostingData: runtime.data
    }).generate({ id: 'https://video.private.example/watch?v=custom-id' })
    expect(generated.query).toEqual(expect.objectContaining({ host: 'youtube', id: 'custom-id' }))

    const page = renderDownloadPage({ host: 'youtube', id: 'custom-id' }, {
      embedUrl: '/e/token',
      hostingData: runtime.data,
      customNames: runtime.customNames
    })
    expect(page).toContain('href="https://watch.example/video/custom-id"')
    expect(page).toContain('Primary video source recognized')
  })

  it('merges a provider cookie with extractor cookies and lets the fresh request value win', async () => {
    const capture = new CaptureHttpClient()
    const runtime = runtimeHostingSettings({ cookie_dood: 'session=configured; preference=dark' }, supportedHosts)
    const client = new ProviderCookieHttpClient('dood', capture, async () => runtime)
    await client.get({ url: 'https://dood.example/embed', headers: { cookie: 'session=fresh; token=request' } })
    expect(new Headers(capture.requests[0]?.headers).get('cookie')).toBe('session=fresh; preference=dark; token=request')
  })

  it('does not attach one provider cookie to another provider client', async () => {
    const capture = new CaptureHttpClient()
    const runtime = runtimeHostingSettings({ cookie_dood: 'session=dood-only' }, supportedHosts)
    const client = new ProviderCookieHttpClient('youtube', capture, async () => runtime)
    await client.head({ url: 'https://youtube.example/watch' })
    expect(new Headers(capture.requests[0]?.headers).has('cookie')).toBe(false)
  })

  it('falls back to bundled settings when the runtime loader fails', async () => {
    const runtime = await loadRuntimeHostingSettings(async () => { throw new Error('database down') }, supportedHosts)
    expect(runtime.data.downloadUrls.gdrive).toBe('https://drive.google.com/file/d/%s/view')
    expect(runtime.cookies).toEqual({})
  })
})
