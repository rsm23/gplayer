import path from 'node:path'
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeneralWorker, type ActiveLoadBalancer, type GeneralWorkerStore, type ManagedSubtitle } from '../src/background/general-worker.js'
import { RemoteLoadBalancerHealthProbe } from '../src/background/load-balancer-health-probe.js'
import { MySqlGeneralWorkerStore } from '../src/background/mysql-general-worker-store.js'

class MemoryGeneralStore implements GeneralWorkerStore {
  public rows: ManagedSubtitle[] = []
  public loadBalancers: ActiveLoadBalancer[] = []
  public deleted: string[] = []
  public async deleteExpiredSources(): Promise<number> { return 4 }
  public async normalizeSubtitleLanguages(): Promise<number> { return 2 }
  public async listActiveLoadBalancers(): Promise<readonly ActiveLoadBalancer[]> { return this.loadBalancers }
  public async listManagedSubtitles(_host: string, afterId: string, limit: number): Promise<readonly ManagedSubtitle[]> {
    return this.rows.filter((row) => Number(row.id) > Number(afterId)).slice(0, limit)
  }
  public async deleteManagedSubtitle(id: string): Promise<boolean> { this.deleted.push(id); return true }
}

describe('general maintenance worker', () => {
  let root = ''

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true })
    root = ''
  })

  it('repairs runtime directories, evicts stale cache, clears temp files, and removes missing subtitle rows', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-general-'))
    const cacheRoot = path.join(root, 'cache')
    const temporaryRoot = path.join(root, 'tmp')
    const uploadsRoot = path.join(root, 'public/uploads')
    const subtitlesRoot = path.join(uploadsRoot, 'subtitles')
    await Promise.all([
      mkdir(path.join(cacheRoot, 'files'), { recursive: true }),
      mkdir(path.join(temporaryRoot, 'nested'), { recursive: true }),
      mkdir(path.join(uploadsRoot, 'images/tmp'), { recursive: true }),
      mkdir(path.join(subtitlesRoot, 'tmp'), { recursive: true })
    ])
    await Promise.all([
      writeFile(path.join(cacheRoot, 'files/stale.bin'), 'cache'),
      writeFile(path.join(temporaryRoot, 'nested/work.bin'), 'tmp'),
      writeFile(path.join(uploadsRoot, 'images/tmp/poster.bin'), 'image'),
      writeFile(path.join(subtitlesRoot, 'tmp/subtitle.bin'), 'subtitle'),
      writeFile(path.join(subtitlesRoot, 'kept.vtt'), 'WEBVTT')
    ])
    await symlink(path.join(subtitlesRoot, 'kept.vtt'), path.join(subtitlesRoot, 'linked.vtt'))
    await utimes(path.join(cacheRoot, 'files'), 1_600_000_000, 1_600_000_000)
    const store = new MemoryGeneralStore()
    store.rows = [
      { id: '1', fileName: 'kept.vtt' },
      { id: '2', fileName: 'missing.vtt' },
      { id: '3', fileName: 'linked.vtt' },
      { id: '4', fileName: '../outside.vtt' }
    ]
    const worker = new GeneralWorker(store, {
      baseUrl: new URL('https://player.example/'),
      cacheRoot,
      temporaryRoot,
      uploadsRoot,
      loadCacheMaxAge: async () => 300,
      now: () => 1_700_000_000,
      freeSpace: async () => 20 * 1_024 * 1_024 * 1_024,
      batchSize: 2
    })

    await expect(worker.runOnce()).resolves.toEqual({
      expiredSources: 4,
      normalizedSubtitles: 2,
      missingSubtitles: 3,
      temporaryEntries: expect.any(Number),
      cacheCleared: true,
      lowSpace: false,
      loadBalancersChecked: 0,
      loadBalancersFailed: 0,
      proxyDisabled: false,
      proxiesDiscovered: 0,
      proxiesChecked: 0,
      proxiesValid: 0,
      pluginsActive: 0,
      pluginsSynchronized: 0,
      pluginsFailed: 0,
      pluginBackgroundsRunning: 0,
      phpPluginBackgroundsUnsupported: 0
    })
    expect(store.deleted).toEqual(['2', '3', '4'])
    await expect(readFile(path.join(subtitlesRoot, 'kept.vtt'), 'utf8')).resolves.toBe('WEBVTT')
    await expect(readFile(path.join(cacheRoot, 'files/stale.bin'))).rejects.toThrow()
    await expect(readFile(path.join(temporaryRoot, 'nested/work.bin'))).rejects.toThrow()
    await expect(readFile(path.join(uploadsRoot, 'images/tmp/poster.bin'))).rejects.toThrow()
    await expect(readFile(path.join(subtitlesRoot, 'tmp/subtitle.bin'))).rejects.toThrow()
  })

  it('clears only the configured cache root under the legacy low-space threshold', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-general-space-'))
    const cacheRoot = path.join(root, 'cache')
    const uploadsRoot = path.join(root, 'uploads')
    await mkdir(cacheRoot, { recursive: true })
    await writeFile(path.join(cacheRoot, 'discard.bin'), 'cache')
    await writeFile(path.join(root, 'keep.bin'), 'keep')
    const worker = new GeneralWorker(new MemoryGeneralStore(), {
      baseUrl: new URL('https://player.example/'),
      cacheRoot,
      temporaryRoot: path.join(root, 'tmp'),
      uploadsRoot,
      loadCacheMaxAge: async () => 10_800,
      freeSpace: async () => 1
    })

    await expect(worker.runOnce()).resolves.toMatchObject({ lowSpace: true, cacheCleared: true })
    await expect(readFile(path.join(cacheRoot, 'discard.bin'))).rejects.toThrow()
    await expect(readFile(path.join(root, 'keep.bin'), 'utf8')).resolves.toBe('keep')
  })

  it('checks active peer health at most once per 30 seconds without mutating peer status', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-general-health-'))
    const store = new MemoryGeneralStore()
    store.loadBalancers = [
      { id: '1', link: 'https://one.example/node' },
      { id: '2', link: 'http://10.0.0.2/' },
      { id: '3', link: 'ftp://invalid.example/' }
    ]
    let now = 1_700_000_000
    const status = vi.fn(async (target: URL) => target.hostname === 'one.example' ? 200 : 503)
    const worker = new GeneralWorker(store, {
      baseUrl: new URL('https://player.example/'),
      cacheRoot: path.join(root, 'cache'),
      temporaryRoot: path.join(root, 'tmp'),
      uploadsRoot: path.join(root, 'uploads'),
      loadCacheMaxAge: async () => 10_800,
      freeSpace: async () => 20 * 1_024 * 1_024 * 1_024,
      healthProbe: { status },
      now: () => now,
      healthCheckConcurrency: 2,
      healthCheckTimeout: 4_000
    })

    await expect(worker.runOnce()).resolves.toMatchObject({ loadBalancersChecked: 2, loadBalancersFailed: 2 })
    expect(status).toHaveBeenCalledWith(new URL('https://one.example/node/health-check/?_=1700000000'), 4_000)
    expect(status).toHaveBeenCalledWith(new URL('http://10.0.0.2/health-check/?_=1700000000'), 4_000)
    now += 29
    await expect(worker.runOnce()).resolves.toMatchObject({ loadBalancersChecked: 0, loadBalancersFailed: 0 })
    now += 1
    await expect(worker.runOnce()).resolves.toMatchObject({ loadBalancersChecked: 2, loadBalancersFailed: 2 })
    expect(status).toHaveBeenCalledTimes(4)
  })
})

