import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { cp, lstat, mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { PluginArchive, parsePluginManifest } from './plugin-archive.js'
import { safePluginDirectory, type PluginBackgroundManager } from './plugin-background-manager.js'
import type { PluginRecord } from './plugin-maintenance-worker.js'
import { createPluginSyncArchive, MAX_PLUGIN_SYNC_BYTES } from './plugin-sync-archive.js'

const LIST_COLUMNS = ['name', 'status', 'created', 'updated', 'id'] as const
export type PluginOrderColumn = typeof LIST_COLUMNS[number]

export type PluginAdminRecord = Readonly<{
  id: string
  name: string
  folder: string
  config: Readonly<Record<string, unknown>>
  status: number
  created: number
  updated: number
}>
export type PluginListQuery = Readonly<{ draw: number; start: number; length: number; search: string; orderBy: PluginOrderColumn; orderDir: 'asc' | 'desc' }>
export type PluginListResult = Readonly<{ data: readonly PluginAdminRecord[]; recordsTotal: number; recordsFiltered: number }>
export type PluginWrite = Readonly<{ name: string; folder: string; config: Readonly<Record<string, unknown>>; status: number; created: number; updated: number }>

export interface PluginAdminStore {
  listPlugins(query: PluginListQuery): Promise<PluginListResult>
  listPluginRecords(): Promise<readonly PluginRecord[]>
  getPlugin(id: string): Promise<PluginAdminRecord | null>
  findPlugin(name: string, folder: string): Promise<PluginAdminRecord | null>
  createPlugin(value: PluginWrite): Promise<string | null>
  updatePlugin(id: string, value: PluginWrite): Promise<boolean>
  updateStatus(id: string, status: number, updated: number): Promise<boolean>
  deletePlugin(id: string): Promise<boolean>
}

export type PluginMutationResult =
  | Readonly<{ status: 'ok'; id: string; message: string; name?: string; iconUri?: string }>
  | Readonly<{ status: 'invalid'; message: string }>

export type PluginSyncArchiveResult =
  | Readonly<{ status: 'ok'; archive: Buffer; filename: string }>
  | Readonly<{ status: 'not-found' }>
  | Readonly<{ status: 'invalid' }>

export class PluginAdminService {
  private readonly now: () => number
  private readonly root: string

  public constructor(
    private readonly store: PluginAdminStore,
    pluginsRoot: string,
    private readonly backgrounds: Pick<PluginBackgroundManager, 'reconcile'>,
    options: Readonly<{ now?: () => number }> = {}
  ) {
    this.root = path.resolve(pluginsRoot)
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  }

  public async records(input: Record<string, unknown>): Promise<Readonly<PluginListResult & { draw: number }>> {
    const query = pluginListQuery(input)
    return Object.freeze({ draw: query.draw, ...(await this.store.listPlugins(query)) })
  }

  public async get(id: unknown): Promise<PluginAdminRecord | null> {
    const normalized = pluginId(id)
    return normalized === null ? null : await this.store.getPlugin(normalized)
  }

  public extensionStore(): Pick<PluginAdminStore, 'listPluginRecords' | 'getPlugin' | 'updatePlugin'> { return this.store }

  public async install(data: Buffer): Promise<PluginMutationResult> {
    let archive: PluginArchive
    try { archive = PluginArchive.fromBuffer(data) } catch (error) { return { status: 'invalid', message: safeArchiveError(error) } }
    await mkdir(path.join(this.root, 'tmp'), { recursive: true, mode: 0o755 })
    const requestedFolder = archive.manifest.folder
    let folder = requestedFolder
    let storedFolder = pluginStoredFolder(folder, archive.manifest.useCli)
    let destination = safePluginDirectory(this.root, storedFolder)
    let existing: PluginAdminRecord | null = null
    let upgradingFiles = false
    const destinationStatus = await lstat(destination).catch(() => null)
    if (destinationStatus !== null) {
      if (!destinationStatus.isDirectory() || destinationStatus.isSymbolicLink()) return { status: 'invalid', message: 'The plugin destination is not a safe directory' }
      const installedManifest = await readInstalledManifest(destination)
      if (installedManifest?.name === archive.manifest.name) {
        upgradingFiles = true
        existing = await this.store.findPlugin(archive.manifest.name, storedFolder)
        if (installedManifest.version === archive.manifest.version) return { status: 'invalid', message: 'Plugin with the same version is already installed.' }
      } else {
        folder = await this.availableFolder(requestedFolder, archive.manifest.useCli)
        storedFolder = pluginStoredFolder(folder, archive.manifest.useCli)
        destination = safePluginDirectory(this.root, storedFolder)
      }
    }
    if (existing === null) existing = await this.store.findPlugin(archive.manifest.name, storedFolder)
    const selectedDestinationStatus = await lstat(destination).catch(() => null)
    if (existing !== null && selectedDestinationStatus === null) return { status: 'invalid', message: 'The installed plugin files are missing' }

    const staging = path.join(this.root, 'tmp', `.install-${folder}-${randomUUID()}`)
    const backup = path.join(this.root, 'tmp', `.backup-${folder}-${randomUUID()}`)
    const upgrading = upgradingFiles || existing !== null
    let databaseSaved = false
    try {
      if (upgrading) await cp(destination, staging, { recursive: true, dereference: false, errorOnExist: true, force: false })
      await archive.extract(staging, upgrading, this.root)
      if (upgrading) await rename(destination, backup)
      await rename(staging, destination)
      const now = this.now()
      const config = mergeConfig(archive.manifest.config, existing?.config ?? {})
      const write: PluginWrite = Object.freeze({
        name: archive.manifest.name, folder: storedFolder, config,
        status: existing?.status ?? 0, created: existing?.created ?? now, updated: now
      })
      const id = existing === null ? await this.store.createPlugin(write) : existing.id
      const saved = existing === null ? id !== null : await this.store.updatePlugin(existing.id, write)
      if (!saved || id === null) {
        await rm(destination, { recursive: true, force: true })
        if (upgrading) await rename(backup, destination)
        return { status: 'invalid', message: 'Plugin installation failed.' }
      }
      databaseSaved = true
      await saveArchive(this.root, folder, data).catch(() => undefined)
      if (upgrading) await rm(backup, { recursive: true, force: true })
      await this.backgrounds.reconcile(await this.store.listPluginRecords()).catch(() => undefined)
      return { status: 'ok', id, name: archive.manifest.name, message: 'Plugin installed successfully.', ...(archive.manifest.iconUri === '' ? {} : { iconUri: archive.manifest.iconUri }) }
    } catch (error) {
      if (!databaseSaved) {
        const destinationNow = await lstat(destination).catch(() => null)
        const backupNow = await lstat(backup).catch(() => null)
        if (backupNow?.isDirectory() === true && !backupNow.isSymbolicLink()) {
          if (destinationNow !== null) await rm(destination, { recursive: true, force: true }).catch(() => undefined)
          await rename(backup, destination).catch(() => undefined)
        }
      }
      return { status: 'invalid', message: safeArchiveError(error) }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  public async setStatus(id: unknown, value: unknown): Promise<PluginMutationResult> {
    const normalized = pluginId(id)
    const status = binaryFlag(value)
    const updated = normalized !== null && status !== null && await this.store.updateStatus(normalized, status, this.now())
    if (!updated) return { status: 'invalid', message: 'Plugin status failed to update.' }
    await this.backgrounds.reconcile(await this.store.listPluginRecords())
    return { status: 'ok', id: normalized, message: 'Plugin status updated successfully.' }
  }

  public async uninstall(id: unknown): Promise<PluginMutationResult> {
    const normalized = pluginId(id)
    if (normalized === null) return { status: 'invalid', message: 'Not found' }
    const plugin = await this.store.getPlugin(normalized)
    if (plugin === null) return { status: 'invalid', message: 'Not found' }
    const destination = safePluginDirectory(this.root, plugin.folder)
    const status = await lstat(destination).catch(() => null)
    if (status !== null && (!status.isDirectory() || status.isSymbolicLink())) return { status: 'invalid', message: 'Uninstall failed! The plugin directory is unsafe.' }
    if (status !== null) {
      const manifestStatus = await lstat(path.join(destination, 'plugin.json')).catch(() => null)
      if (manifestStatus === null || !manifestStatus.isFile() || manifestStatus.isSymbolicLink()) return { status: 'invalid', message: 'Uninstall failed! The plugin manifest is missing.' }
    }
    await this.store.updateStatus(normalized, 0, this.now())
    await this.backgrounds.reconcile(await this.store.listPluginRecords())
    const quarantine = path.join(this.root, 'tmp', `.uninstall-${path.basename(destination)}-${randomUUID()}`)
    await mkdir(path.dirname(quarantine), { recursive: true, mode: 0o755 })
    if (status !== null) await rename(destination, quarantine)
    const deleted = await this.store.deletePlugin(normalized)
    if (!deleted) {
      if (status !== null) await rename(quarantine, destination).catch(() => undefined)
      await this.store.updateStatus(normalized, plugin.status, this.now()).catch(() => false)
      await this.backgrounds.reconcile(await this.store.listPluginRecords()).catch(() => undefined)
      return { status: 'invalid', message: 'Uninstall failed!' }
    }
    await rm(quarantine, { recursive: true, force: true }).catch(() => undefined)
    await rm(path.join(this.root, 'tmp', `${path.basename(destination)}.zip`), { force: true }).catch(() => undefined)
    return { status: 'ok', id: normalized, message: 'Plugin uninstalled successfully.' }
  }

  public async syncArchive(id: unknown): Promise<PluginSyncArchiveResult> {
    const normalized = pluginId(id)
    if (normalized === null) return { status: 'not-found' }
    const plugin = await this.store.getPlugin(normalized)
    if (plugin === null) return { status: 'not-found' }
    let destination: string
    try { destination = safePluginDirectory(this.root, plugin.folder) } catch { return { status: 'invalid' } }
    const destinationStatus = await lstat(destination).catch(() => null)
    if (destinationStatus === null || !destinationStatus.isDirectory() || destinationStatus.isSymbolicLink()) return { status: 'invalid' }
    const installedManifest = await readInstalledManifest(destination)
    if (installedManifest === null) return { status: 'invalid' }
    const filename = `${path.basename(destination)}.zip`
    const cached = path.join(this.root, 'tmp', filename)
    const cachedStatus = await lstat(cached).catch(() => null)
    if (cachedStatus?.isFile() === true && !cachedStatus.isSymbolicLink() && cachedStatus.size <= MAX_PLUGIN_SYNC_BYTES) {
      try {
        const archive = await readSyncArchive(cached)
        const manifest = PluginArchive.fromBuffer(archive).manifest
        if (manifest.name === installedManifest.name && manifest.folder === installedManifest.folder && manifest.version === installedManifest.version && manifest.useCli === installedManifest.useCli) return { status: 'ok', archive, filename }
      } catch {}
    }
    try {
      const archive = await createPluginSyncArchive(destination)
      PluginArchive.fromBuffer(archive)
      await mkdir(path.join(this.root, 'tmp'), { recursive: true, mode: 0o755 })
      await saveArchive(this.root, path.basename(destination), archive).catch(() => undefined)
      return { status: 'ok', archive, filename }
    } catch {
      return { status: 'invalid' }
    }
  }

  private async availableFolder(base: string, useCli: boolean): Promise<string> {
    for (let attempts = 0; attempts < 100; attempts += 1) {
      const candidate = `${base}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
      if (await lstat(safePluginDirectory(this.root, pluginStoredFolder(candidate, useCli))).catch(() => null) === null) return candidate
    }
    throw new Error('A unique plugin directory could not be allocated')
  }
}

function pluginStoredFolder(folder: string, useCli: boolean): string { return useCli ? `${folder}/` : `plugins/${folder}/` }

export function pluginListQuery(input: Record<string, unknown>): PluginListQuery {
  const search = recordValue(input.search)
  const order = recordValue(arrayValue(input.order)[0])
  const index = boundedInteger(order.column ?? input['order[0][column]'], 3, 0, LIST_COLUMNS.length - 1)
  return Object.freeze({ draw: boundedInteger(input.draw, 0, 0, Number.MAX_SAFE_INTEGER), start: boundedInteger(input.start, 0, 0, 1_000_000), length: boundedInteger(input.length, 10, 1, 100), search: stringValue(search.value ?? input['search[value]']).trim().slice(0, 50), orderBy: LIST_COLUMNS[index] ?? 'updated', orderDir: stringValue(order.dir ?? input['order[0][dir]']).toLowerCase() === 'asc' ? 'asc' : 'desc' })
}
export function pluginId(value: unknown): string | null { const normalized = stringValue(value).trim(); if (!/^[1-9]\d{0,9}$/.test(normalized)) return null; try { return BigInt(normalized) <= 4_294_967_295n ? normalized : null } catch { return null } }

async function readInstalledManifest(directory: string): Promise<ReturnType<typeof parsePluginManifest> | null> {
  const manifestPath = path.join(directory, 'plugin.json')
  const status = await lstat(manifestPath).catch(() => null)
  if (status === null || !status.isFile() || status.isSymbolicLink()) return null
  try { return parsePluginManifest(await readFile(manifestPath)) } catch { return null }
}
async function saveArchive(root: string, folder: string, data: Buffer): Promise<void> {
  const temporaryRoot = path.join(root, 'tmp')
  const target = path.join(temporaryRoot, `${folder}.zip`)
  const temporary = path.join(temporaryRoot, `.${folder}.${randomUUID()}.tmp`)
  await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
  try { await rename(temporary, target) } finally { await rm(temporary, { force: true }).catch(() => undefined) }
}
async function readSyncArchive(file: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const status = await handle.stat()
    if (!status.isFile() || status.size > MAX_PLUGIN_SYNC_BYTES) throw new Error('Stored plugin archive is invalid')
    return await readBoundedSyncArchive(handle)
  } finally {
    await handle.close()
  }
}
async function readBoundedSyncArchive(handle: FileHandle): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1_024, MAX_PLUGIN_SYNC_BYTES - size + 1))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    size += bytesRead
    if (size > MAX_PLUGIN_SYNC_BYTES) throw new Error('Stored plugin archive is invalid')
    chunks.push(buffer.subarray(0, bytesRead))
  }
  return Buffer.concat(chunks, size)
}
function mergeConfig(fresh: Readonly<Record<string, unknown>>, existing: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> { return Object.freeze(Object.fromEntries([...Object.entries(fresh), ...Object.entries(existing)])) }
function safeArchiveError(error: unknown): string { const message = error instanceof Error ? error.message : ''; return message === '' || message.length > 300 ? 'Invalid plugin archive.' : message }
function binaryFlag(value: unknown): number | null { const scalar = Array.isArray(value) ? value.at(-1) : value; if (scalar === 1 || scalar === true || scalar === '1' || scalar === 'true' || scalar === 'on') return 1; if (scalar === 0 || scalar === false || scalar === '0' || scalar === 'false' || scalar === '' || scalar === 'off') return 0; return null }
function stringValue(value: unknown): string { return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '' }
function recordValue(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function arrayValue(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : [] }
function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number { const parsed = Number.parseInt(stringValue(value), 10); return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback }
