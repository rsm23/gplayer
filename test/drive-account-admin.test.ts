import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { loadConfig } from '../src/config.js'
import {
  DriveAccountAdminService,
  driveAccountId,
  driveAccountListQuery,
  type DriveAccountAdminRecord,
  type DriveAccountAdminStore,
  type DriveAccountListQuery,
  type DriveAccountWrite,
  type StoredDriveAccountAdminRecord
} from '../src/drive/drive-account-admin-service.js'
import { MySqlDriveAccountAdminStore } from '../src/drive/mysql-drive-account-admin-store.js'

const storedAccount: StoredDriveAccountAdminRecord = Object.freeze({
  id: '1',
  email: 'drive@example.test',
  bypass: 1,
  status: 1,
  created: 1_600_000_000,
  updated: 1_600_000_100,
  apiKeyConfigured: true,
  clientIdConfigured: true,
  clientSecretConfigured: true,
  refreshTokenConfigured: true,
  apiKey: 'private-api-key',
  clientId: 'private-client-id',
  clientSecret: 'private-client-secret',
  refreshToken: 'private-refresh-token'
})

const token = 'drive-admin-token-1234567890'
const userAgent = 'GPlayer Drive admin test'
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

class MemoryDriveAccountStore implements DriveAccountAdminStore {
  public readonly accounts: StoredDriveAccountAdminRecord[] = [{ ...storedAccount }]
  public readonly queries: DriveAccountListQuery[] = []
  public readonly writes: Array<DriveAccountWrite & { id: string }> = []
  public readonly deleted: string[] = []

  public async listAccounts(query: DriveAccountListQuery) {
    this.queries.push(query)
    const matches = this.accounts.filter((account) => query.search === '' || account.email.toLowerCase().startsWith(query.search.toLowerCase()))
    return {
      data: matches.slice(query.start, query.start + query.length).map(publicAccount),
      recordsTotal: this.accounts.length,
      recordsFiltered: matches.length
    }
  }

  public async getAccount(id: string): Promise<StoredDriveAccountAdminRecord | null> {
    return this.accounts.find((account) => account.id === id) ?? null
  }

  public async emailExists(email: string, excludeId?: string): Promise<boolean> {
    return this.accounts.some((account) => account.id !== excludeId && account.email.toLowerCase() === email.toLowerCase())
  }

  public async createAccount(account: DriveAccountWrite): Promise<string> {
    const id = String(this.accounts.length + 1)
    this.writes.push({ ...account, id })
    this.accounts.push(storedFromWrite(id, account))
    return id
  }

  public async updateAccount(id: string, account: DriveAccountWrite): Promise<boolean> {
    const index = this.accounts.findIndex((item) => item.id === id)
    if (index < 0) return false
    this.writes.push({ ...account, id })
    this.accounts[index] = storedFromWrite(id, account)
    return true
  }

  public async deleteAccount(id: string): Promise<boolean> {
    this.deleted.push(id)
    const index = this.accounts.findIndex((item) => item.id === id)
    if (index < 0) return false
    this.accounts.splice(index, 1)
    return true
  }

  public async updateFlag(id: string, column: 'status' | 'bypass', value: number, updated: number): Promise<boolean> {
    const index = this.accounts.findIndex((item) => item.id === id)
    const account = this.accounts[index]
    if (index < 0 || account === undefined) return false
    this.accounts[index] = { ...account, [column]: value, updated }
    return true
  }
}

function service(store: MemoryDriveAccountStore): DriveAccountAdminService {
  return new DriveAccountAdminService(store, { now: () => 1_700_000_000 })
}

