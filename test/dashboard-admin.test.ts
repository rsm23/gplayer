import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { AUTH_COOKIE_NAME, AuthService, type AuthStore, type AuthUser, type SessionWrite, type StoredAuthUser } from '../src/auth/auth-service.js'
import { loadConfig } from '../src/config.js'
import {
  DashboardAdminService,
  dashboardRange,
  type DashboardAdminStore,
  type DashboardAggregatePage,
  type DashboardBrowserRow,
  type DashboardDailyView,
  type DashboardNamedAggregate,
  type DashboardRange,
  type DashboardServerUsage,
  type DashboardVideoRow,
  type DashboardVideoStatus
} from '../src/dashboard/dashboard-admin-service.js'
import { MySqlDashboardAdminStore } from '../src/dashboard/mysql-dashboard-admin-store.js'

const token = 'dashboard-admin-token-1234567890'
const userAgent = 'GPlayer dashboard test browser'
const now = Math.floor(Date.parse('2026-03-30T10:00:00Z') / 1_000)
const admin: AuthUser = Object.freeze({ id: 1, username: 'admin', email: 'admin@gplayer.local', name: 'Admin', role: 0, status: 1, created: 0, updated: 0 })
const member: AuthUser = Object.freeze({ ...admin, id: 2, username: 'member', email: 'member@gplayer.local', name: 'Member', role: 1 })
const video: DashboardVideoRow = Object.freeze({ id: '7', title: 'Launch reel', host: 'direct', hostId: 'asset-7', slug: 'launch reel', name: 'Admin', created: now - 60, views: 42, hasAlt: true, hasSub: true })

class MemoryDashboardStore implements DashboardAdminStore {
  public readonly owners: Array<number | null> = []
  public readonly status: DashboardVideoStatus = Object.freeze({ good: 8, broken: 2, warning: 1, total_videos: 11, total_servers: 3, total_gdrives: 4 })
  public readonly daily: readonly DashboardDailyView[] = Object.freeze([
    Object.freeze({ timestamp: Math.floor(Date.parse('2026-03-29T00:30:00Z') / 1_000), value: 2 }),
    Object.freeze({ timestamp: Math.floor(Date.parse('2026-03-29T01:30:00Z') / 1_000), value: 3 }),
    Object.freeze({ timestamp: Math.floor(Date.parse('2026-03-29T22:30:00Z') / 1_000), value: 7 })
  ])

  public async videoStatus(ownerId: number | null): Promise<DashboardVideoStatus> { this.owners.push(ownerId); return this.status }
  public async recentVideos(ownerId: number | null): Promise<readonly DashboardVideoRow[]> { this.owners.push(ownerId); return [video] }
  public async popularVideos(_range: DashboardRange, ownerId: number | null): Promise<readonly DashboardVideoRow[]> { this.owners.push(ownerId); return [video] }
  public async dailyViews(_range: DashboardRange, ownerId: number | null): Promise<readonly DashboardDailyView[]> { this.owners.push(ownerId); return this.daily }
  public async popularBrowsers(_range: DashboardRange, ownerId: number | null): Promise<DashboardAggregatePage<DashboardBrowserRow>> {
    this.owners.push(ownerId)
    return { data: [{ uaName: 'Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36', views: 9 }], total: 1 }
  }
  public async popularCountries(_range: DashboardRange, ownerId: number | null): Promise<DashboardAggregatePage<DashboardNamedAggregate>> { this.owners.push(ownerId); return { data: [{ name: 'FR', views: 8 }], total: 1 } }
  public async popularAsns(_range: DashboardRange, ownerId: number | null): Promise<DashboardAggregatePage<DashboardNamedAggregate>> { this.owners.push(ownerId); return { data: [{ id: 64500, name: 'Example Network', views: 6 }], total: 1 } }
  public async serverUsage(): Promise<readonly DashboardServerUsage[]> { return [{ name: 'Main Server', sources: 12 }, { name: 'Paris edge', sources: 5 }] }
}

class RouteAuthStore implements AuthStore {
  public constructor(private readonly user: AuthUser | null) {}
  public async findUserByIdentifier(): Promise<StoredAuthUser | null> { return null }
  public async createSession(_session: SessionWrite): Promise<void> {}
  public async recordFailedLogin(_session: Omit<SessionWrite, 'expires' | 'state'>): Promise<void> {}
  public async findActiveSession(requestedToken: string, requestedUserAgent: string): Promise<AuthUser | null> { return requestedToken === token && requestedUserAgent === userAgent ? this.user : null }
  public async revokeSession(): Promise<boolean> { return true }
}

