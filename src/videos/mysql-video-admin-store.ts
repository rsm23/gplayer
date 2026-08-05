import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Database, TransactionExecutor } from '../database/database.js'
import type {
  StoredVideoAlternative,
  StoredVideoDetail,
  StoredVideoRecord,
  StoredVideoSubtitle,
  VideoAccess,
  VideoAdminStore,
  VideoCreateWrite,
  VideoListQuery,
  VideoListResult,
  VideoOrderColumn,
  VideoUpdateWrite
} from './video-admin-service.js'

const ORDER_COLUMNS: Readonly<Record<VideoOrderColumn, string>> = Object.freeze({
  id: 'v.`id`',
  title: 'v.`title`',
  host: 'v.`host`',
  slug: 'v.`slug`',
  status: 'v.`status`',
  dmca: 'v.`dmca`',
  views: 'v.`views`',
  name: 'u.`name`',
  created: 'v.`created`',
  updated: 'v.`updated`',
  poster: 'v.`poster`',
  host_id: 'v.`host_id`'
})

type VideoRow = RowDataPacket & {
  id: string | number
  title: string
  host: string
  host_id: string
  uid: string | number
  name: string
  slug: string | null
  status: string | number
  dmca: string | number
  views: string | number
  poster: string
  created: string | number
  updated: string | number
  has_alt?: string | number
  has_sub?: string | number
}

type AlternativeRow = RowDataPacket & { id: string | number; host: string; host_id: string; order: string | number }
type SubtitleRow = RowDataPacket & { id: string | number; link: string; language: string; order: string | number }

const VIDEO_SELECT = `SELECT v.\`id\`, v.\`title\`, v.\`host\`, v.\`host_id\`, v.\`uid\`, u.\`name\`,
       v.\`slug\`, v.\`status\`, v.\`dmca\`, v.\`views\`, v.\`poster\`, v.\`created\`, v.\`updated\`,
       EXISTS(SELECT 1 FROM \`tb_videos_alternatives\` a WHERE a.\`vid\` = v.\`id\`) AS \`has_alt\`,
       EXISTS(SELECT 1 FROM \`tb_subtitles\` s WHERE s.\`vid\` = v.\`id\`) AS \`has_sub\`
  FROM \`tb_videos\` v
  JOIN \`tb_users\` u ON u.\`id\` = v.\`uid\``

export class MySqlVideoAdminStore implements VideoAdminStore {
  public constructor(private readonly database: Database) {}

