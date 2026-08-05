import path from 'node:path'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { parsePluginManifest, type NodePluginManifest, type PluginConfigField } from './plugin-archive.js'
import { safePluginDirectory } from './plugin-background-manager.js'
import type { PluginAdminRecord, PluginAdminStore, PluginWrite } from './plugin-admin-service.js'

const NODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])
const STATIC_EXTENSIONS = new Set(['.html', '.htm'])
const ASSET_ROOTS = new Set(['assets', 'public'])
const MAX_RESULT_BYTES = 2 * 1_024 * 1_024
const DEFAULT_TIMEOUT_MS = 2_000

const INVOCATION_WORKER = String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
Promise.resolve().then(async () => {
  const loaded = await import(workerData.entry);
  const names = workerData.kind === 'page' || workerData.kind === 'widget'
    ? ['render', 'default', 'run']
    : workerData.kind === 'filter'
      ? ['filter', 'default', 'run']
      : ['handle', 'default', 'run'];
  const handler = names.map((name) => loaded[name]).find((candidate) => typeof candidate === 'function');
  if (typeof handler !== 'function') throw new Error('Node plugin module does not export a supported handler');
  const result = await handler(workerData.input);
  parentPort.postMessage({ ok: true, result });
}).catch((error) => parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : 'Plugin execution failed' }));
`

export type PluginPageResult = Readonly<{
  status: number
  contentType: 'text/html; charset=utf-8' | 'application/json; charset=utf-8' | 'text/plain; charset=utf-8'
  body: string
  headers: Readonly<Record<string, string>>
  plugin: string
  unsupportedPhp: boolean
}>

export type PluginConfiguration = Readonly<{
  plugin: PluginAdminRecord
  manifest: NodePluginManifest
  fields: readonly PluginConfigField[]
}>

export type PluginConfigurationResult =
  | Readonly<{ status: 'ok'; message: string }>
  | Readonly<{ status: 'invalid'; message: string; errors: Readonly<Record<string, string>> }>

type Candidate = Readonly<{
  record: PluginAdminRecord
  directory: string
  manifest: NodePluginManifest
  rank: number
}>

type InvocationKind = 'page' | 'hook' | 'filter' | 'widget'
type InvocationFactory = (entry: string, kind: InvocationKind, input: unknown, timeoutMs: number) => Promise<unknown>

export class PluginExtensionRuntime {
  private readonly root: string
  private readonly invoke: InvocationFactory
  private readonly timeoutMs: number

  public constructor(
    private readonly store: Pick<PluginAdminStore, 'listPluginRecords' | 'getPlugin' | 'updatePlugin'>,
    pluginsRoot: string,
    options: Readonly<{ invoke?: InvocationFactory; timeoutMs?: number }> = {}
  ) {
    this.root = path.resolve(pluginsRoot)
    this.invoke = options.invoke ?? invokePluginModule
    this.timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 30_000)
  }

  public async configuration(id: unknown): Promise<PluginConfiguration | null> {
    const record = await this.pluginRecord(id)
    if (record === null) return null
    const candidate = await this.candidate(record, 0).catch(() => null)
    return candidate === null ? null : Object.freeze({ plugin: record, manifest: candidate.manifest, fields: candidate.manifest.configFields })
  }

  public async saveConfiguration(id: unknown, values: Record<string, unknown>, now = Math.floor(Date.now() / 1_000)): Promise<PluginConfigurationResult> {
    const configuration = await this.configuration(id)
    if (configuration === null) return { status: 'invalid', message: 'Plugin not found.', errors: Object.freeze({}) }
    const errors: Record<string, string> = {}
    const config: Record<string, unknown> = { ...configuration.plugin.config }
    for (const field of configuration.fields) {
      const raw = scalar(values[field.name])
      if (field.type === 'password' && raw === '') {
        if (field.required && scalar(config[field.name]) === '') errors[field.name] = `${field.label} is required.`
        continue
      }
      if (field.type === 'checkbox') {
        const checked = booleanValue(values[field.name])
        if (field.required && !checked) errors[field.name] = `${field.label} is required.`
        else config[field.name] = checked
        continue
      }
      if (field.required && raw === '') {
        errors[field.name] = `${field.label} is required.`
        continue
      }
      if (raw.length > 100_000) {
        errors[field.name] = `${field.label} is too long.`
        continue
      }
      if (field.type === 'number' && raw !== '') {
        const number = Number(raw)
        if (!Number.isFinite(number) || field.minimum !== undefined && number < field.minimum || field.maximum !== undefined && number > field.maximum) {
          errors[field.name] = `${field.label} is outside its allowed range.`
          continue
        }
        config[field.name] = number
        continue
      }
      if (field.type === 'url' && raw !== '') {
        try {
          const url = new URL(raw)
          if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') throw new Error('Invalid URL')
          config[field.name] = url.href
        } catch { errors[field.name] = `${field.label} must be an HTTP or HTTPS URL.` }
        continue
      }
      if (field.type === 'select' && raw !== '' && !field.options.some((option) => option.value === raw)) {
        errors[field.name] = `${field.label} has an invalid selection.`
        continue
      }
      config[field.name] = raw
    }
    if (Object.keys(errors).length > 0) return { status: 'invalid', message: 'Please correct the plugin configuration.', errors: Object.freeze(errors) }
    const plugin = configuration.plugin
    const write: PluginWrite = Object.freeze({ name: plugin.name, folder: plugin.folder, config: Object.freeze(config), status: plugin.status, created: plugin.created, updated: now })
    if (!await this.store.updatePlugin(plugin.id, write)) return { status: 'invalid', message: 'Plugin configuration failed to save.', errors: Object.freeze({}) }
    return { status: 'ok', message: 'Plugin configuration saved successfully.' }
  }

  public async overridePage(page: string, backend: boolean, input: Readonly<Record<string, unknown>>): Promise<PluginPageResult | null> {
    const normalized = pageName(page)
    if (normalized === null) return null
    for (const candidate of await this.candidates()) {
      const file = candidate.manifest.overrides[backend ? 'backend' : 'frontend'][normalized]
      if (file === undefined) continue
      return await this.renderPage(candidate, file, input)
    }
    return null
  }

  public async pluginPage(plugin: string, page: string, backend: boolean, input: Readonly<Record<string, unknown>>): Promise<PluginPageResult | null> {
    const pluginName = pageName(plugin)
    const requestedPage = pageName(page)
    if (pluginName === null || requestedPage === null) return null
    const candidate = (await this.candidates()).find((item) => item.manifest.folder === pluginName || path.basename(item.directory) === pluginName)
    if (candidate === undefined) return null
    const directory = backend ? 'backend' : 'frontend'
    for (const extension of ['.mjs', '.js', '.cjs', '.html', '.htm', '.php']) {
      const file = `views/${directory}/${requestedPage}${extension}`
      if (await regularPluginFile(candidate.directory, file).catch(() => null) !== null) return await this.renderPage(candidate, file, input)
    }
    return null
  }

  public async executeHook(name: string, data: Readonly<Record<string, unknown>>, context: Readonly<Record<string, unknown>> = {}): Promise<Readonly<Record<string, unknown>>> {
    let result: Readonly<Record<string, unknown>> = Object.freeze({ ...data })
    for (const executable of await this.executables(name)) {
      if (!NODE_EXTENSIONS.has(path.extname(executable.file).toLowerCase())) continue
      try {
        const entry = await regularPluginFile(executable.candidate.directory, executable.file)
        const output = await this.invoke(entry, 'hook', invocationInput(executable.candidate, result, context), this.timeoutMs)
        if (isRecord(output)) result = Object.freeze({ ...result, ...output })
      } catch { /* Legacy hook failures are isolated and the remaining hooks continue. */ }
    }
    return result
  }

  public async filterApiResponse(response: unknown, query: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    let result = response
    for (const executable of await this.executables('api.response.filter')) {
      if (!NODE_EXTENSIONS.has(path.extname(executable.file).toLowerCase())) continue
      try {
        const entry = await regularPluginFile(executable.candidate.directory, executable.file)
        const output = await this.invoke(entry, 'filter', invocationInput(executable.candidate, result, query), this.timeoutMs)
        if (output !== undefined && output !== null) result = output
      } catch { /* A failing filter cannot suppress the base API response. */ }
    }
    return result
  }

  public async renderWidgets(slot: string, isAdmin: boolean, context: Readonly<Record<string, unknown>> = {}): Promise<string> {
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(slot)) return ''
    const widgets: Readonly<{ candidate: Candidate; file: string; priority: number; adminOnly: boolean }>[] = []
    for (const candidate of await this.candidates()) {
      for (const widget of candidate.manifest.widgets[slot] ?? []) widgets.push(Object.freeze({ candidate, ...widget }))
    }
    widgets.sort((left, right) => left.priority - right.priority || left.candidate.rank - right.candidate.rank)
    const output: string[] = []
    for (const widget of widgets) {
      if (widget.adminOnly && !isAdmin) continue
      const extension = path.extname(widget.file).toLowerCase()
      try {
        const entry = await regularPluginFile(widget.candidate.directory, widget.file)
        if (STATIC_EXTENSIONS.has(extension)) output.push(interpolatePluginHtml(await readBoundedText(entry), widget.candidate, context))
        else if (NODE_EXTENSIONS.has(extension)) {
          const value = await this.invoke(entry, 'widget', invocationInput(widget.candidate, Object.freeze({ slot }), context), this.timeoutMs)
          const html = pluginHtml(value)
          if (html !== null) output.push(html)
        }
      } catch { /* Widget failures are isolated like the supplied implementation. */ }
    }
    return output.join('')
  }

  public async asset(plugin: string, relativePath: string): Promise<Readonly<{ path: string; type: string }> | null> {
    const pluginName = pageName(plugin)
    const normalized = relativePath.replaceAll('\\', '/').replace(/^\/+/, '')
    const parts = normalized.split('/')
    if (pluginName === null || parts.length < 2 || !ASSET_ROOTS.has(parts[0] ?? '') || parts.some((part) => part === '' || part === '.' || part === '..')) return null
    const candidate = (await this.candidates()).find((item) => item.manifest.folder === pluginName || path.basename(item.directory) === pluginName)
    if (candidate === undefined) return null
    const file = await regularPluginFile(candidate.directory, normalized).catch(() => null)
    if (file === null) return null
    const type = assetContentType(path.extname(file).toLowerCase())
    return type === null ? null : Object.freeze({ path: file, type })
  }

  private async renderPage(candidate: Candidate, file: string, input: Readonly<Record<string, unknown>>): Promise<PluginPageResult> {
    const extension = path.extname(file).toLowerCase()
    if (extension === '.php') return Object.freeze({ status: 501, contentType: 'text/html; charset=utf-8', body: '<p>This legacy PHP plugin page cannot run in the Node.js runtime.</p>', headers: Object.freeze({}), plugin: candidate.manifest.name, unsupportedPhp: true })
    const entry = await regularPluginFile(candidate.directory, file)
    const raw = STATIC_EXTENSIONS.has(extension)
      ? interpolatePluginHtml(await readBoundedText(entry), candidate, input)
      : NODE_EXTENSIONS.has(extension)
        ? await this.invoke(entry, 'page', invocationInput(candidate, input, Object.freeze({})), this.timeoutMs)
        : null
    const normalized = normalizePage(raw)
    return Object.freeze({ ...normalized, plugin: candidate.manifest.name, unsupportedPhp: false })
  }

  private async executables(name: string): Promise<Readonly<{ candidate: Candidate; file: string; priority: number }>[]> {
    const result: Readonly<{ candidate: Candidate; file: string; priority: number }>[] = []
    for (const candidate of await this.candidates()) for (const executable of candidate.manifest.hooks[name] ?? []) result.push(Object.freeze({ candidate, ...executable }))
    result.sort((left, right) => left.priority - right.priority || left.candidate.rank - right.candidate.rank)
    return result
  }

  private async candidates(): Promise<readonly Candidate[]> {
    const records = await this.store.listPluginRecords()
    const candidates: Candidate[] = []
    for (const record of records) {
      if (!record.active) continue
      const detail = await this.store.getPlugin(record.id)
      if (detail === null || detail.status !== 1) continue
      const candidate = await this.candidate(detail, candidates.length).catch(() => null)
      if (candidate !== null) candidates.push(candidate)
    }
    candidates.sort((left, right) => right.manifest.priority - left.manifest.priority || left.rank - right.rank)
    return Object.freeze(candidates.map((candidate, rank) => Object.freeze({ ...candidate, rank })))
  }

  private async candidate(record: PluginAdminRecord, rank: number): Promise<Candidate> {
    const directory = safePluginDirectory(this.root, record.folder)
    const manifestPath = await regularPluginFile(directory, 'plugin.json')
    const manifest = parsePluginManifest(await readFile(manifestPath))
    return Object.freeze({ record, directory: await realpath(directory), manifest, rank })
  }

  private async pluginRecord(id: unknown): Promise<PluginAdminRecord | null> {
    const value = scalar(id)
    if (!/^[1-9]\d{0,9}$/.test(value)) return null
    return await this.store.getPlugin(value)
  }
}

async function regularPluginFile(directory: string, relative: string): Promise<string> {
  const root = await realpath(directory)
  const target = path.resolve(root, relative)
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Plugin file escaped its directory')
  const status = await lstat(target)
  if (!status.isFile() || status.isSymbolicLink()) throw new Error('Plugin file is not regular')
  const resolved = await realpath(target)
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Plugin file traversed a symbolic link')
  return resolved
}

async function readBoundedText(file: string): Promise<string> {
  const data = await readFile(file)
  if (data.length > MAX_RESULT_BYTES) throw new Error('Plugin output exceeds the size limit')
  return data.toString('utf8')
}

async function invokePluginModule(entry: string, kind: InvocationKind, input: unknown, timeoutMs: number): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const worker = new Worker(INVOCATION_WORKER, {
      eval: true,
      env: { NODE_ENV: process.env.NODE_ENV ?? 'production' },
      workerData: { entry: pathToFileURL(entry).href, kind, input },
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
    })
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error('Plugin execution timed out'))
    }, timeoutMs)
    timer.unref()
    worker.once('message', (message: unknown) => {
      clearTimeout(timer)
      void worker.terminate()
      const record = isRecord(message) ? message : {}
      if (record.ok !== true) return reject(new Error(typeof record.message === 'string' ? record.message : 'Plugin execution failed'))
      try {
        const bytes = Buffer.byteLength(JSON.stringify(record.result) ?? '')
        if (bytes > MAX_RESULT_BYTES) throw new Error('Plugin output exceeds the size limit')
        resolve(record.result)
      } catch (error) { reject(error) }
    })
    worker.once('error', (error) => { clearTimeout(timer); reject(error) })
    worker.once('exit', (code) => { if (code !== 0) { clearTimeout(timer); reject(new Error('Plugin worker exited unexpectedly')) } })
  })
}

function invocationInput(candidate: Candidate, data: unknown, context: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    data,
    context,
    config: candidate.record.config,
    plugin: Object.freeze({ id: candidate.record.id, name: candidate.manifest.name, folder: candidate.manifest.folder, version: candidate.manifest.version })
  })
}

function normalizePage(value: unknown): Omit<PluginPageResult, 'plugin' | 'unsupportedPhp'> {
  const record = isRecord(value) ? value : {}
  const direct = typeof value === 'string' ? value : undefined
  const bodyValue = direct ?? (typeof record.body === 'string' ? record.body : typeof record.html === 'string' ? record.html : undefined)
  if (bodyValue === undefined || Buffer.byteLength(bodyValue) > MAX_RESULT_BYTES) return { status: 500, contentType: 'text/plain; charset=utf-8', body: 'Plugin page returned an invalid response.', headers: Object.freeze({}) }
  const status = boundedInteger(record.status, 200, 200, 599)
  const contentType = record.contentType === 'application/json' || record.contentType === 'application/json; charset=utf-8'
    ? 'application/json; charset=utf-8' as const
    : record.contentType === 'text/plain' || record.contentType === 'text/plain; charset=utf-8'
      ? 'text/plain; charset=utf-8' as const
      : 'text/html; charset=utf-8' as const
  const headers: Record<string, string> = {}
  if (isRecord(record.headers)) {
    for (const name of ['cache-control', 'location']) {
      const candidate = record.headers[name]
      if (typeof candidate === 'string' && candidate.length <= 2_048 && !/[\r\n]/.test(candidate)) headers[name] = candidate
    }
  }
  return Object.freeze({ status, contentType, body: bodyValue, headers: Object.freeze(headers) })
}

function pluginHtml(value: unknown): string | null {
  const html = typeof value === 'string' ? value : isRecord(value) && typeof value.html === 'string' ? value.html : null
  return html !== null && Buffer.byteLength(html) <= MAX_RESULT_BYTES ? html : null
}

function assetContentType(extension: string): string | null {
  return ({
    '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8'
  } as Record<string, string>)[extension] ?? null
}

function interpolatePluginHtml(template: string, candidate: Candidate, input: Readonly<Record<string, unknown>>): string {
  const replacements: Record<string, unknown> = {
    csrf: input.csrf,
    base_url: input.baseUrl,
    admin_directory: input.adminDirectory,
    plugin_name: candidate.manifest.name,
    plugin_folder: candidate.manifest.folder,
    plugin_version: candidate.manifest.version,
    plugin_asset_base: `/plugins/${encodeURIComponent(candidate.manifest.folder)}/assets/`
  }
  for (const [key, value] of Object.entries(candidate.record.config)) replacements[`config.${key}`] = value
  return template.replace(/\{\{\s*([a-z0-9_.-]+)\s*\}\}/gi, (full, key: string) => key in replacements ? escapeHtml(String(replacements[key] ?? '')) : full)
}

function escapeHtml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;') }

function pageName(value: string): string | null { const normalized = value.trim(); return /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(normalized) ? normalized : null }
function scalar(value: unknown): string { const item = Array.isArray(value) ? value.at(-1) : value; return typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' ? String(item).trim() : '' }
function booleanValue(value: unknown): boolean { const item = Array.isArray(value) ? value.at(-1) : value; return item === true || item === 1 || item === '1' || item === 'true' || item === 'on' }
function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number { const parsed = typeof value === 'number' ? value : Number.parseInt(typeof value === 'string' ? value : '', 10); return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
