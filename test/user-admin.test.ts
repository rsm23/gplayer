import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { MySqlUserAdminStore } from '../src/auth/mysql-user-admin-store.js'
import { UserAdminService, userId, userListQuery, type AdminUserRecord, type UserAdminStore, type UserConflict, type UserListQuery, type UserWrite } from '../src/auth/user-admin-service.js'
import { loadConfig } from '../src/config.js'

const token = 'user-admin-token-1234567890'
const userAgent = 'GPlayer user test'
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

const adminRecord: AdminUserRecord = Object.freeze({
  id: '1',
  username: 'admin',
  email: 'admin@gplayer.local',
  name: 'Admin',
  role: 0,
  status: 1,
  created: 1_600_000_000,
  updated: 1_600_000_000,
  videos: 8
})

class MemoryUserStore implements UserAdminStore {
  public readonly users: AdminUserRecord[] = [{ ...adminRecord }]
  public readonly queries: UserListQuery[] = []
  public readonly writes: Array<UserWrite & { id: string }> = []
  public readonly deleted: string[] = []

  public async listUsers(query: UserListQuery) {
    this.queries.push(query)
    const search = query.search.toLowerCase()
    const matches = this.users.filter((user) => search === '' || [user.name, user.username, user.email].some((value) => value.toLowerCase().startsWith(search)))
    return { data: matches.slice(query.start, query.start + query.length), recordsTotal: this.users.length, recordsFiltered: matches.length }
  }

  public async getUser(id: string): Promise<AdminUserRecord | null> {
    return this.users.find((user) => user.id === id) ?? null
  }

  public async findConflict(username: string, email: string, excludeId?: string): Promise<UserConflict> {
    const candidates = this.users.filter((user) => user.id !== excludeId)
    return {
      username: candidates.some((user) => user.username.toLowerCase() === username.toLowerCase()),
      email: candidates.some((user) => user.email.toLowerCase() === email.toLowerCase())
    }
  }

  public async createUser(user: UserWrite & Readonly<{ passwordHash: string }>): Promise<string> {
    const id = String(this.users.length + 1)
    this.writes.push({ ...user, id })
    this.users.push({ id, name: user.name, username: user.username, email: user.email, status: user.status, role: user.role, created: user.created, updated: user.updated, videos: 0 })
    return id
  }

  public async updateUser(id: string, user: UserWrite): Promise<boolean> {
    const index = this.users.findIndex((item) => item.id === id)
    if (index < 0) return false
    const current = this.users[index]
    if (current === undefined) return false
    this.writes.push({ ...user, id })
    this.users[index] = { ...current, name: user.name, username: user.username, email: user.email, role: user.role, status: user.status, updated: user.updated }
    return true
  }

  public async updateEmail(id: string, email: string, updated: number): Promise<boolean> {
    const index = this.users.findIndex((item) => item.id === id)
    if (index < 0) return false
    const current = this.users[index]
    if (current === undefined) return false
    this.users[index] = { ...current, email, updated }
    return true
  }

  public async updateUsername(id: string, username: string, updated: number): Promise<boolean> {
    const index = this.users.findIndex((item) => item.id === id)
    if (index < 0) return false
    const current = this.users[index]
    if (current === undefined) return false
    this.users[index] = { ...current, username, updated }
    return true
  }

  public async deleteUser(id: string): Promise<boolean> {
    this.deleted.push(id)
    const index = this.users.findIndex((user) => user.id === id)
    if (index < 0) return false
    this.users.splice(index, 1)
    return true
  }
}

class RouteAuthStore implements AuthStore {
  public readonly revoked: string[] = []
  public constructor(private readonly user: AuthUser | null = admin) {}
  public async findUserByIdentifier(): Promise<StoredAuthUser | null> { return null }
  public async createSession(_session: SessionWrite): Promise<void> {}
  public async recordFailedLogin(_session: Omit<SessionWrite, 'expires' | 'state'>): Promise<void> {}
  public async findActiveSession(requestedToken: string, requestedUserAgent: string): Promise<AuthUser | null> {
    return requestedToken === token && requestedUserAgent === userAgent ? this.user : null
  }
  public async revokeSession(requestedToken: string): Promise<boolean> {
    this.revoked.push(requestedToken)
    return true
  }
}

function service(store: MemoryUserStore): UserAdminService {
  return new UserAdminService(store, { now: () => 1_700_000_000, hashPassword: async (password) => `hash:${password}` })
}

