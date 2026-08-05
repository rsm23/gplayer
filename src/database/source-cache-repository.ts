import type { RowDataPacket } from 'mysql2/promise'
import type {
  SourceCacheCriteria,
  SourceCacheInsert,
  SourceCacheRecord,
  SourceCacheRepository
} from '../core/source-resolver.js'
import type { Database, SqlValues } from './database.js'

type CacheRow = RowDataPacket & {
  data: string
  language: string
  userAgent: string
  created: number
  expired: number
}

export class MySqlSourceCacheRepository implements SourceCacheRepository {
  public constructor(private readonly database: Pick<Database, 'read' | 'write'>) {}

  public async find(criteria: SourceCacheCriteria): Promise<SourceCacheRecord | null> {
    const where = compileCriteria(criteria)
    const rows = await this.database.read<CacheRow[]>(
      `SELECT \`data\`, \`lang\` AS \`language\`, \`ua\` AS \`userAgent\`, \`created\`, \`expired\`
       FROM \`tb_videos_sources\`
       WHERE ${where.sql}
       ORDER BY \`id\` DESC
       LIMIT 1`,
      where.values
    )
    const row = rows[0]
    if (row === undefined) return null
    return Object.freeze({
      data: row.data,
      language: row.language,
      userAgent: row.userAgent,
      created: Number(row.created),
      expired: Number(row.expired)
    })
  }

  public async delete(criteria: SourceCacheCriteria): Promise<void> {
    const where = compileCriteria(criteria)
    await this.database.write(
      `DELETE FROM \`tb_videos_sources\` WHERE ${where.sql}`,
      where.values
    )
  }

  public async deleteIdentity(identity: Readonly<{ host: string; id: string }>): Promise<boolean> {
    const host = identity.host.trim().toLowerCase().slice(0, 100)
    const id = identity.id.trim().slice(0, 32_768)
    if (host === '' || id === '') return false
    await this.database.write(
      'DELETE FROM `tb_videos_sources` WHERE `host` = ? AND `host_id` = ?',
      [host, id]
    )
    return true
  }

  public async insert(record: SourceCacheInsert): Promise<void> {
    await this.database.write(
      `INSERT INTO \`tb_videos_sources\`
       (\`host\`, \`host_id\`, \`data\`, \`dl\`, \`sid\`, \`created\`, \`expired\`, \`ua\`, \`lang\`, \`cip\`, \`ip\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.host,
        record.hostId,
        record.data,
        Number(record.downloadable),
        record.serverId,
        record.created,
        record.expired,
        record.userAgent,
        record.language,
        record.clientIp,
        record.serverIp
      ]
    )
  }
}

function compileCriteria(criteria: SourceCacheCriteria): Readonly<{ sql: string; values: SqlValues }> {
  const clauses = [
    '\`host\` = ?',
    '\`host_id\` = ?',
    '\`expired\` > ?',
    '\`dl\` = ?',
    '\`ua\` = ?',
    '\`lang\` = ?'
  ]
  const values: Array<string | number | null> = [
    criteria.host,
    criteria.hostId,
    criteria.expiresAfter,
    Number(criteria.downloadable),
    criteria.userAgent,
    criteria.language
  ]

  if (criteria.serverId !== null) {
    clauses.push('\`sid\` = ?')
    values.push(criteria.serverId)
  }
  if (criteria.clientIp !== null) {
    clauses.push('\`cip\` = ?')
    values.push(criteria.clientIp)
  }
  return Object.freeze({ sql: clauses.join(' AND '), values: Object.freeze(values) })
}
