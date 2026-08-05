import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { PluginArchive } from './plugin-archive.js'
import { safePluginDirectory, type PluginBackgroundManager, type PluginBackgroundResult } from './plugin-background-manager.js'
import type { PluginSyncClient } from './plugin-sync-client.js'

export type PluginRecord = Readonly<{
  id: string
  name: string
  folder: string
  active: boolean
}>

export interface PluginMaintenanceStore {
  listPlugins(): Promise<readonly PluginRecord[]>
}

export type PluginMaintenanceConfiguration = Readonly<{
  loadBalancer: boolean
  mainSite: URL
}>

export type PluginMaintenanceResult = Readonly<{
  active: number
  synchronized: number
  failed: number
  backgrounds: PluginBackgroundResult
}>

export class PluginMaintenanceWorker {
  private readonly delay: (milliseconds: number) => Promise<void>
  private readonly timeout: number

  public constructor(
    private readonly store: PluginMaintenanceStore,
    private readonly syncClient: Pick<PluginSyncClient, 'ping' | 'download'>,
    private readonly backgrounds: Pick<PluginBackgroundManager, 'reconcile'>,
    private readonly pluginsRoot: string,
    private readonly loadConfiguration: () => Promise<PluginMaintenanceConfiguration>,
    options: Readonly<{ delay?: (milliseconds: number) => Promise<void>; timeout?: number }> = {}
  ) {
    this.delay = options.delay ?? (async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.timeout = Math.max(1_000, Math.min(300_000, Math.trunc(options.timeout ?? 300_000)))
  }

  public async runOnce(): Promise<PluginMaintenanceResult> {
    const [records, configuration] = await Promise.all([this.store.listPlugins(), this.loadConfiguration()])
    const active = records.filter((record) => record.active)
    let synchronized = 0
    let failed = 0
    if (configuration.loadBalancer) {
      for (const record of active) {
        try {
          const ready = await this.syncClient.ping(configuration.mainSite, record.id, this.timeout).catch(() => false)
          if (!ready) await this.delay(2_000)
          const data = await this.syncClient.download(configuration.mainSite, record.id, this.timeout)
          const archive = PluginArchive.fromBuffer(data)
          const storedAsCli = !record.folder.trim().replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase().startsWith('plugins/')
          if (archive.manifest.useCli !== storedAsCli) throw new Error('Plugin package storage mode does not match its database record')
          const destination = safePluginDirectory(this.pluginsRoot, record.folder)
          const status = await lstat(destination).catch(() => null)
          if (status !== null && (!status.isDirectory() || status.isSymbolicLink())) throw new Error('Plugin destination is not a safe directory')
          await archive.extract(destination, status !== null, path.dirname(path.resolve(this.pluginsRoot)))
          await saveArchive(this.pluginsRoot, path.basename(destination), data)
          synchronized += 1
        } catch {
          failed += 1
        }
      }
    }
    const backgrounds = await this.backgrounds.reconcile(records)
    return Object.freeze({ active: active.length, synchronized, failed, backgrounds })
  }
}

async function saveArchive(pluginsRoot: string, folder: string, data: Buffer): Promise<void> {
  const temporaryRoot = path.join(path.resolve(pluginsRoot), 'tmp')
  await mkdir(temporaryRoot, { recursive: true, mode: 0o755 })
  const status = await lstat(temporaryRoot)
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('Plugin temporary directory is unsafe')
  const target = path.join(temporaryRoot, `${folder}.zip`)
  const temporary = path.join(temporaryRoot, `.${folder}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
    const existing = await lstat(target).catch(() => null)
    if (existing?.isSymbolicLink() === true || existing !== null && !existing.isFile()) throw new Error('Stored plugin archive target is unsafe')
    if (existing === null) await rename(temporary, target)
    else await replaceArchive(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function replaceArchive(temporary: string, target: string): Promise<void> {
  try {
    await rename(temporary, target)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error
  }
  const backup = `${target}.${randomUUID()}.bak`
  await rename(target, backup)
  try {
    await rename(temporary, target)
  } catch (error) {
    await rename(backup, target).catch(() => undefined)
    throw error
  }
  await rm(backup, { force: true })
}
