import { runInNewContext } from 'node:vm'
import { Innertube, Platform } from 'youtubei.js'
import { BaseExtractor } from './base-extractor.js'
import type { RuntimeProxySettings } from '../settings/misc-settings.js'
import { RemoteStream } from '../stream/remote-stream.js'

const YOUTUBE_REFERER = 'https://www.youtube.com/'
const GOOGLE_API_REFERER = 'https://youtube.googleapis.com/'
const MAX_PLAYER_SCRIPT_BYTES = 2 * 1_024 * 1_024

export type YoutubeVideo = Readonly<{
  title: string
  image: string
  hlsManifestUrl: string
  formats: readonly Readonly<{ url: string, itag: number, label: string }>[]
  captions: readonly Readonly<{ url: string, label: string, language: string }>[]
}>

export interface YoutubeClient {
  getVideo(id: string): Promise<YoutubeVideo>
}

type YoutubeEvaluation = typeof Platform.shim.eval

/**
 * YouTube.js emits only the player functions needed for signature and nsig
 * transforms. Run that reduced script in an isolated context with no Node
 * globals, no dynamic code generation, and a short CPU deadline.
 */
export const evaluateYoutubePlayerScript: YoutubeEvaluation = (data, environment) => {
  if (Buffer.byteLength(data.output, 'utf8') > MAX_PLAYER_SCRIPT_BYTES) {
    throw new Error('YouTube player transform exceeds the evaluation limit')
  }
  const sandbox = Object.assign(Object.create(null) as Record<string, unknown>, environment)
  return runInNewContext(`(function () {\n${data.output}\n})()`, sandbox, {
    timeout: 500,
    contextCodeGeneration: { strings: false, wasm: false }
  }) as ReturnType<YoutubeEvaluation>
}

// YouTube.js intentionally leaves the interpreter boundary to its consumer.
// Configure it once for every Innertube session created in this process.
Platform.shim.eval = evaluateYoutubePlayerScript

export class YoutubeInnertubeClient implements YoutubeClient {
  #session: Promise<Innertube> | undefined
  #sessionCookie = ''

  public constructor(
    private readonly loadCookie?: () => Promise<string>,
    private readonly fetchImplementation?: typeof fetch
  ) {}

  public async getVideo(id: string): Promise<YoutubeVideo> {
    const session = await this.session()
    const info = await session.getBasicInfo(id)
    const streaming = info.streaming_data
    const formats = await Promise.all((streaming?.formats ?? []).map(async (format) => {
      if (!format.mime_type.toLowerCase().startsWith('video/mp4')) return null
      try {
        const url = await format.decipher(session.session.player)
        if (!isYoutubeMediaUrl(url)) return null
        return {
          url,
          itag: format.itag,
          label: format.quality_label || googleVideoLabel(format.itag)
        }
      } catch {
        return null
      }
    }))

    const captions = (info.captions?.caption_tracks ?? []).flatMap((caption) => {
      if (!isYoutubeCaptionUrl(caption.base_url)) return []
      return [{
        url: caption.base_url,
        label: caption.name.toString(),
        language: caption.language_code
      }]
    })
    const thumbnails = info.basic_info.thumbnail ?? []
    const image = [...thumbnails]
      .sort((left, right) => (right.width * right.height) - (left.width * left.height))
      .map((thumbnail) => thumbnail.url)
      .find(isYoutubeImageUrl) ?? `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`
    const hlsManifestUrl = isYoutubeMediaUrl(streaming?.hls_manifest_url ?? '')
      ? streaming?.hls_manifest_url ?? ''
      : ''

    return Object.freeze({
      title: info.basic_info.title ?? '',
      image,
      hlsManifestUrl,
      formats: formats.filter((format): format is NonNullable<typeof format> => format !== null),
      captions
    })
  }

  private async session(): Promise<Innertube> {
    const cookie = await this.configuredCookie()
    if (this.#session === undefined || cookie !== this.#sessionCookie) {
      this.#sessionCookie = cookie
      this.#session = Innertube.create({
        retrieve_player: true,
        ...(cookie === '' ? {} : { cookie }),
        ...(this.fetchImplementation === undefined ? {} : { fetch: this.fetchImplementation })
      })
    }
    try {
      return await this.#session
    } catch (error) {
      // A transient session bootstrap failure must not poison the long-running
      // factory singleton for every later request.
      this.#session = undefined
      throw error
    }
  }

  private async configuredCookie(): Promise<string> {
    if (this.loadCookie === undefined) return ''
    try {
      return await this.loadCookie()
    } catch {
      return ''
    }
  }
}

