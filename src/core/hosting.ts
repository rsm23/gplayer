import { legacyHostingData, type HostingData } from './hosting-data.js'

const fullPathHosts = new Set(['cloudmailru', 'facebook', 'mediacm', 'navertv', 'rumble', 'tiktok', 'wetransfer'])
const fullPathQueryHosts = new Set(['googlephotos'])
const lastPathHosts = new Set(['amazon', 'archive', 'dailymotion', 'dropload', 'dzen', 'gofile', 'lulustream', 'mymailru', 'pixeldrain', 'sendvid', 'streamable', 'supervideo', 'uqload', 'vidmoly', 'vimeo', 'voe', 'vtube', 'vudeo', 'yadisk', 'yourupload', 'vk', 'savefiles', 'streamhg', 'embedtv', 'embedtv2'])
const onePathHosts = new Set(['vidara', 'aparat', 'cyberfile', 'dood', 'filemail', 'filemoon', 'krakenfiles', 'mediafire', 'mixdrop', 'okru', 'streamtape', 'turboviplay', 'vidyard', 'earnvids', 'nossoplayer'])
const zeroPathHosts = new Set(['cyberfile', 'fileupload', 'fireload', 'goodstream', 'hexupload', 'hxfile', 'iceyfile', 'mp4upload', 'sibnet', 'streama2z', 'udrop', 'vidoza', 'vidtube', 'thetube'])
const queryIdHosts = new Set(['brplayer', 'ecast123', 'youtube'])
const removeFromId = ['embed-', '-600x450', 'file/', '/view', 'video/embed/', '.html', '.htm']

function tryUrl(input: string): URL | undefined {
  try {
    return new URL(input)
  } catch {
    return undefined
  }
}

function isHttpUrl(input: string): boolean {
  const parsed = tryUrl(input)
  return parsed?.protocol === 'http:' || parsed?.protocol === 'https:'
}

function driveId(input: string): string {
  const parsed = tryUrl(input)
  if (!parsed) return input

  const pathMatch = parsed.pathname.match(/\/(?:file\/d|d)\/([^/]+)/)
  return pathMatch?.[1] ?? parsed.searchParams.get('id') ?? parsed.searchParams.get('fileId') ?? input
}

function firstMatchingHost(domain: string, data: HostingData): string {
  const replacementMap = new Map<string, string>()
  for (const [host, aliases] of Object.entries(data.hostnames)) {
    for (const alias of aliases) {
      const normalized = alias.trim().toLowerCase()
      if (normalized !== '') replacementMap.set(normalized, `${host.toLowerCase()}.`)
    }
  }
  const replacements = [...replacementMap.entries()]
  const normalizedDomain = replaceHostnameAliases(domain.toLowerCase(), replacements).replace(/^www\./, '')
  const compactDomain = normalizedDomain.replaceAll('.', '')
  const hosts = Object.keys(data.hostnames).map((host) => host.toLowerCase())

  if (hosts.includes(normalizedDomain)) return normalizedDomain
  if (hosts.includes(compactDomain)) return compactDomain

  const domainParts = normalizedDomain.split('.')
  return hosts.find((host) => domainParts.includes(host)) ?? 'direct'
}

function replaceHostnameAliases(domain: string, replacements: readonly (readonly [string, string])[]): string {
  const candidates = [...replacements].sort(([left], [right]) => right.length - left.length)
  let result = ''
  for (let index = 0; index < domain.length;) {
    const match = candidates.find(([alias]) => domain.startsWith(alias, index))
    if (match === undefined) {
      result += domain[index]
      index += 1
    } else {
      result += match[1]
      index += match[0].length
    }
  }
  return result
}

function specialHost(url: string, detectedHost: string): string {
  const peerTubePath = ['/w/', '/videos/watch/', '/videos/embed/'].some((part) => url.includes(part))
  if (!url.includes('vidmoly') && !url.includes('rumble') && peerTubePath) return 'peertube'
  if (url.includes('rumble.cloud') || (url.includes('cloud.mail.ru') && url.includes('weblink/view'))) return 'direct'
  if (url.includes('archive.org') && url.includes('/download/')) return 'direct'
  return detectedHost
}

export class Hosting {
  #url = ''
  #host = 'direct'
  #id = ''

  public constructor(url = '', private readonly data: HostingData = legacyHostingData) {
    this.setURL(url)
  }

