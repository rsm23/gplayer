import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Database } from '../database/database.js'
import type { DriveAccount, DriveMirror } from './drive-sharer-service.js'
import type {
  DriveAdminStore,
  DriveBackupRecord,
  DriveFingerprint,
  DriveQueueRecord,
  DriveTableQuery,
  DriveTableResult
} from './drive-admin-service.js'

type AccountRow = RowDataPacket & Readonly<{
  email: string
  api_key: string
  client_id: string
  client_secret: string
  refresh_token: string
}>

type MirrorRow = RowDataPacket & Readonly<{
  id: number | string
  gdrive_id: string
  mirror_id: string
  mirror_email: string
  created: number | string
}>

type QueueRow = RowDataPacket & Readonly<{ id: number | string; gdrive_id: string }>
type CountRow = RowDataPacket & Readonly<{ total: number | string }>

const BACKUP_ORDER = Object.freeze({
  id: '`id`',
  gdrive_id: '`gdrive_id`',
  mirror_id: '`mirror_id`',
  mirror_email: '`mirror_email`',
  created: '`created`'
})

const QUEUE_ORDER = Object.freeze({ id: '`id`', gdrive_id: '`gdrive_id`' })

export class MySqlDriveAdminStore implements DriveAdminStore {
  public constructor(private readonly database: Pick<Database, 'read' | 'write'>) {}

  public async listActiveAccounts(bypassOnly: boolean): Promise<readonly DriveAccount[]> {
    const rows = await this.database.read<AccountRow[]>(
      `SELECT \`email\`, \`api_key\`, \`client_id\`, \`client_secret\`, \`refresh_token\` FROM \`tb_gdrive_auth\` WHERE \`status\` = ?${bypassOnly ? ' AND `bypass` = ?' : ''} ORDER BY \`id\` ASC LIMIT 100`,
      bypassOnly ? [1, 1] : [1]
    )
    return Object.freeze(rows.map((row) => Object.freeze({
      email: String(row.email),
      apiKey: String(row.api_key),
      clientId: String(row.client_id),
      clientSecret: String(row.client_secret),
      refreshToken: String(row.refresh_token)
    })))
  }

  public async listMirrors(fileId: string, limit: number): Promise<readonly DriveMirror[]> {
    const boundedLimit = Math.max(1, Math.min(5, Math.trunc(limit)))
    const rows = await this.database.read<MirrorRow[]>(
      'SELECT `gdrive_id`, `mirror_id`, `mirror_email` FROM `tb_gdrive_mirrors` WHERE `gdrive_id` = ? OR `mirror_id` = ? ORDER BY `id` DESC LIMIT ?',
      [fileId, fileId, boundedLimit]
    )
    return Object.freeze(rows.map((row) => Object.freeze({ sourceId: String(row.gdrive_id), mirrorId: String(row.mirror_id), mirrorEmail: String(row.mirror_email) })))
  }

  public async saveMirror(sourceId: string, mirrorId: string, email: string, created: number): Promise<boolean> {
    if (sourceId === mirrorId) return false
    const result = await this.database.write<ResultSetHeader>(
      'INSERT INTO `tb_gdrive_mirrors` (`gdrive_id`, `mirror_id`, `mirror_email`, `created`) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM `tb_gdrive_mirrors` WHERE `gdrive_id` = ? AND `mirror_id` = ? LIMIT 1)',
      [sourceId, mirrorId, email, created, sourceId, mirrorId]
    )
    return result.affectedRows > 0
  }

