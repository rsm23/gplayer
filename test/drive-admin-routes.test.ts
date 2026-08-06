import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { loadConfig } from '../src/config.js'
import type { DriveAdminService, DriveFileAdminRecord } from '../src/drive/drive-admin-service.js'

const token = 'drive-operations-admin-token'
const userAgent = 'GPlayer Drive operations test'
const admin: AuthUser = Object.freeze({
  id: 1,
  username: 'admin',
  email: 'admin@gplayer.local',
  name: 'Admin',
  role: 0,
  status: 1,
  created: 1_600_000_000,
  updated: 1_600_000_000
})

class RouteAuthStore implements AuthStore {
  public constructor(private readonly user: AuthUser | null = admin) {}
  public async findUserByIdentifier(): Promise<StoredAuthUser | null> { return null }
  public async createSession(_session: SessionWrite): Promise<void> {}
  public async recordFailedLogin(_session: Omit<SessionWrite, 'expires' | 'state'>): Promise<void> {}
  public async findActiveSession(requestedToken: string, requestedUserAgent: string): Promise<AuthUser | null> {
    return requestedToken === token && requestedUserAgent === userAgent ? this.user : null
  }
  public async revokeSession(): Promise<boolean> { return true }
}

class FixtureDriveAdmin {
  public readonly fileInputs: Record<string, unknown>[] = []
  public readonly createFolder = vi.fn(async () => ({ status: 'ok' as const, message: 'The new file/folder has been created successfully' }))
  public readonly deleteFile = vi.fn(async () => ({ status: 'ok' as const, message: 'The file/folder has been successfully deleted' }))
  public readonly deleteMirrorRecord = vi.fn(async () => ({ status: 'ok' as const, message: 'The mirror file has been successfully deleted' }))
  public readonly importFile = vi.fn(async () => ({ status: 'ok' as const, message: 'The file has been successfully imported', result: { title: 'Movie.mp4', slug: 'movie', id: '9' } }))
  public readonly removeDuplicates = vi.fn(async () => ({ status: 'ok' as const, message: 'Duplicate files have been successfully removed', result: { nextPageToken: '' } }))
  public readonly rename = vi.fn(async () => ({ status: 'ok' as const, message: 'The file/folder has been successfully updated' }))
  public readonly setPublic = vi.fn(async () => ({ status: 'ok' as const, message: 'The file/folder has been successfully updated' }))
  public readonly deleteBackup = vi.fn(async () => ({ status: 'ok' as const, message: 'The backup file has been successfully deleted' }))
  public readonly deleteQueue = vi.fn(async () => ({ status: 'ok' as const, message: 'The backup queue has been successfully deleted' }))
  public readonly copyQueueFile = vi.fn(async () => ({ status: 'ok' as const, message: '', result: { link: 'https://drive.google.com/file/d/copiedFileXYZ/view', id: 'copiedFileXYZ' } }))

  public async accountEmails() { return ['drive@example.test'] }
  public async files(input: Record<string, unknown>) {
    this.fileInputs.push(input)
    return { draw: Number(input.draw ?? 0), data: [file], recordsTotal: 1, recordsFiltered: 1, token: 'next-page' }
  }
  public async backups(input: Record<string, unknown>) {
    return { draw: Number(input.draw ?? 0), data: [{ id: '3', gdrive_id: 'sourceFileABC', mirror_id: 'copiedFileXYZ', mirror_email: 'drive@example.test', created: 1_700_000_000 }], recordsTotal: 1, recordsFiltered: 1 }
  }
  public async queue(input: Record<string, unknown>) {
    return { draw: Number(input.draw ?? 0), data: [{ id: '4', gdrive_id: 'sourceFileABC' }], recordsTotal: 1, recordsFiltered: 1 }
  }
  public async sharedDrives() {
    return { status: 'ok' as const, message: '', result: [{ id: 'sharedDriveABC', name: 'Editorial' }] }
  }
  public async sharedDriveRecords() { return [{ id: 'sharedDriveABC', name: 'Editorial' }] }
}

