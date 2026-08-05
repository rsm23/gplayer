import { describe, expect, it, vi } from 'vitest'
import type { SourceCacheCriteria } from '../src/core/source-resolver.js'
import { MySqlSourceCacheRepository } from '../src/database/source-cache-repository.js'

const criteria: SourceCacheCriteria = {
  host: 'direct',
  hostId: 'https://cdn.example/video.mp4',
  expiresAfter: 1_700_000_000,
  downloadable: true,
  userAgent: 'UA',
  language: 'en',
  serverId: 12,
  clientIp: '198.51.100.4'
}

describe('MySQL source cache repository', () => {
  it('uses the exact legacy cache criteria and latest row', async () => {
    const database = {
      read: vi.fn(async (_sql: string, _values?: readonly unknown[]) => [{ data: '{"sources":[{}]}', language: 'en', userAgent: 'UA', created: 10, expired: 20 }]),
      write: vi.fn(async (_sql: string, _values?: readonly unknown[]) => undefined)
    }
    const repository = new MySqlSourceCacheRepository(database as never)

    await expect(repository.find(criteria)).resolves.toEqual({
      data: '{"sources":[{}]}', language: 'en', userAgent: 'UA', created: 10, expired: 20
    })
    const [sql, values] = database.read.mock.calls[0] ?? []
    expect(sql).toContain('FROM `tb_videos_sources`')
    expect(sql).toContain('`expired` > ?')
    expect(sql).toContain('`sid` = ?')
    expect(sql).toContain('`cip` = ?')
    expect(sql).toContain('ORDER BY `id` DESC')
    expect(values).toEqual([
      'direct', 'https://cdn.example/video.mp4', 1_700_000_000, 1, 'UA', 'en', 12, '198.51.100.4'
    ])
  })

  it('omits server and client dimensions when the resolver marks them unused', async () => {
    const database = {
      read: vi.fn(async (_sql: string, _values?: readonly unknown[]) => []),
      write: vi.fn(async (_sql: string, _values?: readonly unknown[]) => undefined)
    }
    const repository = new MySqlSourceCacheRepository(database as never)

    await repository.find({ ...criteria, serverId: null, clientIp: null })
    const [sql, values] = database.read.mock.calls[0] ?? []
    expect(sql).not.toContain('`sid` = ?')
    expect(sql).not.toContain('`cip` = ?')
    expect(values).toHaveLength(6)
  })

  it('maps resolver insert fields to the supplied schema columns', async () => {
    const database = {
      read: vi.fn(async (_sql: string, _values?: readonly unknown[]) => []),
      write: vi.fn(async (_sql: string, _values?: readonly unknown[]) => undefined)
    }
    const repository = new MySqlSourceCacheRepository(database as never)

    await repository.insert({
      host: 'direct', hostId: 'id', data: '{}', downloadable: false, serverId: null,
      created: 10, expired: 20, userAgent: 'UA', language: 'en', clientIp: 'client', serverIp: 'server'
    })

    const [sql, values] = database.write.mock.calls[0] ?? []
    expect(sql).toContain('INSERT INTO `tb_videos_sources`')
    expect(sql).toContain('`host`, `host_id`, `data`, `dl`, `sid`')
    expect(values).toEqual(['direct', 'id', '{}', 0, null, 10, 20, 'UA', 'en', 'client', 'server'])
  })

  it('deletes only rows matching the same cache dimensions', async () => {
    const database = {
      read: vi.fn(async (_sql: string, _values?: readonly unknown[]) => []),
      write: vi.fn(async (_sql: string, _values?: readonly unknown[]) => undefined)
    }
    const repository = new MySqlSourceCacheRepository(database as never)

    await repository.delete(criteria)
    const [sql, values] = database.write.mock.calls[0] ?? []
    expect(sql).toContain('DELETE FROM `tb_videos_sources`')
    expect(values).toEqual([
      'direct', 'https://cdn.example/video.mp4', 1_700_000_000, 1, 'UA', 'en', 12, '198.51.100.4'
    ])
  })
})
