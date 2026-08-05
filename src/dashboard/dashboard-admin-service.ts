import { Hosting } from '../core/hosting.js'

export type DashboardAccess = Readonly<{ userId: number; isAdmin: boolean }>
export type DashboardRange = Readonly<{ start: number; end: number }>

export type DashboardVideoStatus = Readonly<{
  good: number
  broken: number
  warning: number
  total_videos: number
  total_servers: number
  total_gdrives: number
}>

export type DashboardVideoRow = Readonly<{
  id: string
  title: string
  host: string
  hostId: string
  slug: string
  name: string
  created: number
  views: number
  hasAlt: boolean
  hasSub: boolean
}>

export type DashboardVideo = Readonly<{
  id: string
  title: string
  host: string
  host_id: string
  slug: string
  name: string
  created: number
  views: number
  has_alt: boolean
  has_sub: boolean
  link: string
  actions: Readonly<{ embed: string; download: string; embed_code: string }>
}>

export type DashboardBrowserRow = Readonly<{ uaName: string; views: number }>
export type DashboardBrowser = Readonly<{ ua_name: string; views: number; name: string; device: string; os: string }>
export type DashboardNamedAggregate = Readonly<{ id?: number; name: string; views: number }>
export type DashboardDailyView = Readonly<{ timestamp: number; value: number }>
export type DashboardServerUsage = Readonly<{ name: string; sources: number }>
export type DashboardAggregatePage<T> = Readonly<{ data: readonly T[]; total: number }>

export interface DashboardAdminStore {
  videoStatus(ownerId: number | null): Promise<DashboardVideoStatus>
  recentVideos(ownerId: number | null, limit: number): Promise<readonly DashboardVideoRow[]>
  popularVideos(range: DashboardRange, ownerId: number | null, limit: number): Promise<readonly DashboardVideoRow[]>
  dailyViews(range: DashboardRange, ownerId: number | null): Promise<readonly DashboardDailyView[]>
  popularBrowsers(range: DashboardRange, ownerId: number | null, start: number, limit: number): Promise<DashboardAggregatePage<DashboardBrowserRow>>
  popularCountries(range: DashboardRange, ownerId: number | null, start: number, limit: number): Promise<DashboardAggregatePage<DashboardNamedAggregate>>
  popularAsns(range: DashboardRange, ownerId: number | null, start: number, limit: number): Promise<DashboardAggregatePage<DashboardNamedAggregate>>
  serverUsage(): Promise<readonly DashboardServerUsage[]>
}

export const EMPTY_DASHBOARD_ADMIN_STORE: DashboardAdminStore = Object.freeze({
  videoStatus: async () => Object.freeze({ good: 0, broken: 0, warning: 0, total_videos: 0, total_servers: 0, total_gdrives: 0 }),
  recentVideos: async () => Object.freeze([]),
  popularVideos: async () => Object.freeze([]),
  dailyViews: async () => Object.freeze([]),
  popularBrowsers: async () => Object.freeze({ data: Object.freeze([]), total: 0 }),
  popularCountries: async () => Object.freeze({ data: Object.freeze([]), total: 0 }),
  popularAsns: async () => Object.freeze({ data: Object.freeze([]), total: 0 }),
  serverUsage: async () => Object.freeze([])
})

export type DashboardSnapshot = Readonly<{
  status: DashboardVideoStatus
  recentVideos: readonly DashboardVideo[]
  popularVideos: readonly DashboardVideo[]
  views: readonly DashboardDailyView[]
  browsers: readonly DashboardBrowser[]
  countries: readonly DashboardNamedAggregate[]
  asns: readonly DashboardNamedAggregate[]
  serverUsage: readonly DashboardServerUsage[]
}>

export type DashboardDataTables<T> = Readonly<{
  draw: number
  data: readonly T[]
  recordsTotal: number
  recordsFiltered: number
}>

export class DashboardAdminService {
  private readonly now: () => number
  private readonly timezone: string

  public constructor(
    private readonly store: DashboardAdminStore,
    private readonly baseUrl: URL,
    private readonly slugs: Readonly<{ embed: string; download: string }>,
    options: Readonly<{ now?: () => number; timezone?: string }> = {}
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.timezone = validTimezone(options.timezone ?? 'UTC')
  }