/** Direct YouTube transport with the supplied non-404 proxy fallback semantics. */
export function createYoutubeProxyFetch(
  loadSettings: () => Promise<RuntimeProxySettings>,
  remoteStream: Pick<RemoteStream, 'open'> = new RemoteStream(),
  directFetch: typeof fetch = fetch,
  random: () => number = Math.random
): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const target = new URL(request.url)
    if (!isYoutubeRequestUrl(target)) throw new Error(`YouTube transport rejected host: ${target.hostname}`)

    let directResponse: Response | undefined
    let directError: unknown
    try {
      directResponse = await directFetch(request.clone())
      if (directResponse.ok || directResponse.status === 404) return directResponse
    } catch (error) {
      directError = error
    }

    let settings: RuntimeProxySettings
    try {
      settings = await loadSettings()
    } catch {
      if (directResponse !== undefined) return directResponse
      throw directError instanceof Error ? directError : new Error('YouTube direct request failed')
    }
    if (settings.disabled || settings.proxies.length === 0) {
      if (directResponse !== undefined) return directResponse
      throw directError instanceof Error ? directError : new Error('YouTube direct request failed')
    }

    const method = normalizedYoutubeMethod(request.method)
    const body = method === 'GET' || method === 'HEAD'
      ? undefined
      : new Uint8Array(await request.arrayBuffer())
    const trustedHeaders = new Headers(request.headers)
    trustedHeaders.set('accept-encoding', 'identity')
    const crossOriginHeaders = withoutCrossOriginCredentials(trustedHeaders)
    let lastError: unknown = directError
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const proxy = settings.proxies[randomPosition(settings.proxies.length, random())]
      if (proxy === undefined) break
      try {
        const response = await remoteStream.open({
          url: target,
          method,
          ...(body === undefined ? {} : { body }),
          signal: request.signal,
          maximumRedirects: 5,
          allowRedirect: (_from, to) => isYoutubeRequestUrl(to),
          headersForTarget: (redirectTarget) => redirectTarget.origin === target.origin ? trustedHeaders : crossOriginHeaders,
          proxy
        })
        const result = remoteFetchResponse(response)
        if (result.ok || result.status === 404 || attempt === 2) {
          await directResponse?.body?.cancel().catch(() => undefined)
          return result
        }
        await result.body?.cancel().catch(() => undefined)
      } catch (error) {
        lastError = error
      }
    }
    if (directResponse !== undefined) return directResponse
    throw lastError instanceof Error ? lastError : new Error('YouTube proxy request failed')
  }
}

function normalizedYoutubeMethod(value: string): 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' {
  const method = value.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'POST' || method === 'PUT' || method === 'DELETE') return method
  throw new Error(`YouTube request method is unsupported: ${method}`)
}

function isYoutubeRequestUrl(value: URL): boolean {
  return value.protocol === 'https:' && !value.username && !value.password && [
    'youtube.com',
    'googleapis.com'
  ].some((domain) => value.hostname === domain || value.hostname.endsWith(`.${domain}`))
}

function withoutCrossOriginCredentials(input: Headers): Headers {
  const headers = new Headers(input)
  for (const name of ['authorization', 'cookie', 'x-goog-authuser', 'x-goog-pageid']) headers.delete(name)
  return headers
}

function randomPosition(length: number, sample: number): number {
  const normalized = Number.isFinite(sample) ? Math.max(0, Math.min(0.9999999999999999, sample)) : 0
  return Math.floor(normalized * length)
}

function remoteFetchResponse(response: Awaited<ReturnType<RemoteStream['open']>>): Response {
  const empty = response.status === 204 || response.status === 205 || response.status === 304
  const result = new Response(empty ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
  Object.defineProperty(result, 'url', { configurable: true, value: response.url.toString() })
  return result
}

export class YoutubeExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly client: YoutubeClient = new YoutubeInnertubeClient()) {
    super(id.trim())
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  public override async getTracks() {
    await this.load()
    return this.tracks
  }

  private async load(): Promise<void> {
    if (this.#loaded || !/^[\w-]{11}$/.test(this.id)) return
    this.#loaded = true
    try {
      const video = await this.client.getVideo(this.id)
      this.title = video.title
      this.image = isYoutubeImageUrl(video.image)
        ? video.image
        : `https://i.ytimg.com/vi/${this.id}/maxresdefault.jpg`
      this.tracks.push(...video.captions.flatMap((caption) => {
        if (!isYoutubeCaptionUrl(caption.url)) return []
        return [{ file: caption.url, label: caption.label, srclang: caption.language }]
      }))

      if (!this.downloadable && isYoutubeMediaUrl(video.hlsManifestUrl)) {
        this.referer = YOUTUBE_REFERER
        this.sources.push({ file: video.hlsManifestUrl, type: 'hls', label: 'Original' })
        return
      }

      const seen = new Set<string>()
      for (const format of video.formats) {
        if (!isYoutubeMediaUrl(format.url) || seen.has(format.url)) continue
        seen.add(format.url)
        this.sources.push({
          file: format.url,
          type: 'video/mp4',
          label: format.label || googleVideoLabel(format.itag)
        })
      }
      if (this.sources.length > 0) this.referer = GOOGLE_API_REFERER
      else if (isYoutubeMediaUrl(video.hlsManifestUrl)) {
        this.referer = YOUTUBE_REFERER
        this.sources.push({ file: video.hlsManifestUrl, type: 'hls', label: 'Original' })
      }
    } catch {
      // Private, unavailable, and upstream-failed videos preserve the empty contract.
    }
  }
}

function googleVideoLabel(itag: number): string {
  return ({
    5: '240p', 6: '270p', 17: '144p', 18: '360p', 22: '720p', 34: '360p',
    35: '480p', 36: '240p', 37: '1080p', 38: 'Original', 43: '360p', 44: '480p',
    45: '720p', 46: '1080p', 59: '480p', 78: '480p'
  } as Record<number, string>)[itag] ?? (itag > 0 ? String(itag) : 'Original')
}

function isYoutubeMediaUrl(value: string): boolean {
  return safeYoutubeUrl(value, ['googlevideo.com'])
}

function isYoutubeCaptionUrl(value: string): boolean {
  return safeYoutubeUrl(value, ['youtube.com'])
}

function isYoutubeImageUrl(value: string): boolean {
  return safeYoutubeUrl(value, ['ytimg.com', 'ggpht.com'])
}

function safeYoutubeUrl(value: string, domains: readonly string[]): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && domains.some((domain) =>
      url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    )
  } catch {
    return false
  }
}