describe('load-balancer health transport', () => {
  it('uses a bounded DNS-pinned request, permits configured private peers, and drains the response', async () => {
    const cancel = vi.fn(async () => undefined)
    const open = vi.fn(async () => ({ status: 204, body: { cancel } }))
    const probe = new RemoteLoadBalancerHealthProbe({ open } as never)
    const target = new URL('http://10.0.0.2/health-check/?_=1')

    await expect(probe.status(target, 5_000)).resolves.toBe(204)
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      url: target,
      method: 'GET',
      allowPrivateNetworks: true,
      maximumRedirects: 2,
      signal: expect.any(AbortSignal)
    }))
    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe('MySQL general maintenance store', () => {
  it('parameterizes source expiry, language repair, subtitle cursors, and scoped deletion', async () => {
    const reads: Array<readonly [string, readonly unknown[]]> = []
    const writes: Array<readonly [string, readonly unknown[]]> = []
    const database = {
      read: async <T>(sql: string, values: readonly unknown[] = []): Promise<T> => {
        reads.push([sql, values])
        if (sql.includes('tb_loadbalancers')) return [{ id: 8, link: 'https://peer.example/' }] as T
        if (sql.includes('tb_settings')) return [
          { key: 'disable_proxy', value: 'false' },
          { key: 'free_proxy', value: 'true' },
          { key: 'proxy_list', value: '198.51.100.8:8080\n198.51.100.9:443,https' }
        ] as T
        return [{ id: 7, file_name: 'caption.vtt' }] as T
      },
      write: async <T>(sql: string, values: readonly unknown[] = []): Promise<T> => {
        writes.push([sql, values])
        return { affectedRows: 1 } as T
      }
    }
    const store = new MySqlGeneralWorkerStore(database as never)
    await expect(store.deleteExpiredSources(1_700_000_000)).resolves.toBe(1)
    await expect(store.normalizeSubtitleLanguages()).resolves.toBe(1)
    await expect(store.listActiveLoadBalancers('https://player.example/')).resolves.toEqual([{ id: '8', link: 'https://peer.example/' }])
    await expect(store.listManagedSubtitles('https://player.example/', '4', 4_000)).resolves.toEqual([{ id: '7', fileName: 'caption.vtt' }])
    await expect(store.deleteManagedSubtitle('7', 'https://player.example/')).resolves.toBe(true)
    await expect(store.loadProxyConfiguration()).resolves.toEqual({
      disabled: false,
      useConfiguredOnly: true,
      proxies: ['198.51.100.8:8080', '198.51.100.9:443,https']
    })
    await store.saveProxyList(['198.51.100.8:8080'])

    expect(writes[0]).toEqual(['DELETE FROM `tb_videos_sources` WHERE `expired` <= ?', [1_700_000_000]])
    expect(writes[1]).toEqual(['UPDATE `tb_subtitle_manager` SET `language` = ? WHERE `language` = ?', ['Unknown CC', '']])
    expect(reads[0]).toEqual([
      'SELECT `id`, `link` FROM `tb_loadbalancers` WHERE `status` = ? AND `link` <> ? ORDER BY `id` ASC',
      [1, 'https://player.example/']
    ])
    expect(reads[1]?.[1]).toEqual(['https://player.example/', '4', 1000])
    expect(writes[2]).toEqual(['DELETE FROM `tb_subtitle_manager` WHERE `id` = ? AND `host` = ?', ['7', 'https://player.example/']])
    expect(reads[2]).toEqual([
      'SELECT `key`, `value` FROM `tb_settings` WHERE `key` IN (?, ?, ?)',
      ['disable_proxy', 'free_proxy', 'proxy_list']
    ])
    expect(writes[3]).toEqual([
      'INSERT INTO `tb_settings` (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
      ['proxy_list', '198.51.100.8:8080']
    ])
    expect([...reads, ...writes].every(([sql]) => !sql.includes('player.example'))).toBe(true)
  })
})