  public async snapshot(access: DashboardAccess, timezoneInput?: string): Promise<DashboardSnapshot> {
    const ownerId = access.isAdmin ? null : access.userId
    const timezone = validTimezone(timezoneInput ?? this.timezone)
    const today = dashboardRange('today', this.now(), timezone)
    const week = dashboardRange('7_days', this.now(), timezone)
    const [status, recent, popular, views, browsers, countries, asns, serverUsage] = await Promise.all([
      this.store.videoStatus(ownerId),
      this.store.recentVideos(ownerId, 10),
      this.store.popularVideos(today, ownerId, 10),
      this.store.dailyViews(week, ownerId),
      this.store.popularBrowsers(today, ownerId, 0, 10),
      this.store.popularCountries(today, ownerId, 0, 10),
      this.store.popularAsns(today, ownerId, 0, 10),
      access.isAdmin ? this.store.serverUsage() : Promise.resolve([])
    ])
    return Object.freeze({
      status,
      recentVideos: Object.freeze(recent.map((row) => this.video(row))),
      popularVideos: Object.freeze(popular.map((row) => this.video(row))),
      views: bucketViews(views, timezone),
      browsers: Object.freeze(browsers.data.map(parseBrowser)),
      countries: countries.data,
      asns: asns.data,
      serverUsage: Object.freeze(serverUsage)
    })
  }

  public async videosStatus(input: Record<string, unknown>, access: DashboardAccess): Promise<DashboardVideoStatus> {
    return await this.store.videoStatus(ownerId(input, access))
  }

  public async serversStatus(access: DashboardAccess): Promise<readonly DashboardServerUsage[] | null> {
    return access.isAdmin ? await this.store.serverUsage() : null
  }

  public async views(input: Record<string, unknown>, access: DashboardAccess): Promise<readonly (readonly [number, number])[]> {
    const timezone = validTimezone(stringValue(input.timezone) || this.timezone)
    const range = dashboardRange(stringValue(input.filter), this.now(), timezone)
    const rows = bucketViews(await this.store.dailyViews(range, ownerId(input, access)), timezone)
    return Object.freeze(rows.map((row) => Object.freeze([row.timestamp, row.value] as const)))
  }

  public async recentVideos(input: Record<string, unknown>, access: DashboardAccess): Promise<DashboardDataTables<DashboardVideo>> {
    const data = (await this.store.recentVideos(ownerId(input, access), 10)).map((row) => this.video(row))
    return dataTables(input.draw, data, data.length)
  }

  public async popularVideos(input: Record<string, unknown>, access: DashboardAccess): Promise<DashboardDataTables<DashboardVideo>> {
    const timezone = validTimezone(stringValue(input.timezone) || this.timezone)
    const data = (await this.store.popularVideos(dashboardRange(stringValue(input.filter), this.now(), timezone), ownerId(input, access), 10)).map((row) => this.video(row))
    return dataTables(input.draw, data, data.length)
  }

  public async popularBrowsers(input: Record<string, unknown>, access: DashboardAccess): Promise<DashboardDataTables<DashboardBrowser>> {
    const aggregate = await this.aggregate(input, access, (range, owner, start) => this.store.popularBrowsers(range, owner, start, 10))
    return dataTables(input.draw, aggregate.data.map(parseBrowser), aggregate.total)
  }

  public async popularCountries(input: Record<string, unknown>, access: DashboardAccess): Promise<DashboardDataTables<DashboardNamedAggregate>> {
    const aggregate = await this.aggregate(input, access, (range, owner, start) => this.store.popularCountries(range, owner, start, 10))
    return dataTables(input.draw, aggregate.data, aggregate.total)
  }

  public async popularAsns(input: Record<string, unknown>, access: DashboardAccess): Promise<DashboardDataTables<DashboardNamedAggregate>> {
    const aggregate = await this.aggregate(input, access, (range, owner, start) => this.store.popularAsns(range, owner, start, 10))
    return dataTables(input.draw, aggregate.data, aggregate.total)
  }

  private async aggregate<T>(
    input: Record<string, unknown>,
    access: DashboardAccess,
    load: (range: DashboardRange, ownerId: number | null, start: number) => Promise<DashboardAggregatePage<T>>
  ): Promise<DashboardAggregatePage<T>> {
    const timezone = validTimezone(stringValue(input.timezone) || this.timezone)
    return await load(
      dashboardRange(stringValue(input.filter), this.now(), timezone),
      ownerId(input, access),
      boundedInteger(input.start, 0, 0, 1_000_000)
    )
  }

