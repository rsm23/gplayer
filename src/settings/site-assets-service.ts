import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile, access, unlink } from 'node:fs/promises'
import path from 'node:path'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'
import type { SiteSettings } from './settings-admin-service.js'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ICON_FILES = Object.freeze([
  ['icon-144x144.png', 144],
  ['icon-192x192.png', 192],
  ['icon-256x256.png', 256],
  ['icon-384x384.png', 384],
  ['icon-512x512.png', 512],
  ['apple-touch-icon-152x152.png', 152],
  ['apple-touch-icon-152x152-precomposed.png', 152],
  ['apple-touch-icon-120x120.png', 120],
  ['apple-touch-icon-120x120-precomposed.png', 120],
  ['apple-touch-icon-114x114.png', 114],
  ['apple-touch-icon-72x72.png', 72],
  ['apple-touch-icon-57x57.png', 57],
  ['apple-touch-icon.png', 57],
  ['apple-touch-icon-precomposed.png', 57]
] as const)

export class InvalidSiteAssetError extends Error {}

export interface SiteAssetManager {
  hasLogo(): Promise<boolean>
  validateLogo(logo: Buffer): Promise<void>
  update(settings: SiteSettings, logo?: Buffer): Promise<void>
}

export class FileSystemSiteAssetManager implements SiteAssetManager {
  public constructor(private readonly publicRoot: string, private readonly adminDirectory: string) {}

  public async hasLogo(): Promise<boolean> {
    try {
      await access(path.join(this.publicRoot, 'assets/img/logo.png'))
      return true
    } catch {
      return false
    }
  }

  public async update(settings: SiteSettings, logo?: Buffer): Promise<void> {
    if (logo !== undefined) await this.writeLogoAssets(logo)
    const manifest = siteManifest(settings, await this.hasLogo(), this.adminDirectory)
    await writeAtomically(path.join(this.publicRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }

  public async validateLogo(input: Buffer): Promise<void> {
    if (input.length === 0 || input.length > 5_242_880 || !input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new InvalidSiteAssetError('The logo must be a PNG image no larger than 5 MB')
    }
    try {
      const metadata = await sharp(input, { limitInputPixels: 16_777_216 }).metadata()
      if (metadata.format !== 'png' || metadata.width === undefined || metadata.height === undefined) throw new Error('invalid PNG')
    } catch {
      throw new InvalidSiteAssetError('The uploaded logo is not a valid PNG image')
    }
  }

  private async writeLogoAssets(input: Buffer): Promise<void> {
    await this.validateLogo(input)

    const imageDirectory = path.join(this.publicRoot, 'assets/img')
    await mkdir(imageDirectory, { recursive: true })
    const normalized = await sharp(input, { limitInputPixels: 16_777_216 })
      .rotate()
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()

    await writeAtomically(path.join(imageDirectory, 'logo.png'), normalized)
    await Promise.all(ICON_FILES.map(async ([filename, size]) => {
      const output = await sharp(normalized).resize(size, size).png().toBuffer()
      await writeAtomically(path.join(imageDirectory, filename), output)
    }))
    const favicon = await pngToIco(await Promise.all([16, 32].map(async (size) => await sharp(normalized).resize(size, size).png().toBuffer())))
    await writeAtomically(path.join(this.publicRoot, 'favicon.ico'), favicon)
  }
}

export function siteManifest(settings: SiteSettings, logoAvailable: boolean, adminDirectory: string): Readonly<Record<string, unknown>> {
  const icons = logoAvailable
    ? [{ src: 'assets/img/logo.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }]
    : [
        { src: 'assets/img/film.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: 'assets/img/maskable_icon.png', sizes: '1024x1024', type: 'image/png', purpose: 'maskable' }
      ]
  return Object.freeze({
    name: settings.site_name,
    short_name: settings.pwa_shortname,
    description: settings.site_description,
    id: './',
    start_url: './?source=pwa',
    scope: './',
    display: settings.pwa_display,
    display_override: ['window-controls-overlay'],
    background_color: `#${settings.pwa_backgroundcolor}`,
    theme_color: `#${settings.pwa_themecolor}`,
    icons,
    shortcuts: [
      {
        name: 'Google Drive Bypass Limit',
        short_name: 'Google Drive Bypass Limit',
        description: 'View Google Drive direct link generator and downloader',
        url: './sharer/?utm_source=homescreen',
        icons: [{ src: 'assets/img/google-drive.png', sizes: '512x512', type: 'image/png' }]
      },
      {
        name: 'Video List',
        short_name: 'Video List',
        description: 'Show a list of videos stored on your account.',
        url: `./${adminDirectory}/videos/list/?utm_source=homescreen`,
        icons: [{ src: 'assets/img/film.png', sizes: '512x512', type: 'image/png' }]
      }
    ]
  })
}

async function writeAtomically(target: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, data, { mode: 0o644 })
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}
