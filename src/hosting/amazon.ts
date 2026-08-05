import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient } from './provider-http.js'

const BASE_URL = 'https://www.amazon.com'

type JsonObject = Record<string, unknown>

export type AmazonExtractorOptions = Readonly<{
  now?: () => number
}>

export class AmazonExtractor extends BaseExtractor {
  #loaded = false

  public constructor(
    id: string,
    private readonly http: ProviderHttpClient,
    private readonly options: AmazonExtractorOptions = {}
  ) {
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
      const timestamp = String(Math.floor((this.options.now?.() ?? Date.now()) / 1_000))
      const shareUrl = new URL(`/drive/v1/shares/${encodeURIComponent(this.id)}`, BASE_URL)
      shareUrl.search = new URLSearchParams({
        shareId: this.id,
        resourceVersion: 'V2',
        ContentType: 'JSON',
        _: timestamp
      }).toString()
      const shareResponse = await this.http.get({ url: shareUrl })
      const share = responseObject(shareResponse.status, shareResponse.body)
      const nodeInfo = objectValue(share?.nodeInfo)
      const nodeId = typeof nodeInfo?.id === 'string' ? nodeInfo.id.trim() : ''
      if (nodeId === '') return

      const childrenUrl = new URL(`/drive/v1/nodes/${encodeURIComponent(nodeId)}/children`, BASE_URL)
      childrenUrl.search = new URLSearchParams({
        asset: 'ALL',
        limit: '1',
        searchOnFamily: 'false',
        tempLink: 'true',
        shareId: this.id,
        offset: '0',
        resourceVersion: 'V2',
        ContentType: 'JSON',
        _: timestamp
      }).toString()
      const childrenResponse = await this.http.get({ url: childrenUrl })
      this.parseChildren(childrenResponse.status, childrenResponse.body)
    } catch {
      // Upstream failures produce an empty source list, matching the legacy extractor contract.
    }
  }

  private parseChildren(status: number, body: string): void {
    const root = responseObject(status, body)
    if (typeof root?.count !== 'number' || root.count <= 0 || !Array.isArray(root.data)) return
    const item = objectValue(root.data[0])
    if (item === null) return
    this.title = typeof item.name === 'string' ? item.name : ''

    const assets = Array.isArray(item.assets) ? item.assets.map(objectValue).filter((value) => value !== null) : []
    if (assets.length === 0) {
      this.appendVideo(item)
      return
    }

    for (const asset of assets) {
      const properties = objectValue(asset.contentProperties)
      const contentType = typeof properties?.contentType === 'string' ? properties.contentType.toLowerCase() : ''
      if (asset.status === 'AVAILABLE' && contentType.includes('video/')) this.appendVideo(asset)
      else if (contentType.includes('image/')) this.image = ownerLink(asset)
    }
  }

  private appendVideo(value: JsonObject): void {
    const file = ownerLink(value)
    if (file === '') return
    const properties = objectValue(value.contentProperties)
    const video = objectValue(properties?.video)
    const height = typeof video?.height === 'number' || typeof video?.height === 'string' ? String(video.height) : ''
    this.sources.push({ file, type: 'video/mp4', label: `${height}p` })
  }
}

function ownerLink(value: JsonObject): string {
  const tempLink = typeof value.tempLink === 'string' ? value.tempLink : ''
  const ownerId = typeof value.ownerId === 'string' ? value.ownerId : ''
  if (tempLink === '' || ownerId === '') return ''
  return safeHttpUrl(`${tempLink}?ownerId=${ownerId}`)
}

function responseObject(status: number, value: string): JsonObject | null {
  if (status < 200 || status >= 300) return null
  try {
    return objectValue(JSON.parse(value))
  } catch {
    return null
  }
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
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
