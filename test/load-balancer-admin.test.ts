import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { loadConfig } from '../src/config.js'
import {
  LoadBalancerAdminService,
  loadBalancerId,
  loadBalancerListQuery,
  type LoadBalancerAdminRecord,
  type LoadBalancerAdminStore,
  type LoadBalancerListQuery,
  type LoadBalancerWrite
} from '../src/load-balancers/load-balancer-admin-service.js'
import { MySqlLoadBalancerAdminStore } from '../src/load-balancers/mysql-load-balancer-admin-store.js'

const token = 'load-balancer-admin-token-1234567890'
const userAgent = 'GPlayer load balancer admin test'
const secureSalt = '1234567890123456'
const admin: AuthUser = Object.freeze({ id: 1, username: 'admin', email: 'admin@gplayer.local', name: 'Admin', role: 0, status: 1, created: 1_600_000_000, updated: 1_600_000_000 })
const member: AuthUser = Object.freeze({ ...admin, id: 2, username: 'member', role: 1 })
const record: LoadBalancerAdminRecord = Object.freeze({
  id: '1', name: 'Paris edge', link: 'https://edge.example/', connections: 14, playbacks: 90, status: 1, public: 0,
  created: 1_600_000_000, updated: 1_600_000_100, disallowHosts: Object.freeze(['youtube']), disallowContinents: Object.freeze(['OC'])
})

class RouteAuthStore implements AuthStore {
  public constructor(private readonly user: AuthUser | null = admin) {}
  public async findUserByIdentifier(): Promise<StoredAuthUser | null> { return null }
  public async createSession(_session: SessionWrite): Promise<void> {}
  public async recordFailedLogin(_session: Omit<SessionWrite, 'expires' | 'state'>): Promise<void> {}
  public async findActiveSession(requestedToken: string, requestedUserAgent: string): Promise<AuthUser | null> { return requestedToken === token && requestedUserAgent === userAgent ? this.user : null }
  public async revokeSession(): Promise<boolean> { return true }
}

class MemoryLoadBalancerStore implements LoadBalancerAdminStore {
  public readonly records: LoadBalancerAdminRecord[] = [{ ...record }]
  public readonly queries: LoadBalancerListQuery[] = []
  public readonly writes: Array<LoadBalancerWrite & { id: string }> = []
  public readonly deletes: string[] = []

  public async listLoadBalancers(query: LoadBalancerListQuery) {
    this.queries.push(query)
    const search = query.search.toLowerCase()
    const filtered = this.records.filter((item) => search === '' || item.name.toLowerCase().includes(search) || item.link.toLowerCase().includes(search))
    return { data: filtered.slice(query.start, query.start + query.length), recordsTotal: this.records.length, recordsFiltered: filtered.length }
  }
  public async getLoadBalancer(id: string): Promise<LoadBalancerAdminRecord | null> { return this.records.find((item) => item.id === id) ?? null }
  public async linkExists(link: string, excludeId?: string): Promise<boolean> { return this.records.some((item) => item.id !== excludeId && item.link === link) }
  public async createLoadBalancer(value: LoadBalancerWrite): Promise<string> { const id = String(this.records.length + 1); this.writes.push({ ...value, id }); this.records.push(fromWrite(id, value)); return id }
  public async updateLoadBalancer(id: string, value: LoadBalancerWrite): Promise<boolean> { const index = this.records.findIndex((item) => item.id === id); if (index < 0) return false; this.writes.push({ ...value, id }); this.records[index] = { ...fromWrite(id, value), connections: this.records[index]?.connections ?? 0, playbacks: this.records[index]?.playbacks ?? 0 }; return true }
  public async deleteLoadBalancer(id: string): Promise<boolean> { this.deletes.push(id); const index = this.records.findIndex((item) => item.id === id); if (index < 0) return false; this.records.splice(index, 1); return true }
  public async updateStatus(id: string, status: number, updated: number): Promise<boolean> { const index = this.records.findIndex((item) => item.id === id); const current = this.records[index]; if (current === undefined) return false; this.records[index] = { ...current, status, updated }; return true }
}

function service(store: MemoryLoadBalancerStore): LoadBalancerAdminService {
  return new LoadBalancerAdminService(store, { hosts: new Set(['youtube', 'vimeo', 'direct']), mainSite: new URL('https://player.example/'), now: () => 1_700_000_000 })
}

