import { Hosting } from '../core/hosting.js'
import type { PlayerMediaQuery } from '../core/player-query.js'

export type DownloadPageOptions = Readonly<{
  embedUrl: string
  alternativeUrl?: string
  bannerTopFrameUrl?: string
  bannerBottomFrameUrl?: string
  popupFrameUrl?: string
  downloadLabel?: string
  hideHostname?: boolean
}>

type DownloadItem = Readonly<{
  href: string
  label: string
  detail: string
  kind: 'media' | 'source' | 'subtitle'
}>

export function renderDownloadPage(media: PlayerMediaQuery, options: DownloadPageOptions): string {
  const title = mediaTitle(media)
  const primary = mediaDownloadItem(media, title, options)
  const subtitles = subtitleDownloadItems(media)
  const availableItems = primary === null ? subtitles : [primary, ...subtitles]
  const adapterPending = media.host !== 'direct'

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
      <div class="actions">
        <a class="button button-watch" href="${escapeHtmlAttribute(options.embedUrl)}" target="_blank" rel="noopener noreferrer">Watch video</a>
        ${options.alternativeUrl === undefined ? '' : `<a class="button button-secondary" href="${escapeHtmlAttribute(options.alternativeUrl)}">Use alternative server</a>`}
      </div>
      ${availableItems.length === 0
        ? '<div class="notice notice-error"><strong>No downloadable source is available.</strong><span>The link is valid, but this source cannot be opened safely.</span></div>'
        : `<ul class="download-list">${availableItems.map(renderDownloadItem).join('')}</ul>`}
      ${adapterPending
        ? `<div class="notice"><strong>${escapeHtml(providerName(media.host ?? 'provider'))} source recognized</strong><span>The source page is available now. Direct-file extraction will be enabled when this provider adapter reaches parity.</span></div>`
        : ''}
      ${renderAdFrame(options.bannerBottomFrameUrl, 'Advertisement below download options', 'banner')}
    </section>
  </main>
  ${renderAdFrame(options.popupFrameUrl, 'Advertisement', 'popup')}
</body>
</html>`
}

export function renderDownloadError(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Download unavailable</title><link rel="stylesheet" href="/assets/css/gplayer-download.css"></head><body><main class="download-shell"><section class="download-card error-card"><p class="eyebrow">GDPlayer download</p><h1>Download unavailable</h1><p>${escapeHtml(message)}</p></section></main></body></html>`
}

function mediaDownloadItem(media: PlayerMediaQuery, title: string, options: DownloadPageOptions): DownloadItem | null {
  if (media.host === undefined || media.id === undefined) return null

  const href = media.host === 'direct'
    ? safeHttpUrl(media.id)
    : safeHttpUrl(new Hosting().setHost(media.host).setID(media.id).getDownloadLink())
  if (href.length === 0) return null

  if (media.host === 'direct') {
    return {
      href,
      label: configuredDownloadLabel(options.downloadLabel, title),
      detail: fileDetail(href, 'Direct media file'),
      kind: 'media'
    }
  }

  return {
    href,
    label: 'Open source page',
    detail: options.hideHostname === true ? 'Video source' : providerName(media.host),
    kind: 'source'
  }
}

function configuredDownloadLabel(template: string | undefined, title: string): string {
  const normalized = template?.replaceAll('{title}', title).trim() ?? ''
  return normalized.length > 0 ? normalized : 'Download video'
}

function subtitleDownloadItems(media: PlayerMediaQuery): DownloadItem[] {
  const subtitles = [...(media.sub ?? [])]
  if (media.subs !== undefined) subtitles.push(media.subs)

  return subtitles.flatMap((subtitle, index) => {
    const href = safeHttpUrl(subtitle)
    if (href.length === 0) return []
    const language = media.lang?.[index]?.trim() || `Subtitle ${index + 1}`
    return [{
      href,
      label: `Download ${language}`,
      detail: fileDetail(href, 'Subtitle file'),
      kind: 'subtitle' as const
    }]
  })
}

function renderDownloadItem(item: DownloadItem): string {
  const icon = item.kind === 'subtitle' ? 'CC' : item.kind === 'source' ? '↗' : '↓'
  return `<li><span class="file-icon" aria-hidden="true">${icon}</span><span class="file-copy"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></span><a class="button button-download" href="${escapeHtmlAttribute(item.href)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtmlAttribute(item.label)}">${item.kind === 'source' ? 'Open' : 'Download'}</a></li>`
}

function renderAdFrame(url: string | undefined, title: string, kind: 'banner' | 'popup'): string {
  if (url === undefined || url.length === 0) return ''
  return `<iframe class="ad-frame ad-frame-${kind}" src="${escapeHtmlAttribute(url)}" title="${escapeHtmlAttribute(title)}" referrerpolicy="no-referrer" sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-scripts"></iframe>`
}

function mediaTitle(media: PlayerMediaQuery): string {
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
  return `${providerName(media.host ?? 'video')} video`
}

function providerName(host: string): string {
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