describe('Google Drive account administration service', () => {
  it('normalizes the legacy six-column DataTables contract without returning credentials', async () => {
    const store = new MemoryDriveAccountStore()
    const accounts = service(store)
    const result = await accounts.list({
      draw: '7',
      'search[value]': 'drive',
      'order[0][column]': '2',
      'order[0][dir]': 'asc'
    })

    expect(result).toEqual({
      draw: 7,
      data: [{ id: '1', email: 'drive@example.test', bypass: 1, status: 1, created: 1_600_000_000, updated: 1_600_000_100 }],
      recordsTotal: 1,
      recordsFiltered: 1
    })
    expect(JSON.stringify(result)).not.toContain('private-')
    expect(store.queries[0]).toEqual(expect.objectContaining({ search: 'drive', orderBy: 'bypass', orderDir: 'asc' }))
    expect(driveAccountListQuery({ length: 999, start: -4 })).toEqual(expect.objectContaining({ length: 100, start: 0, orderBy: 'updated' }))
    expect(driveAccountId('4294967295')).toBe('4294967295')
    expect(driveAccountId('4294967296')).toBeNull()
  })

  it('exposes only configured flags and keeps existing secrets when edit fields are blank', async () => {
    const store = new MemoryDriveAccountStore()
    const accounts = service(store)
    const publicValue = await accounts.get('1')
    expect(publicValue).toEqual(expect.objectContaining({ email: storedAccount.email, clientSecretConfigured: true, refreshTokenConfigured: true }))
    expect(JSON.stringify(publicValue)).not.toContain('private-')

    await expect(accounts.update('1', {
      email: 'renamed@example.test', api_key: '', client_id: '', client_secret: '', refresh_token: '', bypass: '0', status: '1'
    })).resolves.toEqual({
      status: 'ok', id: '1', message: 'The google drive account has been successfully updated'
    })
    expect(store.writes[0]).toEqual(expect.objectContaining({
      apiKey: storedAccount.apiKey,
      clientId: storedAccount.clientId,
      clientSecret: storedAccount.clientSecret,
      refreshToken: storedAccount.refreshToken,
      bypass: 0,
      updated: 1_700_000_000
    }))
  })

  it('validates creates, preserves legacy messages, and updates both flags', async () => {
    const store = new MemoryDriveAccountStore()
    const accounts = service(store)
    await expect(accounts.create({ email: 'broken', api_key: 'key', client_id: 'id', client_secret: 'secret', refresh_token: 'refresh' })).resolves.toEqual({ status: 'invalid', message: 'The email is invalid' })
    await expect(accounts.create({
      email: 'second@example.test', api_key: 'api', client_id: 'client', client_secret: 'secret', refresh_token: 'refresh', bypass: ['0', '1'], status: ['0', '1']
    })).resolves.toEqual({ status: 'ok', id: '2', message: 'The google drive account has been successfully saved' })
    expect(store.writes[0]).toEqual(expect.objectContaining({ bypass: 1, status: 1, created: 1_700_000_000 }))

    await expect(accounts.setFlag('2', 'bypass', '0')).resolves.toEqual({ status: 'ok', id: '2', message: 'The account status has been successfully updated' })
    await expect(accounts.setFlag('2', 'status', '1')).resolves.toEqual({ status: 'ok', id: '2', message: 'The account status has been successfully updated' })
    await expect(accounts.delete('2')).resolves.toEqual({ status: 'ok', id: '2', message: 'The account has been deleted successfully' })
  })
})

describe('MySqlDriveAccountAdminStore', () => {
  it('uses bounded parameterized list, secret lookup, and account writes', async () => {
    const read = vi.fn(async (sql: string, _values: readonly unknown[] = []) => {
      if (sql.includes('COUNT(*)') && sql.includes('WHERE')) return [{ total: '1' }]
      if (sql.includes('COUNT(*)')) return [{ total: '2' }]
      if (sql.includes('WHERE `id`')) return [databaseRow()]
      return [databaseRow()]
    })
    const write = vi.fn()
      .mockResolvedValueOnce({ insertId: 4 })
      .mockResolvedValue({ affectedRows: 1 })
    const database = { read, write, transaction: vi.fn() }
    const store = new MySqlDriveAccountAdminStore(database as never)

    await expect(store.listAccounts({ draw: 1, start: 5, length: 25, search: "x' OR 1=1", orderBy: 'updated', orderDir: 'desc' })).resolves.toEqual({
      data: [publicAccount(storedAccount)], recordsTotal: 2, recordsFiltered: 1
    })
    const listCall = read.mock.calls.find(([sql]) => sql.includes('LIMIT ? OFFSET ?'))
    expect(listCall?.[0]).toContain('ORDER BY `updated` DESC')
    expect(listCall?.[1]).toEqual(["x' OR 1=1%", 25, 5])
    expect(listCall?.[0]).not.toContain("x' OR 1=1")

    await expect(store.getAccount('1')).resolves.toEqual(storedAccount)
    await expect(store.createAccount(writeFromStored(storedAccount))).resolves.toBe('4')
    await expect(store.updateAccount('1', writeFromStored(storedAccount))).resolves.toBe(true)
    await expect(store.updateFlag('1', 'bypass', 0, 123)).resolves.toBe(true)
    expect(write.mock.calls.at(-1)?.[0]).toContain('SET `bypass` = ?')
    expect(write.mock.calls.at(-1)?.[1]).toEqual([0, 123, '1'])
  })

  it('deletes mirrors and the account atomically without interpolating the email', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([databaseRow()])
      .mockResolvedValueOnce({ affectedRows: 2 })
      .mockResolvedValueOnce({ affectedRows: 1 })
    const database = {
      read: vi.fn(),
      write: vi.fn(),
      transaction: async <T>(work: (transaction: { execute: typeof execute }) => Promise<T>): Promise<T> => await work({ execute })
    }
    const store = new MySqlDriveAccountAdminStore(database as never)
    await expect(store.deleteAccount('1')).resolves.toBe(true)
    expect(execute.mock.calls[1]).toEqual(['DELETE FROM `tb_gdrive_mirrors` WHERE `mirror_email` = ?', ['drive@example.test']])
    expect(execute.mock.calls[2]).toEqual(['DELETE FROM `tb_gdrive_auth` WHERE `id` = ?', ['1']])
  })
})