describe('user administration service', () => {
  it('normalizes the legacy nine-column DataTables contract and role labels', async () => {
    const store = new MemoryUserStore()
    const result = await service(store).list({
      draw: '4',
      'search[value]': 'adm',
      'order[0][column]': '7',
      'order[0][dir]': 'asc'
    })

    expect(result).toEqual({
      draw: 4,
      data: [expect.objectContaining({ id: '1', user: 'admin', role: 'Admin', videos: 8 })],
      recordsTotal: 1,
      recordsFiltered: 1
    })
    expect(store.queries[0]).toEqual(expect.objectContaining({ search: 'adm', orderBy: 'videos', orderDir: 'asc' }))
    expect(userListQuery({ length: 999, start: -4 })).toEqual(expect.objectContaining({ length: 100, start: 0, orderBy: 'updated' }))
    expect(userId('4294967295')).toBe('4294967295')
    expect(userId('4294967296')).toBeNull()
  })

  it('creates and updates users with validation, conflicts, and optional bcrypt hashes', async () => {
    const store = new MemoryUserStore()
    const users = service(store)
    await expect(users.create({ name: 'Demo', user: 'demo', email: 'broken', role: '1', status: '1', password: 'password', retype_password: 'password' })).resolves.toEqual({ status: 'invalid', message: 'The email is invalid' })
    const created = await users.create({ name: 'Demo', user: 'demo', email: 'demo@example.test', role: '2', status: '1', password: 'password', retype_password: 'password' })
    expect(created).toEqual({ status: 'ok', id: '2', message: 'The new user has been successfully created' })
    expect(store.writes[0]).toEqual(expect.objectContaining({ username: 'demo', passwordHash: 'hash:password', role: 2 }))

    await expect(users.update('2', { name: 'Demo Two', user: 'demo', email: 'demo@example.test', role: '1', status: '2', password: '', retype_password: '' })).resolves.toEqual({ status: 'ok', id: '2', message: 'The user details have been successfully updated' })
    expect(store.writes[1]).not.toHaveProperty('passwordHash')
    await expect(users.create({ name: 'Other', user: 'admin', email: 'other@example.test', role: '1', status: '1', password: 'password', retype_password: 'password' })).resolves.toEqual({ status: 'invalid', message: 'The username has been used by another user' })
  })

  it('preserves self-service email and username response messages', async () => {
    const store = new MemoryUserStore()
    const users = service(store)
    await expect(users.editEmail(1, 'new@example.test')).resolves.toEqual({ status: 'ok', id: '1', message: 'The email address has been successfully updated. Please re-login' })
    await expect(users.editUsername(1, 'new-admin')).resolves.toEqual({ status: 'ok', id: '1', message: 'The username has been successfully updated. Please re-login' })
    expect(store.users[0]).toEqual(expect.objectContaining({ email: 'new@example.test', username: 'new-admin' }))
  })

  it('updates the complete legacy profile contract without allowing role or status changes', async () => {
    const store = new MemoryUserStore()
    const users = service(store)
    await expect(users.updateProfile(1, {
      name: 'Administrator', user: 'admin', email: 'admin@gplayer.local',
      role: '2', status: '9', password: 'newpassword', retype_password: 'newpassword'
    })).resolves.toEqual({ status: 'ok', id: '1', identityChanged: false, message: 'The user details have been successfully updated' })
    expect(store.writes[0]).toEqual(expect.objectContaining({ name: 'Administrator', role: 0, status: 1, passwordHash: 'hash:newpassword' }))
    await expect(users.updateProfile(1, {
      name: 'Administrator', user: 'new-admin', email: 'admin@gplayer.local', password: '', retype_password: ''
    })).resolves.toEqual({ status: 'ok', id: '1', identityChanged: true, message: 'The user details have been successfully updated' })
    await expect(users.updateProfile(1, {
      name: 'Administrator', user: 'new-admin', email: 'broken', password: '', retype_password: ''
    })).resolves.toEqual({ status: 'invalid', message: 'The email is invalid' })
  })
})

