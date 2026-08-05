import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginArchive } from '../src/plugins/plugin-archive.js'
import { PluginBackgroundManager, safePluginDirectory } from '../src/plugins/plugin-background-manager.js'
import { PluginMaintenanceWorker } from '../src/plugins/plugin-maintenance-worker.js'
import { MySqlPluginMaintenanceStore } from '../src/plugins/mysql-plugin-maintenance-store.js'
import { PluginSyncClient, pluginSyncUrl } from '../src/plugins/plugin-sync-client.js'

describe('Node plugin archive', () => {
  let root = ''

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true })
    root = ''
  })

  it('extracts validated deflated files and preserves keep_files during an upgrade', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-plugin-archive-'))
    const destination = path.join(root, 'sample')
    const first = zipFixture({
      'plugin.json': JSON.stringify({ name: 'Sample', folder: 'sample', version: '1.0.0', keep_files: ['state.json'], config: { background: 'background.mjs' } }),
      'background.mjs': 'export default async function () {}',
      'state.json': '{"source":"first"}'
    }, true)
    await PluginArchive.fromBuffer(first).extract(destination, false, root)
    await writeFile(path.join(destination, 'state.json'), '{"local":true}')

    const upgrade = zipFixture({
      'plugin.json': JSON.stringify({ name: 'Sample', folder: 'sample', version: '2.0.0', keep_files: ['state.json'], config: { background_node: 'background.mjs' } }),
      'background.mjs': 'export default async function () { return 2 }',
      'state.json': '{"source":"upgrade"}'
    }, true)
    const archive = PluginArchive.fromBuffer(upgrade)
    expect(archive.manifest).toMatchObject({ name: 'Sample', folder: 'sample', version: '2.0.0', background: 'background.mjs' })
    await archive.extract(destination, true, root)

    await expect(readFile(path.join(destination, 'state.json'), 'utf8')).resolves.toBe('{"local":true}')
    await expect(readFile(path.join(destination, 'background.mjs'), 'utf8')).resolves.toContain('return 2')
  })

  it('rejects traversal, symbolic-link metadata, duplicate case-folded names, and bad checksums before writing', () => {
    expect(() => PluginArchive.fromBuffer(zipFixture({ '../escape.txt': 'bad', 'plugin.json': validManifest() }))).toThrow('traversal')
    expect(() => PluginArchive.fromBuffer(zipFixture({ 'plugin.json': validManifest(), 'A.txt': 'one', 'a.txt': 'two' }))).toThrow('Duplicate')
    const symlink = zipFixture({ 'plugin.json': validManifest(), 'link': 'target' }, false, new Set(['link']))
    expect(() => PluginArchive.fromBuffer(symlink)).toThrow('Symbolic links')
    const corrupt = zipFixture({ 'plugin.json': validManifest(), 'file.txt': 'payload' })
    const payloadOffset = corrupt.indexOf(Buffer.from('payload'))
    if (payloadOffset < 0) throw new Error('ZIP fixture is missing its payload')
    corrupt[payloadOffset] = (corrupt[payloadOffset] ?? 0) ^ 0xff
    expect(() => PluginArchive.fromBuffer(corrupt)).toThrow('checksum')
  })
})

describe('plugin synchronization client', () => {
  it('builds the legacy-compatible authenticated sync URL without putting it in an error or log surface', async () => {
    const target = pluginSyncUrl(new URL('https://main.example/base/'), 'control', '42', 'fixture-secret', 'download')
    expect(target.pathname).toBe('/base/control/plugins/sync/')
    expect(Object.fromEntries(target.searchParams)).toEqual({ id: '42', secure: 'fixture-secret', action: 'download' })

    const bodies = [webBody('ok'), webBody('plugin-bytes')]
    const open = vi.fn(async () => ({ status: 200, body: bodies.shift() ?? null }))
    const client = new PluginSyncClient({ open } as never, 'control', 'fixture-secret')
    await expect(client.ping(new URL('https://main.example/'), '42', 2_000)).resolves.toBe(true)
    await expect(client.download(new URL('https://main.example/'), '42', 2_000)).resolves.toEqual(Buffer.from('plugin-bytes'))
    expect(open).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenNthCalledWith(1, expect.objectContaining({ allowPrivateNetworks: true, maximumRedirects: 2, signal: expect.any(AbortSignal) }))
  })
})