describe('Google Drive account administration routes', () => {
  let app: FastifyInstance | undefined
  const headers = Object.freeze({ cookie: `${AUTH_COOKIE_NAME}=${token}`, 'user-agent': userAgent })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function createApp(store: MemoryDriveAccountStore, routeAuth = new RouteAuthStore()): Promise<FastifyInstance> {
    return await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: '1234567890123456' }), {
      auth: new AuthService(routeAuth),
      driveAccounts: service(store)
    })
  }

  it('renders list/new/edit pages without returning any stored credential or auth token', async () => {
    const store = new MemoryDriveAccountStore()
    app = await createApp(store)
    const [list, add, edit] = await Promise.all([
      app.inject({ method: 'GET', url: '/administrator/gdrive/', headers }),
      app.inject({ method: 'GET', url: '/administrator/gdrive/new/', headers }),
      app.inject({ method: 'GET', url: '/administrator/gdrive/edit/?id=1', headers })
    ])
    expect(list.statusCode).toBe(200)
    expect(list.body).toContain('Drive accounts.')
    expect(list.body).toContain(storedAccount.email)
    expect(add.body).toContain('New Drive account.')
    expect(edit.body).toContain('Edit Drive account.')
    expect(edit.body).toContain('Leave blank to keep the stored value.')
    expect(edit.body.match(/>Stored</g)).toHaveLength(4)
    for (const response of [list, add, edit]) {
      expect(response.body).not.toContain(token)
      expect(response.body).not.toContain('private-api-key')
      expect(response.body).not.toContain('private-client-id')
      expect(response.body).not.toContain('private-client-secret')
      expect(response.body).not.toContain('private-refresh-token')
    }
  })

  it('creates, edits, toggles, and deletes through signed same-origin forms', async () => {
    const store = new MemoryDriveAccountStore()
    app = await createApp(store)
    const newPage = await app.inject({ method: 'GET', url: '/administrator/gdrive/new/', headers })
    const writeCsrf = csrfFrom(newPage.body)
    const created = await app.inject({
      method: 'POST',
      url: '/administrator/gdrive/new/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${writeCsrf}&email=second%40example.test&api_key=api-two&client_id=client-two&client_secret=secret-two&refresh_token=refresh-two&bypass=1&status=1`
    })
    expect(created.statusCode).toBe(303)
    expect(created.headers.location).toBe('/administrator/gdrive/edit/?id=2&created=1')

    const editPage = await app.inject({ method: 'GET', url: '/administrator/gdrive/edit/?id=2', headers })
    const edited = await app.inject({
      method: 'POST',
      url: '/administrator/gdrive/edit/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${csrfFrom(editPage.body)}&id=2&email=renamed%40example.test&api_key=&client_id=&client_secret=&refresh_token=&bypass=0&status=1`
    })
    expect(edited.statusCode).toBe(303)
    expect(store.accounts[1]).toEqual(expect.objectContaining({ email: 'renamed@example.test', apiKey: 'api-two', clientSecret: 'secret-two', bypass: 0 }))

    const list = await app.inject({ method: 'GET', url: '/administrator/gdrive/', headers })
    const mutationCsrf = csrfFrom(list.body)
    const toggled = await app.inject({
      method: 'POST',
      url: '/administrator/gdrive/flag/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${mutationCsrf}&id=2&column=bypass&status=1`
    })
    expect(toggled.statusCode).toBe(303)
    expect(store.accounts[1]?.bypass).toBe(1)

    const deleted = await app.inject({
      method: 'POST',
      url: '/administrator/gdrive/delete/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${mutationCsrf}&id=2`
    })
    expect(deleted.statusCode).toBe(303)
    expect(store.accounts).toHaveLength(1)
  })

  it('preserves the legacy list and mutation AJAX contract with admin and same-origin enforcement', async () => {
    const store = new MemoryDriveAccountStore()
    app = await createApp(store)
    const list = await app.inject({ method: 'GET', url: '/administrator/ajax/gdrive-account/?action=list&draw=3', headers })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual({
      draw: 3,
      data: [{ id: '1', email: storedAccount.email, bypass: 1, status: 1, created: storedAccount.created, updated: storedAccount.updated }],
      recordsTotal: 1,
      recordsFiltered: 1
    })
    expect(list.body).not.toContain('private-')

    const rejectedGet = await app.inject({ method: 'GET', url: '/administrator/ajax/gdrive-account/?action=delete&id=1', headers })
    expect(rejectedGet.statusCode).toBe(405)
    const rejectedOrigin = await app.inject({
      method: 'POST',
      url: '/administrator/ajax/gdrive-accounts/',
      headers: { ...headers, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=updateStatus&id=1&status=0'
    })
    expect(rejectedOrigin.statusCode).toBe(403)
    expect(store.accounts[0]?.status).toBe(1)

    const updated = await app.inject({
      method: 'POST',
      url: '/administrator/ajax/gdrive-account/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=updateBypass&id=1&status=0'
    })
    expect(updated.json()).toEqual({ status: 'ok', message: 'The account status has been successfully updated', result: null })
    expect(store.accounts[0]?.bypass).toBe(0)
  })

  it('returns an empty DataTables page to non-admin users', async () => {
    const store = new MemoryDriveAccountStore()
    app = await createApp(store, new RouteAuthStore({ ...admin, role: 1 }))
    const response = await app.inject({ method: 'GET', url: '/administrator/ajax/gdrive-accounts-list/?draw=9', headers })
    expect(response.json()).toEqual({ draw: 9, data: [], recordsTotal: 0, recordsFiltered: 0 })
  })
})

