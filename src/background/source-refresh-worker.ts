import type { MediaResult } from '../core/source-resolver.js'

export const OBSOLETE_VIDEO_HOSTS = Object.freeze([
  'streamsilk',
  'filecm',
  'filerio',
  'embedrise',
  'streamff',
  'dropden',
  'streamvid',
  'upstream',
  'vidpro',
  'vixstream',
  'ydb',
  'ztreamhub'
] as const)

export type PendingSourceRefresh = Readonly<{
  id: string
  host: string
  hostId: string
  downloadable: boolean
}>

export type SourceRefreshMaintenance = Readonly<{
  deletedVideos: number
  migratedVideos: number
  deletedSubtitles: number
  normalizedSubtitles: number
}>

export interface SourceRefreshStore {
  maintainLegacyData(): Promise<SourceRefreshMaintenance>
  getLastCleanup(): Promise<number>
  truncatePendingSources(): Promise<void>
  saveLastCleanup(timestamp: number): Promise<void>
  listPendingSources(limit: number): Promise<readonly PendingSourceRefresh[]>
  deletePendingSource(id: string): Promise<boolean>
}

export type BackgroundSourceResolver = (
  query: Readonly<{ host: string; id: string }>,
  context: Readonly<{
    clientIp: string
    userAgent: string
    language: string
    downloadable: boolean
  }>
) => Promise<MediaResult>

export type SourceRefreshResult = SourceRefreshMaintenance & Readonly<{
  truncated: boolean
  pending: number
  resolved: number
  removed: number
  retained: number
  failed: number
}>

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const CLEANUP_INTERVAL_SECONDS = 86_400

export class SourceRefreshWorker {
  private readonly now: () => number
  private readonly batchSize: number

  public constructor(
    private readonly store: SourceRefreshStore,
    private readonly resolve: BackgroundSourceResolver,
    options: Readonly<{ now?: () => number; batchSize?: number }> = {}
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.batchSize = Math.max(1, Math.min(1_000, Math.trunc(options.batchSize ?? 1_000)))
  }

  public async runOnce(): Promise<SourceRefreshResult> {
    const maintenance = await this.store.maintainLegacyData()
    const now = this.now()
    const lastCleanup = await this.store.getLastCleanup()
    const truncated = now - lastCleanup >= CLEANUP_INTERVAL_SECONDS
    if (truncated) {
      await this.store.truncatePendingSources()
      await this.store.saveLastCleanup(now)
    }

    const pending = await this.store.listPendingSources(this.batchSize)
    const processed = new Set<string>()
    let resolved = 0
    let removed = 0
    let retained = 0
    let failed = 0

    for (const row of pending) {
      const key = `${row.host}\0${row.hostId}\0${Number(row.downloadable)}`
      if (processed.has(key)) {
        retained += 1
        continue
      }
      processed.add(key)
      try {
        const result = await this.resolve(
          { host: row.host, id: row.hostId },
          {
            clientIp: '',
            userAgent: DEFAULT_USER_AGENT,
            language: 'en;q=0.9',
            downloadable: row.downloadable
          }
        )
        if (result.sources.length > 0) {
          resolved += 1
          retained += 1
        } else if (await this.store.deletePendingSource(row.id)) {
          removed += 1
        } else {
          retained += 1
        }
      } catch {
        failed += 1
        retained += 1
      }
    }

    return Object.freeze({
      ...maintenance,
      truncated,
      pending: pending.length,
      resolved,
      removed,
      retained,
      failed
    })
  }
}
