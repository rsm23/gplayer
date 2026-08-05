import type { RowDataPacket } from 'mysql2/promise'
import type { Database } from '../database/database.js'
import type {
  DashboardAdminStore,
  DashboardAggregatePage,
  DashboardBrowserRow,
  DashboardDailyView,
  DashboardNamedAggregate,
  DashboardRange,
  DashboardServerUsage,
  DashboardVideoRow,
  DashboardVideoStatus
} from './dashboard-admin-service.js'

type CountRow = RowDataPacket & { total: string | number }
type StatusRow = RowDataPacket & { good: string | number; broken: string | number; warning: string | number; total: string | number }
type VideoRow = RowDataPacket & {
  id: string | number
  title: string | null
  host: string | null
  host_id: string | null
  slug: string | null
  name: string | null
  created: string | number
  views: string | number
  has_alt: string | number
  has_sub: string | number
}
type DailyRow = RowDataPacket & { timestamp: string | number; value: string | number }
type BrowserRow = RowDataPacket & { ua_name: string | null; views: string | number }
type AggregateRow = RowDataPacket & { id?: string | number | null; name: string | null; views: string | number }
type ServerRow = RowDataPacket & { name: string | null; sources: string | number }

const VIDEO_COLUMNS = `v.\`id\`, v.\`title\`, v.\`host\`, v.\`host_id\`, v.\`slug\`, u.\`name\`, v.\`created\`,
       EXISTS(SELECT 1 FROM \`tb_videos_alternatives\` a WHERE a.\`vid\` = v.\`id\`) AS \`has_alt\`,
       EXISTS(SELECT 1 FROM \`tb_subtitles\` sub WHERE sub.\`vid\` = v.\`id\`) AS \`has_sub\``

export class MySqlDashboardAdminStore implements DashboardAdminStore {
  public constructor(private readonly database: Database) {}

  public async videoStatus(ownerId: number | null): Promise<DashboardVideoStatus> {
    const scope = ownerId === null ? '' : ' WHERE `uid` = ?'
    const values = ownerId === null ? [] : [ownerId]
    const [rows, serverRows, driveRows] = await Promise.all([
      this.database.read<StatusRow[]>(
        `SELECT COUNT(CASE WHEN \`status\` = 0 THEN 1 END) AS \`good\`,
                COUNT(CASE WHEN \`status\` = 1 THEN 1 END) AS \`broken\`,
                COUNT(CASE WHEN \`status\` = 2 THEN 1 END) AS \`warning\`,
                COUNT(*) AS \`total\`
           FROM \`tb_videos\`${scope}`,
        values
      ),
      this.database.read<CountRow[]>('SELECT COUNT(*) AS `total` FROM `tb_loadbalancers`'),
      this.database.read<CountRow[]>('SELECT COUNT(*) AS `total` FROM `tb_gdrive_auth`')
    ])
    const row = rows[0]
    return Object.freeze({
      good: count(row?.good),
      broken: count(row?.broken),
      warning: count(row?.warning),
      total_videos: count(row?.total),
      total_servers: count(serverRows[0]?.total),
      total_gdrives: count(driveRows[0]?.total)
    })
  }

  public async recentVideos(ownerId: number | null, limit: number): Promise<readonly DashboardVideoRow[]> {
    const scope = ownerId === null ? '' : ' WHERE v.`uid` = ?'
    const rows = await this.database.read<VideoRow[]>(
      `SELECT ${VIDEO_COLUMNS}, v.\`views\`
         FROM \`tb_videos\` v
         JOIN \`tb_users\` u ON u.\`id\` = v.\`uid\`${scope}
        ORDER BY v.\`created\` DESC
        LIMIT ?`,
      ownerId === null ? [limit] : [ownerId, limit]
    )
    return Object.freeze(rows.map(videoRow))
  }

  public async popularVideos(range: DashboardRange, ownerId: number | null, limit: number): Promise<readonly DashboardVideoRow[]> {
    const owner = ownerId === null ? '' : ' AND v.`uid` = ?'
    const values = ownerId === null ? [range.start, range.end, limit] : [range.start, range.end, ownerId, limit]
    const rows = await this.database.read<VideoRow[]>(
      `SELECT ${VIDEO_COLUMNS}, COUNT(*) AS \`views\`
         FROM \`tb_stats\` s
         JOIN \`tb_videos\` v ON v.\`id\` = s.\`vid\`
         JOIN \`tb_users\` u ON u.\`id\` = v.\`uid\`
        WHERE s.\`created\` BETWEEN ? AND ?${owner}
        GROUP BY v.\`id\`, v.\`title\`, v.\`host\`, v.\`host_id\`, v.\`slug\`, u.\`name\`, v.\`created\`
        ORDER BY \`views\` DESC
        LIMIT ?`,
      values
    )
    return Object.freeze(rows.map(videoRow))
  }

  public async dailyViews(range: DashboardRange, ownerId: number | null): Promise<readonly DashboardDailyView[]> {
    const join = ownerId === null ? '' : ' JOIN `tb_videos` v ON v.`id` = s.`vid`'
    const owner = ownerId === null ? '' : ' AND v.`uid` = ?'
    const values = ownerId === null ? [range.start, range.end] : [range.start, range.end, ownerId]
    const rows = await this.database.read<DailyRow[]>(
      `SELECT s.\`created\` AS \`timestamp\`, COUNT(*) AS \`value\`
         FROM \`tb_stats\` s${join}
        WHERE s.\`created\` BETWEEN ? AND ?${owner}
        GROUP BY s.\`created\`
        ORDER BY s.\`created\` ASC`,
      values
    )
    return Object.freeze(rows.map((row) => Object.freeze({ timestamp: count(row.timestamp), value: count(row.value) })))
  }

