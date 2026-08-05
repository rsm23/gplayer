import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Database, TransactionExecutor } from '../database/database.js'
import type {
  DriveAccountAdminRecord,
  DriveAccountAdminStore,
  DriveAccountListQuery,
  DriveAccountListResult,
  DriveAccountWrite,
  StoredDriveAccountAdminRecord
} from './drive-account-admin-service.js'

type AccountListRow = RowDataPacket & Readonly<{
  id: number | string
  email: string
  bypass: number | string
  status: number | string
  created: number | string
  updated: number | string
  api_key_configured: number | string
  client_id_configured: number | string
  client_secret_configured: number | string
  refresh_token_configured: number | string
}>

type AccountSecretRow = AccountListRow & Readonly<{
  api_key: string
  client_id: string
  client_secret: string
  refresh_token: string
}>

type CountRow = RowDataPacket & Readonly<{ total: number | string }>
type InsertResult = Readonly<{ insertId?: number | string }>

const ORDER_COLUMNS = Object.freeze({
  id: '`id`',
  email: '`email`',
  bypass: '`bypass`',
  status: '`status`',
  created: '`created`',
  updated: '`updated`'
})

const CONFIGURED_COLUMNS = "(`api_key` <> '') AS `api_key_configured`, (`client_id` <> '') AS `client_id_configured`, (`client_secret` <> '') AS `client_secret_configured`, (`refresh_token` <> '') AS `refresh_token_configured`"

export class MySqlDriveAccountAdminStore implements DriveAccountAdminStore {
  public constructor(private readonly database: Pick<Database, 'read' | 'write' | 'transaction'>) {}

  public async listAccounts(query: DriveAccountListQuery): Promise<DriveAccountListResult> {
    const search = query.search === '' ? undefined : `${query.search}%`
    const where = search === undefined ? '' : ' WHERE `email` LIKE ?'
    const values = search === undefined ? [] : [search]
    const orderBy = ORDER_COLUMNS[query.orderBy]
    const orderDir = query.orderDir === 'asc' ? 'ASC' : 'DESC'
    const [rows, totalRows, filteredRows] = await Promise.all([
      this.database.read<AccountListRow[]>(
        `SELECT \`id\`, \`email\`, \`bypass\`, \`status\`, \`created\`, \`updated\`, ${CONFIGURED_COLUMNS} FROM \`tb_gdrive_auth\`${where} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`,
        [...values, query.length, query.start]
      ),
      this.database.read<CountRow[]>('SELECT COUNT(*) AS `total` FROM `tb_gdrive_auth`'),
      search === undefined
        ? Promise.resolve<CountRow[]>([])
        : this.database.read<CountRow[]>(`SELECT COUNT(*) AS \`total\` FROM \`tb_gdrive_auth\`${where}`, values)
    ])
    const recordsTotal = countValue(totalRows[0]?.total)
    return Object.freeze({
      data: Object.freeze(rows.map(publicRow)),
      recordsTotal,
      recordsFiltered: search === undefined ? recordsTotal : countValue(filteredRows[0]?.total)
    })
  }

  public async getAccount(id: string): Promise<StoredDriveAccountAdminRecord | null> {
    const rows = await this.database.read<AccountSecretRow[]>(
      `SELECT \`id\`, \`email\`, \`api_key\`, \`client_id\`, \`client_secret\`, \`refresh_token\`, \`bypass\`, \`status\`, \`created\`, \`updated\`, ${CONFIGURED_COLUMNS} FROM \`tb_gdrive_auth\` WHERE \`id\` = ? LIMIT 1`,
      [id]
    )
    return rows[0] === undefined ? null : secretRow(rows[0])
  }

  public async emailExists(email: string, excludeId?: string): Promise<boolean> {
    const rows = await this.database.read<CountRow[]>(
      `SELECT COUNT(*) AS \`total\` FROM \`tb_gdrive_auth\` WHERE \`email\` = ?${excludeId === undefined ? '' : ' AND `id` <> ?'}`,
      excludeId === undefined ? [email] : [email, excludeId]
    )
    return countValue(rows[0]?.total) > 0
  }

