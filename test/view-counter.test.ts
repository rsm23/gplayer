import { describe, expect, it, vi } from 'vitest'
import { MySqlViewCounterStore } from '../src/stats/mysql-view-counter-store.js'
import { ViewCounterService, type ViewCounterStore, type ViewCounterWrite } from '../src/stats/view-counter-service.js'

describe('playback view counter', () => {
  it('normalizes bounded request data and retains the legacy 24-hour window', async () => {
    const writes: ViewCounterWrite[] = []
    const store: ViewCounterStore = { capture: async (input) => { writes.push(input); return '91' } }
    const lookup = vi.fn(async () => ({ asn: 15169, organization: 'Example ASN', country: 'US', continent: 'NA' }))
    const service = new ViewCounterService(store, lookup, { now: () => 1_700_000_000 })

    await expect(service.capture({
      media: { source: 'db', id: 'saved-video' },
      clientIp: '::ffff:8.8.8.8',
      userAgent: 'x'.repeat(300),
      maximum: 3
    })).resolves.toBe('91')
    expect(lookup).toHaveBeenCalledWith('8.8.8.8')
    expect(writes[0]).toEqual({
      media: { source: 'db', id: 'saved-video' },
      clientIp: '8.8.8.8',
      userAgent: 'x'.repeat(255),
      maximum: 3,
      created: 1_700_000_000,
      since: 1_699_913_600,
      geo: { asn: 15169, organization: 'Example ASN', country: 'US', continent: 'NA' }
    })
    await expect(service.capture({ media: {}, clientIp: 'not-an-ip', userAgent: '', maximum: 3 })).resolves.toBeNull()
    expect(writes).toHaveLength(1)
  })

  it('resolves a saved video, enforces the per-IP cap, reuses user agents, and increments views transactionally', async () => {
    const calls: Array<readonly [string, readonly unknown[]]> = []
    const database = {
      transaction: async <T>(work: (executor: { execute: <R>(sql: string, values?: readonly unknown[]) => Promise<R> }) => Promise<T>): Promise<T> => await work({
        execute: async <R>(sql: string, values: readonly unknown[] = []): Promise<R> => {
          calls.push([sql, values])
          if (sql.startsWith('SELECT `id` FROM `tb_videos`')) return [{ id: 42 }] as R
          if (sql.startsWith('SELECT COUNT')) return [{ count: 0 }] as R
          if (sql.startsWith('SELECT `id` FROM `tb_stats_ua`')) return [{ id: 7 }] as R
          if (sql.startsWith('INSERT INTO `tb_stats`')) return { insertId: 99, affectedRows: 1 } as R
          return { affectedRows: 1 } as R
        }
      })
    }
    const store = new MySqlViewCounterStore(database as never)
    const input = Object.freeze({
      media: Object.freeze({ source: 'db', id: 'movie-slug' }),
      clientIp: '8.8.8.8',
      userAgent: 'Browser',
      maximum: 2,
      created: 1_700_000_000,
      since: 1_699_913_600,
      geo: Object.freeze({ asn: 15169, organization: 'Example ASN', country: 'US', continent: 'NA' })
    })

    await expect(store.capture(input)).resolves.toBe('99')
    expect(calls[0]).toEqual([
      'SELECT `id` FROM `tb_videos` WHERE (`id` = ? OR `slug` = ?) AND `dmca` = 0 LIMIT 1 FOR UPDATE',
      ['movie-slug', 'movie-slug']
    ])
    expect(calls[1]).toEqual([
      'SELECT COUNT(*) AS `count` FROM `tb_stats` WHERE `vid` = ? AND `ip` = ? AND `created` >= ?',
      ['42', '8.8.8.8', 1_699_913_600]
    ])
    expect(calls.some(([sql, values]) => sql.startsWith('INSERT INTO `tb_stats`') && values.at(-2) === 15169 && values.at(-1) === 'US')).toBe(true)
    expect(calls.at(-1)).toEqual(['UPDATE `tb_videos` SET `views` = `views` + 1 WHERE `id` = ?', ['42']])
    expect(calls.every(([sql]) => !sql.includes('8.8.8.8'))).toBe(true)
  })

  it('counts primary and alternative source identities but performs no writes after the cap', async () => {
    const calls: string[] = []
    const database = {
      transaction: async <T>(work: (executor: { execute: <R>(sql: string) => Promise<R> }) => Promise<T>): Promise<T> => await work({
        execute: async <R>(sql: string): Promise<R> => {
          calls.push(sql)
          if (sql.startsWith('SELECT v.`id`')) return [{ id: 5 }] as R
          if (sql.startsWith('SELECT COUNT')) return [{ count: 2 }] as R
          throw new Error('unexpected write')
        }
      })
    }
    const store = new MySqlViewCounterStore(database as never)
    await expect(store.capture({
      media: { host: 'youtube', id: 'video-id' },
      clientIp: '1.1.1.1',
      userAgent: 'Browser',
      maximum: 2,
      created: 1_700_000_000,
      since: 1_699_913_600,
      geo: null
    })).resolves.toBeNull()
    expect(calls[0]).toContain('tb_videos_alternatives')
    expect(calls).toHaveLength(2)
  })
})
