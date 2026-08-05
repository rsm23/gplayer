import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Database } from '../database/database.js'
import type { DriveAccount, DriveMirror, DriveStore } from './drive-sharer-service.js'

type AccountRow = RowDataPacket & Readonly<{
  email: string
  api_key: string
  client_id: string
  client_secret: string
  refresh_token: string
}>

type MirrorRow = RowDataPacket & Readonly<{
  gdrive_id: string
  mirror_id: string
  mirror_email: string
}>

export class MySqlDriveStore implements DriveStore {
  public constructor(private readonly database: Pick<Database, 'read' | 'write'>) {}

  public async listActiveBypassAccounts(): Promise<readonly DriveAccount[]> {
    const rows = await this.database.read<AccountRow[]>(
      'SELECT `email`, `api_key`, `client_id`, `client_secret`, `refresh_token` FROM `tb_gdrive_auth` WHERE `status` = ? AND `bypass` = ? ORDER BY `id` ASC LIMIT 100',
      [1, 1]
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
    return Object.freeze(rows.map((row) => Object.freeze({
      sourceId: String(row.gdrive_id),
      mirrorId: String(row.mirror_id),
      mirrorEmail: String(row.mirror_email)
    })))
  }

  public async saveMirror(sourceId: string, mirrorId: string, email: string, created: number): Promise<boolean> {
    if (sourceId === mirrorId) return false
    const result = await this.database.write<ResultSetHeader>(
      'INSERT INTO `tb_gdrive_mirrors` (`gdrive_id`, `mirror_id`, `mirror_email`, `created`) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM `tb_gdrive_mirrors` WHERE `gdrive_id` = ? AND `mirror_id` = ? LIMIT 1)',
      [sourceId, mirrorId, email, created, sourceId, mirrorId]
    )
    return result.affectedRows > 0
  }
}
