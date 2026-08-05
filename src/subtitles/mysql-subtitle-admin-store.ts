import type { RowDataPacket } from 'mysql2/promise'
import type { Database, TransactionExecutor } from '../database/database.js'
import type {
  StoredSubtitleRecord,
  SubtitleAccess,
  SubtitleAdminStore,
  SubtitleListQuery,
  SubtitleListResult,
  SubtitleWrite
} from './subtitle-admin-service.js'

type SubtitleRow = RowDataPacket & Readonly<{
  id: number | string
  file_name: string
  language: string
  name: string
  uid: number | string
  host: string
  created: number | string
  updated: number | string
}>

type CountRow = RowDataPacket & Readonly<{ total: number | string }>
type MutationResult = Readonly<{ affectedRows?: number; insertId?: number | string }>

const ORDER_COLUMNS = Object.freeze({
  id: '`id`',
  file_name: '`file_name`',
  language: '`language`',
  name: '`name`',
  host: '`host`',
  created: '`created`',
  updated: '`updated`'
})

export class MySqlSubtitleAdminStore implements SubtitleAdminStore {
  public constructor(private readonly database: Pick<Database, 'read' | 'write' | 'transaction'>) {}

  public async listSubtitles(query: SubtitleListQuery, access: SubtitleAccess): Promise<SubtitleListResult> {
    const conditions: string[] = []
    const values: Array<string> = []
    if (!access.isAdmin) {
      conditions.push('`uid` = ?')
      values.push(access.userId)
    }
    if (query.search !== '') {
      conditions.push('(`file_name` LIKE ? OR `language` LIKE ? OR `host` LIKE ? OR `name` LIKE ?)')
      const search = `${query.search}%`
      values.push(search, search, search, search)
    }
    const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`
    const totalWhere = access.isAdmin ? '' : ' WHERE `uid` = ?'
    const totalValues = access.isAdmin ? [] : [access.userId]
    const orderBy = ORDER_COLUMNS[query.orderBy]
    const orderDir = query.orderDir === 'asc' ? 'ASC' : 'DESC'

    const [rows, totalRows, filteredRows] = await Promise.all([
      this.database.read<SubtitleRow[]>(
        `SELECT \`id\`, \`file_name\`, \`language\`, \`name\`, \`uid\`, \`host\`, \`created\`, \`updated\` FROM \`vw_subtitle_manager\`${where} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`,
        [...values, query.length, query.start]
      ),
      this.database.read<CountRow[]>(`SELECT COUNT(*) AS \`total\` FROM \`vw_subtitle_manager\`${totalWhere}`, totalValues),
      query.search === ''
        ? Promise.resolve<CountRow[]>([])
        : this.database.read<CountRow[]>(`SELECT COUNT(*) AS \`total\` FROM \`vw_subtitle_manager\`${where}`, values)
    ])
    const recordsTotal = countValue(totalRows[0]?.total)
    return Object.freeze({
      data: Object.freeze(rows.map(subtitleRow)),
      recordsTotal,
      recordsFiltered: query.search === '' ? recordsTotal : countValue(filteredRows[0]?.total)
    })
  }

  public async getSubtitle(id: string, access: SubtitleAccess): Promise<StoredSubtitleRecord | null> {
    const rows = await this.database.read<SubtitleRow[]>(
      `SELECT \`id\`, \`file_name\`, \`language\`, \`name\`, \`uid\`, \`host\`, \`created\`, \`updated\` FROM \`vw_subtitle_manager\` WHERE \`id\` = ?${access.isAdmin ? '' : ' AND `uid` = ?'} LIMIT 1`,
      access.isAdmin ? [id] : [id, access.userId]
    )
    return rows[0] === undefined ? null : subtitleRow(rows[0])
  }

  public async insertSubtitle(value: SubtitleWrite): Promise<string | null> {
    const result = await this.database.write<MutationResult>(
      'INSERT INTO `tb_subtitle_manager` (`file_name`, `file_size`, `file_type`, `language`, `created`, `uid`, `host`, `updated`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [value.fileName, value.fileSize, value.fileType, value.language, value.created, value.userId, value.host, value.updated]
    )
    return result.insertId === undefined || String(result.insertId) === '0' ? null : String(result.insertId)
  }

  public async deleteSubtitle(id: string, access: SubtitleAccess, links: readonly [string, string]): Promise<boolean> {
    return await this.database.transaction(async (executor) => {
      const deleted = await executor.execute<MutationResult>(
        `DELETE FROM \`tb_subtitle_manager\` WHERE \`id\` = ?${access.isAdmin ? '' : ' AND `uid` = ?'}`,
        access.isAdmin ? [id] : [id, access.userId]
      )
      if ((deleted.affectedRows ?? 0) === 0) return false
      await executor.execute<MutationResult>('DELETE FROM `tb_subtitles` WHERE `link` IN (?, ?)', links)
      return true
    })
  }

  public async renameSubtitle(
    id: string,
    access: SubtitleAccess,
    fileName: string,
    oldSuffix: string,
    link: string,
    updated: number
  ): Promise<boolean> {
    return await this.database.transaction(async (executor) => {
      const renamed = await executor.execute<MutationResult>(
        `UPDATE \`tb_subtitle_manager\` SET \`file_name\` = ?, \`updated\` = ? WHERE \`id\` = ?${access.isAdmin ? '' : ' AND `uid` = ?'}`,
        access.isAdmin ? [fileName, updated, id] : [fileName, updated, id, access.userId]
      )
      if ((renamed.affectedRows ?? 0) === 0) return false
      await executor.execute<MutationResult>(
        'UPDATE `tb_subtitles` SET `link` = ?, `updated` = ? WHERE RIGHT(`link`, CHAR_LENGTH(?)) = ?',
        [link, updated, oldSuffix, oldSuffix]
      )
      return true
    })
  }

  public async listSubtitleHosts(): Promise<readonly string[]> {
    const rows = await this.database.read<Array<RowDataPacket & Readonly<{ host: string }>>>(
      'SELECT DISTINCT `host` FROM `tb_subtitle_manager` WHERE `host` <> ? ORDER BY `host` ASC',
      ['']
    )
    return Object.freeze(rows.map((row) => String(row.host)))
  }

  public async migrateSubtitleHost(oldHost: string, newHost: string, updated: number): Promise<void> {
    await this.database.transaction(async (executor: TransactionExecutor) => {
      await executor.execute<MutationResult>(
        'UPDATE `tb_subtitles` SET `link` = CONCAT(?, SUBSTRING(`link`, CHAR_LENGTH(?) + 1)), `updated` = ? WHERE LEFT(`link`, CHAR_LENGTH(?)) = ?',
        [newHost, oldHost, updated, oldHost, oldHost]
      )
      await executor.execute<MutationResult>(
        'UPDATE `tb_subtitle_manager` SET `host` = ?, `updated` = ? WHERE `host` = ?',
        [newHost, updated, oldHost]
      )
    })
  }
}

function subtitleRow(row: SubtitleRow): StoredSubtitleRecord {
  return Object.freeze({
    id: String(row.id),
    fileName: String(row.file_name),
    language: String(row.language),
    userName: String(row.name),
    userId: String(row.uid),
    host: String(row.host),
    created: finiteInteger(row.created),
    updated: finiteInteger(row.updated)
  })
}

function countValue(value: number | string | undefined): number {
  return Math.max(0, finiteInteger(value ?? 0))
}

function finiteInteger(value: number | string): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : 0
}