  public async deleteMirrorsForFile(fileId: string): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>('DELETE FROM `tb_gdrive_mirrors` WHERE `gdrive_id` = ? OR `mirror_id` = ?', [fileId, fileId])
    return result.affectedRows > 0
  }

  public async deleteMirrorRecord(id: string): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>('DELETE FROM `tb_gdrive_mirrors` WHERE `id` = ?', [id])
    return result.affectedRows > 0
  }

  public async listBackups(query: DriveTableQuery): Promise<DriveTableResult<DriveBackupRecord>> {
    const search = query.search === '' ? undefined : `%${query.search}%`
    const where = search === undefined ? '' : ' WHERE `gdrive_id` LIKE ? OR `mirror_id` LIKE ? OR `mirror_email` LIKE ?'
    const values = search === undefined ? [] : [search, search, search]
    const orderBy = BACKUP_ORDER[query.orderBy as keyof typeof BACKUP_ORDER] ?? '`created`'
    const orderDir = query.orderDir === 'asc' ? 'ASC' : 'DESC'
    const [rows, totalRows, filteredRows] = await Promise.all([
      this.database.read<MirrorRow[]>(`SELECT \`id\`, \`gdrive_id\`, \`mirror_id\`, \`mirror_email\`, \`created\` FROM \`tb_gdrive_mirrors\`${where} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`, [...values, query.length, query.start]),
      this.database.read<CountRow[]>('SELECT COUNT(*) AS `total` FROM `tb_gdrive_mirrors`'),
      search === undefined ? Promise.resolve<CountRow[]>([]) : this.database.read<CountRow[]>(`SELECT COUNT(*) AS \`total\` FROM \`tb_gdrive_mirrors\`${where}`, values)
    ])
    const recordsTotal = countValue(totalRows[0]?.total)
    return Object.freeze({ data: Object.freeze(rows.map(backupRow)), recordsTotal, recordsFiltered: search === undefined ? recordsTotal : countValue(filteredRows[0]?.total) })
  }

  public async getBackup(id: string): Promise<DriveBackupRecord | null> {
    const rows = await this.database.read<MirrorRow[]>('SELECT `id`, `gdrive_id`, `mirror_id`, `mirror_email`, `created` FROM `tb_gdrive_mirrors` WHERE `id` = ? LIMIT 1', [id])
    return rows[0] === undefined ? null : backupRow(rows[0])
  }

  public async deleteBackupsByMirrorId(mirrorId: string): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>('DELETE FROM `tb_gdrive_mirrors` WHERE `mirror_id` = ?', [mirrorId])
    return result.affectedRows > 0
  }

  public async listQueue(query: DriveTableQuery): Promise<DriveTableResult<DriveQueueRecord>> {
    const search = query.search === '' ? undefined : `%${query.search}%`
    const where = search === undefined ? '' : ' WHERE `gdrive_id` LIKE ?'
    const values = search === undefined ? [] : [search]
    const orderBy = QUEUE_ORDER[query.orderBy as keyof typeof QUEUE_ORDER] ?? '`id`'
    const orderDir = query.orderDir === 'asc' ? 'ASC' : 'DESC'
    const [rows, totalRows, filteredRows] = await Promise.all([
      this.database.read<QueueRow[]>(`SELECT \`id\`, \`gdrive_id\` FROM \`tb_gdrive_queue\`${where} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`, [...values, query.length, query.start]),
      this.database.read<CountRow[]>('SELECT COUNT(*) AS `total` FROM `tb_gdrive_queue`'),
      search === undefined ? Promise.resolve<CountRow[]>([]) : this.database.read<CountRow[]>(`SELECT COUNT(*) AS \`total\` FROM \`tb_gdrive_queue\`${where}`, values)
    ])
    const recordsTotal = countValue(totalRows[0]?.total)
    return Object.freeze({ data: Object.freeze(rows.map(queueRow)), recordsTotal, recordsFiltered: search === undefined ? recordsTotal : countValue(filteredRows[0]?.total) })
  }

  public async deleteQueue(id: string): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>('DELETE FROM `tb_gdrive_queue` WHERE `id` = ?', [id])
    return result.affectedRows > 0
  }

  public async duplicateExists(fingerprint: DriveFingerprint): Promise<boolean> {
    const rows = await this.database.read<CountRow[]>(
      'SELECT COUNT(*) AS `total` FROM `tb_gdrive_duplicate` WHERE (`gdrive_id` <> ? OR `gdrive_email` <> ?) AND `fileSize` = ? AND `md5Checksum` = ? AND `sha1Checksum` = ? AND `sha256Checksum` = ? AND (`title` = ? OR `description` = ? OR `title` = ? OR `description` = ?)',
      [fingerprint.gdriveId, fingerprint.email, fingerprint.fileSize, fingerprint.md5Checksum, fingerprint.sha1Checksum, fingerprint.sha256Checksum, fingerprint.title, fingerprint.description, fingerprint.description, fingerprint.title]
    )
    return countValue(rows[0]?.total) > 0
  }

  public async saveFingerprint(fingerprint: DriveFingerprint): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>(
      'INSERT INTO `tb_gdrive_duplicate` (`gdrive_id`, `gdrive_email`, `title`, `description`, `fileSize`, `md5Checksum`, `sha1Checksum`, `sha256Checksum`) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM `tb_gdrive_duplicate` WHERE `gdrive_id` = ? LIMIT 1)',
      [fingerprint.gdriveId, fingerprint.email, fingerprint.title, fingerprint.description, fingerprint.fileSize, fingerprint.md5Checksum, fingerprint.sha1Checksum, fingerprint.sha256Checksum, fingerprint.gdriveId]
    )
    return result.affectedRows > 0
  }
}

function backupRow(row: MirrorRow): DriveBackupRecord {
  return Object.freeze({ id: String(row.id), gdrive_id: String(row.gdrive_id), mirror_id: String(row.mirror_id), mirror_email: String(row.mirror_email), created: integerValue(row.created) })
}

function queueRow(row: QueueRow): DriveQueueRecord {
  return Object.freeze({ id: String(row.id), gdrive_id: String(row.gdrive_id) })
}

function countValue(value: number | string | undefined): number {
  return Math.max(0, integerValue(value ?? 0))
}

function integerValue(value: number | string): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : 0
}
