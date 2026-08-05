import { Hosting } from '../core/hosting.js'
import type { HostingData } from '../core/hosting-data.js'
import type { PlayerMediaQuery } from '../core/player-query.js'

export type DownloadPageOptions = Readonly<{
  embedUrl: string
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
  const title = mediaTitle(media, options.customNames)
  const primary = mediaDownloadItem(media, title, options)
  const subtitles = options.showSubtitleDownloads === false ? [] : subtitleDownloadItems(media, options.shortenedLinks)
  const availableItems = primary === null ? subtitles : [primary, ...subtitles]
  const adapterPending = media.host !== 'direct'
  const actions = renderDownloadActions(options)

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <meta name="robots" content="noindex,nofollow">
  <meta name="referrer" content="no-referrer">
  <title>Download ${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/assets/css/gplayer-download.css">
</head>
<body>
  <main class="download-shell">
    <section class="download-card" aria-labelledby="download-title">
      <p class="eyebrow">GDPlayer download</p>
      <h1 id="download-title">${escapeHtml(title)}</h1>
      <p class="intro">Choose the media or subtitle file you want to open.</p>
      ${renderAdFrame(options.bannerTopFrameUrl, 'Advertisement above download options', 'banner')}
      ${actions}
      ${availableItems.length === 0
        ? '<div class="notice notice-error"><strong>No downloadable source is available.</strong><span>The link is valid, but this source cannot be opened safely.</span></div>'
        : `<ul class="download-list">${availableItems.map(renderDownloadItem).join('')}</ul>`}
      ${adapterPending
        ? `<div class="notice"><strong>${escapeHtml(providerName(media.host ?? 'provider', options.customNames))} source recognized</strong><span>The source page is available now. Direct-file extraction will be enabled when this provider adapter reaches parity.</span></div>`
        : ''}
      ${renderAdFrame(options.bannerBottomFrameUrl, 'Advertisement below download options', 'banner')}
    </section>
  </main>
  ${renderAdFrame(options.popupFrameUrl, 'Advertisement', 'popup')}
</body>
</html>`
}

export function downloadPageLinkTargets(media: PlayerMediaQuery, hostingData?: HostingData, includeSubtitles = true): readonly string[] {
  const primary = mediaDownloadHref(media, hostingData)
  const subtitles = includeSubtitles ? subtitleTargets(media).map(({ href }) => href) : []
  return Object.freeze([...new Set([primary, ...subtitles].filter((value) => value !== ''))])
}

export function renderDownloadError(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Download unavailable</title><link rel="stylesheet" href="/assets/css/gplayer-download.css"></head><body><main class="download-shell"><section class="download-card error-card"><p class="eyebrow">GDPlayer download</p><h1>Download unavailable</h1><p>${escapeHtml(message)}</p></section></main></body></html>`
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

function renderDownloadItem(item: DownloadItem): string {
  const icon = item.kind === 'subtitle' ? 'CC' : item.kind === 'source' ? '↗' : '↓'
  return `<li><span class="file-icon" aria-hidden="true">${icon}</span><span class="file-copy"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></span><a class="button button-download" href="${escapeHtmlAttribute(item.href)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtmlAttribute(item.label)}">${item.kind === 'source' ? 'Open' : 'Download'}</a></li>`
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
