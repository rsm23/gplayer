import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const GOOGLE_PHOTOS_ORIGIN = 'https://photos.google.com/'
const GOOGLE_PHOTOS_SHORT_ORIGIN = 'https://photos.app.goo.gl/'
const GOOGLE_PHOTOS_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const GOOGLE_PHOTOS_HLS_SUFFIX = '=mm,hls'

const GOOGLE_PHOTOS_VARIANTS = Object.freeze([
  ['m18', '360p'],
  ['m22', '720p'],
  ['m37', '1080p']
] as const)

export type GooglePhotosPage = Readonly<{
  mediaBase: string
  image: string
}>

export class GooglePhotosExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim().replace(/^\/+/, ''))
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    const pageUrl = googlePhotosPageUrl(this.id)
    if (pageUrl === null) return
    if (this.downloadable) this.referer = 'https://youtube.googleapis.com/'

    try {
      const response = await this.http.get({ url: pageUrl })
      if (response.status < 200 || response.status >= 300 || !isGooglePhotosUrl(response.url)) return
      const page = parseGooglePhotosPage(response.body)
      if (page === null || !isGoogleMediaBase(page.mediaBase)) return
      this.image = page.image

      if (this.hlsMode && !this.downloadable) {
        const hls = `${page.mediaBase}${GOOGLE_PHOTOS_HLS_SUFFIX}`
        try {
          const manifest = await this.http.get({ url: hls, headers: { 'user-agent': GOOGLE_PHOTOS_USER_AGENT } })
          if (manifest.status >= 200 && manifest.status < 300 && isGoogleHlsUrl(manifest.url) && isHlsManifest(manifest.body)) {
            this.sources.push({ file: hls, type: 'hls', label: 'Original' })
            return
          }
        } catch {
          // HLS is a preference; unavailable manifests fall through to the MP4 rendition probes.
        }
      }

      for (const [format, label] of GOOGLE_PHOTOS_VARIANTS) {
        const file = `${page.mediaBase}=${format}`
        const probe = await this.http.head({ url: file, headers: { 'user-agent': GOOGLE_PHOTOS_USER_AGENT } })
        if (probe.status < 200 || probe.status >= 400 || probe.url.toString() === file) continue
        this.sources.push({ file, type: 'video/mp4', label })
      }
    } catch {
      // Invalid or unavailable provider responses produce an empty result.
    }
  }
}

export function parseGooglePhotosPage(input: string): GooglePhotosPage | null {
  const video = metaValue(input, 'og:video') || attributeValue(input, 'data-url')
  if (video === '') return null
  const mediaBase = video.split('=', 1)[0]?.trim() ?? ''
  if (!isGoogleMediaBase(mediaBase)) return null
  return Object.freeze({
    mediaBase,
    image: `${mediaBase}=s1024-k-rw-no`
  })
}

function googlePhotosPageUrl(id: string): URL | null {
  try {
    if (/^(?:share\/)?[A-Za-z0-9_-]{1,512}\?key=[A-Za-z0-9_-]{1,512}$/.test(id)) {
      return new URL(id.startsWith('share/') ? id : `share/${id}`, GOOGLE_PHOTOS_ORIGIN)
    }
    if (/^[A-Za-z0-9_-]{1,512}$/.test(id)) return new URL(id, GOOGLE_PHOTOS_SHORT_ORIGIN)
    return null
  } catch {
    return null
  }
}

function metaValue(input: string, property: string): string {
  const escaped = escapeRegExp(property)
  const patterns = [
    new RegExp(`<meta\\b(?=[^>]*\\bproperty=["']${escaped}["'])[^>]*\\bcontent=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta\\b(?=[^>]*\\bcontent=["']([^"']*)["'])[^>]*\\bproperty=["']${escaped}["'][^>]*>`, 'i')
  ]
  for (const pattern of patterns) {
    const value = pattern.exec(input)?.[1]
    if (value !== undefined) return decodeHtml(value.trim())
  }
  return ''
}

function attributeValue(input: string, name: string): string {
  const value = new RegExp(`\\b${escapeRegExp(name)}=["']([^"']*)["']`, 'i').exec(input)?.[1]
  return value === undefined ? '' : decodeHtml(value.trim())
}

function isGooglePhotosUrl(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && (
    url.hostname === 'photos.google.com' || url.hostname === 'photos.app.goo.gl'
  )
}

function isGoogleMediaBase(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password &&
      (url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com')) &&
      url.pathname.length > 1
  } catch {
    return false
  }
}

function isGoogleHlsUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase()
  return url.protocol === 'https:' && !url.username && !url.password && (
    hostname === 'googleusercontent.com' || hostname.endsWith('.googleusercontent.com') ||
    hostname === 'googlevideo.com' || hostname.endsWith('.googlevideo.com')
  )
}

function isHlsManifest(value: string): boolean {
  return value.trimStart().startsWith('#EXTM3U')
}

function decodeHtml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
