import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Database } from '../database/database.js'
import {
  OBSOLETE_VIDEO_HOSTS,
  type PendingSourceRefresh,
  type SourceRefreshMaintenance,
  type SourceRefreshStore
} from './source-refresh-worker.js'

type SettingRow = RowDataPacket & Readonly<{ value: string | number | null }>
type PendingRow = RowDataPacket & Readonly<{
  id: string | number
  host: string
  host_id: string
  dl: string | number | boolean
}>

export class MySqlSourceRefreshStore implements SourceRefreshStore {
  public constructor(private readonly database: Pick<Database, 'read' | 'write'>) {}

  public async maintainLegacyData(): Promise<SourceRefreshMaintenance> {
    const obsoletePlaceholders = OBSOLETE_VIDEO_HOSTS.map(() => '?').join(', ')
    const obsolete = await this.database.write<ResultSetHeader>(
      `DELETE FROM \`tb_videos\` WHERE \`host\` IN (${obsoletePlaceholders})`,
      OBSOLETE_VIDEO_HOSTS
    )
    const blank = await this.database.write<ResultSetHeader>(
      'DELETE FROM `tb_videos` WHERE `host` = ? OR `host_id` = ?',
      ['', '']
    )
    const migrated = await this.database.write<ResultSetHeader>(
      `UPDATE \`tb_videos\`
       SET \`host\` = CASE
         WHEN \`host\` = ? THEN ?
         WHEN \`host\` = ? THEN ?
         WHEN \`host\` IN (?, ?) THEN ?
         ELSE \`host\`
       END
       WHERE \`host\` IN (?, ?, ?, ?)`,
      ['goodstream1', 'goodstream', 'streamwish', 'streamhg', 'filelions', 'vidhide', 'earnvids', 'goodstream1', 'streamwish', 'filelions', 'vidhide']
    )
    const deletedSubtitles = await this.database.write<ResultSetHeader>(
      'DELETE FROM `tb_subtitles` WHERE `link` = ? OR `link` LIKE ? OR `link` LIKE ?',
      ['', '%okcdn.%', '%dmcdn.%']
    )
    const normalizedSubtitles = await this.database.write<ResultSetHeader>(
      'UPDATE `tb_subtitles` SET `language` = ? WHERE `language` = ?',
      ['Unknown CC', '']
    )
    return Object.freeze({
      deletedVideos: obsolete.affectedRows + blank.affectedRows,
      migratedVideos: migrated.affectedRows,
      deletedSubtitles: deletedSubtitles.affectedRows,
      normalizedSubtitles: normalizedSubtitles.affectedRows
    })
  }

  public async getLastCleanup(): Promise<number> {
    const rows = await this.database.read<SettingRow[]>(
      'SELECT `value` FROM `tb_settings` WHERE `key` = ? LIMIT 1',
      ['bg_get_last_cleanup']
    )
    const value = Number(rows[0]?.value ?? 0)
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  }

  public async truncatePendingSources(): Promise<void> {
    await this.database.write('TRUNCATE TABLE `tmp_videos_sources`')
  }

  public async saveLastCleanup(timestamp: number): Promise<void> {
    await this.database.write(
      'INSERT INTO `tb_settings` (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
      ['bg_get_last_cleanup', String(timestamp)]
    )
  }

  public async listPendingSources(limit: number): Promise<readonly PendingSourceRefresh[]> {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)))
    const rows = await this.database.read<PendingRow[]>(
      `SELECT t.\`id\`, t.\`host\`, t.\`host_id\`, t.\`dl\`
       FROM \`tmp_videos_sources\` t
       LEFT JOIN \`tb_videos_sources\` v
         ON v.\`host\` = t.\`host\` AND v.\`host_id\` = t.\`host_id\`
       WHERE v.\`id\` IS NULL
       ORDER BY t.\`id\` ASC
       LIMIT ?`,
      [boundedLimit]
    )
    return Object.freeze(rows.map((row) => Object.freeze({
      id: String(row.id),
      host: String(row.host).trim().toLowerCase().slice(0, 50),
      hostId: String(row.host_id).slice(0, 2_048),
      downloadable: row.dl === true || row.dl === 1 || row.dl === '1'
    })))
  }

  public async deletePendingSource(id: string): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>(
      'DELETE FROM `tmp_videos_sources` WHERE `id` = ?',
      [id]
    )
    return result.affectedRows > 0
  }
}