const file: DriveFileAdminRecord = Object.freeze({
  id: 'sourceFileABC',
  title: 'Movie.mp4',
  description: 'Editorial master',
  originalFilename: 'Movie.mp4',
  mimeType: 'video/mp4',
  iconLink: 'https://ssl.gstatic.com/docs/doclist/images/mediatype/icon_1_video_x16.png',
  shared: true,
  modifiedDate: '2023-11-14T22:13:20.000Z',
  webContentLink: 'https://drive.google.com/uc?id=sourceFileABC',
  embedLink: 'https://drive.google.com/file/d/sourceFileABC/preview',
  alternateLink: 'https://drive.google.com/file/d/sourceFileABC/view',
  fileExtension: 'mp4',
  fileSize: '1024',
  md5Checksum: 'a'.repeat(32),
  sha1Checksum: 'b'.repeat(40),
  sha256Checksum: 'c'.repeat(64),
  email: 'drive@example.test',
  modifiedTimestamp: 1_700_000_000,
  actions: Object.freeze({
    id: 'sourceFileABC',
    shared: true,
    download: 'https://drive.google.com/uc?id=sourceFileABC',
    preview: 'https://drive.google.com/file/d/sourceFileABC/preview',
    view: 'https://drive.google.com/file/d/sourceFileABC/view',
    request_url: 'https://player.example/r/?encrypted',
    download_url: 'https://player.example/d/?encrypted',
    embed_url: 'https://player.example/e/?encrypted',
    embed_code: '<iframe></iframe>'
  }),
  mime: Object.freeze({ type: 'video/mp4', icon: 'https://ssl.gstatic.com/docs/doclist/images/mediatype/icon_1_video_x16.png' })
})