function publicAccount(account: StoredDriveAccountAdminRecord): DriveAccountAdminRecord {
  const { apiKey: _apiKey, clientId: _clientId, clientSecret: _clientSecret, refreshToken: _refreshToken, ...safe } = account
  return safe
}

function storedFromWrite(id: string, account: DriveAccountWrite): StoredDriveAccountAdminRecord {
  return Object.freeze({
    id,
    email: account.email,
    bypass: account.bypass,
    status: account.status,
    created: account.created,
    updated: account.updated,
    apiKeyConfigured: account.apiKey !== '',
    clientIdConfigured: account.clientId !== '',
    clientSecretConfigured: account.clientSecret !== '',
    refreshTokenConfigured: account.refreshToken !== '',
    apiKey: account.apiKey,
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    refreshToken: account.refreshToken
  })
}

function databaseRow(): Record<string, string | number> {
  return {
    id: 1,
    email: storedAccount.email,
    bypass: 1,
    status: 1,
    created: storedAccount.created,
    updated: storedAccount.updated,
    api_key_configured: 1,
    client_id_configured: 1,
    client_secret_configured: 1,
    refresh_token_configured: 1,
    api_key: storedAccount.apiKey,
    client_id: storedAccount.clientId,
    client_secret: storedAccount.clientSecret,
    refresh_token: storedAccount.refreshToken
  }
}

function writeFromStored(account: StoredDriveAccountAdminRecord): DriveAccountWrite {
  return {
    email: account.email,
    apiKey: account.apiKey,
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    refreshToken: account.refreshToken,
    bypass: account.bypass,
    status: account.status,
    created: account.created,
    updated: account.updated
  }
}

function csrfFrom(html: string): string {
  const value = html.match(/name="csrf" value="([^"]+)"/)?.[1]
  if (value === undefined) throw new Error('Missing CSRF token')
  return value
}
