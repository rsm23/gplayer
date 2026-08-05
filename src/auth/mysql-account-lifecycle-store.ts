import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Database } from '../database/database.js'
import type { AccountConflict, AccountCreate, AccountLifecycleStore, AccountRecord } from './account-lifecycle-service.js'

type AccountRow = RowDataPacket & Readonly<{
  id: number | string
  user: string
  email: string
  name: string
  status: number | string
  updated: number | string
}>

type InsertResult = Readonly<{ insertId?: number | string }>

export class MySqlAccountLifecycleStore implements AccountLifecycleStore {
  public constructor(private readonly database: Pick<Database, 'read' | 'write' | 'transaction'>) {}

  public async findConflict(username: string, email: string): Promise<AccountConflict> {
    const rows = await this.database.read<AccountRow[]>(
      'SELECT `id`, `user`, `email`, `name`, `status`, `updated` FROM `tb_users` WHERE `user` = ? OR `email` = ? LIMIT 2',
      [username, email]
    )
    return Object.freeze({
      username: rows.some((row) => String(row.user).toLowerCase() === username.toLowerCase()),
      email: rows.some((row) => String(row.email).toLowerCase() === email.toLowerCase())
    })
  }

  public async findByIdentifier(identifier: string): Promise<AccountRecord | null> {
    const rows = await this.database.read<AccountRow[]>(
      'SELECT `id`, `user`, `email`, `name`, `status`, `updated` FROM `tb_users` WHERE `user` = ? OR `email` = ? LIMIT 1',
      [identifier, identifier]
    )
    return rows[0] === undefined ? null : accountRecord(rows[0])
  }

  public async findByEmail(email: string): Promise<AccountRecord | null> {
    const rows = await this.database.read<AccountRow[]>(
      'SELECT `id`, `user`, `email`, `name`, `status`, `updated` FROM `tb_users` WHERE `email` = ? LIMIT 1',
      [email]
    )
    return rows[0] === undefined ? null : accountRecord(rows[0])
  }

  public async createAccount(account: AccountCreate): Promise<string | null> {
    try {
      const result = await this.database.write<InsertResult>(
        'INSERT INTO `tb_users` (`user`, `email`, `password`, `name`, `role`, `status`, `created`, `updated`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [account.username, account.email, account.passwordHash, account.name, account.role, account.status, account.created, account.updated]
      )
      return result.insertId === undefined || String(result.insertId) === '0' ? null : String(result.insertId)
    } catch (error) {
      if (mysqlCode(error) === 'ER_DUP_ENTRY') return null
      throw error
    }
  }

  public async activatePending(email: string, expectedUpdated: number, updated: number): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>(
      'UPDATE `tb_users` SET `status` = 1, `updated` = ? WHERE `email` = ? AND `status` = 2 AND `updated` = ?',
      [updated, email, expectedUpdated]
    )
    return result.affectedRows > 0
  }

  public async resetPassword(email: string, expectedUpdated: number, passwordHash: string, updated: number): Promise<boolean> {
    return await this.database.transaction(async (executor) => {
      const rows = await executor.execute<AccountRow[]>(
        'SELECT `id`, `user`, `email`, `name`, `status`, `updated` FROM `tb_users` WHERE `email` = ? AND `updated` = ? LIMIT 1 FOR UPDATE',
        [email, expectedUpdated]
      )
      const account = rows[0]
      if (account === undefined) return false
      const result = await executor.execute<ResultSetHeader>(
        'UPDATE `tb_users` SET `password` = ?, `updated` = ? WHERE `id` = ? AND `updated` = ?',
        [passwordHash, updated, account.id, expectedUpdated]
      )
      if (result.affectedRows === 0) return false
      await executor.execute<ResultSetHeader>(
        'UPDATE `tb_sessions` SET `stat` = 9 WHERE `username` = ? AND `stat` = 0',
        [account.user]
      )
      return true
    })
  }
}

function accountRecord(row: AccountRow): AccountRecord {
  return Object.freeze({
    id: String(row.id),
    username: String(row.user),
    email: String(row.email),
    name: String(row.name),
    status: finiteInteger(row.status),
    updated: finiteInteger(row.updated)
  })
}

function finiteInteger(value: number | string): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : 0
}

function mysqlCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : ''
}
