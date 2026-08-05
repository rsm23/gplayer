import { describe, expect, it } from 'vitest'
import {
  DriveSharerService,
  RecaptchaVerifier,
  parseGoogleDriveId,
  type DriveAccount,
  type DriveMirror,
  type DriveStore
} from '../src/drive/drive-sharer-service.js'
import { MySqlDriveStore } from '../src/drive/mysql-drive-store.js'
import type { ProviderHttpClient, ProviderHttpPostRequest, ProviderHttpRequest, ProviderHttpResponse } from '../src/hosting/provider-http.js'

const account: DriveAccount = Object.freeze({
  email: 'drive@example.test',
  apiKey: 'api-key',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  refreshToken: 'refresh-token'
})

class MemoryDriveStore implements DriveStore {
  public readonly saved: Array<readonly [string, string, string, number]> = []

  public constructor(
    public accounts: readonly DriveAccount[] = [account],
    public mirrors: readonly DriveMirror[] = []
  ) {}

  public async listActiveBypassAccounts(): Promise<readonly DriveAccount[]> {
    return this.accounts
  }

  public async listMirrors(): Promise<readonly DriveMirror[]> {
    return this.mirrors
  }

  public async saveMirror(sourceId: string, mirrorId: string, email: string, created: number): Promise<boolean> {
    this.saved.push([sourceId, mirrorId, email, created])
    return true
  }
}

class FixtureHttpClient implements ProviderHttpClient {
  public readonly requests: Array<Readonly<{ method: string; request: ProviderHttpPostRequest }>> = []

  public constructor(private readonly responses: ProviderHttpResponse[]) {}

  public async get(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    return await this.respond('GET', request)
  }

  public async head(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    return await this.respond('HEAD', request)
  }

  public async post(request: ProviderHttpPostRequest): Promise<ProviderHttpResponse> {
    return await this.respond('POST', request)
  }

  private async respond(method: string, request: ProviderHttpPostRequest): Promise<ProviderHttpResponse> {
    this.requests.push(Object.freeze({ method, request }))
    const response = this.responses.shift()
    if (response === undefined) throw new Error('Unexpected Drive request')
    return response
  }
}

