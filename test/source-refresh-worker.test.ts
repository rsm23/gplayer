import { describe, expect, it, vi } from 'vitest'
import { emptyMediaResult } from '../src/core/source-resolver.js'
import { MySqlSourceRefreshStore } from '../src/background/mysql-source-refresh-store.js'
import {
  OBSOLETE_VIDEO_HOSTS,
  SourceRefreshWorker,
  type PendingSourceRefresh,
  type SourceRefreshStore
} from '../src/background/source-refresh-worker.js'

const maintenance = Object.freeze({
  deletedVideos: 2,
  migratedVideos: 3,
  deletedSubtitles: 4,
  normalizedSubtitles: 5
})

class MemorySourceRefreshStore implements SourceRefreshStore {
  public rows: PendingSourceRefresh[] = []
  public lastCleanup = 0
  public truncated = 0
  public deleted: string[] = []

  public async maintainLegacyData() { return maintenance }
  public async getLastCleanup() { return this.lastCleanup }
  public async truncatePendingSources() { this.truncated += 1; this.rows = [] }
  public async saveLastCleanup(timestamp: number) { this.lastCleanup = timestamp }
  public async listPendingSources(limit: number) { return this.rows.slice(0, limit) }
  public async deletePendingSource(id: string) { this.deleted.push(id); return true }
}

describe('Node-native bg_get source refresh worker', () => {
  it('preserves the supplied daily truncate-before-query cleanup order', async () => {
    const store = new MemorySourceRefreshStore()
    store.rows = [{ id: '1', host: 'direct', hostId: 'https://media.example/a.mp4', downloadable: false }]
    const resolve = vi.fn(async () => emptyMediaResult())
    const worker = new SourceRefreshWorker(store, resolve, { now: () => 1_700_000_000 })

    await expect(worker.runOnce()).resolves.toEqual({
      ...maintenance,
      truncated: true,
      pending: 0,
      resolved: 0,
      removed: 0,
      retained: 0,
      failed: 0
    })
    expect(store.truncated).toBe(1)
    expect(store.lastCleanup).toBe(1_700_000_000)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('resolves pending rows, deletes empty results, and retains failures for retry', async () => {
    const store = new MemorySourceRefreshStore()
    store.lastCleanup = 1_699_999_900
    store.rows = [
      { id: '1', host: 'youtube', hostId: 'working-id', downloadable: true },
      { id: '2', host: 'youtube', hostId: 'empty-id', downloadable: false },
      { id: '3', host: 'youtube', hostId: 'failed-id', downloadable: false },
      { id: '4', host: 'youtube', hostId: 'working-id', downloadable: true }
    ]
    const resolve = vi.fn(async (
      query: Readonly<{ id: string }>,
      _context: Readonly<{ downloadable: boolean; language: string }>
    ) => {
      if (query.id === 'failed-id') throw new Error('provider unavailable')
      if (query.id === 'empty-id') return emptyMediaResult()
      return Object.freeze({ ...emptyMediaResult(), sources: Object.freeze([{ file: 'https://media.example/video.mp4', type: 'video/mp4' }]) })
    })
    const worker = new SourceRefreshWorker(store, resolve as never, { now: () => 1_700_000_000, batchSize: 20 })

    await expect(worker.runOnce()).resolves.toEqual({
      ...maintenance,
      truncated: false,
      pending: 4,
      resolved: 1,
      removed: 1,
      retained: 3,
      failed: 1
    })
    expect(store.deleted).toEqual(['2'])
    expect(resolve).toHaveBeenCalledTimes(3)
    expect(resolve.mock.calls[0]?.[1]).toMatchObject({ downloadable: true, language: 'en;q=0.9' })
  })
})

describe('MySQL bg_get store', () => {
  it('parameterizes all legacy hygiene, cursor, setting, and pending-row operations', async () => {
    const reads: Array<readonly [string, readonly unknown[]]> = []
    const writes: Array<readonly [string, readonly unknown[]]> = []
    const database = {
      read: async <T>(sql: string, values: readonly unknown[] = []): Promise<T> => {
        reads.push([sql, values])
        if (sql.includes('tmp_videos_sources')) return [{ id: 9, host: 'YouTube', host_id: 'abc', dl: 1 }] as T
        return [{ value: '1700000000' }] as T
      },
      write: async <T>(sql: string, values: readonly unknown[] = []): Promise<T> => {
        writes.push([sql, values])
        return { affectedRows: 1 } as T
      }
    }
    const store = new MySqlSourceRefreshStore(database as never)

    await expect(store.maintainLegacyData()).resolves.toEqual({
      deletedVideos: 2,
      migratedVideos: 1,
      deletedSubtitles: 1,
      normalizedSubtitles: 1
    })
    await expect(store.getLastCleanup()).resolves.toBe(1_700_000_000)
    await store.truncatePendingSources()
    await store.saveLastCleanup(1_700_000_100)
    await expect(store.listPendingSources(4_000)).resolves.toEqual([{ id: '9', host: 'youtube', hostId: 'abc', downloadable: true }])
    await expect(store.deletePendingSource('9')).resolves.toBe(true)

    expect(writes[0]?.[1]).toEqual(OBSOLETE_VIDEO_HOSTS)
    expect(writes[1]?.[1]).toEqual(['', ''])
    expect(writes[2]?.[1]).toEqual(['goodstream1', 'goodstream', 'streamwish', 'streamhg', 'filelions', 'vidhide', 'earnvids', 'goodstream1', 'streamwish', 'filelions', 'vidhide'])
    expect(writes[3]?.[1]).toEqual(['', '%okcdn.%', '%dmcdn.%'])
    expect(writes[4]?.[1]).toEqual(['Unknown CC', ''])
    expect(reads[0]?.[1]).toEqual(['bg_get_last_cleanup'])
    expect(writes[5]).toEqual(['TRUNCATE TABLE `tmp_videos_sources`', []])
    expect(writes[6]?.[1]).toEqual(['bg_get_last_cleanup', '1700000100'])
    expect(reads[1]?.[1]).toEqual([1000])
    expect(writes[7]?.[1]).toEqual(['9'])
    expect([...reads, ...writes].every(([sql]) => !sql.includes('1700000100') && !sql.includes('youtube'))).toBe(true)
  })
})
