import path from 'node:path'
import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient, ProviderHttpResponse } from './provider-http.js'

const WETRANSFER_ORIGIN = 'https://wetransfer.com'
const WETRANSFER_SHORT_ORIGIN = 'https://we.tl'
const COLLECT_ORIGIN = 'https://collect.wetransfer.com'
const COLLECT_API_ORIGIN = 'https://api.wetransfermobile.com'
const COLLECT_SIGNATURE = '1b24adbf8359e427ceaf4c0dcdee43d631355131fad534bdf3a9bac160a71'
const COLLECT_PAGE_SIZE = 20
const MAX_COLLECT_ITEMS = 2_000

type JsonObject = Record<string, unknown>

export type WetransferTarget =
  | Readonly<{ kind: 'normal', transferId: string, securityHash: string, referer: string }>
  | Readonly<{ kind: 'short', token: string, referer: string }>
  | Readonly<{ kind: 'collect', collectionId: string, itemId: string, referer: string }>
  | Readonly<{ kind: 'portals', reviewId: string, itemId: string, referer: string }>

export class WetransferExtractor extends BaseExtractor {
  #loaded = false
  readonly #target: WetransferTarget | null

  public constructor(id: string, private readonly http: ProviderHttpClient) {
    super(id.trim())
    this.#target = parseWetransferTarget(this.id)
    this.referer = this.#target?.referer ?? ''
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  private async load(): Promise<void> {
    if (this.#loaded || this.#target === null) return
    this.#loaded = true

    try {
      let target = this.#target
      if (target.kind === 'short') {
        const response = await this.http.head({ url: target.referer })
        if (response.status < 200 || response.status >= 400) return
        target = parseWetransferTarget(response.url.toString()) ?? target
        if (target.kind !== 'normal') return
        this.referer = target.referer
      }

      if (target.kind === 'normal') await this.loadNormalTransfer(target)
      else if (target.kind === 'collect') await this.loadCollectItem(target)
      // WeTransfer removed Reviews and Portals, including all hosted content, in December 2025.
      // Retired review URLs remain recognized but no longer have a media API to resolve.
    } catch {
      // Invalid, expired, password-protected, or unavailable transfers produce an empty result.
    }
  }

  private async loadNormalTransfer(target: Extract<WetransferTarget, { kind: 'normal' }>): Promise<void> {
    const headers = { 'content-type': 'application/json', referer: target.referer }
    const prepare = await this.http.post({
      url: `${WETRANSFER_ORIGIN}/api/v4/transfers/${encodeURIComponent(target.transferId)}/prepare-download`,
      headers,
      body: JSON.stringify({ security_hash: target.securityHash })
    })
    if (!isWetransferResponse(prepare)) return

    const payload = parseObject(prepare.body)
    if (payload === null) return
    const transfer = objectValue(payload.transfer) ?? payload
    const item = firstTransferFile(transfer)
    if (item === null) {
      this.addSource(stringValue(payload.direct_link), stringValue(transfer.display_name))
      return
    }

    const download = await this.http.post({
      url: `${WETRANSFER_ORIGIN}/api/v4/transfers/${encodeURIComponent(target.transferId)}/download`,
      headers,
      body: JSON.stringify({
        security_hash: target.securityHash,
        intent: 'single_file',
        file_ids: [item.id]
      })
    })
    if (!isWetransferResponse(download)) return
    const result = parseObject(download.body)
    this.addSource(stringValue(result?.direct_link), item.name)
  }

  private async loadCollectItem(target: Extract<WetransferTarget, { kind: 'collect' }>): Promise<void> {
    const headers = collectHeaders()
    const collectionResponse = await this.http.get({
      url: `${COLLECT_API_ORIGIN}/v2/web/collections/${encodeURIComponent(target.collectionId)}/public`,
      headers
    })
    if (!isCollectResponse(collectionResponse)) return
    const collection = parseObject(collectionResponse.body)
    if (collection === null) return

    let item = findCollectItem(arrayValue(collection.items), target.itemId)
    const totalItems = boundedInteger(collection.total_items, MAX_COLLECT_ITEMS)
    for (let offset = 0; item === null && offset < Math.max(totalItems, COLLECT_PAGE_SIZE); offset += COLLECT_PAGE_SIZE) {
      const itemsResponse = await this.http.get({
        url: `${COLLECT_API_ORIGIN}/v2/web/collections/${encodeURIComponent(target.collectionId)}/public/items?offset=${offset}`,
        headers
      })
      if (!isCollectResponse(itemsResponse)) return
      const body = parseJson(itemsResponse.body)
      const items = Array.isArray(body) ? body : arrayValue(objectValue(body)?.items)
      item = findCollectItem(items, target.itemId)
      if (items.length < COLLECT_PAGE_SIZE) break
    }
    if (item === null) return

    const downloadResponse = await this.http.post({
      url: `${COLLECT_API_ORIGIN}/v2/web/downloads/${encodeURIComponent(target.collectionId)}/public`,
      headers,
      body: JSON.stringify({ file_ids: [item.id] })
    })
    if (!isCollectResponse(downloadResponse)) return
    const download = parseObject(downloadResponse.body)
    this.addSource(stringValue(download?.download_url), item.name)
  }

  private addSource(value: string, fallbackName: string): void {
    const file = safeMediaUrl(value)
    if (file === '') return
    const pathname = new URL(file).pathname
    this.sources.push({ file, type: mediaType(pathname || fallbackName), label: 'Original' })
    this.title = decodedBasename(pathname) || fallbackName.trim()
  }
}

export function parseWetransferTarget(value: string): WetransferTarget | null {
  const trimmed = value.trim().replaceAll('&amp;', '&')
  if (trimmed === '' || trimmed.length > 2_048) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    const pathValue = trimmed.replace(/^\/+/, '')
    const origin = pathValue.startsWith('board/')
      ? COLLECT_ORIGIN
      : pathValue.startsWith('reviews/')
        ? 'https://portals.wetransfer.com'
        : pathValue.startsWith('downloads/')
          ? WETRANSFER_ORIGIN
          : WETRANSFER_SHORT_ORIGIN
    try {
      url = new URL(`/${pathValue}`, origin)
    } catch {
      return null
    }
  }

  if (url.protocol !== 'https:' || url.username || url.password) return null
  const hostname = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean).map(decodeSegment)
  if (hostname === 'we.tl' || hostname === 'www.we.tl') {
    const token = parts[0] ?? ''
    return isSafeIdentifier(token)
      ? Object.freeze({ kind: 'short', token, referer: `${WETRANSFER_SHORT_ORIGIN}/${encodeURIComponent(token)}` })
      : null
  }
  if (hostname === 'wetransfer.com' || hostname === 'www.wetransfer.com') {
    const [prefix, transferId = '', securityHash = ''] = parts
    return prefix === 'downloads' && isSafeIdentifier(transferId) && isSafeIdentifier(securityHash)
      ? Object.freeze({
          kind: 'normal',
          transferId,
          securityHash,
          referer: `${WETRANSFER_ORIGIN}/downloads/${encodeURIComponent(transferId)}/${encodeURIComponent(securityHash)}`
        })
      : null
  }
  if (hostname === 'collect.wetransfer.com') {
    const [prefix, collectionId = '', itemId = ''] = parts
    return prefix === 'board' && isSafeIdentifier(collectionId) && isSafeIdentifier(itemId)
      ? Object.freeze({
          kind: 'collect',
          collectionId,
          itemId,
          referer: `${COLLECT_ORIGIN}/board/${encodeURIComponent(collectionId)}/${encodeURIComponent(itemId)}`
        })
      : null
  }
  if (hostname === 'portals.wetransfer.com') {
    const [prefix, reviewId = ''] = parts
    const itemId = url.searchParams.get('item') ?? ''
    return prefix === 'reviews' && isSafeIdentifier(reviewId) && isSafeIdentifier(itemId)
      ? Object.freeze({
          kind: 'portals',
          reviewId,
          itemId,
          referer: `https://portals.wetransfer.com/reviews/${encodeURIComponent(reviewId)}?item=${encodeURIComponent(itemId)}`
        })
      : null
  }
  return null
}

