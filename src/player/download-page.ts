import { Hosting } from '../core/hosting.js'
import type { HostingData } from '../core/hosting-data.js'
import type { PlayerMediaQuery } from '../core/player-query.js'
import type { MediaSource, MediaTrack } from '../core/source-resolver.js'
import { histatsOnly, renderAnalyticsHead, renderAnalyticsNoScript, type AnalyticsConfig } from './analytics.js'
import { withShadcnUi } from '../ui/shadcn-html.js'

export type DownloadPageOptions = Readonly<{
  embedUrl: string
  analytics?: AnalyticsConfig
  alternativeUrl?: string
  bannerTopFrameUrl?: string
  bannerBottomFrameUrl?: string
  popupFrameUrl?: string
  downloadLabel?: string
  hideHostname?: boolean
  hostingData?: HostingData
  customNames?: Readonly<Record<string, string>>
  shortenedLinks?: ReadonlyMap<string, string>
  showSubtitleDownloads?: boolean
  showWatchButton?: boolean
  directAdUrl?: string
  resolvedPlayback?: Readonly<{
    title: string
    sources: readonly MediaSource[]
    tracks: readonly MediaTrack[]
  }>
  servers?: readonly Readonly<{
    label: string
    url: string
    active: boolean
  }>[]
}>

type DownloadItem = Readonly<{
  href: string
  label: string
  detail: string
  kind: 'media' | 'source' | 'subtitle'
}>

type SubtitleTarget = Readonly<{
  href: string
  index: number
}>

