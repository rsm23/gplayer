import type { RowDataPacket } from 'mysql2/promise'
import type { Database } from '../database/database.js'
import type { AuthStore, AuthUser, SessionWrite, StoredAuthUser } from './auth-service.js'

type UserRow = RowDataPacket & Readonly<{
  id: number | string
  user: string
  email: string
  password: string
  name: string
  role: number | string
  status: number | string
  created: number | string
  updated: number | string
}>

export class MySqlAuthStore implements AuthStore {
  public constructor(private readonly database: Pick<Database, 'read' | 'write'>) {}

  public async findUserByIdentifier(identifier: string): Promise<StoredAuthUser | null> {
    const rows = await this.database.read<UserRow[]>(
      'SELECT `id`, `user`, `email`, `password`, `name`, `role`, `status`, `created`, `updated` FROM `tb_users` WHERE `user` = ? OR `email` = ? LIMIT 1',
      [identifier, identifier]
    )
    return rows[0] === undefined ? null : storedUser(rows[0])
  }

  public async findActiveSession(token: string, userAgent: string, now: number): Promise<AuthUser | null> {
    const rows = await this.database.read<UserRow[]>(
      'SELECT `u`.`id`, `u`.`user`, `u`.`email`, `u`.`password`, `u`.`name`, `u`.`role`, `u`.`status`, `u`.`created`, `u`.`updated` FROM `tb_sessions` AS `s` INNER JOIN `tb_users` AS `u` ON `u`.`user` = `s`.`username` WHERE `s`.`token` = ? AND `s`.`expires` > ? AND `s`.`stat` = 0 AND `s`.`useragent` = ? AND `u`.`status` = 1 LIMIT 1',
      [token, now, userAgent]
    )
    if (rows[0] === undefined) return null
    const user = storedUser(rows[0])
    const { passwordHash: _passwordHash, ...safeUser } = user
    return Object.freeze(safeUser)
  }

  public async createSession(session: SessionWrite): Promise<void> {
    await this.database.write(
      'INSERT INTO `tb_sessions` (`ip`, `token`, `useragent`, `created`, `username`, `expires`, `stat`) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [session.ip, session.token, session.userAgent, session.created, session.username, session.expires, session.state]
    )
  }

  public async recordFailedLogin(session: Omit<SessionWrite, 'expires' | 'state'>): Promise<void> {
    await this.database.write(
      'INSERT INTO `tb_sessions` (`ip`, `token`, `useragent`, `created`, `username`, `expires`, `stat`) VALUES (?, ?, ?, ?, ?, 0, 9)',
      [session.ip, session.token, session.userAgent, session.created, session.username]
    )
  }

  public async revokeSession(token: string): Promise<boolean> {
    const result = await this.database.write<{ affectedRows?: number }>(
      'UPDATE `tb_sessions` SET `stat` = 9 WHERE `token` = ? AND `stat` = 0',
      [token]
    )
    return (result.affectedRows ?? 0) > 0
  }
}

function storedUser(row: UserRow): StoredAuthUser {
  return Object.freeze({
    id: Number(row.id),
    username: String(row.user),
    email: String(row.email),
    passwordHash: String(row.password),
    name: String(row.name),
    role: Number(row.role),
    status: Number(row.status),
    created: Number(row.created),
    updated: Number(row.updated)
  })
}