describe('MySqlUserAdminStore', () => {
  it('uses the legacy view/table with parameterized search, conflicts, writes, and IDs', async () => {
    const database = {
      read: vi.fn()
        .mockResolvedValueOnce([{ ...adminRecord, user: adminRecord.username }])
        .mockResolvedValueOnce([{ total: '2' }])
        .mockResolvedValueOnce([{ total: '1' }])
        .mockResolvedValueOnce([{ id: 1, user: 'admin', email: 'admin@gplayer.local' }]),
      write: vi.fn()
        .mockResolvedValueOnce({ insertId: 4 })
        .mockResolvedValue({ affectedRows: 1 })
    }
    const store = new MySqlUserAdminStore(database)
    const page = await store.listUsers({ draw: 1, start: 5, length: 25, search: "a' OR 1=1", orderBy: 'updated', orderDir: 'desc' })
    expect(page).toEqual({ data: [adminRecord], recordsTotal: 2, recordsFiltered: 1 })
    expect(database.read.mock.calls[0]?.[0]).toContain('FROM `vw_users`')
    expect(database.read.mock.calls[0]?.[0]).toContain('ORDER BY `updated` DESC LIMIT ? OFFSET ?')
    expect(database.read.mock.calls[0]?.[1]).toEqual(["a' OR 1=1%", "a' OR 1=1%", "a' OR 1=1%", 25, 5])
    expect(String(database.read.mock.calls[0]?.[0])).not.toContain("a' OR 1=1")

    await expect(store.findConflict('admin', 'other@example.test', '2')).resolves.toEqual({ username: true, email: false })
    await expect(store.createUser({ name: 'Demo', username: 'demo', email: 'demo@example.test', passwordHash: 'hash', role: 1, status: 1, created: 1, updated: 1 })).resolves.toBe('4')
    await expect(store.updateEmail('4', 'new@example.test', 2)).resolves.toBe(true)
    await expect(store.deleteUser('4')).resolves.toBe(true)
    expect(database.write).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM `tb_users` WHERE `id` = ?'), ['4'])
  })
})

