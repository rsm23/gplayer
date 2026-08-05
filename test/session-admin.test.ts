import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { MySqlSessionAdminStore } from '../src/auth/mysql-session-admin-store.js'
import { SessionAdminService, sessionId, sessionListQuery, type AdminSession, type SessionAdminStore, type SessionListQuery } from '../src/auth/session-admin-service.js'
import { loadConfig } from '../src/config.js'

const token = 'session-admin-token-1234567890'
const userAgent = 'GPlayer session test'
const admin: AuthUser = Object.freeze({
  id: 1,
  username: 'admin',
  email: 'admin@gplayer.local',
  name: 'Admin',
  role: 0,
  status: 1,
  created: 0,
  updated: 0
})
const row: AdminSession = Object.freeze({
  id: '12',
  username: 'admin',
  ip: '203.0.113.12',
  useragent: 'Firefox 142 on Linux',
  created: 1_700_000_000,
  expires: 1_700_086_400
})

class SessionStore implements SessionAdminStore {
  public readonly queries: SessionListQuery[] = []
  public readonly deleted: string[] = []

  public async listSessions(query: SessionListQuery) {
    this.queries.push(query)
    return { data: [row], recordsTotal: 1, recordsFiltered: 1 }
  }

  public async deleteSession(id: string): Promise<boolean> {
    this.deleted.push(id)
    return id === row.id
  }
}

class RouteAuthStore implements AuthStore {
  public constructor(private readonly user: AuthUser | null = admin) {}

  public async findUserByIdentifier(): Promise<StoredAuthUser | null> { return null }
  public async createSession(_session: SessionWrite): Promise<void> {}
  public async recordFailedLogin(_session: Omit<SessionWrite, 'expires' | 'state'>): Promise<void> {}
  public async revokeSession(): Promise<boolean> { return true }

  public async findActiveSession(requestedToken: string, requestedUserAgent: string): Promise<AuthUser | null> {
    return requestedToken === token && requestedUserAgent === userAgent ? this.user : null
  }
}

describe('session administration service', () => {
  it('normalizes nested and bracketed DataTables input to bounded whitelisted values', () => {
    expect(sessionListQuery({
      draw: '9',
      start: '-20',
      length: '5000',
      search: { value: '  Firefox  ' },
      order: [{ column: '3', dir: 'ASC' }]
    })).toEqual({ draw: 9, start: 0, length: 100, search: 'Firefox', orderBy: 'useragent', orderDir: 'asc' })

    expect(sessionListQuery({
      'search[value]': 'admin',
      'order[0][column]': '999',
      'order[0][dir]': 'DROP TABLE'
    })).toEqual(expect.objectContaining({ search: 'admin', orderBy: 'expires', orderDir: 'desc' }))
    expect(sessionId('18446744073709551615')).toBe('18446744073709551615')
    expect(sessionId('12 OR 1=1')).toBeNull()
  })

  it('uses parameterized search, limits and IDs with a whitelisted order clause', async () => {
    const database = {
      read: vi.fn()
        .mockResolvedValueOnce([{ ...row }])
        .mockResolvedValueOnce([{ total: '8' }])
        .mockResolvedValueOnce([{ total: '1' }]),
      write: vi.fn().mockResolvedValue({ affectedRows: 1 })
    }
    const store = new MySqlSessionAdminStore(database)
    const result = await store.listSessions({ draw: 4, start: 10, length: 25, search: "%' OR 1=1 --", orderBy: 'expires', orderDir: 'desc' })

    expect(result).toEqual({ data: [row], recordsTotal: 8, recordsFiltered: 1 })
    expect(database.read.mock.calls[0]?.[0]).toContain('ORDER BY `expires` DESC LIMIT ? OFFSET ?')
    expect(database.read.mock.calls[0]?.[1]).toEqual(["%%' OR 1=1 --%", "%%' OR 1=1 --%", "%%' OR 1=1 --%", 25, 10])
    expect(String(database.read.mock.calls[0]?.[0])).not.toContain("%' OR 1=1")
    await expect(store.deleteSession('12')).resolves.toBe(true)
    expect(database.write).toHaveBeenCalledWith('DELETE FROM `tb_sessions` WHERE `id` = ?', ['12'])
  })
})