function service(store: DashboardAdminStore): DashboardAdminService {
  return new DashboardAdminService(store, new URL('https://player.example/'), { embed: 'e', download: 'd' }, { now: () => now, timezone: 'Europe/Paris' })
}

describe('dashboard administration service', () => {
  it('builds calendar ranges in the requested timezone across daylight-saving changes', () => {
    expect(dashboardRange('today', now, 'Europe/Paris')).toEqual({ start: Math.floor(Date.parse('2026-03-29T22:00:00Z') / 1_000), end: now })
    expect(dashboardRange('7_days', now, 'Europe/Paris').start).toBe(Math.floor(Date.parse('2026-03-22T23:00:00Z') / 1_000))
    expect(dashboardRange('2026-03-29 - 2026-03-30', now, 'Europe/Paris')).toEqual({
      start: Math.floor(Date.parse('2026-03-28T23:00:00Z') / 1_000),
      end: Math.floor(Date.parse('2026-03-30T22:00:00Z') / 1_000) - 1
    })
    expect(dashboardRange('not-a-filter', now, 'Invalid/Zone')).toEqual({ start: Math.floor(Date.parse('2026-03-30T00:00:00Z') / 1_000), end: now })
  })

  it('buckets every raw timestamp in local time and preserves video/browser compatibility fields', async () => {
    const store = new MemoryDashboardStore()
    const dashboard = service(store)
    await expect(dashboard.views({ filter: '2026-03-29 - 2026-03-30', timezone: 'Europe/Paris' }, { userId: 2, isAdmin: false })).resolves.toEqual([
      [Math.floor(Date.parse('2026-03-28T23:00:00Z') / 1_000), 5],
      [Math.floor(Date.parse('2026-03-29T22:00:00Z') / 1_000), 7]
    ])
    const popular = await dashboard.popularVideos({ draw: '4', uid: '99' }, { userId: 2, isAdmin: false })
    expect(popular).toEqual(expect.objectContaining({ draw: 4, recordsTotal: 1, recordsFiltered: 1 }))
    expect(popular.data[0]).toEqual(expect.objectContaining({ has_alt: true, has_sub: true, link: 'asset-7' }))
    expect(popular.data[0]?.actions.embed).toBe('https://player.example/e/launch%20reel')
    expect(popular.data[0]?.actions.embed_code).toContain('allowfullscreen')
    const browsers = await dashboard.popularBrowsers({}, { userId: 2, isAdmin: false })
    expect(browsers.data[0]).toEqual(expect.objectContaining({ name: 'Chrome 124.0.0.0', device: 'Desktop', views: 9 }))
    expect(store.owners.every((owner) => owner === 2)).toBe(true)
  })

  it('allows admins to select an owner and includes infrastructure only in admin snapshots', async () => {
    const store = new MemoryDashboardStore()
    const dashboard = service(store)
    await dashboard.videosStatus({ uid: '8' }, { userId: 1, isAdmin: true })
    expect(store.owners.at(-1)).toBe(8)
    const snapshot = await dashboard.snapshot({ userId: 1, isAdmin: true }, 'Europe/Paris')
    expect(snapshot.serverUsage).toEqual([{ name: 'Main Server', sources: 12 }, { name: 'Paris edge', sources: 5 }])
    expect(snapshot.views).toEqual([
      { timestamp: Math.floor(Date.parse('2026-03-28T23:00:00Z') / 1_000), value: 5 },
      { timestamp: Math.floor(Date.parse('2026-03-29T22:00:00Z') / 1_000), value: 7 }
    ])
  })
})

