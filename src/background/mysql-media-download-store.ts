import type { RowDataPacket } from 'mysql2/promise'
import type { Database } from '../database/database.js'
import type { CachedMediaSourceRow, MediaDownloadStore } from './media-download-worker.js'

type ServerRow = RowDataPacket & Readonly<{ id: string | number }>
type SourceRow = RowDataPacket & Readonly<{
  id: string | number
  host: string
  host_id: string
  data: string
  ua: string | null
  lang: string | null
}>

export class MySqlMediaDownloadStore implements MediaDownloadStore {
  public constructor(private readonly database: Pick<Database, 'read'>) {}

  public async currentServerId(baseUrl: string): Promise<string | null> {
    const rows = await this.database.read<ServerRow[]>(
      'SELECT `id` FROM `tb_load_balancers` WHERE `link` = ? LIMIT 1',
      [baseUrl]
    )
    return rows[0] === undefined ? null : String(rows[0].id)
  }

  public async listCandidates(afterId: string, limit: number, serverId: string | null): Promise<readonly CachedMediaSourceRow[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
    const serverClause = serverId === null ? '' : ' AND `sid` = ?'
    const values: Array<string | number> = [afterId]
    if (serverId !== null) values.push(serverId)
    values.push(boundedLimit)
    const rows = await this.database.read<SourceRow[]>(
      `SELECT v.\`id\`, v.\`host\`, v.\`host_id\`, v.\`data\`, v.\`ua\`, v.\`lang\`
       FROM \`tb_videos_sources\` v
       INNER JOIN (
         SELECT MIN(\`id\`) AS \`id\`
         FROM \`tb_videos_sources\`
         WHERE \`id\` > ?${serverClause}
         GROUP BY \`host\`, \`host_id\`
         ORDER BY MIN(\`id\`) ASC
         LIMIT ?
       ) selected ON selected.\`id\` = v.\`id\`
       ORDER BY v.\`id\` ASC`,
      values
    )
    return Object.freeze(rows.map((row) => Object.freeze({
      id: String(row.id),
      host: String(row.host).trim().toLowerCase().slice(0, 50),
      hostId: String(row.host_id).slice(0, 2_048),
      data: String(row.data),
      userAgent: String(row.ua ?? '').slice(0, 2_048),
      language: String(row.lang ?? '').slice(0, 100)
    })))
  }
}
