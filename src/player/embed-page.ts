import { Hosting } from '../core/hosting.js'
import type { HostingData } from '../core/hosting-data.js'
import type { PlayerMediaQuery, PlayerPublicOptions } from '../core/player-query.js'
import { languageEntry, type PlayerSettings } from '../settings/player-settings.js'

type RenderedSource = Readonly<{
  kind: 'video' | 'hls' | 'dash' | 'provider' | 'unavailable'
  url: string
  message?: string
}>

export type EmbedAdsOptions = Readonly<{
  blockAdblocker: boolean
  directAdUrl: string
  directAdOnPlay: boolean
  showIframeAds: boolean
  popupFrameUrl: string
  popupDelaySeconds: number
}>

export type EmbedPlayerOptions = Readonly<{
  settings: PlayerSettings
  downloadUrl: string
  hostingData?: HostingData
  customNames?: Readonly<Record<string, string>>
}>

const DISABLED_EMBED_ADS: EmbedAdsOptions = Object.freeze({
  blockAdblocker: false,
  directAdUrl: '',
  directAdOnPlay: false,
  showIframeAds: false,
  popupFrameUrl: '',
  popupDelaySeconds: 0
})

export function renderEmbedPage(
  media: PlayerMediaQuery,
  options: PlayerPublicOptions,
  ads: EmbedAdsOptions = DISABLED_EMBED_ADS,
  playerOptions?: EmbedPlayerOptions
): string {
  const settings = playerOptions?.settings
  const source = resolveRenderedSource(media, playerOptions?.hostingData)
  const poster = safePlayerResource(media.poster ?? '', '/poster/')
  const tracks = renderTracks(
    [...(media.sub ?? []), ...(media.subs === undefined ? [] : [media.subs])],
    media.lang ?? [],
    settings?.default_subtitle ?? ''
  )
  const videoAttributes = [
    options.autoplay ? ' autoplay' : '',
    options.mute ? ' muted' : '',
    options.repeat ? ' loop' : ''
  ].join('')
  const preload = settings?.preload ?? 'metadata'
  const stretching = settings?.stretching ?? 'uniform'
  const title = playerTitle(media, playerOptions?.customNames)

  let player: string
  if (source.kind === 'provider') {
    player = `<iframe class="provider-frame" src="${escapeHtmlAttribute(source.url)}" title="Embedded video player" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"></iframe>`
  } else if (source.kind === 'unavailable') {
    player = `<div class="player-notice"><span>Source accepted</span><h1>Provider adapter in progress</h1><p>${escapeHtml(source.message ?? 'This provider is not available in the Node player yet.')}</p></div>`
  } else {
    const sourceAttribute = source.kind === 'hls' ? '' : ` src="${escapeHtmlAttribute(source.url)}"`
    player = `<video id="media-player" class="player-stretch-${stretching}" controls playsinline preload="${preload}"${videoAttributes}${sourceAttribute}${poster ? ` poster="${escapeHtmlAttribute(poster)}"` : ''} data-source="${escapeHtmlAttribute(source.url)}" data-source-kind="${source.kind}">${tracks}<p>Your browser cannot play this media.</p></video>`
  }

  const directEnabled = ads.directAdOnPlay && ads.directAdUrl.length > 0
  const delayedPopupEnabled = ads.popupFrameUrl.length > 0 && ads.popupDelaySeconds > 0
  const providerGate = source.kind === 'provider' && (directEnabled || delayedPopupEnabled)
    ? '<button class="provider-ad-gate" type="button" data-provider-ad-gate aria-label="Continue to the video"><span aria-hidden="true">▶</span></button>'
    : ''
  const directFallback = directEnabled && ads.showIframeAds
    ? `<section class="direct-ad-panel" data-direct-ad-panel hidden aria-label="Advertisement"><button class="direct-ad-close" type="button" data-direct-ad-close aria-label="Close advertisement">&times;</button><iframe data-direct-ad-frame title="Advertisement" referrerpolicy="no-referrer" sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-scripts"></iframe></section>`
    : ''
  const adblockNotice = ads.blockAdblocker
    ? '<section class="adblock-notice" data-adblock-notice hidden role="alert"><strong>Ad blocker detected</strong><span>Please disable your ad blocker and reload the player to continue.</span></section>'
    : ''
  const logo = settings === undefined ? '' : renderPlayerLogo(settings.logo_file, settings.logo_open_link, settings.logo_position, settings.logo_margin, settings.logo_hide, 'player-logo')
  const smallLogo = settings === undefined ? '' : renderPlayerLogo(settings.small_logo_file, settings.small_logo_link, 'bottom-left', '0', false, 'player-small-logo')
  const titleOverlay = settings?.display_title === true
    ? `<h1 class="player-title" data-player-title>${escapeHtml(title)}</h1>`
    : `<h1 class="sr-only">${escapeHtml(title)}</h1>`
  const fakePlay = settings?.fake_play_button === true && (source.kind === 'video' || source.kind === 'hls' || source.kind === 'dash')
    ? '<button class="player-fake-play" type="button" data-player-fake-play aria-label="Play video"><span aria-hidden="true">▶</span></button>'
    : ''
  const toolbar = settings === undefined ? '' : renderPlayerToolbar(settings, playerOptions?.downloadUrl ?? '')
  const resumePrompt = settings?.continue_watching === true
    ? `<section class="player-resume" data-player-resume hidden role="dialog" aria-modal="true" aria-labelledby="player-resume-text"><p id="player-resume-text" data-player-resume-text>${escapeHtml(settings.text_resume)}</p><div><button type="button" data-player-resume-yes>${escapeHtml(settings.text_resume_yes)}</button><button type="button" data-player-resume-no>${escapeHtml(settings.text_resume_no)}</button></div></section>`
    : ''
  const documentTitle = settings === undefined
    ? 'GPlayer'
    : settings.text_title.replaceAll('{title}', title).replaceAll('{siteName}', 'GPlayer')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${escapeHtml(documentTitle)}</title>
  <link rel="stylesheet" href="/assets/css/gplayer-embed.css">
</head>
<body data-block-adblocker="${String(ads.blockAdblocker)}" data-direct-ad-url="${escapeHtmlAttribute(ads.directAdUrl)}" data-direct-ad-on-play="${String(directEnabled)}" data-direct-ad-iframe="${String(ads.showIframeAds)}" data-popup-frame-url="${escapeHtmlAttribute(ads.popupFrameUrl)}" data-popup-delay-seconds="${String(ads.popupDelaySeconds)}" data-player-color="#${escapeHtmlAttribute(settings?.player_color ?? '8068ff')}" data-player-color-2="#${escapeHtmlAttribute(settings?.player_color2 ?? '8068ff')}" data-pause-on-left="${String(settings?.pause_on_left === true)}" data-continue-watching="${String(settings?.continue_watching === true)}" data-logo-margin="${escapeHtmlAttribute(settings?.logo_margin ?? '0')}">
  <main class="player-stage" aria-label="Video player">${player}${providerGate}${fakePlay}${titleOverlay}${logo}${smallLogo}${toolbar}</main>
  ${directFallback}
  ${adblockNotice}
  ${resumePrompt}
  ${source.kind === 'hls' ? '<script src="/assets/vendor/hls.js/1.6.4/hls.min.js"></script>' : source.kind === 'dash' ? '<script src="/assets/vendor/shaka-player/4.13.4/shaka-player.compiled.js"></script>' : ''}
  <script src="/assets/js/gplayer-embed.js"></script>
</body>
</html>`
}

export function renderEmbedError(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>Player unavailable</title><link rel="stylesheet" href="/assets/css/gplayer-embed.css"></head><body><main class="player-stage"><div class="player-notice player-error"><span>GDPlayer</span><h1>Player unavailable</h1><p>${escapeHtml(message)}</p></div></main></body></html>`
}