describe('plugin maintenance worker', () => {
  let root = ''

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true })
    root = ''
  })

  it('pings, waits when the master is still preparing, downloads, safely upgrades, and reconciles backgrounds', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-plugin-sync-'))
    const data = zipFixture({ 'plugin.json': validManifest(), 'background.mjs': 'export default async function () {}' }, true)
    const store = { listPlugins: vi.fn(async () => [{ id: '7', name: 'Sample', folder: 'plugins/sample/', active: true }]) }
    const client = { ping: vi.fn(async () => false), download: vi.fn(async () => data) }
    const backgrounds = {
      reconcile: vi.fn(async () => ({ started: 1, stopped: 0, running: 1, unsupportedPhp: 0, invalid: 0 }))
    }
    const delays: number[] = []
    const worker = new PluginMaintenanceWorker(
      store,
      client,
      backgrounds as never,
      root,
      async () => ({ loadBalancer: true, mainSite: new URL('https://main.example/') }),
      { delay: async (milliseconds) => { delays.push(milliseconds) }, timeout: 4_000 }
    )

    await expect(worker.runOnce()).resolves.toEqual({
      active: 1,
      synchronized: 1,
      failed: 0,
      backgrounds: { started: 1, stopped: 0, running: 1, unsupportedPhp: 0, invalid: 0 }
    })
    expect(delays).toEqual([2_000])
    expect(client.ping).toHaveBeenCalledWith(new URL('https://main.example/'), '7', 4_000)
    await expect(readFile(path.join(root, 'sample/plugin.json'), 'utf8')).resolves.toContain('Sample')
    await expect(readFile(path.join(root, 'tmp/sample.zip'))).resolves.toEqual(data)
    expect(backgrounds.reconcile).toHaveBeenCalledWith(await store.listPlugins.mock.results[0]?.value)
  })

  it('retains an existing installation when a downloaded archive is invalid and skips sync on the main node', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-plugin-retain-'))
    await mkdir(path.join(root, 'sample'), { recursive: true })
    await writeFile(path.join(root, 'sample/keep.txt'), 'preserved')
    const records = [{ id: '7', name: 'Sample', folder: 'sample/', active: true }]
    const store = { listPlugins: vi.fn(async () => records) }
    const backgrounds = { reconcile: vi.fn(async () => ({ started: 0, stopped: 0, running: 0, unsupportedPhp: 0, invalid: 1 })) }
    const failedClient = { ping: vi.fn(async () => true), download: vi.fn(async () => Buffer.from('not-a-zip')) }
    const loadBalancer = new PluginMaintenanceWorker(store, failedClient, backgrounds as never, root, async () => ({ loadBalancer: true, mainSite: new URL('https://main.example/') }))
    await expect(loadBalancer.runOnce()).resolves.toMatchObject({ synchronized: 0, failed: 1 })
    await expect(readFile(path.join(root, 'sample/keep.txt'), 'utf8')).resolves.toBe('preserved')

    const mainClient = { ping: vi.fn(), download: vi.fn() }
    const main = new PluginMaintenanceWorker(store, mainClient as never, backgrounds as never, root, async () => ({ loadBalancer: false, mainSite: new URL('https://player.example/') }))
    await expect(main.runOnce()).resolves.toMatchObject({ active: 1, synchronized: 0, failed: 0 })
    expect(mainClient.ping).not.toHaveBeenCalled()
    expect(mainClient.download).not.toHaveBeenCalled()
  })
})

describe('Node plugin background lifecycle', () => {
  let root = ''

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true })
    root = ''
  })

  it('starts JavaScript modules, stops them when disabled, and never executes PHP backgrounds', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-plugin-background-'))
    await mkdir(path.join(root, 'node-plugin'), { recursive: true })
    await writeFile(path.join(root, 'node-plugin/plugin.json'), JSON.stringify({ name: 'Node', folder: 'node-plugin', version: '1', config: { background: 'background.mjs' } }))
    await writeFile(path.join(root, 'node-plugin/background.mjs'), 'export default async function () { await new Promise(() => setInterval(() => {}, 1000)) }')
    await mkdir(path.join(root, 'php-plugin'), { recursive: true })
    await writeFile(path.join(root, 'php-plugin/plugin.json'), JSON.stringify({ name: 'PHP', folder: 'php-plugin', version: '1', config: { background: 'background.php' } }))
    await writeFile(path.join(root, 'php-plugin/background.php'), '<?php throw new Exception("must never run");')
    const manager = new PluginBackgroundManager(root)

    await expect(manager.reconcile([
      { id: '1', name: 'Node', folder: 'plugins/node-plugin/', active: true },
      { id: '2', name: 'PHP', folder: 'plugins/php-plugin/', active: true }
    ])).resolves.toEqual({ started: 1, stopped: 0, running: 1, unsupportedPhp: 1, invalid: 0 })
    await expect(manager.reconcile([
      { id: '1', name: 'Node', folder: 'plugins/node-plugin/', active: false },
      { id: '2', name: 'PHP', folder: 'plugins/php-plugin/', active: false }
    ])).resolves.toEqual({ started: 0, stopped: 1, running: 0, unsupportedPhp: 0, invalid: 0 })
    await manager.close()
  })

  it('rejects stored folders outside the dedicated plugins root', () => {
    expect(() => safePluginDirectory('/srv/app/plugins', '../outside')).toThrow('invalid')
    expect(() => safePluginDirectory('/srv/app/plugins', 'public/evil')).toThrow('outside')
    expect(safePluginDirectory('/srv/app/plugins', 'plugins/valid-one/')).toBe('/srv/app/plugins/valid-one')
  })
})

describe('MySQL plugin maintenance store', () => {
  it('reads the exact tb_plugins lifecycle columns without interpolating values', async () => {
    const read = vi.fn(async () => [{ id: 3, name: 'Sample', folder: 'plugins/sample/', status: 1 }])
    const store = new MySqlPluginMaintenanceStore({ read } as never)
    await expect(store.listPlugins()).resolves.toEqual([{ id: '3', name: 'Sample', folder: 'plugins/sample/', active: true }])
    expect(read).toHaveBeenCalledWith('SELECT `id`, `name`, `folder`, `status` FROM `tb_plugins` ORDER BY `id` ASC')
  })
})

function validManifest(): string {
  return JSON.stringify({ name: 'Sample', folder: 'sample', version: '1.0.0', config: { background: 'background.mjs' } })
}

function webBody(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(value)); controller.close() } })
}

function zipFixture(files: Readonly<Record<string, string>>, deflated = false, symlinks: ReadonlySet<string> = new Set()): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, value] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name)
    const data = Buffer.from(value)
    const compressed = deflated ? deflateRawSync(data) : data
    const method = deflated ? 8 : 0
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    locals.push(local, nameBuffer, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt32LE(((symlinks.has(name) ? 0xa1ff : 0x81a4) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuffer)
    offset += local.length + nameBuffer.length + compressed.length
  }
  const localData = Buffer.concat(locals)
  const centralData = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralData.length, 12)
  eocd.writeUInt32LE(localData.length, 16)
  return Buffer.concat([localData, centralData, eocd])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
