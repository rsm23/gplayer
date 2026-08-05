import path from 'node:path'
import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'
import { parseXFileSharingPage } from './xfile-sharing.js'

export type DirectProbeResult = Readonly<{
  status: number
  contentType?: string
  bodyPrefix?: string
  finalUrl?: string
  networkInterface?: string
}>

export type DirectProbe = (url: URL) => Promise<DirectProbeResult>

export function createDirectProbe(http: ProviderHttpClient): DirectProbe {
  return async (url) => {
    const head = await http.head({ url })
    const headContentType = head.headers.get('content-type') ?? ''
    if (head.status < 200 || head.status >= 400 || typeFromContentType(headContentType) !== null) {
      return {
        status: head.status,
        contentType: headContentType,
        finalUrl: head.url.toString()
      }
    }

    const response = await http.get({ url: head.url })
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? headContentType,
      bodyPrefix: response.body,
      finalUrl: response.url.toString()
    }
  }
}

export class DirectExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly probe?: DirectProbe) {
    super(id.replaceAll('&amp;', '&'))
    const url = parseHttpUrl(this.id)
    this.title = url === null ? '' : path.posix.basename(url.pathname)
  }

  public override async getSources() {
    if (this.#loaded) return this.sources
    this.#loaded = true

    const original = parseHttpUrl(this.id)
    if (original === null) return this.sources
    const extensionType = typeFromExtension(this.title)
    if (extensionType !== null) {
      this.sources.push({ file: original.toString(), type: extensionType, label: 'Original' })
      return this.sources
    }
    if (this.probe === undefined) return this.sources

    let response: DirectProbeResult
    try {
      response = await this.probe(original)
    } catch {
      return this.sources
    }
    if (response.status < 200 || response.status >= 400) return this.sources
    this.networkInterface = response.networkInterface ?? ''
    const finalUrl = response.finalUrl === undefined ? original : parseHttpUrl(response.finalUrl) ?? original
    const body = response.bodyPrefix ?? ''
    const type = typeFromContentType(response.contentType ?? '') ?? typeFromBody(body)
    if (type !== null) {
      this.sources.push({ file: finalUrl.toString(), type, label: 'Original' })
      return this.sources
    }

    // Xvs in 4.8.3 is an internal XVFSParser subclass reached only here. Parse
    // the already-fetched, bounded response statically; never execute page JS.
    this.sources.push(...parseXFileSharingPage(body).sources)
    return this.sources
  }
}

export function typeFromContentType(contentType: string): 'hls' | 'mpd' | 'video/mp4' | null {
  const normalized = contentType.toLowerCase()
  if (normalized.includes('mpegurl')) return 'hls'
  if (normalized.includes('dash')) return 'mpd'
  if (normalized.includes('video') || normalized.includes('audio') || normalized.includes('octet')) {
    return 'video/mp4'
  }
  return null
}

function typeFromExtension(filename: string): 'hls' | 'mpd' | 'video/mp4' | null {
  const extension = path.posix.extname(filename).slice(1)
  if (extension === 'm3u8') return 'hls'
  if (extension === 'mpd') return 'mpd'
  if (extension === 'mp4' || extension === 'mkv') return 'video/mp4'
  return null
}

function typeFromBody(body: string): 'hls' | 'mpd' | null {
  // 4.8.3 checks #M3U; accept the standard #EXTM3U marker as well.
  if (body.includes('#M3U') || body.includes('#EXTM3U')) return 'hls'
  if (body.includes('<MPD')) return 'mpd'
  return null
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}
