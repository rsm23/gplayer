import { runInNewContext } from 'node:vm'
import { Innertube, Platform } from 'youtubei.js'
import { BaseExtractor } from './base-extractor.js'

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

  public constructor(private readonly loadCookie?: () => Promise<string>) {}

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
      this.#session = Innertube.create({ retrieve_player: true, ...(cookie === '' ? {} : { cookie }) })
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
