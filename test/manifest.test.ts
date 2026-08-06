import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { LEGACY_BACKGROUND_WORKER_RUNTIME } from '../src/drive/drive-background-worker.js'
import { ExtractorFactory } from '../src/hosting/extractor-factory.js'
import { hostingCases } from './fixtures/hosting-cases.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('generated legacy parity manifest', () => {
  it('captures the supplied 4.8.3 application surface', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'docs/parity-manifest.json'), 'utf8'))

    expect(manifest.source.version).toBe('4.8.3')
    expect(manifest.routes.frontend).toHaveLength(28)
    expect(manifest.routes.backend).toHaveLength(42)
    expect(manifest.features.hostingAdapters).toHaveLength(64)
    expect(manifest.features.databaseMigrations).toHaveLength(20)
    expect(manifest.features.backgroundWorkers).toHaveLength(6)
    expect(Object.keys(manifest.database.tables)).toHaveLength(20)
    expect(manifest.database.views).toEqual(['vw_loadbalancers', 'vw_subtitle_manager', 'vw_users', 'vw_videos'])
    expect(manifest.database.version).toBe(101)

    const inventoriedAdapters = manifest.features.hostingAdapters.map((name: string) => name.toLowerCase())
    const fixtureAdapters = hostingCases.map(([host]) => host)
    expect(inventoriedAdapters.filter((adapter: string) => adapter !== 'xvs').sort()).toEqual([...fixtureAdapters].sort())
  })

  it('maps every supplied backend view to a registered Node route and test', async () => {
    type AdminRoute = Readonly<{ legacy: string; method: 'GET' | 'POST'; replacement: string; sourceFile: string; testFile: string }>
    const [manifest, map] = await Promise.all([
      fs.readFile(path.join(projectRoot, 'docs/parity-manifest.json'), 'utf8').then((value) => JSON.parse(value)),
      fs.readFile(path.join(projectRoot, 'docs/admin-parity-map.json'), 'utf8').then((value) => JSON.parse(value) as { legacyRoutes: AdminRoute[]; ajaxControllers: AdminRoute[] })
    ])
    expect(map.legacyRoutes.map((entry) => entry.legacy).sort()).toEqual([...manifest.routes.backend].sort())
    expect(map.ajaxControllers.map((entry) => entry.legacy).sort()).toEqual([...manifest.routes.ajaxControllers].sort())
    for (const entry of [...map.legacyRoutes, ...map.ajaxControllers]) {
      if (map.legacyRoutes.includes(entry)) expect(entry.replacement).toBe(`/administrator/${entry.legacy}/`)
      await expect(fs.access(path.join(projectRoot, entry.sourceFile))).resolves.toBeUndefined()
      await expect(fs.access(path.join(projectRoot, entry.testFile))).resolves.toBeUndefined()
    }

    const app = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: '1234567890123456' }))
    try {
      await app.ready()
      for (const entry of [...map.legacyRoutes, ...map.ajaxControllers]) expect(app.hasRoute({ method: entry.method, url: entry.replacement }), `${entry.method} ${entry.replacement}`).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('maps every supplied background entry point to a tested Node runtime', async () => {
    type BackgroundMap = Readonly<{ legacy: string; coordinatorJob: string; runtime: string; sourceFile: string; testFile: string }>
    const [manifest, map] = await Promise.all([
      fs.readFile(path.join(projectRoot, 'docs/parity-manifest.json'), 'utf8').then((value) => JSON.parse(value)),
      fs.readFile(path.join(projectRoot, 'docs/background-parity-map.json'), 'utf8').then((value) => JSON.parse(value) as { legacyWorkers: BackgroundMap[] })
    ])
    expect(map.legacyWorkers.map((entry) => entry.legacy).sort()).toEqual([...manifest.features.backgroundWorkers].sort())
    expect(Object.fromEntries(map.legacyWorkers.map((entry) => [entry.legacy, entry.coordinatorJob]))).toEqual(LEGACY_BACKGROUND_WORKER_RUNTIME)
    for (const entry of map.legacyWorkers) {
      expect(entry.runtime).not.toBe('')
      await expect(fs.access(path.join(projectRoot, entry.sourceFile))).resolves.toBeUndefined()
      await expect(fs.access(path.join(projectRoot, entry.testFile))).resolves.toBeUndefined()
    }
  })

  it('maps every supplied default-theme file to a registered and tested Node surface', async () => {
    type ThemeMap = Readonly<{
      legacy: string
      runtime: string
      route?: string
      replacementFiles: readonly string[]
      testFile: string
    }>
    const [manifest, map] = await Promise.all([
      fs.readFile(path.join(projectRoot, 'docs/parity-manifest.json'), 'utf8').then((value) => JSON.parse(value)),
      fs.readFile(path.join(projectRoot, 'docs/theme-parity-map.json'), 'utf8').then((value) => JSON.parse(value) as {
        bundledThemes: { backend: string[]; frontend: string[] }
        legacyThemeFiles: ThemeMap[]
      })
    ])
    expect(map.bundledThemes).toEqual({ backend: ['default'], frontend: ['default'] })
    expect(map.legacyThemeFiles.map((entry) => entry.legacy).sort()).toEqual([...manifest.features.themes].sort())
    for (const entry of map.legacyThemeFiles) {
      expect(entry.runtime).not.toBe('')
      expect(entry.replacementFiles.length).toBeGreaterThan(0)
      for (const replacement of entry.replacementFiles) {
        await expect(fs.access(path.join(projectRoot, replacement))).resolves.toBeUndefined()
      }
      await expect(fs.access(path.join(projectRoot, entry.testFile))).resolves.toBeUndefined()
    }

    const app = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: '1234567890123456' }))
    try {
      await app.ready()
      for (const route of new Set(map.legacyThemeFiles.flatMap((entry) => entry.route === undefined ? [] : [entry.route]))) {
        expect(app.hasRoute({ method: 'GET', url: route }), `GET ${route}`).toBe(true)
      }
    } finally {
      await app.close()
    }
  })

  it('maps every legacy browser and optional external workflow to tested Node code', async () => {
    type BrowserlessMap = Readonly<{ legacyClass: string; host: string; replacementFile: string; testFile: string }>
    type ExternalMap = Readonly<{ legacy: string; replacementFiles: readonly string[]; testFiles: readonly string[] }>
    const map = JSON.parse(await fs.readFile(path.join(projectRoot, 'docs/external-service-parity-map.json'), 'utf8')) as {
      browserlessAdapters: BrowserlessMap[]
      optionalTools: ExternalMap[]
      networkServices: ExternalMap[]
    }
    expect(map.browserlessAdapters.map((entry) => entry.legacyClass).sort()).toEqual([
      'Blogger', 'Cloudmailru', 'Dood', 'Facebook', 'Filemoon', 'Filesfm', 'Hxfile', 'Mediafire', 'Mstream', 'Navertv', 'Rumble', 'Voe'
    ])
    const supportedHosts = new Set(new ExtractorFactory().supportedHosts())
    for (const entry of map.browserlessAdapters) {
      expect(supportedHosts.has(entry.host), entry.host).toBe(true)
      await expect(fs.access(path.join(projectRoot, entry.replacementFile))).resolves.toBeUndefined()
      await expect(fs.access(path.join(projectRoot, entry.testFile))).resolves.toBeUndefined()
      const implementation = await fs.readFile(path.join(projectRoot, entry.replacementFile), 'utf8')
      expect(implementation).not.toMatch(/puppeteer|playwright|selenium|HeadlessChrome/iu)
    }
    expect(map.optionalTools.map((entry) => entry.legacy).sort()).toEqual([
      'HeadlessChrome', 'PowerShell system metrics', 'YtdlpBridge', 'aria2c', 'shell port and connection enumeration'
    ])
    expect(map.networkServices.map((entry) => entry.legacy).sort()).toEqual([
      'Google reCAPTCHA verification', 'HTTP, HTTPS, SOCKS, and configured provider proxies', 'MaxMind GeoLite2 country and ASN lookup',
      'SMTP account mail', 'Subscene subtitle archive ingestion'
    ])
    for (const entry of [...map.optionalTools, ...map.networkServices]) {
      expect(entry.replacementFiles.length).toBeGreaterThan(0)
      expect(entry.testFiles.length).toBeGreaterThan(0)
      for (const file of [...entry.replacementFiles, ...entry.testFiles]) {
        await expect(fs.access(path.join(projectRoot, file))).resolves.toBeUndefined()
      }
    }
    const packageJson = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8')
    expect(packageJson).not.toMatch(/puppeteer|playwright|selenium|yt-dlp|youtube-dl|aria2c/iu)
  })
})