describe('user administration routes', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function createApp(users: MemoryUserStore, routeAuth = new RouteAuthStore()): Promise<FastifyInstance> {
    return await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: '1234567890123456' }), {
      auth: new AuthService(routeAuth),
      users: service(users)
    })
  }

  const headers = Object.freeze({ cookie: `${AUTH_COOKIE_NAME}=${token}`, 'user-agent': userAgent })

  it('renders user list and edit/new forms without password hashes or auth tokens', async () => {
    const store = new MemoryUserStore()
    app = await createApp(store)
    const [list, edit, add] = await Promise.all([
      app.inject({ method: 'GET', url: '/administrator/users/', headers }),
      app.inject({ method: 'GET', url: '/administrator/users/edit/?id=1', headers }),
      app.inject({ method: 'GET', url: '/administrator/users/new/', headers })
    ])
    expect(list.statusCode).toBe(200)
    expect(list.body).toContain('User list.')
    expect(list.body).toContain('admin@gplayer.local')
    expect(list.body).not.toContain(token)
    expect(edit.body).toContain('Edit user.')
    expect(edit.body).toContain('Leave blank to keep the current password.')
    expect(add.body).toContain('New user.')
  })

  it('creates, edits, and deletes through signed same-origin forms', async () => {
    const store = new MemoryUserStore()
    app = await createApp(store)
    const newPage = await app.inject({ method: 'GET', url: '/administrator/users/new/', headers })
    const writeCsrf = newPage.body.match(/name="csrf" value="([^"]+)"/)?.[1]
    const created = await app.inject({
      method: 'POST',
      url: '/administrator/users/new/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${writeCsrf}&name=Demo&user=demo&email=demo%40example.test&role=1&status=1&password=password&retype_password=password`
    })
    expect(created.statusCode).toBe(303)
    expect(created.headers.location).toBe('/administrator/users/edit/?id=2&created=1')

    const editPage = await app.inject({ method: 'GET', url: '/administrator/users/edit/?id=2', headers })
    const editCsrf = editPage.body.match(/name="csrf" value="([^"]+)"/)?.[1]
    const edited = await app.inject({
      method: 'POST',
      url: '/administrator/users/edit/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${editCsrf}&id=2&name=Demo+Two&user=demo&email=demo%40example.test&role=2&status=2&password=&retype_password=`
    })
    expect(edited.statusCode).toBe(303)
    expect(store.users[1]).toEqual(expect.objectContaining({ name: 'Demo Two', role: 2, status: 2 }))

    const list = await app.inject({ method: 'GET', url: '/administrator/users/', headers })
    const deleteCsrf = list.body.match(/name="csrf" value="([^"]+)"/)?.[1]
    const deleted = await app.inject({
      method: 'POST',
      url: '/administrator/users/delete/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `csrf=${deleteCsrf}&id=2`
    })
    expect(deleted.statusCode).toBe(303)
    expect(deleted.headers.location).toBe('/administrator/users/?deleted=1')
  })

  it('serves legacy users-list/deletion shapes and blocks non-admin deletion', async () => {
    const store = new MemoryUserStore()
    app = await createApp(store)
    const listed = await app.inject({ method: 'GET', url: '/administrator/ajax/users-list/?draw=5', headers })
    expect(listed.json()).toEqual({ draw: 5, data: [expect.objectContaining({ user: 'admin', role: 'Admin' })], recordsTotal: 1, recordsFiltered: 1 })

    const routeAuth = new RouteAuthStore({ ...admin, role: 1 })
    await app.close()
    app = await createApp(store, routeAuth)
    const deniedList = await app.inject({ method: 'GET', url: '/administrator/ajax/users-list/?draw=9', headers })
    const deniedDelete = await app.inject({
      method: 'POST', url: '/administrator/ajax/users/', headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' }, payload: 'action=delete&id=1'
    })
    expect(deniedList.json()).toEqual({ draw: 9, data: [], recordsTotal: 0, recordsFiltered: 0 })
    expect(deniedDelete.json()).toEqual({ status: 'fail', message: 'You are not authorized to access this feature', result: null })
  })

  it('keeps self-service profile actions and revokes the session after identity changes', async () => {
    const store = new MemoryUserStore()
    const routeAuth = new RouteAuthStore({ ...admin, role: 1 })
    app = await createApp(store, routeAuth)
    const response = await app.inject({
      method: 'POST',
      url: '/administrator/ajax/users/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=editEmail&email=new%40example.test'
    })
    expect(response.json()).toEqual({ status: 'ok', message: 'The email address has been successfully updated. Please re-login', result: null })
    expect(routeAuth.revoked).toEqual([token])
    expect(String(response.headers['set-cookie'])).toContain(`${AUTH_COOKIE_NAME}=;`)
  })

  it('renders and submits the full signed profile form, preserving blank password fields', async () => {
    const store = new MemoryUserStore()
    const routeAuth = new RouteAuthStore()
    app = await createApp(store, routeAuth)
    const page = await app.inject({ method: 'GET', url: '/administrator/profile/', headers })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('My Account.')
    expect(page.body).toContain('value="admin@gplayer.local"')
    expect(page.body).not.toContain(token)
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1] ?? ''
    const renamed = await app.inject({
      method: 'POST', url: '/administrator/profile/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ csrf, name: 'Administrator', user: 'admin', email: 'admin@gplayer.local', password: '', retype_password: '' }).toString()
    })
    expect(renamed.statusCode).toBe(303)
    expect(renamed.headers.location).toBe('/administrator/profile/?updated=1')
    expect(store.writes.at(-1)).not.toHaveProperty('passwordHash')
    expect(store.users[0]).toEqual(expect.objectContaining({ name: 'Administrator', role: 0, status: 1 }))

    const changedIdentity = await app.inject({
      method: 'POST', url: '/administrator/profile/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ csrf, name: 'Administrator', user: 'admin-two', email: 'admin@gplayer.local', password: '', retype_password: '' }).toString()
    })
    expect(changedIdentity.statusCode).toBe(303)
    expect(changedIdentity.headers.location).toBe('/administrator/login/?account=profile-updated')
    expect(routeAuth.revoked).toEqual([token])
    expect(String(changedIdentity.headers['set-cookie'])).toContain(`${AUTH_COOKIE_NAME}=;`)
  })

  it('rejects cross-origin writes and invalid signed form submissions', async () => {
    const store = new MemoryUserStore()
    app = await createApp(store)
    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/administrator/ajax/users/',
      headers: { ...headers, origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=delete&id=1'
    })
    const badCsrf = await app.inject({
      method: 'POST',
      url: '/administrator/users/delete/',
      headers: { ...headers, origin: 'https://player.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'csrf=invalid&id=1'
    })
    const getDelete = await app.inject({
      method: 'GET',
      url: '/administrator/ajax/users/?action=delete&id=1',
      headers
    })
    expect(crossOrigin.statusCode).toBe(403)
    expect(badCsrf.statusCode).toBe(403)
    expect(getDelete.statusCode).toBe(405)
    expect(store.deleted).toEqual([])
  })
})
