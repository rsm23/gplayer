import type { RowDataPacket } from 'mysql2/promise'
import type { Database } from '../database/database.js'
import type { AdminSession, SessionAdminStore, SessionListQuery, SessionListResult } from './session-admin-service.js'

type SessionRow = RowDataPacket & Readonly<{
  id: number | string
  username: string
  ip: string
  useragent: string
  created: number | string
  expires: number | string
}>

type CountRow = RowDataPacket & Readonly<{ total: number | string }>

const ORDER_COLUMNS = Object.freeze({
  id: '`id`',
  username: '`username`',
  ip: '`ip`',
  useragent: '`useragent`',
  created: '`created`',
  expires: '`expires`'
})

export class MySqlSessionAdminStore implements SessionAdminStore {
  public constructor(private readonly database: Pick<Database, 'read' | 'write'>) {}

  public async listSessions(query: SessionListQuery): Promise<SessionListResult> {
    const search = query.search === '' ? undefined : `%${query.search}%`
    const where = search === undefined ? '' : ' WHERE `ip` LIKE ? OR `useragent` LIKE ? OR `username` LIKE ?'
    const searchValues = search === undefined ? [] : [search, search, search]
    const orderBy = ORDER_COLUMNS[query.orderBy]
    const orderDir = query.orderDir === 'asc' ? 'ASC' : 'DESC'

    const [rows, totalRows, filteredRows] = await Promise.all([
      this.database.read<SessionRow[]>(
        `SELECT \`id\`, \`username\`, \`ip\`, \`useragent\`, \`created\`, \`expires\` FROM \`tb_sessions\`${where} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`,
        [...searchValues, query.length, query.start]
      ),
      this.database.read<CountRow[]>('SELECT COUNT(*) AS `total` FROM `tb_sessions`'),
      search === undefined
        ? Promise.resolve<CountRow[]>([])
        : this.database.read<CountRow[]>(`SELECT COUNT(*) AS \`total\` FROM \`tb_sessions\`${where}`, searchValues)
    ])

    const recordsTotal = countValue(totalRows[0]?.total)
    return Object.freeze({
      data: Object.freeze(rows.map(sessionRow)),
      recordsTotal,
      recordsFiltered: search === undefined ? recordsTotal : countValue(filteredRows[0]?.total)
    })
  }

  public async deleteSession(id: string): Promise<boolean> {
    const result = await this.database.write<{ affectedRows?: number }>('DELETE FROM `tb_sessions` WHERE `id` = ?', [id])
    return (result.affectedRows ?? 0) > 0
  }
}

function sessionRow(row: SessionRow): AdminSession {
  return Object.freeze({
    id: String(row.id),
    username: String(row.username),
    ip: String(row.ip),
    useragent: String(row.useragent),
    created: finiteInteger(row.created),
    expires: finiteInteger(row.expires)
  })
}

function countValue(value: number | string | undefined): number {
  return Math.max(0, finiteInteger(value ?? 0))
}

function finiteInteger(value: number | string): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : 0
}
