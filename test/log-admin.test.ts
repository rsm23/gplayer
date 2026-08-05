import { createHmac } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { loadConfig } from '../src/config.js'
import { LogAdminService, LogFileError, logFileName } from '../src/logs/log-admin-service.js'

const secureSalt = '1234567890123456'
const token = 'log-admin-token-1234567890'
const memberToken = 'log-member-token-1234567890'
const userAgent = 'GPlayer log test'
const admin: AuthUser = Object.freeze({ id: 1, username: 'admin', email: 'admin@gplayer.local', name: 'Admin', role: 0, status: 1, created: 1, updated: 1 })
const member: AuthUser = Object.freeze({ ...admin, id: 2, username: 'member', email: 'member@gplayer.local', name: 'Member', role: 1 })

class RouteAuthStore implements AuthStore {
  public async findUserByIdentifier(): Promise<StoredAuthUser | null> { return null }
  public async createSession(_session: SessionWrite): Promise<void> {}
  public async recordFailedLogin(_session: Omit<SessionWrite, 'expires' | 'state'>): Promise<void> {}
  public async revokeSession(): Promise<boolean> { return true }
  public async findActiveSession(requestedToken: string, requestedUserAgent: string): Promise<AuthUser | null> {
    if (requestedUserAgent !== userAgent) return null
    if (requestedToken === token) return admin
    if (requestedToken === memberToken) return member
    return null
  }
}

describe('filesystem log administration', () => {
  let root = ''
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
    if (root !== '') await rm(root, { recursive: true, force: true })
    root = ''
  })

  it('lists regular files, reads bounded line chunks, streams downloads, and blocks traversal and symlinks', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-logs-'))
    await writeFile(path.join(root, 'app.log'), 'one\ntwo\nthree\nfour\n')
    await writeFile(path.join(root, 'worker.log'), 'worker')
    await symlink(path.join(root, 'app.log'), path.join(root, 'linked.log'))
    const logs = new LogAdminService(root)

    await expect(logs.list()).resolves.toEqual([
      expect.objectContaining({ name: 'app.log', size: 19, sizeKb: 0 }),
      expect.objectContaining({ name: 'worker.log', size: 6, sizeKb: 0 })
    ])
    await expect(logs.read('app.log', 2, 2)).resolves.toEqual({ name: 'app.log', start: 2, nextStart: 4, lines: ['two', 'three'] })
    const download = await logs.download('worker.log')
    const chunks: Buffer[] = []
    for await (const chunk of download.stream) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks).toString()).toBe('worker')
    expect(() => logFileName('../app.log')).toThrow(LogFileError)
    await expect(logs.read('linked.log')).rejects.toMatchObject({ code: 'not-file' })

    await logs.clear('app.log')
    await expect(readFile(path.join(root, 'app.log'), 'utf8')).resolves.toBe('')
    await logs.delete('worker.log')
    await expect(logs.list()).resolves.toEqual([expect.objectContaining({ name: 'app.log' })])
  })

  it('serves the legacy log API and hardened signed mutations plus the backend DMCA notice', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-log-routes-'))
    await writeFile(path.join(root, 'app.log'), 'alpha\nbeta\ngamma\n')
    const logs = new LogAdminService(root)
    app = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: secureSalt }), {
      auth: new AuthService(new RouteAuthStore()), logs
    })
    const headers = Object.freeze({ cookie: `${AUTH_COOKIE_NAME}=${token}`, 'user-agent': userAgent, origin: 'https://player.example' })

    const [page, list, read, download, dmca] = await Promise.all([
      app.inject({ method: 'GET', url: '/administrator/log/', headers }),
      app.inject({ method: 'GET', url: '/administrator/log/?api=1&action=list', headers }),
      app.inject({ method: 'GET', url: '/administrator/log/?api=1&action=read&file=app.log&start=2', headers }),
      app.inject({ method: 'GET', url: '/administrator/log/?action=download&file=app.log', headers }),
      app.inject({ method: 'GET', url: '/administrator/dmca/', headers })
    ])
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('System logs.')
    expect(page.body).toContain('app.log')
    expect(list.json()).toEqual([{ src: 'app.log', size: 0 }])
    expect(read.body).toBe('beta\ngamma')
    expect(download.body).toBe('alpha\nbeta\ngamma\n')
    expect(download.headers['content-disposition']).toContain('filename="app.log"')
    expect(dmca.statusCode).toBe(200)
    expect(dmca.body).toContain('Content has been taken down.')

    const destructiveGet = await app.inject({ method: 'GET', url: '/administrator/log/?api=1&action=clear&file=app.log', headers })
    expect(destructiveGet.statusCode).toBe(405)
    await expect(readFile(path.join(root, 'app.log'), 'utf8')).resolves.toContain('alpha')

    const csrf = createHmac('sha256', secureSalt).update(`log-mutate\0${token}`).digest('base64url')
    const badCsrf = await app.inject({
      method: 'POST', url: '/administrator/log/', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'api=1&action=clear&file=app.log&csrf=bad'
    })
    expect(badCsrf.statusCode).toBe(403)
    const cleared = await app.inject({
      method: 'POST', url: '/administrator/log/', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ api: '1', action: 'clear', file: 'app.log', csrf }).toString()
    })
    expect(cleared.json()).toEqual({ status: 'ok', message: 'Log cleared successfully', result: null })
    await expect(readFile(path.join(root, 'app.log'), 'utf8')).resolves.toBe('')

    const memberHeaders = { cookie: `${AUTH_COOKIE_NAME}=${memberToken}`, 'user-agent': userAgent }
    const denied = await app.inject({ method: 'GET', url: '/administrator/log/', headers: memberHeaders })
    expect(denied.statusCode).toBe(302)
    expect(denied.headers.location).toBe('/administrator/403/')
  })
})
