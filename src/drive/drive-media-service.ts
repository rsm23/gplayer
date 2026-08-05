import type { DriveAdminStore, DriveApiClient, DriveLocatedFile, DriveMediaRequest } from './drive-admin-service.js'
import { parseGoogleDriveId } from './drive-sharer-service.js'
import type { Security } from '../security/security.js'

export type DriveRuntimeSettings = Readonly<{ copy: boolean; copyAll: boolean }>
export type DriveRuntimeSettingsLoader = () => Promise<DriveRuntimeSettings>

export type DrivePrivateSource = Readonly<{
  file: string
  type: 'video/mp4'
  label: 'Original'
  proxy: false
  title: string
  image: string
}>

export interface DrivePrivateSourceResolver {
  enqueue(fileId: string): Promise<void>
  resolve(fileId: string, preferredEmail: string, allowCopy: boolean): Promise<DrivePrivateSource | null>
}

export class DriveMediaService implements DrivePrivateSourceResolver {
  public constructor(
    private readonly store: DriveAdminStore,
    private readonly api: DriveApiClient,
    private readonly security: Security,
    private readonly baseUrl: URL
  ) {}

  public async enqueue(fileId: string): Promise<void> {
    const id = parseGoogleDriveId(fileId)
    if (id !== null) await this.store.enqueueQueue(id, false).catch(() => false)
  }

  public async resolve(fileId: string, preferredEmail: string, allowCopy: boolean): Promise<DrivePrivateSource | null> {
    const id = parseGoogleDriveId(fileId)
    if (id === null) return null
    const located = allowCopy
      ? (await this.api.copyFromAnyOutcome(id, true)).located
      : await this.api.locateFile(id, preferredEmail)
    return located === null ? null : this.source(located)
  }

  public async mediaRequest(token: string): Promise<DriveMediaRequest | null> {
    const decrypted = this.security.decryptURLStrict(token)
    if (decrypted === null) return null
    const payload = new URLSearchParams(decrypted)
    if ([...payload.keys()].some((key) => key !== 'email' && key !== 'id')) return null
    const email = payload.get('email') ?? ''
    const id = parseGoogleDriveId(payload.get('id') ?? '')
    return id === null ? null : await this.api.mediaRequest(email, id)
  }

  private source(located: DriveLocatedFile): DrivePrivateSource {
    const title = located.file.originalFilename || located.file.title || located.file.description
    const payload = new URLSearchParams({ email: located.email, id: located.file.id }).toString()
    const file = new URL(`/gdrive-media/${this.security.encryptURL(payload)}`, this.baseUrl).toString()
    const image = `https://drive.google.com/thumbnail?id=${encodeURIComponent(located.file.id)}&authuser=0&sz=w9999`
    return Object.freeze({ file, type: 'video/mp4', label: 'Original', proxy: false, title, image })
  }
}