function firstTransferFile(payload: JsonObject): Readonly<{ id: string, name: string }> | null {
  const items = [...arrayValue(payload.items), ...arrayValue(payload.files)]
  for (const value of items) {
    const item = objectValue(value)
    const nestedFile = objectValue(item?.file)
    const itemType = stringValue(item?.item_type) || stringValue(item?.apiType)
    if (itemType !== '' && itemType !== 'file') continue
    const id = stringValue(item?.id) || stringValue(nestedFile?.id)
    if (!isSafeIdentifier(id)) continue
    const name = stringValue(item?.name) || stringValue(item?.filename) ||
      stringValue(nestedFile?.name) || stringValue(nestedFile?.filename)
    return Object.freeze({ id, name })
  }
  return null
}

function findCollectItem(values: readonly unknown[], wantedId: string): Readonly<{ id: string, name: string }> | null {
  for (const value of values) {
    const item = objectValue(value)
    const id = stringValue(item?.id)
    if (id !== wantedId || stringValue(item?.content_identifier) !== 'file') continue
    return Object.freeze({ id, name: stringValue(item?.name) || stringValue(item?.filename) })
  }
  return null
}

function collectHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({
    'content-type': 'application/json',
    origin: COLLECT_ORIGIN,
    referer: `${COLLECT_ORIGIN}/`,
    'x-origin': COLLECT_ORIGIN,
    'x-signature': COLLECT_SIGNATURE
  })
}

function isWetransferResponse(response: ProviderHttpResponse): boolean {
  const hostname = response.url.hostname.toLowerCase()
  return response.status >= 200 && response.status < 300 &&
    (hostname === 'wetransfer.com' || hostname === 'www.wetransfer.com')
}

function isCollectResponse(response: ProviderHttpResponse): boolean {
  return response.status >= 200 && response.status < 300 &&
    response.url.hostname.toLowerCase() === 'api.wetransfermobile.com'
}

function safeMediaUrl(value: string): string {
  if (value === '' || value.length > 16_384) return ''
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : ''
  } catch {
    return ''
  }
}

function mediaType(filename: string): 'hls' | 'mpd' | 'video/mp4' {
  const extension = path.posix.extname(filename).toLowerCase()
  if (extension === '.m3u8') return 'hls'
  if (extension === '.mpd') return 'mpd'
  return 'video/mp4'
}

function decodedBasename(value: string): string {
  const basename = path.posix.basename(value)
  try {
    return decodeURIComponent(basename).trim()
  } catch {
    return basename.trim()
  }
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input)
  } catch {
    return null
  }
}

function parseObject(input: string): JsonObject | null {
  return objectValue(parseJson(input))
}

function objectValue(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function boundedInteger(value: unknown, maximum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : 0
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return ''
  }
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{2,256}$/.test(value)
}
