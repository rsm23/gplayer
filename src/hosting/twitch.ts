import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const TWITCH_GQL_URL = new URL('https://gql.twitch.tv/gql')
const TWITCH_USHER_ORIGIN = 'https://usher.ttvnw.net'
const TWITCH_REFERER = 'https://www.twitch.tv/'

// Public identifier used by Twitch's own web player. It is a client identifier,
// not a server credential; playback access tokens remain short-lived per source.
const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'

const PLAYBACK_ACCESS_QUERY = `query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {
  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {
    value
    signature
  }
  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {
    value
    signature
  }
}`

export type TwitchExtractorOptions = Readonly<{
  clientId?: string
  gqlUrl?: string | URL
  random?: () => number
}>

type TwitchTarget = Readonly<{
  kind: 'channel' | 'vod'
  id: string
}>

type PlaybackAccessToken = Readonly<{
  signature: string
  value: string
}>

export class TwitchExtractor extends BaseExtractor {
  #loaded = false

  public constructor(
    id: string,
    private readonly http: ProviderHttpClient,
    private readonly options: TwitchExtractorOptions = {}
  ) {
    super(id.trim())
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    const target = parseTwitchTarget(this.id)
    if (target === null) return

    try {
      const gqlUrl = new URL(this.options.gqlUrl ?? TWITCH_GQL_URL)
      const response = await this.http.post({
        url: gqlUrl,
        headers: {
          'client-id': this.options.clientId?.trim() || TWITCH_WEB_CLIENT_ID,
          'content-type': 'application/json',
          origin: 'https://www.twitch.tv',
          referer: TWITCH_REFERER
        },
        body: JSON.stringify({
          operationName: 'PlaybackAccessToken_Template',
          query: PLAYBACK_ACCESS_QUERY,
          variables: {
            isLive: target.kind === 'channel',
            login: target.kind === 'channel' ? target.id : '',
            isVod: target.kind === 'vod',
            vodID: target.kind === 'vod' ? target.id : '',
            playerType: 'site'
          }
        })
      })
      if (response.status < 200 || response.status >= 300 || response.url.origin !== gqlUrl.origin || response.url.pathname !== gqlUrl.pathname) return

      const token = playbackAccessToken(response.body, target.kind)
      if (token === null) return
      this.referer = TWITCH_REFERER
      this.title = target.kind === 'channel' ? target.id : `Twitch video ${target.id}`
      this.sources.push(Object.freeze({
        file: twitchPlaylistUrl(target, token, boundedNonce(this.options.random?.() ?? Math.random())).toString(),
        type: 'hls',
        label: target.kind === 'channel' ? 'Live' : 'Auto'
      }))
    } catch {
      // Offline channels, removed VODs, and upstream protocol failures fail closed.
    }
  }
}

export function parseTwitchTarget(input: string): TwitchTarget | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  let path = trimmed.replace(/^\/+|\/+$/g, '')
  try {
    const url = new URL(trimmed)
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    if (hostname !== 'twitch.tv' && !hostname.endsWith('.twitch.tv')) return null
    path = url.pathname.replace(/^\/+|\/+$/g, '')
  } catch {
    // Parsed host IDs are accepted without requiring a complete URL.
  }

  const parts = path.split('/').filter(Boolean)
  if ((parts[0]?.toLowerCase() === 'videos' || parts[0]?.toLowerCase() === 'v') && /^\d{1,20}$/.test(parts[1] ?? '')) {
    return Object.freeze({ kind: 'vod', id: parts[1] ?? '' })
  }
  const channel = parts[0]?.toLowerCase() ?? ''
  return /^[a-z0-9_]{1,25}$/.test(channel) ? Object.freeze({ kind: 'channel', id: channel }) : null
}

function playbackAccessToken(input: string, kind: TwitchTarget['kind']): PlaybackAccessToken | null {
  try {
    const parsed: unknown = JSON.parse(input)
    if (!isRecord(parsed) || !isRecord(parsed.data)) return null
    const candidate = kind === 'channel' ? parsed.data.streamPlaybackAccessToken : parsed.data.videoPlaybackAccessToken
    if (!isRecord(candidate)) return null
    const signature = typeof candidate.signature === 'string' ? candidate.signature.trim() : ''
    const value = typeof candidate.value === 'string' ? candidate.value.trim() : ''
    if (!/^[a-f0-9]{16,256}$/i.test(signature) || value.length === 0 || value.length > 65_536 || /[\u0000-\u001f\u007f]/.test(value)) return null
    return Object.freeze({ signature, value })
  } catch {
    return null
  }
}

function twitchPlaylistUrl(target: TwitchTarget, token: PlaybackAccessToken, nonce: string): URL {
  const path = target.kind === 'channel'
    ? `/api/channel/hls/${encodeURIComponent(target.id)}.m3u8`
    : `/vod/${encodeURIComponent(target.id)}.m3u8`
  const url = new URL(path, TWITCH_USHER_ORIGIN)
  url.searchParams.set('acmb', 'e30=')
  url.searchParams.set('allow_audio_only', 'true')
  url.searchParams.set('allow_source', 'true')
  url.searchParams.set('fast_bread', 'true')
  url.searchParams.set('p', nonce)
  url.searchParams.set('player_backend', 'mediaplayer')
  url.searchParams.set('playlist_include_framerate', 'true')
  url.searchParams.set('reassignments_supported', 'true')
  url.searchParams.set(target.kind === 'channel' ? 'sig' : 'nauthsig', token.signature)
  url.searchParams.set('supported_codecs', 'av1,h265,h264')
  url.searchParams.set(target.kind === 'channel' ? 'token' : 'nauth', token.value)
  url.searchParams.set('transcode_mode', 'cbr_v1')
  return url
}

function boundedNonce(sample: number): string {
  const normalized = Number.isFinite(sample) ? Math.max(0, Math.min(0.9999999999999999, sample)) : 0
  return String(Math.floor(normalized * 1_000_000))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
