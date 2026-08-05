import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { legacyHostingData } from '../src/core/hosting-data.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(absolute))
    else if (entry.isFile()) files.push(absolute)
  }
  return files
}

describe('legacy non-PHP assets', () => {
  it('copies every inventoried public static asset', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'docs/parity-manifest.json'), 'utf8')) as {
      features: { staticAssets: string[] }
    }

    const missing: string[] = []
    for (const relative of manifest.features.staticAssets) {
      try {
        await fs.access(path.join(projectRoot, relative))
      } catch {
        missing.push(relative)
      }
    }
    expect(missing).toEqual([])
  })

  it('keeps the runtime hostname and URL data byte-for-meaning equivalent', async () => {
    const hostnameJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'resources/data/json/custom-hostnames.json'), 'utf8'))
    const downloadUrlJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'resources/data/json/download-urls.json'), 'utf8'))
    expect(legacyHostingData.hostnames).toEqual(hostnameJson)
    expect(legacyHostingData.downloadUrls).toEqual(downloadUrlJson)
  })

  it('contains no PHP runtime files', async () => {
    const files = await filesUnder(projectRoot)
    expect(files.filter((file) => file.endsWith('.php'))).toEqual([])
  })
})
