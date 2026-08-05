import type { GeoIpDetails, GeoIpDetailsLookup } from '../security/geoip-details.js'

export type PendingStatGeo = Readonly<{ id: string; ip: string }>

export interface StatsWorkerStore {
  acquire(now: number): Promise<boolean>
  release(): Promise<void>
  cleanupInvalid(): Promise<number>
  listMissingGeo(afterId: string, limit: number): Promise<readonly PendingStatGeo[]>
  saveGeo(ip: string, details: GeoIpDetails | null): Promise<void>
}

export type StatsWorkerResult = Readonly<{
  acquired: boolean
  cleaned: number
  processed: number
  enriched: number
}>

export class StatsWorker {
  private readonly now: () => number
  private readonly batchSize: number

  public constructor(
    private readonly store: StatsWorkerStore,
    private readonly lookup: GeoIpDetailsLookup,
    options: Readonly<{ now?: () => number; batchSize?: number }> = {}
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.batchSize = Math.max(1, Math.min(1_000, Math.trunc(options.batchSize ?? 1_000)))
  }

  public async runOnce(): Promise<StatsWorkerResult> {
    if (!await this.store.acquire(this.now())) return result(false, 0, 0, 0)
    let cleaned = 0
    let processed = 0
    let enriched = 0
    try {
      cleaned = await this.store.cleanupInvalid()
      let cursor = '0'
      while (true) {
        const rows = await this.store.listMissingGeo(cursor, this.batchSize)
        if (rows.length === 0) break
        for (const row of rows) {
          const details = await this.lookup(row.ip).catch(() => null)
          await this.store.saveGeo(row.ip, details)
          cursor = row.id
          processed += 1
          if (details?.asn !== null && details?.country) enriched += 1
        }
        if (rows.length < this.batchSize) break
      }
      return result(true, cleaned, processed, enriched)
    } finally {
      await this.store.release().catch(() => undefined)
    }
  }
}

function result(acquired: boolean, cleaned: number, processed: number, enriched: number): StatsWorkerResult {
  return Object.freeze({ acquired, cleaned, processed, enriched })
}