  public async createAccount(account: DriveAccountWrite): Promise<string | null> {
    const result = await this.database.write<InsertResult>(
      'INSERT INTO `tb_gdrive_auth` (`email`, `api_key`, `client_id`, `client_secret`, `refresh_token`, `created`, `status`, `bypass`, `updated`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      writeValues(account)
    )
    return result.insertId === undefined || String(result.insertId) === '0' ? null : String(result.insertId)
  }

  public async updateAccount(id: string, account: DriveAccountWrite): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>(
      'UPDATE `tb_gdrive_auth` SET `email` = ?, `api_key` = ?, `client_id` = ?, `client_secret` = ?, `refresh_token` = ?, `created` = ?, `status` = ?, `bypass` = ?, `updated` = ? WHERE `id` = ?',
      [...writeValues(account), id]
    )
    return result.affectedRows > 0
  }

  public async deleteAccount(id: string): Promise<boolean> {
    return await this.database.transaction(async (transaction) => {
      const rows = await transaction.execute<AccountSecretRow[]>(
        `SELECT \`id\`, \`email\`, \`api_key\`, \`client_id\`, \`client_secret\`, \`refresh_token\`, \`bypass\`, \`status\`, \`created\`, \`updated\`, ${CONFIGURED_COLUMNS} FROM \`tb_gdrive_auth\` WHERE \`id\` = ? FOR UPDATE`,
        [id]
      )
      const account = rows[0]
      if (account === undefined) return false
      await transaction.execute<ResultSetHeader>('DELETE FROM `tb_gdrive_mirrors` WHERE `mirror_email` = ?', [String(account.email)])
      const result = await transaction.execute<ResultSetHeader>('DELETE FROM `tb_gdrive_auth` WHERE `id` = ?', [id])
      return result.affectedRows > 0
    })
  }

  public async updateFlag(id: string, column: 'status' | 'bypass', value: number, updated: number): Promise<boolean> {
    const sqlColumn = column === 'bypass' ? '`bypass`' : '`status`'
    const result = await this.database.write<ResultSetHeader>(
      `UPDATE \`tb_gdrive_auth\` SET ${sqlColumn} = ?, \`updated\` = ? WHERE \`id\` = ?`,
      [value, updated, id]
    )
    return result.affectedRows > 0
  }
}

function writeValues(account: DriveAccountWrite): readonly (string | number)[] {
  return [account.email, account.apiKey, account.clientId, account.clientSecret, account.refreshToken, account.created, account.status, account.bypass, account.updated]
}

function publicRow(row: AccountListRow): DriveAccountAdminRecord {
  return Object.freeze({
    id: String(row.id),
    email: String(row.email),
    bypass: flagValue(row.bypass),
    status: flagValue(row.status),
    created: integerValue(row.created),
    updated: integerValue(row.updated),
    apiKeyConfigured: flagValue(row.api_key_configured) === 1,
    clientIdConfigured: flagValue(row.client_id_configured) === 1,
    clientSecretConfigured: flagValue(row.client_secret_configured) === 1,
    refreshTokenConfigured: flagValue(row.refresh_token_configured) === 1
  })
}

function secretRow(row: AccountSecretRow): StoredDriveAccountAdminRecord {
  return Object.freeze({
    ...publicRow(row),
    apiKey: String(row.api_key),
    clientId: String(row.client_id),
    clientSecret: String(row.client_secret),
    refreshToken: String(row.refresh_token)
  })
}

function countValue(value: number | string | undefined): number {
  return Math.max(0, integerValue(value ?? 0))
}

function integerValue(value: number | string): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : 0
}

function flagValue(value: number | string): number {
  return Number(value) === 1 ? 1 : 0
}
