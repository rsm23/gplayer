import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Database } from '../database/database.js'
import type { LoadBalancerAdminRecord, LoadBalancerAdminStore, LoadBalancerListQuery, LoadBalancerListResult, LoadBalancerWrite } from './load-balancer-admin-service.js'
import type { LoadBalancerSelectionQuery, LoadBalancerSelectionStore } from './load-balancer-selector.js'

type LoadBalancerRow = RowDataPacket & Readonly<{
  id: number | string
  name: string
  link: string
  connections: number | string | null
  playbacks: number | string | null
  status: number | string
  public: number | string
  created: number | string
  updated: number | string
  disallow_hosts: string
  disallow_continent: string
}>
type CountRow = RowDataPacket & Readonly<{ total: number | string }>
type InsertResult = Readonly<{ insertId?: number | string }>

const ORDER_COLUMNS = Object.freeze({
  name: '`name`', link: '`link`', connections: '`connections`', playbacks: '`playbacks`', status: '`status`',
  created: '`created`', updated: '`updated`', public: '`public`', id: '`id`'
})
const SELECT_COLUMNS = '`id`, `name`, `link`, `connections`, `playbacks`, `status`, `public`, `created`, `updated`, `disallow_hosts`, `disallow_continent`'

export class MySqlLoadBalancerAdminStore implements LoadBalancerAdminStore, LoadBalancerSelectionStore {
  public constructor(private readonly database: Pick<Database, 'read' | 'write'>) {}

  public async listLoadBalancers(query: LoadBalancerListQuery): Promise<LoadBalancerListResult> {
    const search = query.search === '' ? undefined : `%${query.search}%`
    const where = search === undefined ? '' : ' WHERE `name` LIKE ? OR `link` LIKE ?'
    const values = search === undefined ? [] : [search, search]
    const orderBy = ORDER_COLUMNS[query.orderBy]
    const orderDir = query.orderDir === 'asc' ? 'ASC' : 'DESC'
    const [rows, totalRows, filteredRows] = await Promise.all([
      this.database.read<LoadBalancerRow[]>(`SELECT ${SELECT_COLUMNS} FROM \`vw_loadbalancers\`${where} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`, [...values, query.length, query.start]),
      this.database.read<CountRow[]>('SELECT COUNT(*) AS `total` FROM `vw_loadbalancers`'),
      search === undefined ? Promise.resolve<CountRow[]>([]) : this.database.read<CountRow[]>(`SELECT COUNT(*) AS \`total\` FROM \`vw_loadbalancers\`${where}`, values)
    ])
    const recordsTotal = countValue(totalRows[0]?.total)
    return Object.freeze({ data: Object.freeze(rows.map(loadBalancerRow)), recordsTotal, recordsFiltered: search === undefined ? recordsTotal : countValue(filteredRows[0]?.total) })
  }

  public async getLoadBalancer(id: string): Promise<LoadBalancerAdminRecord | null> {
    const rows = await this.database.read<LoadBalancerRow[]>(`SELECT ${SELECT_COLUMNS} FROM \`vw_loadbalancers\` WHERE \`id\` = ? LIMIT 1`, [id])
    return rows[0] === undefined ? null : loadBalancerRow(rows[0])
  }

  public async linkExists(link: string, excludeId?: string): Promise<boolean> {
    const rows = await this.database.read<CountRow[]>(`SELECT COUNT(*) AS \`total\` FROM \`tb_loadbalancers\` WHERE \`link\` = ?${excludeId === undefined ? '' : ' AND `id` <> ?'}`, excludeId === undefined ? [link] : [link, excludeId])
    return countValue(rows[0]?.total) > 0
  }

  public async createLoadBalancer(value: LoadBalancerWrite): Promise<string | null> {
    const result = await this.database.write<InsertResult>('INSERT INTO `tb_loadbalancers` (`name`, `link`, `status`, `public`, `created`, `updated`, `disallow_hosts`, `disallow_continent`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', writeValues(value))
    return result.insertId === undefined || String(result.insertId) === '0' ? null : String(result.insertId)
  }

  public async updateLoadBalancer(id: string, value: LoadBalancerWrite): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>('UPDATE `tb_loadbalancers` SET `name` = ?, `link` = ?, `status` = ?, `public` = ?, `created` = ?, `updated` = ?, `disallow_hosts` = ?, `disallow_continent` = ? WHERE `id` = ?', [...writeValues(value), id])
    return result.affectedRows > 0
  }

  public async deleteLoadBalancer(id: string): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>('DELETE FROM `tb_loadbalancers` WHERE `id` = ?', [id])
    return result.affectedRows > 0
  }

  public async updateStatus(id: string, status: number, updated: number): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>('UPDATE `tb_loadbalancers` SET `status` = ?, `updated` = ? WHERE `id` = ?', [status, updated, id])
    return result.affectedRows > 0
  }

  public async selectLoadBalancer(query: LoadBalancerSelectionQuery): Promise<string | null> {
    const orderBy = query.metric === 'connections' ? '`connections`' : '`playbacks`'
    const exclude = query.excludeUrl === undefined ? '' : ' AND `link` <> ?'
    const values = query.excludeUrl === undefined
      ? [query.host, query.continent]
      : [query.host, query.continent, query.excludeUrl]
    const rows = await this.database.read<LoadBalancerRow[]>(
      `SELECT ${SELECT_COLUMNS} FROM \`vw_loadbalancers\` WHERE \`status\` = 1` +
      " AND JSON_CONTAINS(IF(JSON_VALID(`disallow_hosts`), `disallow_hosts`, '[]'), JSON_QUOTE(?)) = 0" +
      " AND JSON_CONTAINS(IF(JSON_VALID(`disallow_continent`), `disallow_continent`, '[]'), JSON_QUOTE(?)) = 0" +
      `${exclude} ORDER BY ${orderBy} ASC, \`id\` ASC LIMIT 1`,
      values
    )
    const selected = rows[0]?.link
    return typeof selected === 'string' && selected.trim() !== '' ? selected : null
  }
}

function writeValues(value: LoadBalancerWrite): readonly (string | number)[] {
  return [value.name, value.link, value.status, value.public, value.created, value.updated, JSON.stringify(value.disallowHosts), JSON.stringify(value.disallowContinents)]
}

function loadBalancerRow(row: LoadBalancerRow): LoadBalancerAdminRecord {
  return Object.freeze({
    id: String(row.id), name: String(row.name), link: String(row.link), connections: integerValue(row.connections), playbacks: integerValue(row.playbacks),
    status: flagValue(row.status), public: flagValue(row.public), created: integerValue(row.created), updated: integerValue(row.updated),
    disallowHosts: jsonStringArray(row.disallow_hosts), disallowContinents: jsonStringArray(row.disallow_continent)
  })
}

function jsonStringArray(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Object.freeze(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
  } catch { return Object.freeze([]) }
}
function countValue(value: number | string | undefined): number { return Math.max(0, integerValue(value ?? 0)) }
function integerValue(value: number | string | null): number { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0 }
function flagValue(value: number | string): number { return Number(value) === 1 ? 1 : 0 }
