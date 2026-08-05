import path from 'node:path'
import { lstat, mkdir, readdir, rm, stat, statfs } from 'node:fs/promises'

const TEN_GIBIBYTES = 10 * 1_024 * 1_024 * 1_024

export type ManagedSubtitle = Readonly<{ id: string; fileName: string }>

export interface GeneralWorkerStore {
  deleteExpiredSources(now: number): Promise<number>
  normalizeSubtitleLanguages(): Promise<number>
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
}>

export class GeneralWorker {
  private readonly now: () => number
  private readonly freeSpace: (target: string) => Promise<number>
  private readonly batchSize: number

  public constructor(
    private readonly store: GeneralWorkerStore,
    private readonly options: Readonly<{
      baseUrl: URL
      cacheRoot: string
      temporaryRoot: string
      uploadsRoot: string
      loadCacheMaxAge: () => Promise<number>
      now?: () => number
      freeSpace?: (target: string) => Promise<number>
      batchSize?: number
    }>
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.freeSpace = options.freeSpace ?? availableBytes
    this.batchSize = Math.max(1, Math.min(1_000, Math.trunc(options.batchSize ?? 1_000)))
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
    return Object.freeze({ expiredSources, normalizedSubtitles, missingSubtitles, temporaryEntries, cacheCleared, lowSpace })
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