  public async popularBrowsers(range: DashboardRange, ownerId: number | null, start: number, limit: number): Promise<DashboardAggregatePage<DashboardBrowserRow>> {
    const scope = statScope(range, ownerId)
    const [rows, total] = await Promise.all([
      this.database.read<BrowserRow[]>(
        `SELECT ua.\`ua\` AS \`ua_name\`, COUNT(*) AS \`views\`
           FROM \`tb_stats\` s
           JOIN \`tb_stats_ua\` ua ON ua.\`id\` = s.\`ua\`${scope.join}
          WHERE ${scope.where}
          GROUP BY s.\`ua\`, ua.\`ua\`
          ORDER BY \`views\` DESC
          LIMIT ? OFFSET ?`,
        [...scope.values, limit, start]
      ),
      groupedTotal(this.database, 's.`ua`', scope)
    ])
    return Object.freeze({ data: Object.freeze(rows.map((row) => Object.freeze({ uaName: String(row.ua_name ?? ''), views: count(row.views) }))), total })
  }

  public async popularCountries(range: DashboardRange, ownerId: number | null, start: number, limit: number): Promise<DashboardAggregatePage<DashboardNamedAggregate>> {
    return await this.namedAggregate('s.`country`', 's.`country`', '', range, ownerId, start, limit)
  }

  public async popularAsns(range: DashboardRange, ownerId: number | null, start: number, limit: number): Promise<DashboardAggregatePage<DashboardNamedAggregate>> {
    return await this.namedAggregate('s.`asn`', 'a.`name`', ' LEFT JOIN `tb_maxmind_asn` a ON a.`id` = s.`asn`', range, ownerId, start, limit, true)
  }

  public async serverUsage(): Promise<readonly DashboardServerUsage[]> {
    const rows = await this.database.read<ServerRow[]>(
      `SELECT 'Main Server' AS \`name\`, COUNT(s.\`id\`) AS \`sources\`, 0 AS \`sort_order\`
         FROM \`tb_videos_sources\` s
        WHERE s.\`sid\` = 0 OR s.\`sid\` IS NULL
        UNION ALL
       SELECT lb.\`name\`, COUNT(s.\`id\`) AS \`sources\`, lb.\`id\` AS \`sort_order\`
         FROM \`tb_loadbalancers\` lb
         LEFT JOIN \`tb_videos_sources\` s ON s.\`sid\` = lb.\`id\`
        WHERE lb.\`status\` = 1
        GROUP BY lb.\`id\`, lb.\`name\`
        ORDER BY \`sort_order\` ASC`
    )
    return Object.freeze(rows.map((row) => Object.freeze({ name: String(row.name ?? 'Unknown server'), sources: count(row.sources) })))
  }

  private async namedAggregate(
    key: string,
    name: string,
    extraJoin: string,
    range: DashboardRange,
    ownerId: number | null,
    start: number,
    limit: number,
    includeId = false
  ): Promise<DashboardAggregatePage<DashboardNamedAggregate>> {
    const scope = statScope(range, ownerId)
    const [rows, total] = await Promise.all([
      this.database.read<AggregateRow[]>(
        `SELECT ${includeId ? `${key} AS \`id\`, ` : ''}${name} AS \`name\`, COUNT(*) AS \`views\`
           FROM \`tb_stats\` s${extraJoin}${scope.join}
          WHERE ${scope.where}
          GROUP BY ${key}, ${name}
          ORDER BY \`views\` DESC
          LIMIT ? OFFSET ?`,
        [...scope.values, limit, start]
      ),
      groupedTotal(this.database, key, scope)
    ])
    return Object.freeze({
      data: Object.freeze(rows.map((row) => {
        const id = row.id === undefined || row.id === null ? undefined : count(row.id)
        return Object.freeze({ ...(id === undefined ? {} : { id }), name: String(row.name ?? 'Unknown'), views: count(row.views) })
      })),
      total
    })
  }
}

type StatScope = Readonly<{ join: string; where: string; values: readonly number[] }>

function statScope(range: DashboardRange, ownerId: number | null): StatScope {
  return Object.freeze({
    join: ownerId === null ? '' : ' JOIN `tb_videos` v ON v.`id` = s.`vid`',
    where: `s.\`created\` BETWEEN ? AND ?${ownerId === null ? '' : ' AND v.`uid` = ?'}`,
    values: Object.freeze(ownerId === null ? [range.start, range.end] : [range.start, range.end, ownerId])
  })
}

async function groupedTotal(database: Database, key: string, scope: StatScope): Promise<number> {
  const rows = await database.read<CountRow[]>(
    `SELECT COUNT(*) AS \`total\`
       FROM (SELECT ${key} FROM \`tb_stats\` s${scope.join} WHERE ${scope.where} GROUP BY ${key}) dashboard_groups`,
    scope.values
  )
  return count(rows[0]?.total)
}

function videoRow(row: VideoRow): DashboardVideoRow {
  return Object.freeze({
    id: String(row.id),
    title: String(row.title ?? ''),
    host: String(row.host ?? ''),
    hostId: String(row.host_id ?? ''),
    slug: String(row.slug ?? row.id),
    name: String(row.name ?? ''),
    created: count(row.created),
    views: count(row.views),
    hasAlt: count(row.has_alt) > 0,
    hasSub: count(row.has_sub) > 0
  })
}

function count(value: string | number | undefined | null): number {
  const parsed = Number(value ?? 0)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}
