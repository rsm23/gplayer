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

  it('keeps the static Pages install shortcuts inside the published landing', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'public/manifest.json'), 'utf8')) as {
      start_url: string
      shortcuts: Array<{ url: string; icons: Array<{ src: string }> }>
    }
    expect(manifest.start_url).toBe('./?source=pwa')
    expect(manifest.shortcuts.map((shortcut) => shortcut.url)).toEqual([
      './?utm_source=homescreen#generator',
      './?utm_source=homescreen#product-demo'
    ])
    for (const shortcut of manifest.shortcuts) {
      expect(shortcut.url.startsWith('./')).toBe(true)
      await expect(fs.access(path.join(projectRoot, 'public', shortcut.icons[0]?.src ?? 'missing'))).resolves.toBeUndefined()
    }
  })

  it('keeps runtime markers out of the static document title text', async () => {
    const landing = await fs.readFile(path.join(projectRoot, 'public/index.html'), 'utf8')
    expect(landing).toContain('<title data-runtime-site-title>GPlayer | 63 sources, one Node.js player</title>')
    expect(landing).not.toMatch(/<title[^>]*>[^<]*<!--/u)
  })

  it('contains no PHP runtime files', async () => {
    const files = await filesUnder(projectRoot)
    expect(files.filter((file) => file.endsWith('.php'))).toEqual([])
  })
})
