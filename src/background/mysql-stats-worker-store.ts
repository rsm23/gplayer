import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Database, TransactionExecutor } from '../database/database.js'
import type { GeoIpDetails } from '../security/geoip-details.js'
import type { PendingStatGeo, StatsWorkerStore } from './stats-worker.js'

type SettingRow = RowDataPacket & Readonly<{ value: string }>
type StatRow = RowDataPacket & Readonly<{ id: number | string; ip: string }>

const LOCK_KEY = 'check_stats'
const STALE_LOCK_SECONDS = 3_600

export class MySqlStatsWorkerStore implements StatsWorkerStore {
  public constructor(private readonly database: Pick<Database, 'read' | 'write' | 'transaction'>) {}

  public async acquire(now: number): Promise<boolean> {
    return await this.database.transaction(async (transaction) => {
      await transaction.execute<ResultSetHeader>('INSERT IGNORE INTO `tb_settings` (`key`, `value`) VALUES (?, ?)', [LOCK_KEY, '0'])
      const rows = await transaction.execute<SettingRow[]>('SELECT `value` FROM `tb_settings` WHERE `key` = ? LIMIT 1 FOR UPDATE', [LOCK_KEY])
      const current = unsignedInteger(rows[0]?.value)
      if (current > 0 && current > now - STALE_LOCK_SECONDS) return false
      await transaction.execute<ResultSetHeader>('UPDATE `tb_settings` SET `value` = ? WHERE `key` = ?', [String(now), LOCK_KEY])
      return true
    })
  }

  public async release(): Promise<void> {
    await this.database.write<ResultSetHeader>('UPDATE `tb_settings` SET `value` = ? WHERE `key` = ?', ['0', LOCK_KEY])
  }

  public async cleanupInvalid(): Promise<number> {
    const [local, missingUa, missingVideo] = await Promise.all([
      this.database.write<ResultSetHeader>('DELETE FROM `tb_stats` WHERE `ip` IN (?, ?, ?, ?)', ['', '::1', '127.0.0.1', 'localhost']),
      this.database.write<ResultSetHeader>('DELETE s FROM `tb_stats` s LEFT JOIN `tb_stats_ua` a ON s.`ua` = a.`id` WHERE a.`id` IS NULL'),
      this.database.write<ResultSetHeader>('DELETE s FROM `tb_stats` s LEFT JOIN `tb_videos` v ON s.`vid` = v.`id` WHERE v.`id` IS NULL')
    ])
    return local.affectedRows + missingUa.affectedRows + missingVideo.affectedRows
  }

  public async listMissingGeo(afterId: string, limit: number): Promise<readonly PendingStatGeo[]> {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)))
    const rows = await this.database.read<StatRow[]>(
      'SELECT `id`, `ip` FROM `tb_stats` WHERE `id` > ? AND (`country` IS NULL OR `asn` IS NULL) ORDER BY `id` ASC LIMIT ?',
      [afterId, boundedLimit]
    )
    return Object.freeze(rows.map((row) => Object.freeze({ id: String(row.id), ip: String(row.ip).slice(0, 45) })))
  }

  public async saveGeo(ip: string, details: GeoIpDetails | null): Promise<void> {
    await this.database.transaction(async (transaction) => {
      if (details?.asn !== null && details?.asn !== undefined && details.organization !== '') {
        await transaction.execute<ResultSetHeader>(
          'INSERT INTO `tb_maxmind_asn` (`id`, `name`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)',
          [details.asn, details.organization]
        )
      }
      await saveIpDetails(transaction, ip, details)
      if (details?.asn !== null && details?.asn !== undefined && details.country !== '') {
        await transaction.execute<ResultSetHeader>('UPDATE `tb_stats` SET `asn` = ?, `country` = ? WHERE `ip` = ?', [details.asn, details.country, ip])
      }
    })
  }
}

async function saveIpDetails(transaction: TransactionExecutor, ip: string, details: GeoIpDetails | null): Promise<void> {
  await transaction.execute<ResultSetHeader>(
    'INSERT INTO `tb_maxmind` (`ip`, `prefix_len`, `asn`, `continent`, `country`) VALUES (?, NULL, ?, ?, ?) ON DUPLICATE KEY UPDATE `asn` = VALUES(`asn`), `continent` = VALUES(`continent`), `country` = VALUES(`country`)',
    [ip, details?.asn ?? null, details?.continent ?? '', details?.country ?? '']
  )
}

function unsignedInteger(value: unknown): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}