function resolveRenderedSource(media: PlayerMediaQuery, hostingData?: HostingData): RenderedSource {
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

  const sourcePage = new Hosting('', hostingData).setHost(media.host).setID(media.id).getDownloadLink()
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

function renderTracks(subtitles: readonly string[], labels: readonly string[], defaultLanguage: string): string {
  const language = languageEntry(defaultLanguage)
  const preferred = labels.findIndex((label) => {
    const normalized = label.trim().toLowerCase()
    return normalized === language.key.toLowerCase() || normalized === language.value.toLowerCase()
  })
  return subtitles.flatMap((subtitle, index) => {
    const url = safePlayerResource(subtitle, '/subtitle/')
    if (url.length === 0) return []
    const label = labels[index]?.trim() || `Subtitle ${index + 1}`
    return [`<track kind="subtitles" src="${escapeHtmlAttribute(url)}" label="${escapeHtmlAttribute(label)}"${index === (preferred < 0 ? 0 : preferred) ? ' default' : ''}>`]
  }).join('')
}

function renderPlayerLogo(
  image: string,
  link: string,
  position: PlayerSettings['logo_position'],
  margin: string,
  hidden: boolean,
  className: 'player-logo' | 'player-small-logo'
): string {
  const source = safeHttpUrl(image)
  if (hidden || source.length === 0) return ''
  const logo = `<img src="${escapeHtmlAttribute(source)}" alt="" data-player-logo data-logo-margin="${escapeHtmlAttribute(margin)}">`
  const href = safeHttpUrl(link)
  const content = href.length === 0 ? logo : `<a href="${escapeHtmlAttribute(href)}" target="_blank" rel="noopener noreferrer" aria-label="Open player brand link">${logo}</a>`
  return `<div class="${className} logo-${position}">${content}</div>`
}

function renderPlayerToolbar(settings: PlayerSettings, downloadUrl: string): string {
  if (!settings.enable_share_button && !settings.enable_download_button) return ''
  const share = settings.enable_share_button
    ? '<button type="button" data-player-share aria-label="Share video">Share</button>'
    : ''
  const download = settings.enable_download_button && downloadUrl.length > 0
    ? `<a href="${escapeHtmlAttribute(downloadUrl)}" target="_blank" rel="noopener noreferrer">Download</a>`
    : ''
  return `<nav class="player-toolbar" aria-label="Player actions">${share}${download}</nav>`
}

function playerTitle(media: PlayerMediaQuery, customNames?: Readonly<Record<string, string>>): string {
  if (media.host === 'direct' && media.id !== undefined) {
    const source = safeHttpUrl(media.id)
    if (source.length > 0) {
      try {
        const filename = decodeURIComponent(new URL(source).pathname.split('/').filter(Boolean).at(-1) ?? '')
        if (filename.trim().length > 0) return filename
      } catch {
        // A malformed escape sequence falls back to the provider label below.
      }
    }
  }
  const host = media.host ?? 'video'
  const custom = customNames?.[host]?.trim() ?? ''
  const label = custom !== '' ? custom : host.replaceAll(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
  return `${label} video`
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
