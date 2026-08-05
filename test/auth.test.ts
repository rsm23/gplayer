import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AUTH_COOKIE_NAME, AuthService, authTokenFromRequest, publicUser, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { MySqlAuthStore } from '../src/auth/mysql-auth-store.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'

const legacyAdminHash = '$2y$10$NINj/fIn5uU/k7nZqcpubux7hMyA9FXxV7sfFmplu1oEgduKHp0Ty'
const fixedToken = 'fixed-session-token-1234567890'
const userAgent = 'GPlayer test browser'

const activeAdmin: StoredAuthUser = Object.freeze({
  id: 1,
  username: 'admin',
  email: 'admin@gplayer.local',
  passwordHash: legacyAdminHash,
  name: 'Admin',
  role: 0,
  status: 1,
  created: 0,
  updated: 0
})

class MemoryAuthStore implements AuthStore {
  public readonly sessions: SessionWrite[] = []
  public readonly failures: Array<Omit<SessionWrite, 'expires' | 'state'>> = []
  public readonly revoked: string[] = []

  public constructor(public users: StoredAuthUser[] = [activeAdmin]) {}

  public async findUserByIdentifier(identifier: string): Promise<StoredAuthUser | null> {
    return this.users.find((user) => user.username === identifier || user.email === identifier) ?? null
  }

  public async findActiveSession(token: string, requestedUserAgent: string, now: number): Promise<AuthUser | null> {
    const session = this.sessions.find((item) => item.token === token && item.userAgent === requestedUserAgent && item.expires > now && item.state === 0)
    const user = this.users.find((item) => item.username === session?.username && item.status === 1)
    return user === undefined ? null : publicUser(user)
  }

  public async createSession(session: SessionWrite): Promise<void> {
    this.sessions.push(session)
  }

  public async recordFailedLogin(session: Omit<SessionWrite, 'expires' | 'state'>): Promise<void> {
    this.failures.push(session)
  }

  public async revokeSession(token: string): Promise<boolean> {
    this.revoked.push(token)
    const session = this.sessions.find((item) => item.token === token)
    if (session === undefined) return false
    this.sessions.splice(this.sessions.indexOf(session), 1, { ...session, state: 9 })
    return true
  }
}

function auth(store: MemoryAuthStore, now = 1_000): AuthService {
  return new AuthService(store, { now: () => now, token: () => fixedToken })
}