export function renderDownloadPage(media: PlayerMediaQuery, options: DownloadPageOptions): string {
  const resolved = options.resolvedPlayback
  const title = resolved?.title.trim() || mediaTitle(media, options.customNames)
  const primary = resolved === undefined
    ? [mediaDownloadItem(media, title, options)].filter((item): item is DownloadItem => item !== null)
    : resolvedSourceItems(resolved.sources, title, options)
  const subtitles = options.showSubtitleDownloads === false
    ? []
    : resolved === undefined
      ? subtitleDownloadItems(media, options.shortenedLinks)
      : resolvedTrackItems(resolved.tracks, options.shortenedLinks)
  const availableItems = [...primary, ...subtitles]
  const adapterPending = media.host !== 'direct' && resolved === undefined
  const actions = renderDownloadActions(options)
  const servers = renderDownloadServers(options.servers ?? [])

  return withShadcnUi(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <meta name="robots" content="noindex,nofollow">
  <meta name="referrer" content="no-referrer">
  <title>Download ${escapeHtml(title)}</title>
  ${renderAnalyticsHead(options.analytics)}
  <link rel="stylesheet" href="/assets/css/gplayer-download.css">
</head>
<body>
  ${renderAnalyticsNoScript(options.analytics)}
  <main class="download-shell">
    <section class="download-card" aria-labelledby="download-title">
      <p class="eyebrow">GDPlayer download</p>
      <h1 id="download-title">${escapeHtml(title)}</h1>
      <p class="intro">Choose the media or subtitle file you want to open.</p>
      ${renderAdFrame(options.bannerTopFrameUrl, 'Advertisement above download options', 'banner')}
      ${actions}
      ${servers}
      ${availableItems.length === 0
        ? '<div class="notice notice-error"><strong>No downloadable source is available.</strong><span>The link is valid, but this source cannot be opened safely.</span></div>'
        : `<ul class="download-list">${availableItems.map((item) => renderDownloadItem(item, options.directAdUrl ?? '')).join('')}</ul>`}
      ${adapterPending
        ? `<div class="notice"><strong>${escapeHtml(providerName(media.host ?? 'provider', options.customNames))} source recognized</strong><span>The source page is available now. Direct-file extraction will be enabled when this provider adapter reaches parity.</span></div>`
        : ''}
      ${renderAdFrame(options.bannerBottomFrameUrl, 'Advertisement below download options', 'banner')}
    </section>
  </main>
  ${renderAdFrame(options.popupFrameUrl, 'Advertisement', 'popup')}
  ${safeHttpUrl(options.directAdUrl ?? '') === '' || availableItems.length === 0 ? '' : '<script src="/assets/js/gplayer-download.js"></script>'}
</body>
</html>`)
}

function resolvedSourceItems(sources: readonly MediaSource[], title: string, options: DownloadPageOptions): DownloadItem[] {
  const safeSources = sources.slice(0, 100).flatMap((source) => {
    const file = typeof source.file === 'string' ? safeHttpUrl(source.file) : ''
    if (file.length === 0) return []
    const label = typeof source.label === 'string' ? source.label.trim().slice(0, 100) : ''
    return [{ file, label }]
  })
  return safeSources.map((source) => ({
    href: transformedDownloadHref(source.file, options.shortenedLinks),
    label: safeSources.length === 1
      ? configuredDownloadLabel(options.downloadLabel, title)
      : `Download ${source.label || 'Original'} Video`,
    detail: source.label || fileDetail(source.file, 'Direct media file'),
    kind: 'media' as const
  }))
}

function resolvedTrackItems(tracks: readonly MediaTrack[], shortenedLinks?: ReadonlyMap<string, string>): DownloadItem[] {
  return tracks.slice(0, 100).flatMap((track, index) => {
    const file = typeof track.file === 'string' ? safeHttpUrl(track.file) : ''
    if (file.length === 0) return []
    const label = typeof track.label === 'string' && track.label.trim() !== '' ? track.label.trim().slice(0, 100) : `Subtitle ${index + 1}`
    return [{
      href: transformedDownloadHref(file, shortenedLinks),
      label: `Download ${label} Subtitle`,
      detail: 'Subtitle file',
      kind: 'subtitle' as const
    }]
  })
}

function renderDownloadServers(servers: readonly Readonly<{ label: string; url: string; active: boolean }>[]): string {
  if (servers.length < 2) return ''
  const links = servers.map((server) => server.active
    ? `<li><span aria-current="page">${escapeHtml(server.label)}</span></li>`
    : `<li><a href="${escapeHtmlAttribute(server.url)}">${escapeHtml(server.label)}</a></li>`).join('')
  return `<nav class="download-servers" data-download-servers aria-label="Download servers"><span>Servers</span><ul>${links}</ul></nav>`
}

export function downloadPageLinkTargets(media: PlayerMediaQuery, hostingData?: HostingData, includeSubtitles = true): readonly string[] {
  const primary = mediaDownloadHref(media, hostingData)
  const subtitles = includeSubtitles ? subtitleTargets(media).map(({ href }) => href) : []
  return Object.freeze([...new Set([primary, ...subtitles].filter((value) => value !== ''))])
}

export function renderDownloadError(message: string, analytics?: AnalyticsConfig): string {
  const errorAnalytics = histatsOnly(analytics)
  return withShadcnUi(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Download unavailable</title>${renderAnalyticsHead(errorAnalytics)}<link rel="stylesheet" href="/assets/css/gplayer-download.css"></head><body>${renderAnalyticsNoScript(errorAnalytics)}<main class="download-shell"><section class="download-card error-card"><p class="eyebrow">GDPlayer download</p><h1>Download unavailable</h1><p>${escapeHtml(message)}</p></section></main></body></html>`)
}

function mediaDownloadItem(media: PlayerMediaQuery, title: string, options: DownloadPageOptions): DownloadItem | null {
  const originalHref = mediaDownloadHref(media, options.hostingData)
  if (originalHref.length === 0) return null
  const href = transformedDownloadHref(originalHref, options.shortenedLinks)

  if (media.host === 'direct') {
    return {
      href,
      label: configuredDownloadLabel(options.downloadLabel, title),
      detail: fileDetail(originalHref, 'Direct media file'),
      kind: 'media'
    }
  }

  return {
    href,
    label: 'Open source page',
    detail: options.hideHostname === true ? 'Video source' : providerName(media.host ?? 'provider', options.customNames),
    kind: 'source'
  }
}

function renderDownloadActions(options: DownloadPageOptions): string {
  const watch = options.showWatchButton === false
    ? ''
    : `<a class="button button-watch" href="${escapeHtmlAttribute(options.embedUrl)}" target="_blank" rel="noopener noreferrer">Watch video</a>`
  const alternative = options.alternativeUrl === undefined
    ? ''
    : `<a class="button button-secondary" href="${escapeHtmlAttribute(options.alternativeUrl)}">Use alternative server</a>`
  return watch === '' && alternative === '' ? '' : `<div class="actions">${watch}${alternative}</div>`
}

