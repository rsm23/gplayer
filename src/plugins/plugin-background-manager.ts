import path from 'node:path'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { parsePluginManifest } from './plugin-archive.js'
import type { PluginRecord } from './plugin-maintenance-worker.js'

const WORKER_SOURCE = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
Promise.resolve()
  .then(() => import(workerData.entry))
  .then(async (module) => {
    const run = typeof module.default === 'function' ? module.default : module.run;
    if (typeof run !== 'function') throw new Error('Node plugin background module must export default or run');
    parentPort.postMessage({ type: 'started' });
    await run(Object.freeze({ pluginDirectory: workerData.pluginDirectory }));
    parentPort.postMessage({ type: 'complete' });
  })
  .catch((error) => {
    parentPort.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Plugin background failed' });
    process.exitCode = 1;
  });
`

export type PluginBackgroundResult = Readonly<{
  started: number
  stopped: number
  running: number
  unsupportedPhp: number
  invalid: number
}>

type RunningPlugin = Readonly<{ worker: Worker; entry: string; signature: string }>

export class PluginBackgroundManager {
  private readonly running = new Map<string, RunningPlugin>()
  private readonly workerFactory: (entry: string, pluginDirectory: string) => Worker

  public constructor(
    private readonly pluginsRoot: string,
    options: Readonly<{ workerFactory?: (entry: string, pluginDirectory: string) => Worker }> = {}
  ) {
    this.workerFactory = options.workerFactory ?? createPluginWorker
  }

  public async reconcile(records: readonly PluginRecord[]): Promise<PluginBackgroundResult> {
    const desired = new Map<string, Readonly<{ entry: string; directory: string; signature: string }>>()
    let unsupportedPhp = 0
    let invalid = 0
    for (const record of records) {
      if (!record.active) continue
      try {
        const directory = safePluginDirectory(this.pluginsRoot, record.folder)
        const manifestPath = path.join(directory, 'plugin.json')
        const manifestStatus = await lstat(manifestPath)
        if (!manifestStatus.isFile() || manifestStatus.isSymbolicLink()) throw new Error('Plugin manifest is not a regular file')
        const manifest = parsePluginManifest(await readFile(manifestPath))
        if (manifest.background === null) continue
        if (path.extname(manifest.background).toLowerCase() === '.php') {
          unsupportedPhp += 1
          continue
        }
        if (!['.js', '.mjs', '.cjs'].includes(path.extname(manifest.background).toLowerCase())) throw new Error('Plugin background is not a Node module')
        const entry = path.resolve(directory, manifest.background)
        if (!entry.startsWith(`${path.resolve(directory)}${path.sep}`)) throw new Error('Plugin background escaped its directory')
        const status = await lstat(entry)
        if (!status.isFile() || status.isSymbolicLink()) throw new Error('Plugin background is not a regular file')
        const [realDirectory, realEntry] = await Promise.all([realpath(directory), realpath(entry)])
        if (!realEntry.startsWith(`${realDirectory}${path.sep}`)) throw new Error('Plugin background traverses a symbolic link')
        const signature = createHash('sha256').update(await readFile(realEntry)).digest('hex')
        desired.set(record.id, Object.freeze({ entry: realEntry, directory: realDirectory, signature }))
      } catch {
        invalid += 1
      }
    }

    let stopped = 0
    for (const [id, active] of [...this.running]) {
      const candidate = desired.get(id)
      if (candidate !== undefined && candidate.entry === active.entry && candidate.signature === active.signature) continue
      this.running.delete(id)
      await active.worker.terminate().catch(() => undefined)
      stopped += 1
    }

    let started = 0
    for (const [id, candidate] of desired) {
      if (this.running.has(id)) continue
      const worker = this.workerFactory(candidate.entry, candidate.directory)
      const active = Object.freeze({ worker, entry: candidate.entry, signature: candidate.signature })
      this.running.set(id, active)
      const clear = (): void => { if (this.running.get(id) === active) this.running.delete(id) }
      worker.once('error', clear)
      worker.once('exit', clear)
      started += 1
    }
    return Object.freeze({ started, stopped, running: this.running.size, unsupportedPhp, invalid })
  }

  public async close(): Promise<void> {
    const workers = [...this.running.values()].map(({ worker }) => worker)
    this.running.clear()
    await Promise.all(workers.map(async (worker) => await worker.terminate().catch(() => undefined)))
  }
}

export function safePluginDirectory(pluginsRoot: string, storedFolder: string): string {
  const normalized = storedFolder.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.some((part) => part === '.' || part === '..') || parts.length === 0 || parts.length > 2) throw new Error('Stored plugin folder is invalid')
  if (parts.length === 2 && parts[0]?.toLowerCase() !== 'plugins') throw new Error('Stored plugin folder is outside the plugins directory')
  const folder = parts.at(-1) ?? ''
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(folder) || folder.toLowerCase() === 'tmp') throw new Error('Stored plugin folder name is invalid')
  const root = path.resolve(pluginsRoot)
  const applicationRoot = path.dirname(root)
  const cli = parts.length === 1
  if (cli && new Set(['cache', 'coverage', 'dist', 'docs', 'includes', 'node_modules', 'plugins', 'public', 'resources', 'src', 'test', 'tests', 'themes', 'tmp', 'vendor']).has(folder.toLowerCase())) throw new Error('Stored CLI plugin folder targets a protected application directory')
  const boundary = cli ? applicationRoot : root
  const destination = path.resolve(boundary, folder)
  if (!destination.startsWith(`${boundary}${path.sep}`)) throw new Error('Stored plugin folder escaped its directory')
  return destination
}

function createPluginWorker(entry: string, pluginDirectory: string): Worker {
  return new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { entry: pathToFileURL(entry).href, pluginDirectory }
  })
}