describe('AuthService', () => {
  it('verifies legacy PHP bcrypt hashes and writes a seven-day compatible session', async () => {
    const store = new MemoryAuthStore()
    const result = await auth(store).login({
      identifier: 'admin',
      password: 'admin',
      remember: true,
      ip: '203.0.113.8',
      userAgent
    })

    expect(result).toEqual(expect.objectContaining({
      status: 'ok',
      token: fixedToken,
      expires: 605_800
    }))
    expect(store.sessions).toEqual([expect.objectContaining({
      username: 'admin',
      token: fixedToken,
      state: 0,
      userAgent
    })])
    expect(result.status === 'ok' && 'passwordHash' in result.user).toBe(false)
  })

  it('records generic failures without distinguishing an unknown user or bad password', async () => {
    const store = new MemoryAuthStore()
    const service = auth(store)
    await expect(service.login({ identifier: 'admin', password: 'bad', remember: false, ip: '127.0.0.1', userAgent })).resolves.toEqual({ status: 'invalid' })
    await expect(service.login({ identifier: 'missing', password: 'bad', remember: false, ip: '127.0.0.1', userAgent })).resolves.toEqual({ status: 'invalid' })
    expect(store.failures).toHaveLength(2)
  })

  it.each([[0, 'inactive'], [2, 'pending']] as const)('preserves legacy user status %i', async (status, expected) => {
    const store = new MemoryAuthStore([{ ...activeAdmin, status }])
    await expect(auth(store).login({ identifier: 'admin', password: 'admin', remember: false, ip: '127.0.0.1', userAgent })).resolves.toEqual({ status: expected })
    expect(store.sessions).toHaveLength(0)
  })

  it('binds active sessions to their exact user agent and revokes tokens', async () => {
    const store = new MemoryAuthStore()
    const service = auth(store)
    await service.login({ identifier: 'admin', password: 'admin', remember: false, ip: '127.0.0.1', userAgent })

    await expect(service.authenticate(fixedToken, userAgent)).resolves.toEqual(expect.objectContaining({ username: 'admin' }))
    await expect(service.authenticate(fixedToken, 'another browser')).resolves.toBeNull()
    await expect(service.logout(fixedToken)).resolves.toBe(true)
    await expect(service.authenticate(fixedToken, userAgent)).resolves.toBeNull()
  })

  it('verifies active credentials without creating a session or recording a login failure', async () => {
    const store = new MemoryAuthStore()
    const service = auth(store)

    await expect(service.verifyCredentials('admin', 'admin')).resolves.toEqual(expect.objectContaining({ username: 'admin', role: 0 }))
    await expect(service.verifyCredentials('admin', 'bad')).resolves.toBeNull()
    await expect(service.verifyCredentials('missing', 'bad')).resolves.toBeNull()
    expect(store.sessions).toEqual([])
    expect(store.failures).toEqual([])
  })

  it('accepts strict bearer or cookie tokens and rejects ambiguous authorization values', () => {
    expect(authTokenFromRequest({ authorization: `Bearer ${fixedToken}`, cookie: 'cookie-token' })).toBe(fixedToken)
    expect(authTokenFromRequest({ cookie: 'cookie-token' })).toBe('cookie-token')
    expect(authTokenFromRequest({ authorization: `Basic ${fixedToken}`, cookie: 'cookie-token' })).toBe('cookie-token')
    expect(authTokenFromRequest({ authorization: `Bearer ${fixedToken} injected` })).toBe('')
  })
})

describe('MySqlAuthStore', () => {
  it('uses parameterized legacy user/session tables', async () => {
    const database = {
      read: vi.fn()
        .mockResolvedValueOnce([{ id: 1, user: 'admin', email: 'admin@gplayer.local', password: legacyAdminHash, name: 'Admin', role: 0, status: 1, created: 0, updated: 0 }])
        .mockResolvedValueOnce([{ id: 1, user: 'admin', email: 'admin@gplayer.local', password: legacyAdminHash, name: 'Admin', role: 0, status: 1, created: 0, updated: 0 }]),
      write: vi.fn().mockResolvedValue({ affectedRows: 1 })
    }
    const store = new MySqlAuthStore(database)

    await expect(store.findUserByIdentifier('admin')).resolves.toEqual(expect.objectContaining({ username: 'admin', passwordHash: legacyAdminHash }))
    await expect(store.findActiveSession(fixedToken, userAgent, 1_000)).resolves.toEqual(expect.objectContaining({ username: 'admin' }))
    await store.createSession({ ip: '127.0.0.1', token: fixedToken, userAgent, created: 1_000, username: 'admin', expires: 2_000, state: 0 })
    await store.recordFailedLogin({ ip: '127.0.0.1', token: '', userAgent, created: 1_000, username: 'bad' })
    await expect(store.revokeSession(fixedToken)).resolves.toBe(true)

    for (const call of [...database.read.mock.calls, ...database.write.mock.calls]) expect(call[0]).not.toContain('admin@gplayer.local')
    expect(database.write).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO `tb_sessions`'), expect.arrayContaining([fixedToken]))
    expect(database.write).toHaveBeenCalledWith(expect.stringContaining('UPDATE `tb_sessions`'), [fixedToken])
  })
})