describe('session administration routes', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function createApp(store: SessionStore, user: AuthUser | null = admin): Promise<FastifyInstance> {
    return await buildApp(loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'https://player.example/',
      SECURE_SALT: '1234567890123456'
    }), {
      auth: new AuthService(new RouteAuthStore(user)),
      sessions: new SessionAdminService(store)
    })
  }

  const headers = Object.freeze({ cookie: `${AUTH_COOKIE_NAME}=${token}`, 'user-agent': userAgent })

  it('renders the protected session ledger without exposing authentication tokens', async () => {
    const store = new SessionStore()
    app = await createApp(store)
    const response = await app.inject({ method: 'GET', url: '/administrator/users/sessions/', headers })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('Session list.')
    expect(response.body).toContain('Firefox 142 on Linux')
    expect(response.body).toContain('name="csrf"')
    expect(response.body).not.toContain(token)
    expect(store.queries[0]).toEqual(expect.objectContaining({ orderBy: 'expires', orderDir: 'desc', length: 100 }))
  })

  it('preserves the legacy sessions-list DataTables response and token parameter', async () => {
    const store = new SessionStore()
    app = await createApp(store)
    const response = await app.inject({
      method: 'GET',
      url: `/administrator/ajax/sessions-list/?token=${token}&draw=7&search%5Bvalue%5D=Firefox&order%5B0%5D%5Bcolumn%5D=2&order%5B0%5D%5Bdir%5D=asc`,
      headers: { 'user-agent': userAgent }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ draw: 7, data: [row], recordsTotal: 1, recordsFiltered: 1 })
    expect(store.queries[0]).toEqual(expect.objectContaining({ search: 'Firefox', orderBy: 'ip', orderDir: 'asc' }))
  })

  it('preserves legacy action deletion and generic unauthorized responses', async () => {
    const store = new SessionStore()
    app = await createApp(store)
    const deleted = await app.inject({
      method: 'POST',
      url: '/administrator/ajax/sessions/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=delete&id=12'
    })
    const unauthorized = await app.inject({
      method: 'GET',
      url: '/administrator/ajax/sessions-list/?draw=1',
      headers: { 'user-agent': userAgent }
    })
    const rejectedGet = await app.inject({
      method: 'GET',
      url: '/administrator/ajax/sessions/?action=delete&id=12',
      headers
    })

    expect(deleted.json()).toEqual({ status: 'ok', message: 'The session has been successfully deleted', result: null })
    expect(rejectedGet.statusCode).toBe(405)
    expect(store.deleted).toEqual(['12'])
    expect(unauthorized.json()).toEqual({ draw: 1, data: [], recordsTotal: 0, recordsFiltered: 0 })
  })

  it('requires both same-origin delivery and a signed form token for browser revocation', async () => {
    const store = new SessionStore()
    app = await createApp(store)
    const page = await app.inject({ method: 'GET', url: '/administrator/users/sessions/', headers })
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1]
    expect(csrf).toBeTruthy()

    const rejected = await app.inject({
      method: 'POST',
      url: '/administrator/users/sessions/delete/',
      headers: { ...headers, origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `id=12&csrf=${csrf}`
    })
    const accepted = await app.inject({
      method: 'POST',
      url: '/administrator/users/sessions/delete/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `id=12&csrf=${csrf}`
    })

    expect(rejected.statusCode).toBe(403)
    expect(accepted.statusCode).toBe(303)
    expect(accepted.headers.location).toBe('/administrator/users/sessions/?deleted=1')
    expect(store.deleted).toEqual(['12'])
  })

  it('denies non-admin users from both the HTML and compatibility surfaces', async () => {
    const store = new SessionStore()
    app = await createApp(store, { ...admin, role: 1 })
    const page = await app.inject({ method: 'GET', url: '/administrator/users/sessions/', headers })
    const ajax = await app.inject({ method: 'GET', url: '/administrator/ajax/sessions-list/', headers })

    expect(page.statusCode).toBe(302)
    expect(page.headers.location).toBe('/administrator/403/')
    expect(ajax.json()).toEqual({ draw: 0, data: [], recordsTotal: 0, recordsFiltered: 0 })
  })
})
