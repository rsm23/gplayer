import path from 'node:path'
import { lstat, mkdir, readdir, rm, stat, statfs } from 'node:fs/promises'
import type { ProxyMaintenanceWorker } from './proxy-maintenance-worker.js'
import type { PluginMaintenanceWorker } from '../plugins/plugin-maintenance-worker.js'

const TEN_GIBIBYTES = 10 * 1_024 * 1_024 * 1_024

export type ManagedSubtitle = Readonly<{ id: string; fileName: string }>
export type ActiveLoadBalancer = Readonly<{ id: string; link: string }>

export interface LoadBalancerHealthProbe {
  status(target: URL, timeoutMilliseconds: number): Promise<number>
}

export interface GeneralWorkerStore {
  deleteExpiredSources(now: number): Promise<number>
  normalizeSubtitleLanguages(): Promise<number>
  listActiveLoadBalancers(baseUrl: string): Promise<readonly ActiveLoadBalancer[]>
  listManagedSubtitles(host: string, afterId: string, limit: number): Promise<readonly ManagedSubtitle[]>
  deleteManagedSubtitle(id: string, host: string): Promise<boolean>
}

export type GeneralWorkerResult = Readonly<{
  expiredSources: number
  normalizedSubtitles: number
  missingSubtitles: number
  temporaryEntries: number
  cacheCleared: boolean
  lowSpace: boolean
  loadBalancersChecked: number
  loadBalancersFailed: number
  proxyDisabled: boolean
  proxiesDiscovered: number
  proxiesChecked: number
  proxiesValid: number
  pluginsActive: number
  pluginsSynchronized: number
  pluginsFailed: number
  pluginBackgroundsRunning: number
  phpPluginBackgroundsUnsupported: number
}>

export class GeneralWorker {
  private readonly now: () => number
  private readonly freeSpace: (target: string) => Promise<number>
  private readonly batchSize: number
  private readonly healthCheckInterval: number
  private readonly healthCheckTimeout: number
  private readonly healthCheckConcurrency: number
  private lastHealthCheck = Number.NEGATIVE_INFINITY

  public constructor(
    private readonly store: GeneralWorkerStore,
    private readonly options: Readonly<{
      baseUrl: URL
      cacheRoot: string
      temporaryRoot: string
      uploadsRoot: string
      loadCacheMaxAge: () => Promise<number>
      healthProbe?: LoadBalancerHealthProbe
      proxyMaintenance?: Pick<ProxyMaintenanceWorker, 'runOnce'>
      pluginMaintenance?: Pick<PluginMaintenanceWorker, 'runOnce'>
      now?: () => number
      freeSpace?: (target: string) => Promise<number>
      batchSize?: number
      healthCheckInterval?: number
      healthCheckTimeout?: number
      healthCheckConcurrency?: number
    }>
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.freeSpace = options.freeSpace ?? availableBytes
    this.batchSize = Math.max(1, Math.min(1_000, Math.trunc(options.batchSize ?? 1_000)))
    this.healthCheckInterval = Math.max(1, Math.min(3_600, Math.trunc(options.healthCheckInterval ?? 30)))
    this.healthCheckTimeout = Math.max(100, Math.min(300_000, Math.trunc(options.healthCheckTimeout ?? 300_000)))
    this.healthCheckConcurrency = Math.max(1, Math.min(25, Math.trunc(options.healthCheckConcurrency ?? 10)))
  }

  public async runOnce(): Promise<GeneralWorkerResult> {
    const now = this.now()
    const expiredSources = await this.store.deleteExpiredSources(now)
    const normalizedSubtitles = await this.store.normalizeSubtitleLanguages()
    const lowSpace = await this.freeSpace(this.options.cacheRoot).then((bytes) => bytes < TEN_GIBIBYTES).catch(() => false)
    let cacheCleared = false
    if (lowSpace) {
      await replaceDirectory(this.options.cacheRoot)
      cacheCleared = true
    }

    const directories = managedDirectories(this.options)
    await Promise.all(directories.map(async (directory) => await mkdir(directory, { recursive: true })))
    if (!cacheCleared) cacheCleared = await this.clearExpiredFileCache(now)

    const temporaryEntries = await Promise.all([
      clearDirectory(path.join(this.options.uploadsRoot, 'images/tmp')),
      clearDirectory(path.join(this.options.uploadsRoot, 'subtitles/tmp')),
      clearDirectory(this.options.temporaryRoot)
    ]).then((counts) => counts.reduce((sum, count) => sum + count, 0))
    await Promise.all(directories.map(async (directory) => await mkdir(directory, { recursive: true })))

    const missingSubtitles = await this.removeMissingSubtitles()
    const health = await this.checkLoadBalancers(now)
    const proxies = await this.options.proxyMaintenance?.runOnce().catch(() => null) ?? null
    const plugins = await this.options.pluginMaintenance?.runOnce().catch(() => null) ?? null
    return Object.freeze({
      expiredSources,
      normalizedSubtitles,
      missingSubtitles,
      temporaryEntries,
      cacheCleared,
      lowSpace,
      loadBalancersChecked: health.checked,
      loadBalancersFailed: health.failed,
      proxyDisabled: proxies?.disabled ?? false,
      proxiesDiscovered: proxies?.discovered ?? 0,
      proxiesChecked: proxies?.checked ?? 0,
      proxiesValid: proxies?.valid ?? 0,
      pluginsActive: plugins?.active ?? 0,
      pluginsSynchronized: plugins?.synchronized ?? 0,
      pluginsFailed: plugins?.failed ?? 0,
      pluginBackgroundsRunning: plugins?.backgrounds.running ?? 0,
      phpPluginBackgroundsUnsupported: plugins?.backgrounds.unsupportedPhp ?? 0
    })
  }

