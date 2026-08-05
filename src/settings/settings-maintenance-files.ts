import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import type { SettingsMaintenanceFiles } from './settings-maintenance-service.js'

export class FileSystemSettingsMaintenanceFiles implements SettingsMaintenanceFiles {
  private readonly temporaryRoot: string
  private readonly cacheRoot: string
  private readonly cacheFilesRoot: string
  private readonly imageTemporaryRoot: string
  private readonly subtitleTemporaryRoot: string

  public constructor(input: Readonly<{ temporaryRoot: string; cacheRoot: string; uploadsRoot: string }>) {
    this.temporaryRoot = safeRoot(input.temporaryRoot, 'temporary')
    this.cacheRoot = safeRoot(input.cacheRoot, 'cache')
    const uploadsRoot = safeRoot(input.uploadsRoot, 'uploads')
    this.cacheFilesRoot = safeChild(this.cacheRoot, 'files')
    this.imageTemporaryRoot = safeChild(uploadsRoot, path.join('images', 'tmp'))
    this.subtitleTemporaryRoot = safeChild(uploadsRoot, path.join('subtitles', 'tmp'))
  }

  public async clearAll(): Promise<boolean> {
    await Promise.all([
      replaceDirectory(this.temporaryRoot),
      replaceDirectory(this.cacheRoot),
      replaceDirectory(this.imageTemporaryRoot),
      replaceDirectory(this.subtitleTemporaryRoot)
    ])
    return true
  }

  public async clearSettingsTemporary(): Promise<boolean> {
    await replaceDirectory(this.temporaryRoot)
    return true
  }

  public async clearVideoCache(): Promise<boolean> {
    await replaceDirectory(this.cacheFilesRoot)
    return true
  }

  public async clearVideoFiles(): Promise<Readonly<{ imageFilesCleared: boolean; subtitleFilesCleared: boolean; cacheFilesCleared: boolean }>> {
    await Promise.all([
      replaceDirectory(this.subtitleTemporaryRoot),
      replaceDirectory(this.imageTemporaryRoot),
      replaceDirectory(this.cacheFilesRoot)
    ])
    return Object.freeze({ imageFilesCleared: true, subtitleFilesCleared: true, cacheFilesCleared: true })
  }
}

function safeRoot(value: string, label: string): string {
  const resolved = path.resolve(value)
  if (resolved === path.parse(resolved).root) throw new Error(`The ${label} maintenance root is too broad`)
  return resolved
}

function safeChild(root: string, suffix: string): string {
  const candidate = path.resolve(root, suffix)
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) throw new Error('A settings maintenance path escaped its configured root')
  return candidate
}

async function replaceDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
}