describe('load balancer administration service', () => {
  it('preserves the nine-column DataTables contract with bounded search and ordering', async () => {
    const store = new MemoryLoadBalancerStore()
    const result = await service(store).list({ draw: '7', 'search[value]': 'edge', 'order[0][column]': '2', 'order[0][dir]': 'asc', length: 999 })
    expect(result).toEqual({ draw: 7, data: [{ ...record, slug: 'load-balancers' }], recordsTotal: 1, recordsFiltered: 1 })
    expect(store.queries[0]).toEqual(expect.objectContaining({ orderBy: 'connections', orderDir: 'asc', length: 100 }))
    expect(loadBalancerListQuery({ start: -5 })).toEqual(expect.objectContaining({ start: 0, orderBy: 'updated' }))
    expect(loadBalancerId('4294967295')).toBe('4294967295')
    expect(loadBalancerId('4294967296')).toBeNull()
  })

  it('normalizes URLs, allowlists routing exclusions, and fixes public to zero', async () => {
    const store = new MemoryLoadBalancerStore()
    await expect(service(store).create({
      name: 'Amsterdam edge', link: 'https://EDGE-2.example/path', status: ['0', '1'], public: '1',
      'disallow_hosts[]': ['', 'youtube', 'unknown', 'youtube'], 'disallow_continent[]': ['', 'EU', 'XX']
    })).resolves.toEqual({ status: 'ok', id: '2', message: 'The new load balancer site has been successfully created' })
    expect(store.writes[0]).toEqual({ id: '2', name: 'Amsterdam edge', link: 'https://edge-2.example/path/', status: 1, public: 0, created: 1_700_000_000, updated: 1_700_000_000, disallowHosts: ['youtube'], disallowContinents: ['EU'] })
  })

  it('rejects the main origin, duplicate origins, credentials, queries, and invalid names without writing', async () => {
    const store = new MemoryLoadBalancerStore()
    const loadBalancers = service(store)
    await expect(loadBalancers.create({ name: 'Main', link: 'https://player.example' })).resolves.toEqual({ status: 'invalid', message: 'The main site should not be stored as a load balancer site' })
    await expect(loadBalancers.create({ name: 'Duplicate', link: 'https://edge.example' })).resolves.toEqual({ status: 'invalid', message: 'The load balancer URL is already in use' })
    await expect(loadBalancers.create({ name: 'Private', link: 'https://user:secret@edge-2.example/' })).resolves.toEqual({ status: 'invalid', message: 'The load balancer homepage URL is invalid' })
    await expect(loadBalancers.create({ name: 'Query', link: 'https://edge-2.example/?token=secret' })).resolves.toEqual({ status: 'invalid', message: 'The load balancer homepage URL is invalid' })
    await expect(loadBalancers.create({ name: '\u0000', link: 'https://edge-2.example/' })).resolves.toEqual({ status: 'invalid', message: 'The load balancer name is invalid' })
    expect(store.writes).toEqual([])
  })

  it('updates, toggles, and deletes with the exact legacy messages', async () => {
    const store = new MemoryLoadBalancerStore()
    const loadBalancers = service(store)
    await expect(loadBalancers.update('1', { name: 'Paris updated', link: 'https://edge.example/', status: '0', disallow_hosts: ['vimeo'], disallow_continent: ['AF'] })).resolves.toEqual({ status: 'ok', id: '1', message: 'The load balancer site has been successfully updated' })
    expect(store.writes[0]).toEqual(expect.objectContaining({ created: record.created, updated: 1_700_000_000, status: 0 }))
    await expect(loadBalancers.setStatus('1', '1')).resolves.toEqual({ status: 'ok', id: '1', message: 'The load balancer server has been successfully updated' })
    await expect(loadBalancers.delete('1')).resolves.toEqual({ status: 'ok', id: '1', message: 'The load balancer server deleted successfully' })
    await expect(loadBalancers.delete('1')).resolves.toEqual({ status: 'invalid', message: 'The load balancer server failed to delete' })
  })
})

describe('MySqlLoadBalancerAdminStore', () => {
  it('reads the legacy view and parameterizes list, lookup, and writes', async () => {
    const read = vi.fn(async (sql: string, _values: readonly unknown[] = []) => sql.includes('COUNT(*)') ? [{ total: '1' }] : [databaseRow()])
    const write = vi.fn().mockResolvedValueOnce({ insertId: 3 }).mockResolvedValue({ affectedRows: 1 })
    const store = new MySqlLoadBalancerAdminStore({ read, write } as never)
    await expect(store.listLoadBalancers({ draw: 0, start: 4, length: 25, search: "x' OR 1=1", orderBy: 'connections', orderDir: 'desc' })).resolves.toEqual({ data: [record], recordsTotal: 1, recordsFiltered: 1 })
    const listCall = read.mock.calls.find(([sql]) => sql.includes('LIMIT ? OFFSET ?'))
    expect(listCall?.[0]).toContain('FROM `vw_loadbalancers`')
    expect(listCall?.[0]).toContain('ORDER BY `connections` DESC')
    expect(listCall?.[0]).not.toContain("x' OR 1=1")
    expect(listCall?.[1]).toEqual(["%x' OR 1=1%", "%x' OR 1=1%", 25, 4])
    await expect(store.getLoadBalancer('1')).resolves.toEqual(record)
    await expect(store.selectLoadBalancer({ host: 'youtube', continent: 'EU', metric: 'connections', excludeUrl: 'https://old.example/' })).resolves.toBe('https://edge.example/')
    const selectionCall = read.mock.calls.find(([sql]) => sql.includes('JSON_CONTAINS'))
    expect(selectionCall?.[0]).toContain('ORDER BY `connections` ASC, `id` ASC LIMIT 1')
    expect(selectionCall?.[0]).toContain('`link` <> ?')
    expect(selectionCall?.[1]).toEqual(['youtube', 'EU', 'https://old.example/'])
    await expect(store.createLoadBalancer(writeValue())).resolves.toBe('3')
    await expect(store.updateLoadBalancer('1', writeValue())).resolves.toBe(true)
    await expect(store.updateStatus('1', 0, 123)).resolves.toBe(true)
    await expect(store.deleteLoadBalancer('1')).resolves.toBe(true)
    expect(write.mock.calls.at(-1)).toEqual(['DELETE FROM `tb_loadbalancers` WHERE `id` = ?', ['1']])
    expect(write.mock.calls[0]?.[1]).toEqual(['Paris edge', 'https://edge.example/', 1, 0, 1_600_000_000, 1_600_000_100, '["youtube"]', '["OC"]'])
  })
})