describe('MySqlDashboardAdminStore', () => {
  it('uses parameterized owner/range/paging values and raw timestamps for timezone-safe bucketing', async () => {
    const read = vi.fn(async (sql: string, _values: readonly unknown[] = []) => {
      if (sql.includes('COUNT(CASE')) return [{ good: '8', broken: '2', warning: '1', total: '11' }]
      if (sql.includes('tb_loadbalancers') && sql.includes('COUNT(*)')) return [{ total: '3' }]
      if (sql.includes('tb_gdrive_auth')) return [{ total: '4' }]
      if (sql.includes('dashboard_groups')) return [{ total: '1' }]
      if (sql.includes('GROUP BY s.`country`')) return [{ name: 'FR', views: '8' }]
      if (sql.includes('GROUP BY s.`created`')) return [{ timestamp: String(now - 1), value: '2' }]
      return []
    })
    const store = new MySqlDashboardAdminStore({ read } as never)
    await expect(store.videoStatus(9)).resolves.toEqual({ good: 8, broken: 2, warning: 1, total_videos: 11, total_servers: 3, total_gdrives: 4 })
    const range = { start: now - 100, end: now }
    await expect(store.popularCountries(range, 9, 20, 10)).resolves.toEqual({ data: [{ name: 'FR', views: 8 }], total: 1 })
    await expect(store.dailyViews(range, 9)).resolves.toEqual([{ timestamp: now - 1, value: 2 }])
    const countryCall = read.mock.calls.find(([sql]) => sql.includes('GROUP BY s.`country`') && !sql.includes('dashboard_groups'))
    expect(countryCall?.[0]).toContain('v.`uid` = ?')
    expect(countryCall?.[0]).toContain('LIMIT ? OFFSET ?')
    expect(countryCall?.[1]).toEqual([range.start, range.end, 9, 10, 20])
    const dailyCall = read.mock.calls.find(([sql]) => sql.includes('GROUP BY s.`created`'))
    expect(dailyCall?.[0]).not.toContain('FLOOR')
    expect(dailyCall?.[1]).toEqual([range.start, range.end, 9])
    expect(read.mock.calls.every(([sql]) => !sql.includes(String(range.start)))).toBe(true)
  })
})

describe('dashboard administration routes', () => {
  let app: FastifyInstance | undefined
  const headers = Object.freeze({ cookie: `${AUTH_COOKIE_NAME}=${token}`, 'user-agent': userAgent })

  afterEach(async () => { await app?.close(); app = undefined })

  async function createApp(user: AuthUser): Promise<{ app: FastifyInstance; store: MemoryDashboardStore }> {
    const store = new MemoryDashboardStore()
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: '1234567890123456' }), {
      auth: new AuthService(new RouteAuthStore(user)),
      dashboard: service(store)
    })
    return { app, store }
  }

  it('renders the full analytics surface and all eight legacy dashboard actions', async () => {
    const runtime = await createApp(admin)
    app = runtime.app
    const page = await app.inject({ method: 'GET', url: '/administrator/dashboard/', headers })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Playback views')
    expect(page.body).toContain('Launch reel')
    expect(page.body).toContain('Top browsers')
    expect(page.body).toContain('Paris edge')
    expect(page.body).not.toContain('dashboard-admin-token')

    const expected = new Map<string, (value: Record<string, unknown>) => void>([
      ['videosStatus', (value) => expect(value.result).toEqual(expect.objectContaining({ total_videos: 11, broken: 2 }))],
      ['serversStatus', (value) => expect(value.result).toEqual({ 'Main Server': 12, 'Paris edge': 5 })],
      ['views', (value) => expect(value.result).toHaveLength(2)],
      ['recentVideos', (value) => expect(value).toEqual(expect.objectContaining({ draw: 3, recordsTotal: 1 }))],
      ['popularVideos', (value) => expect(value).toEqual(expect.objectContaining({ draw: 3, recordsTotal: 1 }))],
      ['popularBrowsers', (value) => expect(value).toEqual(expect.objectContaining({ draw: 3, recordsTotal: 1 }))],
      ['popularCountries', (value) => expect(value).toEqual(expect.objectContaining({ draw: 3, recordsTotal: 1 }))],
      ['popularASN', (value) => expect(value).toEqual(expect.objectContaining({ draw: 3, recordsTotal: 1 }))]
    ])
    for (const [action, assertResult] of expected) {
      const response = await app.inject({ method: 'GET', url: `/administrator/ajax/dashboard/?action=${action}&draw=3&timezone=Europe%2FParis`, headers })
      expect(response.statusCode).toBe(200)
      assertResult(response.json() as Record<string, unknown>)
    }
  })

  it('enforces member ownership and denies the admin-only server action', async () => {
    const runtime = await createApp(member)
    app = runtime.app
    const status = await app.inject({ method: 'GET', url: '/administrator/ajax/dashboard/?action=videosStatus&uid=99', headers })
    expect(status.statusCode).toBe(200)
    expect(runtime.store.owners.at(-1)).toBe(2)
    const servers = await app.inject({ method: 'GET', url: '/administrator/ajax/dashboard/?action=serversStatus', headers })
    expect(servers.json()).toEqual({ status: 'fail', message: 'You are not authorized to access this feature', result: null })
    const page = await app.inject({ method: 'GET', url: '/administrator/dashboard/', headers })
    expect(page.body).not.toContain('Server usage')
  })
})