  private video(row: DashboardVideoRow): DashboardVideo {
    const embed = new URL(`/${this.slugs.embed}/${encodeURIComponent(row.slug)}`, this.baseUrl).toString()
    const download = new URL(`/${this.slugs.download}/${encodeURIComponent(row.slug)}`, this.baseUrl).toString()
    return Object.freeze({
      id: row.id,
      title: row.title,
      host: row.host,
      host_id: row.hostId,
      slug: row.slug,
      name: row.name,
      created: row.created,
      views: row.views,
      has_alt: row.hasAlt,
      has_sub: row.hasSub,
      link: new Hosting().setHost(row.host).setID(row.hostId).getDownloadLink(),
      actions: Object.freeze({
        embed,
        download,
        embed_code: `<iframe src="${escapeAttribute(embed)}" title="${escapeAttribute(row.title)}" allowfullscreen></iframe>`
      })
    })
  }
}

export function dashboardRange(filter: unknown, nowSeconds: number, timezone: string): DashboardRange {
  const zone = validTimezone(timezone)
  const now = Number.isSafeInteger(nowSeconds) && nowSeconds > 0 ? nowSeconds : Math.floor(Date.now() / 1_000)
  const today = calendarAt(now, zone)
  const todayStart = zonedMidnight(today.year, today.month, today.day, zone)
  const normalized = stringValue(filter) || 'today'
  const custom = /^(\d{4})-(\d{2})-(\d{2})\s+-\s+(\d{4})-(\d{2})-(\d{2})$/.exec(normalized)
  if (custom !== null) {
    const start = safeMidnight(custom[1], custom[2], custom[3], zone)
    const endStart = safeMidnight(custom[4], custom[5], custom[6], zone)
    if (start !== null && endStart !== null && endStart >= start && endStart - start <= 31_622_400) {
      return Object.freeze({ start, end: addCalendarDays(endStart, 1, zone) - 1 })
    }
  }
  const day = (offset: number) => calendarShift(today, { days: offset })
  const month = (offset: number) => calendarShift({ ...today, day: 1 }, { months: offset })
  const year = (offset: number) => ({ year: today.year + offset, month: 1, day: 1 })
  const start = (date: CalendarDate) => zonedMidnight(date.year, date.month, date.day, zone)
  if (normalized === 'yesterday') return Object.freeze({ start: start(day(-1)), end: todayStart - 1 })
  if (normalized === 'this_month') return Object.freeze({ start: start(month(0)), end: now })
  if (normalized === 'this_year') return Object.freeze({ start: start(year(0)), end: now })
  if (normalized === 'last_month') return Object.freeze({ start: start(month(-1)), end: start(month(0)) - 1 })
  if (normalized === '7_days') return Object.freeze({ start: start(day(-7)), end: now })
  if (normalized === '30_days') return Object.freeze({ start: start(day(-30)), end: now })
  if (normalized === '60_days') return Object.freeze({ start: start(day(-60)), end: now })
  if (normalized === '3_months') return Object.freeze({ start: start(month(-3)), end: now })
  if (normalized === '6_months') return Object.freeze({ start: start(month(-6)), end: now })
  if (normalized === 'last_year') return Object.freeze({ start: start(year(-1)), end: start(year(0)) - 1 })
  if (normalized === 'last_weekend') {
    const utc = new Date(Date.UTC(today.year, today.month - 1, today.day))
    const weekday = utc.getUTCDay()
    const sinceSaturday = ((weekday - 6 + 7) % 7) || 7
    const saturday = start(day(-sinceSaturday))
    return Object.freeze({ start: saturday, end: addCalendarDays(saturday, 2, zone) - 1 })
  }
  return Object.freeze({ start: todayStart, end: now })
}

type CalendarDate = Readonly<{ year: number; month: number; day: number }>

function ownerId(input: Record<string, unknown>, access: DashboardAccess): number | null {
  if (!access.isAdmin) return access.userId
  const value = boundedInteger(input.uid, 0, 0, 4_294_967_295)
  return value > 0 ? value : null
}

