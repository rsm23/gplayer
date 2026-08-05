import type { RowDataPacket } from 'mysql2/promise'
import type { Database } from '../database/database.js'
import type { AdminUserRecord, UserAdminStore, UserConflict, UserListQuery, UserListResult, UserWrite } from './user-admin-service.js'

type UserAdminRow = RowDataPacket & Readonly<{
  id: number | string
  name: string
  user: string
  email: string
  status: number | string
  created: number | string
  updated: number | string
  role: number | string
  videos?: number | string
}>

type CountRow = RowDataPacket & Readonly<{ total: number | string }>
type InsertResult = Readonly<{ insertId?: number | string }>

const ORDER_COLUMNS = Object.freeze({
  name: '`name`',
  user: '`user`',
  email: '`email`',
  status: '`status`',
  created: '`created`',
  updated: '`updated`',
  role: '`role`',
  videos: '`videos`',
  id: '`id`'
})

export class MySqlUserAdminStore implements UserAdminStore {
  public constructor(private readonly database: Pick<Database, 'read' | 'write'>) {}

  public async listUsers(query: UserListQuery): Promise<UserListResult> {
    const search = query.search === '' ? undefined : `${query.search}%`
    const where = search === undefined ? '' : ' WHERE `email` LIKE ? OR `user` LIKE ? OR `name` LIKE ?'
    const searchValues = search === undefined ? [] : [search, search, search]
    const orderBy = ORDER_COLUMNS[query.orderBy]
    const orderDir = query.orderDir === 'asc' ? 'ASC' : 'DESC'

    const [rows, totalRows, filteredRows] = await Promise.all([
      this.database.read<UserAdminRow[]>(
        `SELECT \`id\`, \`name\`, \`user\`, \`email\`, \`status\`, \`created\`, \`updated\`, \`role\`, \`videos\` FROM \`vw_users\`${where} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`,
        [...searchValues, query.length, query.start]
      ),
      this.database.read<CountRow[]>('SELECT COUNT(*) AS `total` FROM `vw_users`'),
      search === undefined
        ? Promise.resolve<CountRow[]>([])
        : this.database.read<CountRow[]>(`SELECT COUNT(*) AS \`total\` FROM \`vw_users\`${where}`, searchValues)
    ])
    const recordsTotal = countValue(totalRows[0]?.total)
    return Object.freeze({
      data: Object.freeze(rows.map(userRow)),
      recordsTotal,
      recordsFiltered: search === undefined ? recordsTotal : countValue(filteredRows[0]?.total)
    })
  }

  public async getUser(id: string): Promise<AdminUserRecord | null> {
    const rows = await this.database.read<UserAdminRow[]>(
      'SELECT `id`, `name`, `user`, `email`, `status`, `created`, `updated`, `role`, `videos` FROM `vw_users` WHERE `id` = ? LIMIT 1',
      [id]
    )
    return rows[0] === undefined ? null : userRow(rows[0])
  }

  public async findConflict(username: string, email: string, excludeId?: string): Promise<UserConflict> {
    const rows = await this.database.read<UserAdminRow[]>(
      `SELECT \`id\`, \`user\`, \`email\` FROM \`tb_users\` WHERE (\`user\` = ? OR \`email\` = ?)${excludeId === undefined ? '' : ' AND `id` <> ?'} LIMIT 2`,
      excludeId === undefined ? [username, email] : [username, email, excludeId]
    )
    return Object.freeze({
      username: rows.some((row) => String(row.user).toLowerCase() === username.toLowerCase()),
      email: rows.some((row) => String(row.email).toLowerCase() === email.toLowerCase())
    })
  }

  public async createUser(user: UserWrite & Readonly<{ passwordHash: string }>): Promise<string | null> {
    const result = await this.database.write<InsertResult>(
      'INSERT INTO `tb_users` (`name`, `user`, `email`, `password`, `role`, `status`, `created`, `updated`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [user.name, user.username, user.email, user.passwordHash, user.role, user.status, user.created, user.updated]
    )
    return result.insertId === undefined || String(result.insertId) === '0' ? null : String(result.insertId)
  }

  public async updateUser(id: string, user: UserWrite): Promise<boolean> {
    const withPassword = user.passwordHash !== undefined
    const result = await this.database.write<{ affectedRows?: number }>(
      withPassword
        ? 'UPDATE `tb_users` SET `name` = ?, `user` = ?, `email` = ?, `password` = ?, `role` = ?, `status` = ?, `updated` = ? WHERE `id` = ?'
        : 'UPDATE `tb_users` SET `name` = ?, `user` = ?, `email` = ?, `role` = ?, `status` = ?, `updated` = ? WHERE `id` = ?',
      withPassword
        ? [user.name, user.username, user.email, user.passwordHash ?? '', user.role, user.status, user.updated, id]
        : [user.name, user.username, user.email, user.role, user.status, user.updated, id]
    )
    return (result.affectedRows ?? 0) > 0
  }

  public async deleteUser(id: string): Promise<boolean> {
    const result = await this.database.write<{ affectedRows?: number }>('DELETE FROM `tb_users` WHERE `id` = ?', [id])
    return (result.affectedRows ?? 0) > 0
  }

  public async updateEmail(id: string, email: string, updated: number): Promise<boolean> {
    const result = await this.database.write<{ affectedRows?: number }>(
      'UPDATE `tb_users` SET `email` = ?, `updated` = ? WHERE `id` = ?',
      [email, updated, id]
    )
    return (result.affectedRows ?? 0) > 0
  }

  public async updateUsername(id: string, username: string, updated: number): Promise<boolean> {
    const result = await this.database.write<{ affectedRows?: number }>(
      'UPDATE `tb_users` SET `user` = ?, `updated` = ? WHERE `id` = ?',
      [username, updated, id]
    )
    return (result.affectedRows ?? 0) > 0
  }
}

function userRow(row: UserAdminRow): AdminUserRecord {
  return Object.freeze({
    id: String(row.id),
    name: String(row.name),
    username: String(row.user),
    email: String(row.email),
    status: finiteInteger(row.status),
    created: finiteInteger(row.created),
    updated: finiteInteger(row.updated),
    role: finiteInteger(row.role),
    videos: finiteInteger(row.videos ?? 0)
  })
}

function countValue(value: number | string | undefined): number {
  return Math.max(0, finiteInteger(value ?? 0))
}

function finiteInteger(value: number | string): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : 0
}