  public async listVideos(query: VideoListQuery, access: VideoAccess): Promise<VideoListResult> {
    const conditions: string[] = []
    const values: Array<string | number> = []
    if (!access.isAdmin) {
      conditions.push('v.`uid` = ?')
      values.push(access.userId)
    } else if (query.userId !== null) {
      conditions.push('v.`uid` = ?')
      values.push(query.userId)
    }
    const totalConditions = [...conditions]
    const totalValues = [...values]
    if (query.status !== null) {
      conditions.push('v.`status` = ?')
      values.push(query.status)
    }
    if (query.dmca !== null) {
      conditions.push('v.`dmca` = ?')
      values.push(query.dmca)
    }
    if (query.search !== '') {
      const search = `%${query.search}%`
      conditions.push('(v.`title` LIKE ? OR v.`host` LIKE ? OR v.`host_id` LIKE ? OR v.`slug` LIKE ? OR v.`poster` LIKE ? OR u.`name` LIKE ? OR CAST(v.`id` AS CHAR) = ?)')
      values.push(search, search, search, search, search, search, query.search)
    }
    const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`
    const totalWhere = totalConditions.length === 0 ? '' : ` WHERE ${totalConditions.join(' AND ')}`
    const order = ORDER_COLUMNS[query.orderBy] ?? ORDER_COLUMNS.updated
    const rows = await this.database.read<VideoRow[]>(
      `${VIDEO_SELECT}${where} ORDER BY ${order} ${query.orderDir.toUpperCase()} LIMIT ?, ?`,
      [...values, query.start, query.length]
    )
    const [totalRows, filteredRows] = await Promise.all([
      this.database.read<Array<RowDataPacket & { count: string | number }>>(
        `SELECT COUNT(*) AS \`count\` FROM \`tb_videos\` v JOIN \`tb_users\` u ON u.\`id\` = v.\`uid\`${totalWhere}`,
        totalValues
      ),
      this.database.read<Array<RowDataPacket & { count: string | number }>>(
        `SELECT COUNT(*) AS \`count\` FROM \`tb_videos\` v JOIN \`tb_users\` u ON u.\`id\` = v.\`uid\`${where}`,
        values
      )
    ])
    return Object.freeze({
      data: Object.freeze(rows.map(videoRecord)),
      recordsTotal: countValue(totalRows[0]?.count),
      recordsFiltered: countValue(filteredRows[0]?.count)
    })
  }

  public async getVideo(id: string, access: VideoAccess): Promise<StoredVideoDetail | null> {
    const scope = access.isAdmin ? '' : ' AND v.`uid` = ?'
    const values = access.isAdmin ? [id] : [id, access.userId]
    const rows = await this.database.read<VideoRow[]>(`${VIDEO_SELECT} WHERE v.\`id\` = ?${scope} LIMIT 1`, values)
    return rows[0] === undefined ? null : await this.detail(rows[0])
  }

  public async getPublicVideo(idOrSlug: string): Promise<StoredVideoDetail | null> {
    const rows = await this.database.read<VideoRow[]>(
      `${VIDEO_SELECT} WHERE (v.\`id\` = ? OR v.\`slug\` = ?) AND v.\`dmca\` = 0 LIMIT 1`,
      [idOrSlug, idOrSlug]
    )
    return rows[0] === undefined ? null : await this.detail(rows[0])
  }

  public async slugExists(slug: string, excludeId?: string): Promise<boolean> {
    const rows = await this.database.read<Array<RowDataPacket & { found: number }>>(
      `SELECT 1 AS \`found\` FROM \`tb_videos\` WHERE \`slug\` = ?${excludeId === undefined ? '' : ' AND `id` <> ?'} LIMIT 1`,
      excludeId === undefined ? [slug] : [slug, excludeId]
    )
    return rows.length > 0
  }

  public async createVideo(value: VideoCreateWrite): Promise<string | null> {
    return await this.database.transaction(async (transaction) => {
      const inserted = await transaction.execute<ResultSetHeader>(
        `INSERT INTO \`tb_videos\`
           (\`title\`, \`host\`, \`host_id\`, \`uid\`, \`slug\`, \`status\`, \`dmca\`, \`views\`, \`poster\`, \`created\`, \`updated\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [value.title, value.host, value.hostId, value.userId, value.slug, value.status, value.dmca, value.views, value.poster, value.created, value.updated]
      )
      const id = String(inserted.insertId ?? '')
      if (!/^\d+$/.test(id) || id === '0') return null
      await insertRelations(transaction, id, value.alternatives, value.subtitles)
      return id
    })
  }

  public async updateVideo(id: string, access: VideoAccess, value: VideoUpdateWrite): Promise<boolean> {
    return await this.database.transaction(async (transaction) => {
      const current = await lockedVideo(transaction, id, access)
      if (current === null) return false
      await clearSourceCache(transaction, id, current.host, current.hostId)
      const updated = await transaction.execute<ResultSetHeader>(
        `UPDATE \`tb_videos\`
            SET \`title\` = ?, \`host\` = ?, \`host_id\` = ?, \`slug\` = ?, \`poster\` = ?, \`updated\` = ?
          WHERE \`id\` = ?${access.isAdmin ? '' : ' AND `uid` = ?'}`,
        access.isAdmin
          ? [value.title, value.host, value.hostId, value.slug, value.poster, value.updated, id]
          : [value.title, value.host, value.hostId, value.slug, value.poster, value.updated, id, access.userId]
      )
      if (updated.affectedRows === 0) return false
      await transaction.execute('DELETE FROM `tb_videos_alternatives` WHERE `vid` = ?', [id])
      await transaction.execute('DELETE FROM `tb_subtitles` WHERE `vid` = ?', [id])
      await insertRelations(transaction, id, value.alternatives, value.subtitles)
      return true
    })
  }

  public async deleteVideo(id: string, access: VideoAccess): Promise<boolean> {
    return await this.database.transaction(async (transaction) => {
      const current = await lockedVideo(transaction, id, access)
      if (current === null) return false
      await clearSourceCache(transaction, id, current.host, current.hostId)
      await transaction.execute('DELETE FROM `tb_subtitles` WHERE `vid` = ?', [id])
      await transaction.execute('DELETE FROM `tb_videos_alternatives` WHERE `vid` = ?', [id])
      const deleted = await transaction.execute<ResultSetHeader>(
        `DELETE FROM \`tb_videos\` WHERE \`id\` = ?${access.isAdmin ? '' : ' AND `uid` = ?'}`,
        access.isAdmin ? [id] : [id, access.userId]
      )
      return deleted.affectedRows > 0
    })
  }

  public async renameVideo(id: string, access: VideoAccess, title: string, updated: number): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>(
      `UPDATE \`tb_videos\` SET \`title\` = ?, \`updated\` = ? WHERE \`id\` = ?${access.isAdmin ? '' : ' AND `uid` = ?'}`,
      access.isAdmin ? [title, updated, id] : [title, updated, id, access.userId]
    )
    return result.affectedRows > 0
  }

  public async renameVideos(
    ids: readonly string[],
    access: VideoAccess,
    transform: Readonly<{ prefix: string; postfix: string; search: string; replacement: string }>,
    updated: number
  ): Promise<boolean> {
    if (ids.length === 0) return false
    return await this.database.transaction(async (transaction) => {
      const placeholders = ids.map(() => '?').join(', ')
      const rows = await transaction.execute<Array<RowDataPacket & { id: string | number; title: string }>>(
        `SELECT \`id\`, \`title\` FROM \`tb_videos\` WHERE \`id\` IN (${placeholders})${access.isAdmin ? '' : ' AND `uid` = ?'} FOR UPDATE`,
        access.isAdmin ? ids : [...ids, access.userId]
      )
      let changed = false
      for (const row of rows) {
        let title = `${transform.prefix}${String(row.title)}${transform.postfix}`
        if (transform.search !== '') title = title.replaceAll(transform.search, transform.replacement)
        const result = await transaction.execute<ResultSetHeader>(
          'UPDATE `tb_videos` SET `title` = ?, `updated` = ? WHERE `id` = ?',
          [title.slice(0, 255), updated, String(row.id)]
        )
        changed ||= result.affectedRows > 0
      }
      return changed
    })
  }

  public async updateVideoStatus(id: string, access: VideoAccess, status: number): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>(
      `UPDATE \`tb_videos\` SET \`status\` = ? WHERE \`id\` = ?${access.isAdmin ? '' : ' AND `uid` = ?'}`,
      access.isAdmin ? [status, id] : [status, id, access.userId]
    )
    return result.affectedRows > 0
  }

  public async updateVideoDmca(id: string, takedown: number, updated: number): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>(
      'UPDATE `tb_videos` SET `dmca` = ?, `updated` = ? WHERE `id` = ?',
      [takedown, updated, id]
    )
    return result.affectedRows > 0
  }

  public async updateVideoPoster(id: string, access: VideoAccess, poster: string, updated: number): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>(
      `UPDATE \`tb_videos\` SET \`poster\` = ?, \`updated\` = ? WHERE \`id\` = ?${access.isAdmin ? '' : ' AND `uid` = ?'}`,
      access.isAdmin ? [poster, updated, id] : [poster, updated, id, access.userId]
    )
    return result.affectedRows > 0
  }

  public async deleteVideoSubtitle(id: string, access: VideoAccess): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>(
      `DELETE s FROM \`tb_subtitles\` s
         JOIN \`tb_videos\` v ON v.\`id\` = s.\`vid\`
        WHERE s.\`id\` = ?${access.isAdmin ? '' : ' AND v.`uid` = ?'}`,
      access.isAdmin ? [id] : [id, access.userId]
    )
    return result.affectedRows > 0
  }

  public async updateVideoSubtitle(id: string, access: VideoAccess, link: string, language: string, updated: number): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>(
      `UPDATE \`tb_subtitles\` s
         JOIN \`tb_videos\` v ON v.\`id\` = s.\`vid\`
          SET s.\`link\` = ?, s.\`language\` = ?, s.\`updated\` = ?
        WHERE s.\`id\` = ?${access.isAdmin ? '' : ' AND v.`uid` = ?'}`,
      access.isAdmin ? [link, language, updated, id] : [link, language, updated, id, access.userId]
    )
    return result.affectedRows > 0
  }

  public async deleteVideosByHosts(hosts: readonly string[]): Promise<readonly string[]> {
    if (hosts.length === 0) return Object.freeze([])
    return await this.database.transaction(async (transaction) => {
      const placeholders = hosts.map(() => '?').join(', ')
      const rows = await transaction.execute<Array<RowDataPacket & {
        id: string | number
        host: string
        host_id: string
        poster: string
      }>>(
        `SELECT \`id\`, \`host\`, \`host_id\`, \`poster\` FROM \`tb_videos\` WHERE \`host\` IN (${placeholders}) FOR UPDATE`,
        hosts
      )
      if (rows.length === 0) return Object.freeze([])
      const ids = rows.map((row) => String(row.id))
      for (const row of rows) await clearSourceCache(transaction, String(row.id), String(row.host), String(row.host_id))
      const idPlaceholders = ids.map(() => '?').join(', ')
      await transaction.execute(`DELETE FROM \`tb_subtitles\` WHERE \`vid\` IN (${idPlaceholders})`, ids)
      await transaction.execute(`DELETE FROM \`tb_videos_alternatives\` WHERE \`vid\` IN (${idPlaceholders})`, ids)
      const deleted = await transaction.execute<ResultSetHeader>(
        `DELETE FROM \`tb_videos\` WHERE \`id\` IN (${idPlaceholders})`,
        ids
      )
      return deleted.affectedRows > 0
        ? Object.freeze(rows.map((row) => String(row.poster ?? '')))
        : Object.freeze([])
    })
  }

  private async detail(row: VideoRow): Promise<StoredVideoDetail> {
    const id = String(row.id)
    const [alternatives, subtitles] = await Promise.all([
      this.database.read<AlternativeRow[]>(
        'SELECT `id`, `host`, `host_id`, `order` FROM `tb_videos_alternatives` WHERE `vid` = ? ORDER BY `order` ASC, `id` ASC',
        [id]
      ),
      this.database.read<SubtitleRow[]>(
        'SELECT `id`, `link`, `language`, `order` FROM `tb_subtitles` WHERE `vid` = ? ORDER BY `order` ASC, `id` ASC',
        [id]
      )
    ])
    return Object.freeze({
      ...videoRecord(row),
      alternatives: Object.freeze(alternatives.map(alternativeRecord)),
      subtitles: Object.freeze(subtitles.map(subtitleRecord))
    })
  }
}

