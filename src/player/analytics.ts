import type { GeneralSettings } from '../settings/settings-admin-service.js'

export type AnalyticsConfig = Readonly<{
  googleAnalyticsId: string
  googleTagManagerId: string
  histatsId: string
}>

export type AnalyticsCspSources = Readonly<{
  scripts: readonly string[]
  connections: readonly string[]
  images: readonly string[]
  frames: readonly string[]
}>

const EMPTY_ANALYTICS: AnalyticsConfig = Object.freeze({
  googleAnalyticsId: '',
  googleTagManagerId: '',
  histatsId: ''
})

export function analyticsConfig(
  settings: Pick<GeneralSettings, 'google_analytics_id' | 'google_tag_manager' | 'histats_id'>
): AnalyticsConfig {
  const googleAnalyticsId = normalizedGoogleAnalyticsId(settings.google_analytics_id)
  const googleTagManagerId = normalizedGoogleTagManagerId(settings.google_tag_manager)
  const histatsId = normalizedHistatsId(settings.histats_id)
  if (googleAnalyticsId === '' && googleTagManagerId === '' && histatsId === '') return EMPTY_ANALYTICS
  return Object.freeze({ googleAnalyticsId, googleTagManagerId, histatsId })
}

export function hasAnalytics(config: AnalyticsConfig | undefined): config is AnalyticsConfig {
  return config !== undefined && (
    config.googleAnalyticsId !== '' ||
    config.googleTagManagerId !== '' ||
    config.histatsId !== ''
  )
}

export function histatsOnly(config: AnalyticsConfig | undefined): AnalyticsConfig {
  if (config === undefined || config.histatsId === '') return EMPTY_ANALYTICS
  return Object.freeze({ googleAnalyticsId: '', googleTagManagerId: '', histatsId: config.histatsId })
}

export function renderAnalyticsHead(config: AnalyticsConfig | undefined): string {
  if (!hasAnalytics(config)) return ''
  return `<meta name="gplayer-analytics" content="enabled" data-google-analytics-id="${escapeHtmlAttribute(config.googleAnalyticsId)}" data-google-tag-manager-id="${escapeHtmlAttribute(config.googleTagManagerId)}" data-histats-id="${escapeHtmlAttribute(config.histatsId)}">\n  <script defer src="/assets/js/gplayer-analytics.js"></script>`
}

export function renderAnalyticsNoScript(config: AnalyticsConfig | undefined): string {
  if (!hasAnalytics(config)) return ''
  const tagManager = config.googleTagManagerId === ''
    ? ''
    : `<iframe src="https://www.googletagmanager.com/ns.html?id=${encodeURIComponent(config.googleTagManagerId)}" height="0" width="0" hidden title="Google Tag Manager" referrerpolicy="no-referrer-when-downgrade"></iframe>`
  const histats = config.histatsId === ''
    ? ''
    : `<img src="https://sstatic1.histats.com/0.gif?${encodeURIComponent(config.histatsId)}&amp;101" alt="" width="1" height="1">`
  return `<noscript data-analytics-noscript>${tagManager}${histats}</noscript>`
}

export function analyticsCspSources(config: AnalyticsConfig | undefined): AnalyticsCspSources {
  if (!hasAnalytics(config)) return Object.freeze({ scripts: [], connections: [], images: [], frames: [] })
  const scripts: string[] = []
  const connections: string[] = []
  const images: string[] = []
  const frames: string[] = []

  if (config.googleAnalyticsId !== '') {
    scripts.push('https://www.googletagmanager.com')
    connections.push('https://www.google-analytics.com', 'https://analytics.google.com', 'https://*.google-analytics.com')
    images.push('https://www.google-analytics.com', 'https://*.google-analytics.com')
  }
  if (config.googleTagManagerId !== '') {
    scripts.push('https://www.googletagmanager.com', 'https:')
    connections.push('https://www.googletagmanager.com', 'https:')
    images.push('https://www.googletagmanager.com', 'https:')
    frames.push('https://www.googletagmanager.com', 'https:')
  }
  if (config.histatsId !== '') {
    scripts.push('https://s10.histats.com')
    connections.push('https://*.histats.com')
    images.push('https://*.histats.com')
  }

  return Object.freeze({
    scripts: Object.freeze([...new Set(scripts)]),
    connections: Object.freeze([...new Set(connections)]),
    images: Object.freeze([...new Set(images)]),
    frames: Object.freeze([...new Set(frames)])
  })
}

function normalizedGoogleAnalyticsId(value: unknown): string {
  const candidate = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return /^(?:G-[A-Z0-9]{5,32}|UA-[0-9]{4,10}-[0-9]{1,4})$/.test(candidate) ? candidate : ''
}

function normalizedGoogleTagManagerId(value: unknown): string {
  const candidate = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return /^GTM-[A-Z0-9]{4,32}$/.test(candidate) ? candidate : ''
}

function normalizedHistatsId(value: unknown): string {
  const candidate = typeof value === 'string' ? value.trim() : ''
  return /^[0-9]{1,20}$/.test(candidate) ? candidate : ''
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
