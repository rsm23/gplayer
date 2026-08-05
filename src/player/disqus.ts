import type { GeneralSettings } from '../settings/settings-admin-service.js'

export type DisqusConfig = Readonly<{
  shortname: string
  pageUrl: string
  pageIdentifier: string
}>

export function disqusConfig(
  settings: Pick<GeneralSettings, 'disqus_shortname'>,
  baseUrl: URL
): DisqusConfig | null {
  const shortname = normalizedShortname(settings.disqus_shortname)
  if (shortname === '') return null
  const pageUrl = new URL(baseUrl)
  if (!['http:', 'https:'].includes(pageUrl.protocol) || pageUrl.username !== '' || pageUrl.password !== '') return null
  pageUrl.search = ''
  pageUrl.hash = ''
  return Object.freeze({ shortname, pageUrl: pageUrl.href, pageIdentifier: pageUrl.href })
}

export function renderDisqus(config: DisqusConfig | null): string {
  if (config === null) return ''
  return `<section class="runtime-comments" aria-label="Comments" data-disqus-config data-disqus-shortname="${escapeHtmlAttribute(config.shortname)}" data-disqus-page-url="${escapeHtmlAttribute(config.pageUrl)}" data-disqus-page-identifier="${escapeHtmlAttribute(config.pageIdentifier)}">
      <header><p class="section-index">Community</p><h2>Join the discussion.</h2></header>
      <div id="disqus_thread"></div>
      <noscript>Please enable JavaScript to view the <a href="https://disqus.com/?ref_noscript" rel="noopener noreferrer">comments powered by Disqus.</a></noscript>
      <script defer src="/assets/js/gplayer-disqus.js"></script>
    </section>`
}

export function disqusCsp(config: DisqusConfig | null): Readonly<{
  scripts: readonly string[]
  connections: readonly string[]
  images: readonly string[]
  frames: readonly string[]
}> {
  if (config === null) return Object.freeze({ scripts: [], connections: [], images: [], frames: [] })
  return Object.freeze({
    scripts: Object.freeze([`https://${config.shortname}.disqus.com`, 'https://c.disquscdn.com']),
    connections: Object.freeze(['https://disqus.com', 'https://*.disqus.com']),
    images: Object.freeze(['https://disqus.com', 'https://*.disqus.com', 'https://*.disquscdn.com']),
    frames: Object.freeze(['https://disqus.com', 'https://*.disqus.com'])
  })
}

function normalizedShortname(value: unknown): string {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(candidate) ? candidate : ''
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