  private async checkLoadBalancers(now: number): Promise<Readonly<{ checked: number; failed: number }>> {
    if (this.options.healthProbe === undefined || now - this.lastHealthCheck < this.healthCheckInterval) {
      return Object.freeze({ checked: 0, failed: 0 })
    }
    this.lastHealthCheck = now
    const rows = await this.store.listActiveLoadBalancers(this.options.baseUrl.toString()).catch(() => [])
    let cursor = 0
    let checked = 0
    let failed = 0
    const consume = async (): Promise<void> => {
      while (cursor < rows.length) {
        const row = rows[cursor]
        cursor += 1
        if (row === undefined) continue
        const target = loadBalancerHealthUrl(row.link, now)
        if (target === null) {
          failed += 1
          continue
        }
        checked += 1
        const status = await this.options.healthProbe?.status(target, this.healthCheckTimeout).catch(() => 0) ?? 0
        if (status !== 200) failed += 1
      }
    }
    await Promise.all(Array.from({ length: Math.min(rows.length, this.healthCheckConcurrency) }, consume))
    return Object.freeze({ checked, failed })
  }

  private async clearExpiredFileCache(now: number): Promise<boolean> {
    const files = path.join(this.options.cacheRoot, 'files')
    const status = await stat(files).catch(() => null)
    if (status === null) return false
    const maxAge = Math.max(0, Math.min(31_536_000, Math.trunc(await this.options.loadCacheMaxAge().catch(() => 10_800))))
    if (Math.max(0, now - Math.floor(status.mtimeMs / 1_000)) <= maxAge) return false
    await replaceDirectory(files)
    return true
  }

  private async removeMissingSubtitles(): Promise<number> {
    const root = path.join(this.options.uploadsRoot, 'subtitles')
    const host = this.options.baseUrl.toString()
    let cursor = '0'
    let deleted = 0
    while (true) {
      const rows = await this.store.listManagedSubtitles(host, cursor, this.batchSize)
      if (rows.length === 0) break
      for (const row of rows) {
        cursor = row.id
        const safeName = path.basename(row.fileName) === row.fileName && !row.fileName.includes('\0')
        const status = safeName ? await lstat(path.join(root, row.fileName)).catch(() => null) : null
        if (status !== null && status.isFile() && !status.isSymbolicLink()) continue
        if (await this.store.deleteManagedSubtitle(row.id, host)) deleted += 1
      }
      if (rows.length < this.batchSize) break
    }
    return deleted
  }
}

function loadBalancerHealthUrl(link: string, now: number): URL | null {
  try {
    const base = new URL(link)
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return null
    if (base.username !== '' || base.password !== '') return null
    if (!base.pathname.endsWith('/')) base.pathname += '/'
    const target = new URL('health-check/', base)
    target.searchParams.set('_', String(now))
    return target
  } catch {
    return null
  }
}

function managedDirectories(options: Readonly<{ cacheRoot: string; temporaryRoot: string; uploadsRoot: string }>): readonly string[] {
  return Object.freeze([
    options.cacheRoot,
    path.join(options.cacheRoot, 'files'),
    path.join(options.cacheRoot, 'logs'),
    path.join(options.cacheRoot, 'logs/process'),
    path.join(options.cacheRoot, 'logs/yt-dlp'),
    path.join(options.cacheRoot, 'streaming'),
    options.temporaryRoot,
    path.join(options.temporaryRoot, 'hosts'),
    path.join(options.temporaryRoot, 'img'),
    path.join(options.uploadsRoot, 'images'),
    path.join(options.uploadsRoot, 'images/tmp'),
    path.join(options.uploadsRoot, 'subtitles'),
    path.join(options.uploadsRoot, 'subtitles/tmp')
  ])
}

async function clearDirectory(directory: string): Promise<number> {
  const entries = await readdir(directory).catch(() => [])
  await Promise.all(entries.map(async (entry) => await rm(path.join(directory, entry), { recursive: true, force: true })))
  return entries.length
}

async function replaceDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
}

async function availableBytes(target: string): Promise<number> {
  const parent = path.dirname(target)
  const details = await statfs(parent)
  return Number(details.bavail) * Number(details.bsize)
}