function configuredDownloadLabel(template: string | undefined, title: string): string {
  const normalized = template?.replaceAll('{title}', title).trim() ?? ''
  return normalized.length > 0 ? normalized : 'Download video'
}

function subtitleDownloadItems(media: PlayerMediaQuery, shortenedLinks?: ReadonlyMap<string, string>): DownloadItem[] {
  return subtitleTargets(media).map(({ href, index }) => {
    const language = media.lang?.[index]?.trim() || `Subtitle ${index + 1}`
    return {
      href: transformedDownloadHref(href, shortenedLinks),
      label: `Download ${language}`,
      detail: fileDetail(href, 'Subtitle file'),
      kind: 'subtitle' as const
    }
  })
}

function mediaDownloadHref(media: PlayerMediaQuery, hostingData?: HostingData): string {
  if (media.host === undefined || media.id === undefined) return ''
  return media.host === 'direct'
    ? safeHttpUrl(media.id)
    : safeHttpUrl(new Hosting('', hostingData).setHost(media.host).setID(media.id).getDownloadLink())
}

function subtitleTargets(media: PlayerMediaQuery): SubtitleTarget[] {
  const subtitles = [...(media.sub ?? [])]
  if (media.subs !== undefined) subtitles.push(media.subs)
  return subtitles.flatMap((subtitle, index) => {
    const href = safeHttpUrl(subtitle)
    return href.length === 0 ? [] : [{ href, index }]
  })
}

function transformedDownloadHref(href: string, shortenedLinks?: ReadonlyMap<string, string>): string {
  const transformed = shortenedLinks?.get(href)
  if (transformed === undefined) return href
  return safeHttpUrl(transformed) || href
}

function renderDownloadItem(item: DownloadItem, directAdUrl = ''): string {
  const icon = item.kind === 'subtitle' ? 'CC' : item.kind === 'source' ? '↗' : '↓'
  const advertisement = safeHttpUrl(directAdUrl)
  const href = advertisement || item.href
  const target = advertisement === '' ? '' : ` data-download-target="${escapeHtmlAttribute(item.href)}"`
  return `<li><span class="file-icon" aria-hidden="true">${icon}</span><span class="file-copy"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></span><a class="button button-download" href="${escapeHtmlAttribute(href)}"${target} target="_blank" rel="noopener noreferrer" aria-label="${escapeHtmlAttribute(item.label)}">${item.kind === 'source' ? 'Open' : 'Download'}</a></li>`
}

function renderAdFrame(url: string | undefined, title: string, kind: 'banner' | 'popup'): string {
  if (url === undefined || url.length === 0) return ''
  return `<iframe class="ad-frame ad-frame-${kind}" src="${escapeHtmlAttribute(url)}" title="${escapeHtmlAttribute(title)}" referrerpolicy="no-referrer" sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-scripts"></iframe>`
}

function mediaTitle(media: PlayerMediaQuery, customNames?: Readonly<Record<string, string>>): string {
  if (media.title?.trim()) return media.title.trim()
  if (media.host === 'direct' && media.id !== undefined) {
    const href = safeHttpUrl(media.id)
    if (href.length > 0) {
      try {
        const filename = decodeURIComponent(new URL(href).pathname.split('/').filter(Boolean).at(-1) ?? '')
        if (filename.trim().length > 0) return filename
      } catch {
        // The URL was already validated, but a malformed escape sequence can still fail decoding.
      }
    }
  }
  return `${providerName(media.host ?? 'video', customNames)} video`
}

function providerName(host: string, customNames?: Readonly<Record<string, string>>): string {
  const custom = customNames?.[host]?.trim() ?? ''
  if (custom !== '') return custom
  const names: Readonly<Record<string, string>> = {
    dailymotion: 'Dailymotion',
    gdrive: 'Google Drive',
    googlephotos: 'Google Photos',
    streamhg: 'StreamWish',
    youtube: 'YouTube'
  }
  return names[host] ?? host.replaceAll(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function fileDetail(href: string, fallback: string): string {
  try {
    const filename = decodeURIComponent(new URL(href).pathname.split('/').filter(Boolean).at(-1) ?? '')
    return filename.trim().length > 0 ? filename : fallback
  } catch {
    return fallback
  }
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
