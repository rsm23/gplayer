import { Hosting } from '../core/hosting.js'
import { buildPlayerQuery, type PlayerMediaQuery } from '../core/player-query.js'
import type { Security } from '../security/security.js'

export type PlayerLinkGeneratorOptions = Readonly<{
  baseUrl: URL
  embedSlug: string
  downloadSlug: string
  requestSlug: string
  iframeCode?: string
}>

export type CreatePlayerInput = Readonly<{
  id: string
  aid?: string
  poster?: string
  sub?: readonly string[]
  lang?: readonly string[]
  subs?: string
  uid?: string
}>

export type GeneratedPlayerLinks = Readonly<{
  query: PlayerMediaQuery
  queryString: string
  token: string
  embedUrl: string
  downloadUrl: string
  requestUrl: string
  embedCode: string
}>

export class PlayerLinkGenerator {
  public constructor(
    private readonly security: Security,
    private readonly options: PlayerLinkGeneratorOptions
  ) {}

  public generate(input: CreatePlayerInput): GeneratedPlayerLinks {
    const mainUrl = requiredHttpUrl(input.id, 'Main video URL')
    const main = new Hosting(mainUrl)
    const query: {
      host: string
      id: string
      ahost?: string
      aid?: string
      poster?: string
      sub?: readonly string[]
      lang?: readonly string[]
      subs?: string
      uid?: string
    } = {
      host: main.getHost(),
      id: main.getID()
    }

    if (input.aid !== undefined && input.aid.trim().length > 0) {
      const alternative = new Hosting(requiredHttpUrl(input.aid, 'Alternative video URL'))
      query.ahost = alternative.getHost()
      query.aid = alternative.getID()
    }

    if (input.poster !== undefined && input.poster.trim().length > 0) {
      query.poster = requiredHttpUrl(input.poster, 'Poster URL')
    } else {
      // The PHP generator includes an empty poster value in every generated query.
      query.poster = ''
    }

    const subtitles = (input.sub ?? []).map((url) => requiredHttpUrl(url, 'Subtitle URL'))
    const labels = (input.lang ?? []).map((label) => label.trim()).filter(Boolean)
    if (subtitles.length > 0) {
      query.sub = subtitles
      query.lang = subtitles.map((_, index) => labels[index] ?? `Subtitle ${index + 1}`)
    }
    if (input.subs !== undefined && input.subs.trim().length > 0) {
      query.subs = requiredHttpUrl(input.subs, 'Subtitle URL')
    }
    if (input.uid !== undefined && /^\d+$/.test(input.uid)) query.uid = input.uid

    const queryString = buildPlayerQuery(query)
    const token = this.security.encryptURL(queryString)
    const embedUrl = routeUrl(this.options.baseUrl, this.options.embedSlug, token)
    const downloadUrl = routeUrl(this.options.baseUrl, this.options.downloadSlug, token)
    const requestUrl = routeUrl(this.options.baseUrl, this.options.requestSlug, queryString)

    return Object.freeze({
      query: Object.freeze(query),
      queryString,
      token,
      embedUrl,
      downloadUrl,
      requestUrl,
      embedCode: createIframe(embedUrl, '', this.options.iframeCode)
    })
  }
}

export function createIframe(embedUrl: string, title = '', template?: string): string {
  if (template !== undefined && template.includes('{embed_url}') && template.includes('{title}')) {
    return template
      .replaceAll('{embed_url}', escapeHtmlAttribute(embedUrl))
      .replaceAll('{title}', escapeHtmlAttribute(title))
  }
  return `<iframe title="${escapeHtmlAttribute(title)}" src="${escapeHtmlAttribute(embedUrl)}" loading="lazy" frameborder="0" width="640" height="320" scrolling="no" allow="fullscreen; accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; geolocation; web-share; screen-wake-lock; idle-detection"></iframe>`
}

function requiredHttpUrl(value: string, label: string): string {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new Error(`${label} must be a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTP or HTTPS`)
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error(`${label} cannot contain credentials`)
  }
  return parsed.toString()
}

function routeUrl(baseUrl: URL, slug: string, query: string): string {
  const url = new URL(`${slug.replace(/^\/+|\/+$/g, '')}/`, ensureTrailingSlash(baseUrl))
  url.search = query
  return url.toString()
}

function ensureTrailingSlash(url: URL): URL {
  const result = new URL(url)
  if (!result.pathname.endsWith('/')) result.pathname += '/'
  return result
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
