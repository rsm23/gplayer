import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
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
})
