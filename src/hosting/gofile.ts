import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient, ProviderHttpResponse } from './provider-http.js'

const API_URL = 'https://api.gofile.io'
const WEBSITE_TOKEN = '194e67cc5b84f3969cc86e2e311eae2d7ebfc693408117864a840cb4048e547e'

type JsonObject = Record<string, unknown>

export class GofileExtractor extends BaseExtractor {
  #loaded = false

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || this.id.length === 0) return
    this.#loaded = true
    try {
      const accountResponse = await this.http.post({ url: `${API_URL}/accounts` })
      const accountToken = responseToken(accountResponse)
      if (accountToken === '') return

      const websiteResponse = await this.http.get({
        url: `${API_URL}/accounts/website`,
        headers: { authorization: `Bearer ${accountToken}` }
      })
      const websiteAccountToken = responseToken(websiteResponse)
      if (websiteAccountToken === '') return

      const accountCookie = `accountToken=${websiteAccountToken}`
      this.cookies = [accountCookie]
      await this.http.get({
        url: 'https://gofile.io/contents/filemanager.html',
        headers: { cookie: accountCookie }
      })

      const endpoint = new URL(`${API_URL}/contents/${encodeURIComponent(this.id)}`)
      endpoint.search = new URLSearchParams({
        contentFilter: '',
        page: '1',
        pageSize: '1000',
        sortField: 'name',
        sortDirection: '1'
      }).toString()
      const contentResponse = await this.http.get({
        url: endpoint,
        headers: {
          authorization: `Bearer ${websiteAccountToken}`,
          'x-bl': 'en',
          'x-website-token': WEBSITE_TOKEN
        }
      })
      const child = firstContentChild(contentResponse)
      if (child === null || typeof child.link !== 'string') return
      const file = safeHttpUrl(child.link)
      if (file === '') return

      this.title = typeof child.name === 'string' ? child.name : ''
      this.image = typeof child.thumbnail === 'string' ? safeHttpUrl(child.thumbnail) : ''
      this.sources.push({ file, type: 'video/mp4', label: 'Original' })
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
    }
  }
}

function responseToken(response: ProviderHttpResponse): string {
  if (response.status < 200 || response.status >= 300) return ''
  const root = parseObject(response.body)
  const data = objectValue(root?.data)
  return typeof data?.token === 'string' ? safeToken(data.token) : ''
}

function firstContentChild(response: ProviderHttpResponse): JsonObject | null {
  if (response.status < 200 || response.status >= 300) return null
  const root = parseObject(response.body)
  if (root?.status !== 'ok') return null
  const data = objectValue(root.data)
  const children = objectValue(data?.children)
  if (children === null) return null
  return Object.values(children).map(objectValue).find((value) => value !== null) ?? null
}

function parseObject(value: string): JsonObject | null {
  try {
    return objectValue(JSON.parse(value))
  } catch {
    return null
  }
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
}

function safeToken(value: string): string {
  const token = value.trim()
  return token.length <= 2_048 && /^[A-Za-z0-9._~-]+$/.test(token) ? token : ''
}

function safeHttpUrl(value: string): string {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.toString()
      : ''
  } catch {
    return ''
  }
}
