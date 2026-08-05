import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Database, TransactionExecutor } from '../database/database.js'
import type { PlayerMediaQuery } from '../core/player-query.js'
import type { ViewCounterStore, ViewCounterWrite } from './view-counter-service.js'

type IdRow = RowDataPacket & Readonly<{ id: string | number }>
type CountRow = RowDataPacket & Readonly<{ count: string | number }>

export class MySqlViewCounterStore implements ViewCounterStore {
  public constructor(private readonly database: Database) {}

  public async capture(input: ViewCounterWrite): Promise<string | null> {
    return await this.database.transaction(async (transaction) => {
      const videoId = await lockedVideoId(transaction, input.media)
      if (videoId === null) return null
      const counts = await transaction.execute<CountRow[]>(
        'SELECT COUNT(*) AS `count` FROM `tb_stats` WHERE `vid` = ? AND `ip` = ? AND `created` >= ?',
        [videoId, input.clientIp, input.since]
      )
      if (unsignedInteger(counts[0]?.count) >= input.maximum) return null

      const uaId = await userAgentId(transaction, input.userAgent)
      if (uaId === null) return null
      const inserted = await transaction.execute<ResultSetHeader>(
        'INSERT INTO `tb_stats` (`vid`, `ip`, `ua`, `created`, `asn`, `country`) VALUES (?, ?, ?, ?, ?, ?)',
        [videoId, input.clientIp, uaId, input.created, input.geo?.asn ?? null, input.geo?.country || null]
      )
      if (inserted.insertId === undefined || inserted.insertId === null || String(inserted.insertId) === '0') return null
      await transaction.execute<ResultSetHeader>('UPDATE `tb_videos` SET `views` = `views` + 1 WHERE `id` = ?', [videoId])
      return String(inserted.insertId)
    })
  }
}

async function lockedVideoId(transaction: TransactionExecutor, media: PlayerMediaQuery): Promise<string | null> {
  let rows: IdRow[]
  if (media.source === 'db') {
    rows = await transaction.execute<IdRow[]>(
      'SELECT `id` FROM `tb_videos` WHERE (`id` = ? OR `slug` = ?) AND `dmca` = 0 LIMIT 1 FOR UPDATE',
      [media.id ?? '', media.id ?? '']
    )
  } else {
    rows = await transaction.execute<IdRow[]>(
      `SELECT v.\`id\` FROM \`tb_videos\` v
        WHERE v.\`dmca\` = 0
          AND ((v.\`host\` = ? AND v.\`host_id\` = ?)
            OR EXISTS (
              SELECT 1 FROM \`tb_videos_alternatives\` a
               WHERE a.\`vid\` = v.\`id\` AND a.\`host\` = ? AND a.\`host_id\` = ?
            ))
        ORDER BY v.\`id\` ASC LIMIT 1 FOR UPDATE`,
      [media.host ?? '', media.id ?? '', media.host ?? '', media.id ?? '']
    )
  }
  return rows[0] === undefined ? null : String(rows[0].id)
}

async function userAgentId(transaction: TransactionExecutor, userAgent: string): Promise<string | null> {
  const existing = await transaction.execute<IdRow[]>('SELECT `id` FROM `tb_stats_ua` WHERE `ua` = ? LIMIT 1', [userAgent])
  if (existing[0] !== undefined) return String(existing[0].id)
  const inserted = await transaction.execute<ResultSetHeader>('INSERT INTO `tb_stats_ua` (`ua`) VALUES (?)', [userAgent])
  return inserted.insertId === undefined || inserted.insertId === null || String(inserted.insertId) === '0'
    ? null
    : String(inserted.insertId)
}

function unsignedInteger(value: unknown): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}