  public setURL(url = ''): this {
    this.#url = url.trim()
    this.#id = this.#url
    const parsed = tryUrl(this.#url)
    this.#host = specialHost(this.#url, parsed ? firstMatchingHost(parsed.hostname, this.data) : 'direct')
    this.#id = this.extractId(parsed)
    return this
  }

  public setHost(host = ''): this {
    this.#host = host.trim().toLowerCase()
    return this
  }

  public setID(id = ''): this {
    this.#id = id.trim()
    return this
  }

  public getHost(): string {
    return this.#host.trim()
  }

  public getID(): string {
    if (this.#host === 'direct') return this.#id.trim().replace(/^[ \\/?&#\n\r\t\v\0]+|[ \\/?&#\n\r\t\v\0]+$/g, '')
    return removeFromId.reduce((id, part) => id.replaceAll(part, ''), this.#id)
  }

  public getDownloadLink(): string {
    let result: string
    if (this.#host === 'blogger' && !isHttpUrl(this.#id)) result = `https://www.blogger.com/video.g?token=${this.#id}`
    else if (this.#host === 'googlephotos' && !this.#id.includes('key=')) result = `https://photos.app.goo.gl/${this.#id.replace(/^\/+/, '')}`
    else if (this.#host === 'mymailru' && !/^\d+$/.test(this.#id)) result = `https://my.mail.ru/${this.#id}`
    else if (this.#host === 'onedrive') result = this.onedriveDownloadUrl()
    else if (this.#host === 'sibnet' && /^\d+$/.test(this.#id)) result = `https://video.sibnet.ru/shell.php?videoid=${this.#id}`
    else if (this.#host === 'wetransfer') result = this.weTransferDownloadUrl()
    else if (this.#host === 'yadisk' && this.#id.includes('d/')) result = `https://disk.yandex.com/${this.#id}`
    else result = this.#id

    if (!isHttpUrl(result)) {
      const pattern = this.data.downloadUrls[this.#host]
      if (pattern) result = pattern.replace('%s', this.#id.replace(/^\/+/, ''))
    }

    return result.trim()
  }

  private extractId(parsed: URL | undefined): string {
    if (this.#host === 'direct' || !parsed) return this.#url

    const path = parsed.pathname.replace(/^\/+|\/+$/g, '')
    const pathParts = path.split('/').filter(Boolean)
    const query = parsed.search.replace(/^\?/, '')

    if (this.#host === 'gdrive') return driveId(this.#url)
    if (this.#host === 'dzen' && this.#url.includes('.dzen.ru')) return this.#url

    if (query) {
      if (queryIdHosts.has(this.#host)) return parsed.searchParams.get('id') ?? parsed.searchParams.get('v') ?? ''
      if (this.#host === 'blogger' && parsed.searchParams.has('token')) return parsed.searchParams.get('token') ?? ''
      if (this.#host === 'sibnet' && parsed.searchParams.has('videoid')) return parsed.searchParams.get('videoid') ?? ''
      if (this.#host === 'vk' && parsed.searchParams.has('z')) return parsed.searchParams.get('z') ?? ''
      if (this.#host === 'gocast2' && parsed.searchParams.has('live')) return parsed.searchParams.get('live') ?? ''
      if (this.#host === 'dailymotion' && parsed.searchParams.has('video')) return parsed.searchParams.get('video') ?? ''
    }
    if (this.#host === 'yadisk' && this.#url.includes('d/')) return path
    if (this.#host === 'mymailru' && this.#url.includes('/mail/')) return path
    if (fullPathHosts.has(this.#host)) return path
    if (fullPathQueryHosts.has(this.#host) || (this.#url.includes('reviews/') && this.#url.includes('item='))) return `${path}${query ? `?${query}` : ''}`
    if (zeroPathHosts.has(this.#host)) return pathParts[0] ?? ''
    if (onePathHosts.has(this.#host)) return pathParts[1] ?? ''
    if (lastPathHosts.has(this.#host) || this.#url.includes('youtu.be')) return pathParts.at(-1) ?? ''
    // The legacy method leaves the ID initialized to the original URL when no
    // provider-specific path/query rule matches (for example Dropbox, pCloud,
    // Files.fm, MStream, SoundCloud, and dynamically detected PeerTube URLs).
    return this.#url
  }

  private onedriveDownloadUrl(): string {
    if (isHttpUrl(this.#id)) return this.#id
    return `https://onedrive.live.com/${this.#id.includes('parId') ? `?${this.#id}` : `embed?${this.#id}`}`
  }

  private weTransferDownloadUrl(): string {
    let base = 'https://we.tl/'
    if (this.#id.includes('reviews/')) base = 'https://portals.wetransfer.com/'
    else if (this.#id.includes('board/')) base = 'https://collect.wetransfer.com/'
    else if (this.#id.includes('downloads/')) base = 'https://wetransfer.com/'
    return `${base}${this.#id}`
  }
}