describe('credentialed Google Drive sharer', () => {
  it('normalizes raw IDs and supported Google Drive document links', () => {
    expect(parseGoogleDriveId('sourceFileABC')).toBe('sourceFileABC')
    expect(parseGoogleDriveId('https://drive.google.com/file/d/sourceFileABC/view?usp=sharing')).toBe('sourceFileABC')
    expect(parseGoogleDriveId('https://drive.google.com/open?id=sourceFileABC')).toBe('sourceFileABC')
    expect(parseGoogleDriveId('https://drive.google.com/drive/folders/sourceFileABC')).toBe('sourceFileABC')
    expect(parseGoogleDriveId('https://docs.google.com/document/d/sourceFileABC/edit')).toBe('sourceFileABC')
    expect(parseGoogleDriveId('http://drive.google.com/file/d/sourceFileABC/view')).toBeNull()
    expect(parseGoogleDriveId('https://evil.example/file/d/sourceFileABC/view')).toBeNull()
    expect(parseGoogleDriveId('too-short')).toBeNull()
  })

  it('refreshes OAuth, copies the file, grants public read, records the mirror, and verifies it', async () => {
    const store = new MemoryDriveStore()
    const http = new FixtureHttpClient([
      json({ access_token: 'access-token-value', token_type: 'Bearer', expires_in: 3600 }),
      json({ id: 'sourceFileABC', title: 'Source movie.mp4', description: 'Original', originalFilename: 'Source movie.mp4' }),
      json({ id: 'copiedFileXYZ' }),
      json({ id: 'permission-id' }),
      json({ id: 'copiedFileXYZ', title: 'Source movie.mp4', originalFilename: 'Source movie.mp4' })
    ])
    const service = new DriveSharerService(store, http, { now: () => 1_700_000_000 })

    await expect(service.bypass('https://drive.google.com/file/d/sourceFileABC/view')).resolves.toEqual({
      id: 'copiedFileXYZ',
      link: 'https://drive.google.com/file/d/copiedFileXYZ/view'
    })
    expect(store.saved).toEqual([['sourceFileABC', 'copiedFileXYZ', 'drive@example.test', 1_700_000_000]])
    expect(http.requests.map(({ method }) => method)).toEqual(['POST', 'GET', 'POST', 'POST', 'GET'])
    expect(String(http.requests[0]?.request.url)).toBe('https://www.googleapis.com/oauth2/v4/token')
    expect(String(http.requests[0]?.request.body)).toContain('grant_type=refresh_token')
    expect(String(http.requests[1]?.request.url)).toBe('https://www.googleapis.com/drive/v2/files/sourceFileABC?acknowledgeAbuse=true&supportsAllDrives=true&key=api-key')
    expect(new Headers(http.requests[1]?.request.headers).get('authorization')).toBe('Bearer access-token-value')
    const copyBody = JSON.parse(String(http.requests[2]?.request.body))
    expect(copyBody).toEqual({
      copyable: true,
      parents: [{ id: 'root' }],
      title: 'Source movie.mp4',
      description: 'Copy created by the GPlayer Drive bypass tool.',
      originalFilename: 'Source movie.mp4'
    })
    expect(JSON.stringify(copyBody)).not.toMatch(/gdplayer\.(?:to|io)/i)
    expect(JSON.parse(String(http.requests[3]?.request.body))).toEqual({ role: 'reader', type: 'anyone' })
  })

  it('reuses a validated mirror without creating another copy', async () => {
    const store = new MemoryDriveStore([account], [{
      sourceId: 'sourceFileABC',
      mirrorId: 'copiedFileXYZ',
      mirrorEmail: account.email
    }])
    const http = new FixtureHttpClient([
      json({ access_token: 'access-token-value', token_type: 'Bearer' }),
      json({ id: 'copiedFileXYZ', title: 'Existing copy' })
    ])
    const service = new DriveSharerService(store, http)

    await expect(service.bypass('sourceFileABC')).resolves.toEqual({
      id: 'copiedFileXYZ',
      link: 'https://drive.google.com/file/d/copiedFileXYZ/view'
    })
    expect(store.saved).toEqual([])
    expect(http.requests).toHaveLength(2)
  })

  it('coalesces concurrent copies and caches the access token', async () => {
    const store = new MemoryDriveStore()
    const http = new FixtureHttpClient([
      json({ access_token: 'access-token-value', token_type: 'Bearer' }),
      json({ id: 'sourceFileABC', title: 'Movie' }),
      json({ id: 'copiedFileXYZ' }),
      json({ id: 'permission-id' }),
      json({ id: 'copiedFileXYZ', title: 'Movie' })
    ])
    const service = new DriveSharerService(store, http)
    const [first, second] = await Promise.all([service.bypass('sourceFileABC'), service.bypass('sourceFileABC')])
    expect(first).toEqual(second)
    expect(http.requests.filter(({ request }) => String(request.url).includes('/oauth2/'))).toHaveLength(1)
    expect(store.saved).toHaveLength(1)
  })

  it('fails closed for unavailable accounts, malformed API responses, and rejected reCAPTCHA checks', async () => {
    await expect(new DriveSharerService(new MemoryDriveStore([]), new FixtureHttpClient([])).bypass('sourceFileABC')).resolves.toBeNull()
    await expect(new DriveSharerService(new MemoryDriveStore(), new FixtureHttpClient([json({ error: 'invalid_grant' })])).bypass('sourceFileABC')).resolves.toBeNull()

    const noSecret = new RecaptchaVerifier(new FixtureHttpClient([]))
    await expect(noSecret.verify('', '', '127.0.0.1')).resolves.toBe(true)
    const verifier = new RecaptchaVerifier(new FixtureHttpClient([json({ success: false })]))
    await expect(verifier.verify('secret', 'captcha-token', '203.0.113.7')).resolves.toBe(false)
  })

  it('uses bounded parameterized SQL for Drive credentials and mirrors', async () => {
    const reads: Array<readonly [string, readonly unknown[]]> = []
    const writes: Array<readonly [string, readonly unknown[]]> = []
    const database = {
      read: async <T>(sql: string, values: readonly unknown[] = []): Promise<T> => {
        reads.push([sql, values])
        return (reads.length === 1
          ? [{ email: account.email, api_key: account.apiKey, client_id: account.clientId, client_secret: account.clientSecret, refresh_token: account.refreshToken }]
          : [{ gdrive_id: 'sourceFileABC', mirror_id: 'copiedFileXYZ', mirror_email: account.email }]) as T
      },
      write: async <T>(sql: string, values: readonly unknown[] = []): Promise<T> => {
        writes.push([sql, values])
        return { affectedRows: 1 } as T
      }
    }
    const store = new MySqlDriveStore(database as never)
    await expect(store.listActiveBypassAccounts()).resolves.toEqual([account])
    await expect(store.listMirrors('sourceFileABC', 999)).resolves.toEqual([{
      sourceId: 'sourceFileABC', mirrorId: 'copiedFileXYZ', mirrorEmail: account.email
    }])
    await expect(store.saveMirror('sourceFileABC', 'copiedFileXYZ', account.email, 123)).resolves.toBe(true)
    expect(reads[0]?.[0]).toContain('`status` = ? AND `bypass` = ?')
    expect(reads[0]?.[1]).toEqual([1, 1])
    expect(reads[1]?.[0]).toContain('LIMIT ?')
    expect(reads[1]?.[1]).toEqual(['sourceFileABC', 'sourceFileABC', 5])
    expect(writes[0]?.[0]).toContain('WHERE NOT EXISTS')
    expect(writes[0]?.[1]).toEqual(['sourceFileABC', 'copiedFileXYZ', account.email, 123, 'sourceFileABC', 'copiedFileXYZ'])
  })
})

function json(value: unknown, status = 200): ProviderHttpResponse {
  return Object.freeze({
    url: new URL('https://www.googleapis.com/fixture'),
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(value)
  })
}
