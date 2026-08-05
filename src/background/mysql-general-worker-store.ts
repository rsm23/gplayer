import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Database } from '../database/database.js'
import type { GeneralWorkerStore, ManagedSubtitle } from './general-worker.js'

type SubtitleRow = RowDataPacket & Readonly<{ id: number | string; file_name: string }>

export class MySqlGeneralWorkerStore implements GeneralWorkerStore {
  public constructor(private readonly database: Pick<Database, 'read' | 'write'>) {}

  public async deleteExpiredSources(now: number): Promise<number> {
    const result = await this.database.write<ResultSetHeader>('DELETE FROM `tb_videos_sources` WHERE `expired` <= ?', [now])
    return result.affectedRows
  }

  public async normalizeSubtitleLanguages(): Promise<number> {
    const result = await this.database.write<ResultSetHeader>('UPDATE `tb_subtitle_manager` SET `language` = ? WHERE `language` = ?', ['Unknown CC', ''])
    return result.affectedRows
  }

  public async listManagedSubtitles(host: string, afterId: string, limit: number): Promise<readonly ManagedSubtitle[]> {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)))
    const rows = await this.database.read<SubtitleRow[]>(
      'SELECT `id`, `file_name` FROM `tb_subtitle_manager` WHERE `host` = ? AND `id` > ? ORDER BY `id` ASC LIMIT ?',
      [host, afterId, boundedLimit]
    )
    return Object.freeze(rows.map((row) => Object.freeze({ id: String(row.id), fileName: String(row.file_name).slice(0, 255) })))
  }

  public async deleteManagedSubtitle(id: string, host: string): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>('DELETE FROM `tb_subtitle_manager` WHERE `id` = ? AND `host` = ?', [id, host])
    return result.affectedRows > 0
  }
}
