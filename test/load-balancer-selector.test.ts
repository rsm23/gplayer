import { describe, expect, it, vi } from 'vitest'
import {
  LoadBalancerSelector,
  normalizedDeliveryUrl,
  type LoadBalancerSelectionQuery,
  type LoadBalancerSelectionStore
} from '../src/load-balancers/load-balancer-selector.js'

class MemorySelectionStore implements LoadBalancerSelectionStore {
  public readonly queries: LoadBalancerSelectionQuery[] = []
  public selected: string | null = 'https://edge.example/media/'

  public async selectLoadBalancer(query: LoadBalancerSelectionQuery): Promise<string | null> {
    this.queries.push(query)
    return this.selected
  }
}

describe('load-balancer delivery selection', () => {
  it('maps GeoIP continent, host, exclusion, and least-connections mode into the legacy selector contract', async () => {
    const store = new MemorySelectionStore()
    const lookup = vi.fn(async () => Object.freeze({ asn: 64500, organization: 'Example', country: 'FR', continent: 'EU' }))
    const selector = new LoadBalancerSelector(store, lookup, new URL('https://player.example/'))

    await expect(selector.select({
      clientIp: '203.0.113.9',
      host: 'YouTube',
      leastConnections: true,
      excludeUrl: 'https://EDGE-OLD.example/path'
    })).resolves.toEqual(new URL('https://edge.example/media/'))
    expect(lookup).toHaveBeenCalledWith('203.0.113.9')
    expect(store.queries).toEqual([{
      host: 'youtube',
      continent: 'EU',
      metric: 'connections',
      excludeUrl: 'https://edge-old.example/path/'
    }])
  })

  it('orders by cached playbacks by default and falls back for missing, invalid, or failed selections', async () => {
    const store = new MemorySelectionStore()
    const selector = new LoadBalancerSelector(store, async () => null, new URL('https://player.example/root/'))
    store.selected = null
    await expect(selector.select({ clientIp: 'bad', host: '../unsafe', leastConnections: false })).resolves.toEqual(new URL('https://player.example/root/'))
    expect(store.queries[0]).toEqual({ host: '', continent: '', metric: 'playbacks' })

    store.selected = 'https://user:secret@edge.example/'
    await expect(selector.select({ clientIp: 'bad', host: 'direct', leastConnections: false })).resolves.toEqual(new URL('https://player.example/root/'))
    store.selectLoadBalancer = async () => { throw new Error('database unavailable') }
    await expect(selector.select({ clientIp: 'bad', host: 'direct', leastConnections: false })).resolves.toEqual(new URL('https://player.example/root/'))
  })

  it('accepts only normalized HTTP delivery origins without credentials, queries, or fragments', () => {
    expect(normalizedDeliveryUrl('HTTPS://EDGE.EXAMPLE/path')).toEqual(new URL('https://edge.example/path/'))
    expect(normalizedDeliveryUrl('https://edge.example/?secret=1')).toBeNull()
    expect(normalizedDeliveryUrl('file:///tmp/video')).toBeNull()
  })
})
