import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
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
})