function dataTables<T>(draw: unknown, data: readonly T[], total: number): DashboardDataTables<T> {
  return Object.freeze({
    draw: boundedInteger(draw, 0, 0, Number.MAX_SAFE_INTEGER),
    data: Object.freeze([...data]),
    recordsTotal: Math.max(0, total),
    recordsFiltered: Math.max(0, total)
  })
}

function parseBrowser(row: DashboardBrowserRow): DashboardBrowser {
  const ua = row.uaName
  const browser = firstMatch(ua, [
    [/Edg\/([\d.]+)/, 'Edge'], [/OPR\/([\d.]+)/, 'Opera'], [/Chrome\/([\d.]+)/, 'Chrome'],
    [/Firefox\/([\d.]+)/, 'Firefox'], [/Version\/([\d.]+).*Safari\//, 'Safari']
  ])
  const os = /Windows NT 10/.test(ua) ? 'Windows 10' : /Windows/.test(ua) ? 'Windows' : /Android ([\d.]+)/.test(ua) ? `Android ${RegExp.$1}` : /(?:iPhone|CPU) OS ([\d_]+)/.test(ua) ? `iOS ${RegExp.$1.replaceAll('_', '.')}` : /Mac OS X ([\d_]+)/.test(ua) ? `Mac OS X ${RegExp.$1.replaceAll('_', '.')}` : /Linux/.test(ua) ? 'Linux' : 'Other'
  const device = /iPad|Tablet/i.test(ua) ? 'Tablet' : /Mobile|iPhone|Android/i.test(ua) ? 'Mobile' : 'Desktop'
  return Object.freeze({ ua_name: ua, views: row.views, name: browser, device, os })
}

function firstMatch(value: string, patterns: readonly (readonly [RegExp, string])[]): string {
  for (const [pattern, name] of patterns) {
    const match = pattern.exec(value)
    if (match !== null) return `${name} ${match[1] ?? ''}`.trim()
  }
  return 'Other'
}

function validTimezone(value: string): string {
  const normalized = value.trim().slice(0, 100)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized || 'UTC' }).format(0)
    return normalized || 'UTC'
  } catch {
    return 'UTC'
  }
}

function calendarAt(epochSeconds: number, timezone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(epochSeconds * 1_000)
  const number = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  return Object.freeze({ year: number('year'), month: number('month'), day: number('day') })
}

function zonedMidnight(year: number, month: number, day: number, timezone: string): number {
  const desired = Date.UTC(year, month - 1, day)
  let guess = desired
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  for (let index = 0; index < 3; index += 1) {
    const parts = formatter.formatToParts(guess)
    const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0)
    const represented = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'))
    guess += desired - represented
  }
  return Math.floor(guess / 1_000)
}

function calendarShift(date: CalendarDate, offset: Readonly<{ days?: number; months?: number }>): CalendarDate {
  const value = new Date(Date.UTC(date.year, date.month - 1 + (offset.months ?? 0), date.day + (offset.days ?? 0)))
  return Object.freeze({ year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() })
}

function safeMidnight(year: string | undefined, month: string | undefined, day: string | undefined, timezone: string): number | null {
  const values = [year, month, day].map((value) => Number(value))
  const [y = 0, m = 0, d = 0] = values
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) return null
  return zonedMidnight(y, m, d, timezone)
}

function addCalendarDays(epochSeconds: number, days: number, timezone: string): number {
  const date = calendarAt(epochSeconds, timezone)
  const next = calendarShift(date, { days })
  return zonedMidnight(next.year, next.month, next.day, timezone)
}

function bucketViews(rows: readonly DashboardDailyView[], timezone: string): readonly DashboardDailyView[] {
  const buckets = new Map<number, number>()
  for (const row of rows) {
    const date = calendarAt(row.timestamp, timezone)
    const timestamp = zonedMidnight(date.year, date.month, date.day, timezone)
    buckets.set(timestamp, (buckets.get(timestamp) ?? 0) + row.value)
  }
  return Object.freeze([...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([timestamp, value]) => Object.freeze({ timestamp, value })))
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(stringValue(value), 10)
  return Number.isSafeInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback
}

function stringValue(value: unknown): string { return typeof value === 'string' ? value.trim().slice(0, 100) : typeof value === 'number' ? String(value) : '' }
function escapeAttribute(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') }