describe('administration routes', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  function createApp(store = new MemoryAuthStore()): Promise<FastifyInstance> {
    return buildApp(loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'https://player.example/',
      SECURE_SALT: '1234567890123456'
    }), { auth: auth(store) })
  }

  it('renders a noindex login page and strips credentials from query strings', async () => {
    app = await createApp()
    const page = await app.inject({ method: 'GET', url: '/administrator/login/' })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Welcome back.')
    expect(page.body).toContain('name="username"')
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.headers['content-security-policy']).toContain("default-src 'none'")
    expect(page.headers['x-robots-tag']).toBe('noindex, nofollow')

    const dirtyUrl = await app.inject({ method: 'GET', url: '/administrator/login/?username=admin&password=secret' })
    expect(dirtyUrl.statusCode).toBe(303)
    expect(dirtyUrl.headers.location).toBe('/administrator/login/')
    expect(dirtyUrl.body).not.toContain('secret')
  })

  it('logs in with a secure host-only cookie and serves the protected dashboard', async () => {
    const store = new MemoryAuthStore()
    app = await createApp(store)
    const login = await app.inject({
      method: 'POST',
      url: '/administrator/login/',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': userAgent },
      payload: 'username=admin&password=admin&remember=1'
    })

    expect(login.statusCode).toBe(303)
    expect(login.headers.location).toBe('/administrator/dashboard/')
    const cookie = String(login.headers['set-cookie'])
    expect(cookie).toContain(`${AUTH_COOKIE_NAME}=${fixedToken}`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Secure')
    expect(cookie).not.toContain('Domain=')

    const dashboard = await app.inject({
      method: 'GET',
      url: '/administrator/dashboard/',
      headers: { cookie: `${AUTH_COOKIE_NAME}=${fixedToken}`, 'user-agent': userAgent }
    })
    expect(dashboard.statusCode).toBe(200)
    expect(dashboard.body).toContain('Good to see you, Admin.')
    expect(dashboard.body).not.toContain(legacyAdminHash)

    const wrongBrowser = await app.inject({
      method: 'GET',
      url: '/administrator/dashboard/',
      headers: { cookie: `${AUTH_COOKIE_NAME}=${fixedToken}`, 'user-agent': 'wrong browser' }
    })
    expect(wrongBrowser.statusCode).toBe(302)
    expect(wrongBrowser.headers.location).toBe('/administrator/login/')
  })

  it('accepts bearer sessions and revokes them through logout', async () => {
    const store = new MemoryAuthStore()
    const service = auth(store)
    await service.login({ identifier: 'admin', password: 'admin', remember: false, ip: '127.0.0.1', userAgent })
    app = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: '1234567890123456' }), { auth: service })

    const dashboard = await app.inject({
      method: 'GET',
      url: '/administrator/dashboard/',
      headers: { authorization: `Bearer ${fixedToken}`, 'user-agent': userAgent }
    })
    expect(dashboard.statusCode).toBe(200)

    const logout = await app.inject({
      method: 'POST',
      url: '/administrator/logout/',
      headers: { authorization: `Bearer ${fixedToken}`, 'user-agent': userAgent }
    })
    expect(logout.statusCode).toBe(303)
    expect(logout.headers.location).toBe('/administrator/login/')
    expect(String(logout.headers['set-cookie'])).toContain(`${AUTH_COOKIE_NAME}=;`)
    expect(store.revoked).toEqual([fixedToken])
  })

  it('returns legacy-compatible account-state messages without exposing hashes', async () => {
    const store = new MemoryAuthStore([{ ...activeAdmin, status: 2 }])
    app = await createApp(store)
    const response = await app.inject({
      method: 'POST',
      url: '/administrator/login/',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': userAgent },
      payload: 'username=admin&password=admin'
    })
    expect(response.statusCode).toBe(401)
    expect(response.body).toContain('account is awaiting approval')
    expect(response.body).not.toContain(legacyAdminHash)
  })

  it('rejects cross-origin browser login and logout submissions', async () => {
    app = await createApp()
    const login = await app.inject({
      method: 'POST',
      url: '/administrator/login/',
      headers: { origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': userAgent },
      payload: 'username=admin&password=admin'
    })
    const logout = await app.inject({
      method: 'POST',
      url: '/administrator/logout/',
      headers: { origin: 'https://attacker.example', 'user-agent': userAgent }
    })
    expect(login.statusCode).toBe(403)
    expect(logout.statusCode).toBe(403)
    expect(login.body).toContain('did not originate from this application')
  })
})