async function lockedVideo(
  transaction: TransactionExecutor,
  id: string,
  access: VideoAccess
): Promise<Readonly<{ host: string; hostId: string }> | null> {
  const rows = await transaction.execute<Array<RowDataPacket & { host: string; host_id: string }>>(
    `SELECT \`host\`, \`host_id\` FROM \`tb_videos\` WHERE \`id\` = ?${access.isAdmin ? '' : ' AND `uid` = ?'} FOR UPDATE`,
    access.isAdmin ? [id] : [id, access.userId]
  )
  return rows[0] === undefined ? null : Object.freeze({ host: String(rows[0].host), hostId: String(rows[0].host_id) })
}

async function clearSourceCache(transaction: TransactionExecutor, videoId: string, host: string, hostId: string): Promise<void> {
  const alternatives = await transaction.execute<Array<RowDataPacket & { host: string; host_id: string }>>(
    'SELECT `host`, `host_id` FROM `tb_videos_alternatives` WHERE `vid` = ?',
    [videoId]
  )
  for (const identity of [{ host, host_id: hostId }, ...alternatives]) {
    await transaction.execute('DELETE FROM `tb_videos_sources` WHERE `host` = ? AND `host_id` = ?', [identity.host, identity.host_id])
  }
}

async function insertRelations(
  transaction: TransactionExecutor,
  videoId: string,
  alternatives: VideoCreateWrite['alternatives'],
  subtitles: VideoCreateWrite['subtitles']
): Promise<void> {
  for (const alternative of alternatives) {
    await transaction.execute(
      'INSERT INTO `tb_videos_alternatives` (`vid`, `host`, `host_id`, `order`) VALUES (?, ?, ?, ?)',
      [videoId, alternative.host, alternative.hostId, alternative.order]
    )
  }
  for (const subtitle of subtitles) {
    await transaction.execute(
      'INSERT INTO `tb_subtitles` (`vid`, `uid`, `link`, `language`, `order`, `created`, `updated`) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [videoId, subtitle.userId, subtitle.link, subtitle.language, subtitle.order, subtitle.created, subtitle.updated]
    )
  }
}