describe('Google Drive file, backup, and queue administration routes', () => {
  let app: FastifyInstance | undefined
  const headers = Object.freeze({ cookie: `${AUTH_COOKIE_NAME}=${token}`, 'user-agent': userAgent })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function createApp(drive: FixtureDriveAdmin, routeAuth = new RouteAuthStore()): Promise<FastifyInstance> {
    return await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: '1234567890123456' }), {
      auth: new AuthService(routeAuth),
      driveAdmin: drive as unknown as DriveAdminService
    })
  }

  it('renders the authenticated file, backup, and queue pages without credentials or auth tokens', async () => {
    const drive = new FixtureDriveAdmin()
    app = await createApp(drive)
    const legacyList = await app.inject({ method: 'GET', url: '/administrator/gdrive/list/?q=drive', headers })
    expect(legacyList.statusCode).toBe(308)
    expect(legacyList.headers.location).toBe('/administrator/gdrive/?q=drive')
    const [files, backups, queue] = await Promise.all([
      app.inject({ method: 'GET', url: '/administrator/gdrive/files/?email=drive%40example.test&token=remote-page-2', headers }),
      app.inject({ method: 'GET', url: '/administrator/gdrive/backup-files/', headers }),
      app.inject({ method: 'GET', url: '/administrator/gdrive/backup-queue/', headers })
    ])

    expect(files.statusCode).toBe(200)
    expect(files.body).toContain('Drive files.')
    expect(files.body).toContain('Movie.mp4')
    expect(files.body).toContain('Editorial')
    expect(files.body).toContain('Next page')
    expect(files.body).toContain('name="csrf"')
    expect(drive.fileInputs[0]).toEqual(expect.objectContaining({ token: 'remote-page-2' }))
    expect(backups.body).toContain('Backup files.')
    expect(backups.body).toContain('copiedFileXYZ')
    expect(queue.body).toContain('Backup queue.')
    expect(queue.body).toContain('Copy now')
    for (const response of [files, backups, queue]) {
      expect(response.body).not.toContain(token)
      expect(response.body).not.toContain('private-api-key')
      expect(response.headers['content-security-policy']).toContain("form-action 'self'")
    }
  })

  it('executes signed same-origin browser actions and rejects a foreign origin', async () => {
    const drive = new FixtureDriveAdmin()
    app = await createApp(drive)
    const filePage = await app.inject({ method: 'GET', url: '/administrator/gdrive/files/?email=drive%40example.test', headers })
    const csrf = csrfFrom(filePage.body)
    const updated = await app.inject({
      method: 'POST',
      url: '/administrator/gdrive/files/action/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${encodeURIComponent(csrf)}&action=updateStatus&email=drive%40example.test&id=sourceFileABC&public=0`
    })
    expect(updated.statusCode).toBe(303)
    expect(updated.headers.location).toContain('notice=updateStatus&success=1')
    expect(drive.setPublic).toHaveBeenCalledWith(expect.objectContaining({ id: 'sourceFileABC', public: '0' }))

    const renamed = await app.inject({
      method: 'POST',
      url: '/administrator/gdrive/files/action/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${encodeURIComponent(csrf)}&action=renameFileFolder&email=drive%40example.test&folder_id=campaignFolderABC&id=sourceFileABC&name=Renamed.mp4`
    })
    expect(renamed.statusCode).toBe(303)
    expect(renamed.headers.location).toContain('folder_id=campaignFolderABC')
    expect(drive.rename).toHaveBeenCalledWith(expect.objectContaining({ id: 'sourceFileABC', name: 'Renamed.mp4' }))

    const rejected = await app.inject({
      method: 'POST',
      url: '/administrator/gdrive/files/action/',
      headers: { ...headers, origin: 'https://foreign.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${encodeURIComponent(csrf)}&action=delete&email=drive%40example.test&id=sourceFileABC`
    })
    expect(rejected.statusCode).toBe(403)
    expect(drive.deleteFile).not.toHaveBeenCalled()
  })

  it('preserves legacy file, mirror, and queue AJAX shapes with method and origin enforcement', async () => {
    const drive = new FixtureDriveAdmin()
    app = await createApp(drive)
    const list = await app.inject({ method: 'GET', url: '/administrator/ajax/gdrive-files-list?draw=7&email=drive%40example.test', headers })
    expect(list.json()).toEqual({ draw: 7, data: [file], recordsTotal: 1, recordsFiltered: 1, token: 'next-page' })

    const shared = await app.inject({ method: 'GET', url: '/administrator/ajax/gdrive-files?action=getSharedDrives&email=drive%40example.test', headers })
    expect(shared.json()).toEqual({ status: 'ok', message: '', result: [{ id: 'sharedDriveABC', name: 'Editorial' }] })

    const rejectedGet = await app.inject({ method: 'GET', url: '/administrator/ajax/gdrive-backup-queue?action=delete&id=4', headers })
    expect(rejectedGet.statusCode).toBe(405)
    const rejectedOrigin = await app.inject({
      method: 'POST',
      url: '/administrator/ajax/gdrive-backup-files',
      headers: { ...headers, origin: 'https://foreign.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=delete&id=3'
    })
    expect(rejectedOrigin.statusCode).toBe(403)

    const copied = await app.inject({
      method: 'POST',
      url: '/administrator/ajax/gdrive-backup-queue',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=copy&id=sourceFileABC'
    })
    expect(copied.json()).toEqual({ status: 'ok', message: '', result: { link: 'https://drive.google.com/file/d/copiedFileXYZ/view', id: 'copiedFileXYZ' } })
  })

  it('returns an empty legacy page to non-admin users', async () => {
    const drive = new FixtureDriveAdmin()
    app = await createApp(drive, new RouteAuthStore({ ...admin, role: 1 }))
    const response = await app.inject({ method: 'GET', url: '/administrator/ajax/gdrive-backup-files-list?draw=9', headers })
    expect(response.json()).toEqual({ draw: 9, data: [], recordsTotal: 0, recordsFiltered: 0 })
  })
})

function csrfFrom(html: string): string {
  const value = html.match(/name="csrf" value="([^"]+)"/)?.[1]
  if (value === undefined) throw new Error('Missing CSRF token')
  return value
}
