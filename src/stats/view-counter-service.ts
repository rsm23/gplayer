import { isIP } from 'node:net'
import type { PlayerMediaQuery } from '../core/player-query.js'
import type { GeoIpDetails, GeoIpDetailsLookup } from '../security/geoip-details.js'

export type ViewCounterWrite = Readonly<{
  media: PlayerMediaQuery
  clientIp: string
  userAgent: string
  maximum: number
  created: number
  since: number
  geo: GeoIpDetails | null
}>

export interface ViewCounterStore {
  capture(input: ViewCounterWrite): Promise<string | null>
}

export type ViewCounterCapture = Readonly<{
  media: PlayerMediaQuery
  clientIp: string
  userAgent: string
  maximum: number
}>

export class ViewCounterService {
  private readonly now: () => number

  public constructor(
    private readonly store: ViewCounterStore,
    private readonly lookup: GeoIpDetailsLookup,
    options: Readonly<{ now?: () => number }> = {}
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  }

  public async capture(input: ViewCounterCapture): Promise<string | null> {
    const clientIp = normalizedIp(input.clientIp)
    if (clientIp === null || !usableMedia(input.media)) return null
    const maximum = boundedMaximum(input.maximum)
    const created = this.now()
    const geo = await this.lookup(clientIp).catch(() => null)
    return await this.store.capture(Object.freeze({
      media: input.media,
      clientIp,
      userAgent: input.userAgent.slice(0, 255),
      maximum,
      created,
      since: created - 86_400,
      geo
    }))
  }
}

function normalizedIp(value: string): string | null {
  const candidate = value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value
  return isIP(candidate) === 0 || candidate.length > 45 ? null : candidate
}

function boundedMaximum(value: number): number {
  return Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000 ? value : 1
}

function usableMedia(media: PlayerMediaQuery): boolean {
  if (media.id === undefined || media.id === '') return false
  return media.source === 'db' || (media.host !== undefined && media.host !== '')
}
