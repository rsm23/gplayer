import type { PrivateCacheManager } from './private-cache-manager.js'
import { systemStatusSnapshot, type SystemInspector, type SystemStatusSnapshot } from './system-inspector.js'

const CACHE_CLEAR_FAIL = 'The cache failed to clear or does not exist'
const CACHE_CLEAR_SUCCESS = 'The cache has been cleared successfully'

export type PrivateCacheIdentity = Readonly<{ host: string; hostId: string }>

export type PrivateVideoCacheClear = Readonly<{
  found: boolean
  identities: readonly PrivateCacheIdentity[]
  primarySourcesCleared: boolean
  alternativeSourcesCleared: boolean
}>

export type PrivateLoadBalancerCacheClear = Readonly<{
  found: boolean
  sourcesCleared: boolean
}>

export interface PrivateAdminStore {
  clearVideoSources(id: string): Promise<PrivateVideoCacheClear>
  clearLoadBalancerSources(link: string): Promise<PrivateLoadBalancerCacheClear>
}

export type PrivateMutationResult = Readonly<{
  status: 'ok' | 'fail'
  message: string
  result: Readonly<Record<string, boolean>> | null
}>

export class PrivateAdminService {
  private readonly now: () => number
  private readonly cacheTtl: number
  private readonly groups = new Map<string, Readonly<{ expires: number; value: Readonly<Record<string, unknown>> }>>()
  private snapshotCache: Readonly<{ expires: number; value: SystemStatusSnapshot }> | undefined

  public constructor(
    private readonly store: PrivateAdminStore,
    private readonly inspector: SystemInspector,
    private readonly cacheManager: PrivateCacheManager,
    private readonly options: Readonly<{
      baseUrl: URL
      loadMainSite: () => URL | Promise<URL>
      clearRuntimeCache: () => boolean | Promise<boolean>
      now?: () => number
      cacheTtl?: number
    }>
  ) {
    this.now = options.now ?? Date.now
    this.cacheTtl = Math.max(0, Math.min(300_000, Math.trunc(options.cacheTtl ?? 30_000)))
  }

  public async serverStatus(group: unknown): Promise<Readonly<Record<string, unknown>>> {
    const normalized = stringValue(group)
    const cached = this.groups.get(normalized)
    const now = this.now()
    if (cached !== undefined && cached.expires > now) return cached.value

    let value: Readonly<Record<string, unknown>>
    switch (normalized) {
      case '1':
        value = await this.inspector.operatingSystem()
        break
      case '2':
        value = Object.freeze({ ram: await this.inspector.ramUsage() })
        break
      case '3':
        value = Object.freeze({ disk: await this.inspector.diskUsage() })
        break
      case '4':
        value = Object.freeze({ services: await this.inspector.services() })
        break
      default:
        value = Object.freeze({})
    }
    const frozen = Object.freeze({ ...value })
    this.groups.set(normalized, Object.freeze({ expires: now + this.cacheTtl, value: frozen }))
    return frozen
  }

  public async systemStatus(): Promise<SystemStatusSnapshot> {
    const now = this.now()
    if (this.snapshotCache !== undefined && this.snapshotCache.expires > now) return this.snapshotCache.value
    const value = await systemStatusSnapshot(this.inspector)
    this.snapshotCache = Object.freeze({ expires: now + this.cacheTtl, value })
    return value
  }

  public async clearVideoCache(id: unknown): Promise<PrivateMutationResult> {
    const normalized = videoId(id)
    if (normalized === null) return mutation('fail', CACHE_CLEAR_FAIL, null)
    const cleared = await this.store.clearVideoSources(normalized)
    if (!cleared.found) return mutation('ok', CACHE_CLEAR_SUCCESS, null)
    const [player, files] = await Promise.all([
      Promise.resolve(this.options.clearRuntimeCache()).catch(() => false),
      this.cacheManager.clearVideos(cleared.identities).catch(() => false)
    ])
    this.groups.clear()
    this.snapshotCache = undefined
    return mutation('ok', CACHE_CLEAR_SUCCESS, {
      clear_video_sources: cleared.primarySourcesCleared,
      clear_video_player: player,
      clear_alternative_sources: cleared.alternativeSourcesCleared,
      clear_video_files: files
    })
  }

  public async clearLoadBalancer(): Promise<PrivateMutationResult> {
    const mainSite = await this.options.loadMainSite()
    if (sameUrl(mainSite, this.options.baseUrl)) return mutation('fail', CACHE_CLEAR_FAIL, {})
    const cleared = await this.store.clearLoadBalancerSources(this.options.baseUrl.toString())
    if (!cleared.found) return mutation('fail', CACHE_CLEAR_FAIL, {})
    const files = await this.cacheManager.clearLoadBalancerFiles().catch(() => false)
    this.groups.clear()
    this.snapshotCache = undefined
    return mutation('ok', CACHE_CLEAR_SUCCESS, {
      clear_video_sources: cleared.sourcesCleared,
      clear_video_files: files
    })
  }
}

function mutation(status: 'ok' | 'fail', message: string, result: Readonly<Record<string, boolean>> | null): PrivateMutationResult {
  return Object.freeze({ status, message, result: result === null ? null : Object.freeze({ ...result }) })
}

function videoId(value: unknown): string | null {
  const normalized = stringValue(value)
  return /^[1-9]\d{0,19}$/.test(normalized) ? normalized : null
}

function stringValue(value: unknown): string {
  const scalar = Array.isArray(value) ? value.at(-1) : value
  return typeof scalar === 'string' || typeof scalar === 'number' ? String(scalar).trim().slice(0, 2_048) : ''
}

function sameUrl(left: URL, right: URL): boolean {
  const normalize = (value: URL): string => {
    const copy = new URL(value)
    copy.hash = ''
    copy.search = ''
    if (!copy.pathname.endsWith('/')) copy.pathname += '/'
    return copy.toString()
  }
  return normalize(left) === normalize(right)
}
