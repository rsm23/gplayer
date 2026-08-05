import type { GeoIpDetailsLookup } from '../security/geoip-details.js'

export type LoadBalancerSelectionQuery = Readonly<{
  host: string
  continent: string
  metric: 'connections' | 'playbacks'
  excludeUrl?: string
}>

export interface LoadBalancerSelectionStore {
  selectLoadBalancer(query: LoadBalancerSelectionQuery): Promise<string | null>
}

export type DeliveryBaseUrlSelection = Readonly<{
  clientIp: string
  host: string
  leastConnections: boolean
  excludeUrl?: string
}>

export type DeliveryBaseUrlSelector = (input: DeliveryBaseUrlSelection) => Promise<URL>

export class LoadBalancerSelector {
  private readonly fallback: URL

  public constructor(
    private readonly store: LoadBalancerSelectionStore,
    private readonly geoIpLookup: GeoIpDetailsLookup,
    fallback: URL
  ) {
    this.fallback = normalizedDeliveryUrl(fallback.toString()) ?? new URL(fallback)
  }

  public async select(input: DeliveryBaseUrlSelection): Promise<URL> {
    const host = normalizedHost(input.host)
    const excludeUrl = input.excludeUrl === undefined
      ? undefined
      : normalizedDeliveryUrl(input.excludeUrl)?.toString()
    const geo = await this.geoIpLookup(input.clientIp).catch(() => null)
    const continent = /^[A-Z]{2}$/.test(geo?.continent ?? '') ? String(geo?.continent) : ''

    try {
      const selected = await this.store.selectLoadBalancer({
        host,
        continent,
        metric: input.leastConnections ? 'connections' : 'playbacks',
        ...(excludeUrl === undefined ? {} : { excludeUrl })
      })
      return selected === null ? new URL(this.fallback) : normalizedDeliveryUrl(selected) ?? new URL(this.fallback)
    } catch {
      return new URL(this.fallback)
    }
  }
}

export function normalizedDeliveryUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') return null
    if (url.hostname === '' || url.search !== '' || url.hash !== '') return null
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
    return url
  } catch {
    return null
  }
}

function normalizedHost(value: string): string {
  const host = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9._-]{0,99}$/.test(host) ? host : ''
}
