import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { mediaCachePaths } from '../background/media-cache-path.js'
import type { PrivateCacheIdentity } from './private-admin-service.js'

export interface PrivateCacheManager {
  clearVideos(identities: readonly PrivateCacheIdentity[]): Promise<boolean>
  clearLoadBalancerFiles(): Promise<boolean>
}

export class FileSystemPrivateCacheManager implements PrivateCacheManager {
  private readonly cacheRoot: string
  private readonly filesRoot: string

  public constructor(cacheRoot: string) {
    this.cacheRoot = path.resolve(cacheRoot)
    this.filesRoot = path.resolve(this.cacheRoot, 'files')
    if (this.filesRoot === this.cacheRoot || !this.filesRoot.startsWith(`${this.cacheRoot}${path.sep}`)) {
      throw new Error('Media cache files path escaped its configured root')
    }
  }

  public async clearVideos(identities: readonly PrivateCacheIdentity[]): Promise<boolean> {
    const directories = new Set(identities.map((identity) => mediaCachePaths(this.cacheRoot, identity.host, identity.hostId, 'Original').directory))
    await Promise.all([...directories].map(async (directory) => await rm(directory, { recursive: true, force: true })))
    return true
  }

  public async clearLoadBalancerFiles(): Promise<boolean> {
    await rm(this.filesRoot, { recursive: true, force: true })
    await mkdir(this.filesRoot, { recursive: true })
    return true
  }
}