describe('load balancer administration routes', () => {
  let app: FastifyInstance | undefined
  const headers = Object.freeze({ cookie: `${AUTH_COOKIE_NAME}=${token}`, 'user-agent': userAgent, origin: 'https://player.example' })
  afterEach(async () => { await app?.close(); app = undefined })

  async function createApp(store: MemoryLoadBalancerStore, user: AuthUser | null = admin): Promise<FastifyInstance> {
    return await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: secureSalt }), { auth: new AuthService(new RouteAuthStore(user)), loadBalancers: service(store) })
  }

  it('renders authenticated list/form pages and blocks non-admin users', async () => {
    const store = new MemoryLoadBalancerStore()
    app = await createApp(store)
    const list = await app.inject({ method: 'GET', url: '/administrator/load-balancers/list/?q=Paris', headers })
    expect(list.statusCode).toBe(200)
    expect(list.body).toContain('Paris edge')
    expect(list.body).toContain('14')
    expect(list.body).not.toContain('gdplayer.')
    const form = await app.inject({ method: 'GET', url: '/administrator/load-balancers/edit/?id=1', headers })
    expect(form.statusCode).toBe(200)
    expect(form.body).toContain('Disabled hosts')
    expect(form.body).toContain('Oceania')
    await app.close()
    app = await createApp(store, member)
    const forbidden = await app.inject({ method: 'GET', url: '/administrator/load-balancers/list/', headers })
    expect(forbidden.statusCode).toBe(302)
    expect(forbidden.headers.location).toBe('/administrator/403/')
  })

  it('creates through the protected form and serves legacy list/status/delete actions', async () => {
    const store = new MemoryLoadBalancerStore()
    app = await createApp(store)
    const csrf = createHmac('sha256', secureSalt).update(`load-balancer-mutate\0${token}`).digest('base64url')
    const created = await app.inject({ method: 'POST', url: '/administrator/load-balancers/new/', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ csrf, name: 'London edge', link: 'https://london.example', status: '1', 'disallow_hosts[]': 'youtube', 'disallow_continent[]': 'EU' }).toString() })
    expect(created.statusCode).toBe(303)
    expect(created.headers.location).toBe('/administrator/load-balancers/edit/?id=2&created=1')
    const listed = await app.inject({ method: 'GET', url: '/administrator/ajax/load-balancer-list/?draw=2', headers })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toEqual(expect.objectContaining({ draw: 2, recordsTotal: 2 }))
    const status = await app.inject({ method: 'POST', url: '/administrator/ajax/load-balancer/', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'action=updateStatus&id=2&status=0' })
    expect(status.json()).toEqual({ status: 'ok', message: 'The load balancer server has been successfully updated', result: null })
    const deleted = await app.inject({ method: 'POST', url: '/administrator/load-balancers/delete/', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ csrf, id: '2' }).toString() })
    expect(deleted.statusCode).toBe(303)
    expect(store.deletes).toContain('2')
  })

  it('rejects cross-origin and missing-CSRF mutations', async () => {
    app = await createApp(new MemoryLoadBalancerStore())
    const crossOrigin = await app.inject({ method: 'POST', url: '/administrator/load-balancers/status/', headers: { ...headers, origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded' }, payload: 'id=1&status=0' })
    expect(crossOrigin.statusCode).toBe(403)
    const noCsrf = await app.inject({ method: 'POST', url: '/administrator/load-balancers/status/', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'id=1&status=0' })
    expect(noCsrf.statusCode).toBe(403)
  })
})

function fromWrite(id: string, value: LoadBalancerWrite): LoadBalancerAdminRecord { return Object.freeze({ id, name: value.name, link: value.link, connections: 0, playbacks: 0, status: value.status, public: value.public, created: value.created, updated: value.updated, disallowHosts: Object.freeze([...value.disallowHosts]), disallowContinents: Object.freeze([...value.disallowContinents]) }) }
function writeValue(): LoadBalancerWrite { return { name: record.name, link: record.link, status: record.status, public: 0, created: record.created, updated: record.updated, disallowHosts: record.disallowHosts, disallowContinents: record.disallowContinents } }
function databaseRow() { return { id: 1, name: record.name, link: record.link, connections: '14', playbacks: '90', status: '1', public: '0', created: String(record.created), updated: String(record.updated), disallow_hosts: '["youtube"]', disallow_continent: '["OC"]' } }
