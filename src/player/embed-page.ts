import { Hosting } from '../core/hosting.js'
import type { PlayerMediaQuery, PlayerPublicOptions } from '../core/player-query.js'

type RenderedSource = Readonly<{
  kind: 'video' | 'hls' | 'dash' | 'provider' | 'unavailable'
  url: string
  message?: string
}>

export function renderEmbedPage(media: PlayerMediaQuery, options: PlayerPublicOptions): string {
  const source = resolveRenderedSource(media)
  const poster = safePlayerResource(media.poster ?? '', '/poster/')
  const tracks = renderTracks(
    [...(media.sub ?? []), ...(media.subs === undefined ? [] : [media.subs])],
    media.lang ?? []
  )
  const videoAttributes = [
    options.autoplay ? ' autoplay' : '',
    options.mute ? ' muted' : '',
    options.repeat ? ' loop' : ''
  ].join('')

  let player: string
  if (source.kind === 'provider') {
    player = `<iframe class="provider-frame" src="${escapeHtmlAttribute(source.url)}" title="Embedded video player" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"></iframe>`
  } else if (source.kind === 'unavailable') {
    player = `<div class="player-notice"><span>Source accepted</span><h1>Provider adapter in progress</h1><p>${escapeHtml(source.message ?? 'This provider is not available in the Node player yet.')}</p></div>`
  } else {
    const sourceAttribute = source.kind === 'hls' ? '' : ` src="${escapeHtmlAttribute(source.url)}"`
    player = `<video id="media-player" controls playsinline preload="metadata"${videoAttributes}${sourceAttribute}${poster ? ` poster="${escapeHtmlAttribute(poster)}"` : ''} data-source="${escapeHtmlAttribute(source.url)}" data-source-kind="${source.kind}">${tracks}<p>Your browser cannot play this media.</p></video>`
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>GDPlayer</title>
  <link rel="stylesheet" href="/assets/css/gplayer-embed.css">
</head>
<body>
  <main class="player-stage">${player}</main>
  ${source.kind === 'hls' ? '<script src="/assets/vendor/hls.js/1.6.4/hls.min.js"></script>\n  <script src="/assets/js/gplayer-embed.js"></script>' : source.kind === 'dash' ? '<script src="/assets/vendor/shaka-player/4.13.4/shaka-player.compiled.js"></script>\n  <script src="/assets/js/gplayer-embed.js"></script>' : ''}
</body>
</html>`
}

export function renderEmbedError(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>Player unavailable</title><link rel="stylesheet" href="/assets/css/gplayer-embed.css"></head><body><main class="player-stage"><div class="player-notice player-error"><span>GDPlayer</span><h1>Player unavailable</h1><p>${escapeHtml(message)}</p></div></main></body></html>`
}

function resolveRenderedSource(media: PlayerMediaQuery): RenderedSource {
  if (media.host === undefined || media.id === undefined) {
    return { kind: 'unavailable', url: '', message: 'The player query does not contain a source.' }
  }

  if (media.host === 'direct') {
    if (media.id.startsWith('/hls/') && !media.id.includes('\\') && !media.id.includes('..')) {
      return { kind: 'hls', url: media.id }
    }
    if (media.id.startsWith('/mpd/') && !media.id.includes('\\') && !media.id.includes('..')) {
      return { kind: 'dash', url: media.id }
    }
    const url = safeHttpUrl(media.id)
    if (url.length === 0) return { kind: 'unavailable', url: '', message: 'The direct source URL is invalid.' }
    const pathname = new URL(url).pathname.toLowerCase()
    if (pathname.endsWith('.m3u8')) return { kind: 'hls', url }
    if (pathname.endsWith('.mpd')) return { kind: 'dash', url }
    return { kind: 'video', url }
  }

  const providerUrl = providerEmbedUrl(media.host, media.id)
  if (providerUrl !== null) return { kind: 'provider', url: providerUrl }

  const sourcePage = new Hosting().setHost(media.host).setID(media.id).getDownloadLink()
  return {
    kind: 'unavailable',
    url: '',
    message: `The ${media.host} source was recognized. Its native extractor is still being ported from GDPlayer 4.8.3. Source page: ${sourcePage}`
  }
}

function providerEmbedUrl(host: string, id: string): string | null {
  const cleanId = encodeURIComponent(id.trim())
  if (cleanId.length === 0) return null
  switch (host) {
    case 'youtube': return `https://www.youtube-nocookie.com/embed/${cleanId}`
    case 'vimeo': return `https://player.vimeo.com/video/${cleanId}`
    case 'dailymotion': return `https://www.dailymotion.com/embed/video/${cleanId}`
    case 'gdrive': return `https://drive.google.com/file/d/${cleanId}/preview`
    default: return null
  }
}

function renderTracks(subtitles: readonly string[], labels: readonly string[]): string {
  return subtitles.flatMap((subtitle, index) => {
    const url = safePlayerResource(subtitle, '/subtitle/')
    if (url.length === 0) return []
    const label = labels[index]?.trim() || `Subtitle ${index + 1}`
    return [`<track kind="subtitles" src="${escapeHtmlAttribute(url)}" label="${escapeHtmlAttribute(label)}"${index === 0 ? ' default' : ''}>`]
  }).join('')
}

function safeHttpUrl(value: string): string {
  try {
    const url = new URL(value.trim())
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return ''
    return url.toString()
  } catch {
    return ''
  }
}

function safePlayerResource(value: string, localPrefix: '/poster/' | '/subtitle/'): string {
  const trimmed = value.trim()
  if (trimmed.startsWith(localPrefix) && !trimmed.includes('\\') && !trimmed.includes('..')) return trimmed
  return safeHttpUrl(trimmed)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value)
}
