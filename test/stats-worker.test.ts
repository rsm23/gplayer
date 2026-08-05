import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { MySqlStatsWorkerStore } from '../src/background/mysql-stats-worker-store.js'
import { StatsWorker, type PendingStatGeo, type StatsWorkerStore } from '../src/background/stats-worker.js'
import { createGeoIpDetailsLookup, type GeoIpDetails } from '../src/security/geoip-details.js'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const googleDetails: GeoIpDetails = Object.freeze({ asn: 15169, organization: 'Google LLC', country: 'US', continent: 'NA' })

class MemoryStatsStore implements StatsWorkerStore {
  public locked = false
  public released = 0
  public cleaned = 3
  public rows: PendingStatGeo[] = [
    { id: '1', ip: '8.8.8.8' },
    { id: '2', ip: 'invalid' },
    { id: '3', ip: '1.1.1.1' }
  ]
  public saved: Array<Readonly<{ ip: string; details: GeoIpDetails | null }>> = []

  public async acquire(): Promise<boolean> { return !this.locked }
  public async release(): Promise<void> { this.released += 1 }
  public async cleanupInvalid(): Promise<number> { return this.cleaned }
  public async listMissingGeo(afterId: string, limit: number): Promise<readonly PendingStatGeo[]> {
    return this.rows.filter((row) => Number(row.id) > Number(afterId)).slice(0, limit)
  }
  public async saveGeo(ip: string, details: GeoIpDetails | null): Promise<void> { this.saved.push({ ip, details }) }
}

describe('statistics maintenance worker', () => {
  it('cleans invalid rows and enriches every cursor batch before releasing the lock', async () => {
    const store = new MemoryStatsStore()
    const lookup = vi.fn(async (ip: string) => ip === 'invalid' ? null : googleDetails)
    const worker = new StatsWorker(store, lookup, { now: () => 1_700_000_000, batchSize: 2 })

    await expect(worker.runOnce()).resolves.toEqual({ acquired: true, cleaned: 3, processed: 3, enriched: 2 })
    expect(lookup.mock.calls.map(([ip]) => ip)).toEqual(['8.8.8.8', 'invalid', '1.1.1.1'])
    expect(store.saved).toEqual([
      { ip: '8.8.8.8', details: googleDetails },
      { ip: 'invalid', details: null },
      { ip: '1.1.1.1', details: googleDetails }
    ])
    expect(store.released).toBe(1)
  })

  it('does no maintenance when another runtime owns the distributed lock', async () => {
    const store = new MemoryStatsStore()
    store.locked = true
    const lookup = vi.fn(async () => googleDetails)
    await expect(new StatsWorker(store, lookup).runOnce()).resolves.toEqual({ acquired: false, cleaned: 0, processed: 0, enriched: 0 })
    expect(lookup).not.toHaveBeenCalled()
    expect(store.released).toBe(0)
  })

  it('reads country and ASN data from the bundled MaxMind databases', async () => {
    const lookup = createGeoIpDetailsLookup(
      path.resolve(currentDirectory, '../resources/data/geoip/GeoLite2-Country.mmdb'),
      path.resolve(currentDirectory, '../resources/data/geoip/GeoLite2-ASN.mmdb')
    )
    await expect(lookup('8.8.8.8')).resolves.toMatchObject({ asn: expect.any(Number), organization: expect.any(String), country: 'US', continent: 'NA' })
    await expect(lookup('not-an-ip')).resolves.toBeNull()
  })
})

describe('MySQL statistics maintenance store', () => {
  it('uses a transactional lock and parameterized cleanup, cursor, ASN, cache, and stat writes', async () => {
    const transactions: Array<readonly [string, readonly unknown[]]> = []
    const reads: Array<readonly [string, readonly unknown[]]> = []
    const writes: Array<readonly [string, readonly unknown[]]> = []
    const database = {
      transaction: async <T>(work: (executor: { execute: <R>(sql: string, values?: readonly unknown[]) => Promise<R> }) => Promise<T>): Promise<T> => await work({
        execute: async <R>(sql: string, values: readonly unknown[] = []): Promise<R> => {
          transactions.push([sql, values])
          if (sql.startsWith('SELECT `value`')) return [{ value: '0' }] as R
          return { affectedRows: 1 } as R
        }
      }),
      read: async <T>(sql: string, values: readonly unknown[] = []): Promise<T> => {
        reads.push([sql, values])
        return [{ id: 42, ip: '8.8.8.8' }] as T
      },
      write: async <T>(sql: string, values: readonly unknown[] = []): Promise<T> => {
        writes.push([sql, values])
        return { affectedRows: 1 } as T
      }
    }
    const store = new MySqlStatsWorkerStore(database as never)

    await expect(store.acquire(1_700_000_000)).resolves.toBe(true)
    await store.release()
    await expect(store.cleanupInvalid()).resolves.toBe(3)
    await expect(store.listMissingGeo('40', 5_000)).resolves.toEqual([{ id: '42', ip: '8.8.8.8' }])
    await store.saveGeo('8.8.8.8', googleDetails)

    expect(transactions[0]).toEqual(['INSERT IGNORE INTO `tb_settings` (`key`, `value`) VALUES (?, ?)', ['check_stats', '0']])
    expect(transactions[1]).toEqual(['SELECT `value` FROM `tb_settings` WHERE `key` = ? LIMIT 1 FOR UPDATE', ['check_stats']])
    expect(transactions[2]).toEqual(['UPDATE `tb_settings` SET `value` = ? WHERE `key` = ?', ['1700000000', 'check_stats']])
    expect(writes[0]).toEqual(['UPDATE `tb_settings` SET `value` = ? WHERE `key` = ?', ['0', 'check_stats']])
    expect(reads[0]?.[0]).toContain('WHERE `id` > ?')
    expect(reads[0]?.[1]).toEqual(['40', 1000])
    expect(transactions.some(([sql, values]) => sql.includes('INSERT INTO `tb_maxmind_asn`') && values[0] === 15169)).toBe(true)
    expect(transactions.some(([sql, values]) => sql.includes('INSERT INTO `tb_maxmind`') && values[0] === '8.8.8.8')).toBe(true)
    expect(transactions.some(([sql, values]) => sql.includes('UPDATE `tb_stats` SET `asn`') && values.at(-1) === '8.8.8.8')).toBe(true)
    expect([...transactions, ...reads, ...writes].every(([sql]) => !sql.includes('8.8.8.8'))).toBe(true)
  })

  it('preserves a fresh lock and takes over a stale lock', async () => {
    const value = { current: '1699999990' }
    const updates: string[] = []
    const database = {
      transaction: async <T>(work: (executor: { execute: <R>(sql: string, values?: readonly unknown[]) => Promise<R> }) => Promise<T>): Promise<T> => await work({
        execute: async <R>(sql: string, values: readonly unknown[] = []): Promise<R> => {
          if (sql.startsWith('SELECT')) return [{ value: value.current }] as R
          if (sql.startsWith('INSERT IGNORE')) return { affectedRows: 0 } as R
          updates.push(String(values[0]))
          return { affectedRows: 1 } as R
        }
      })
    }
    const store = new MySqlStatsWorkerStore(database as never)
    await expect(store.acquire(1_700_000_000)).resolves.toBe(false)
    value.current = '1699990000'
    await expect(store.acquire(1_700_000_000)).resolves.toBe(true)
    expect(updates).toEqual(['1700000000'])
  })
})