function videoRecord(row: VideoRow): StoredVideoRecord {
  return Object.freeze({
    id: String(row.id),
    title: String(row.title ?? ''),
    host: String(row.host ?? ''),
    hostId: String(row.host_id ?? ''),
    userId: String(row.uid),
    userName: String(row.name ?? ''),
    slug: String(row.slug ?? ''),
    status: finiteInteger(row.status),
    dmca: finiteInteger(row.dmca),
    views: finiteInteger(row.views),
    poster: String(row.poster ?? ''),
    created: finiteInteger(row.created),
    updated: finiteInteger(row.updated),
    hasAlternatives: finiteInteger(row.has_alt ?? 0) > 0,
    hasSubtitles: finiteInteger(row.has_sub ?? 0) > 0
  })
}

function alternativeRecord(row: AlternativeRow): StoredVideoAlternative {
  return Object.freeze({ id: String(row.id), host: String(row.host), hostId: String(row.host_id), order: finiteInteger(row.order) })
}

function subtitleRecord(row: SubtitleRow): StoredVideoSubtitle {
  return Object.freeze({ id: String(row.id), link: String(row.link), language: String(row.language), order: finiteInteger(row.order) })
}

function finiteInteger(value: string | number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : 0
}

function countValue(value: string | number | undefined): number {
  return Math.max(0, finiteInteger(value ?? 0))
}
