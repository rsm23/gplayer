import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Database, TransactionExecutor } from '../database/database.js'
import type { SettingsMaintenanceStore } from './settings-maintenance-service.js'

type VideoIdentityRow = RowDataPacket & Readonly<{ host: string; host_id: string }>
type SettingRow = RowDataPacket & Readonly<{ value: string }>

export class MySqlSettingsMaintenanceStore implements SettingsMaintenanceStore {
  public constructor(private readonly database: Pick<Database, 'transaction' | 'read' | 'write'>) {}

  public async clearAllSourceCaches(): Promise<Readonly<{ temporarySourcesCleared: boolean; videoSourcesCleared: boolean }>> {
    return await this.database.transaction(async (transaction) => {
      await transaction.execute<ResultSetHeader>('DELETE FROM `tmp_videos_sources`')
      await transaction.execute<ResultSetHeader>('DELETE FROM `tb_videos_sources`')
      return Object.freeze({ temporarySourcesCleared: true, videoSourcesCleared: true })
    })
  }

  public async clearLoadBalancerSources(id: string): Promise<boolean> {
    await this.database.write<ResultSetHeader>('DELETE FROM `tb_videos_sources` WHERE `sid` = ?', [id])
    return true
  }

  public async disableBlacklistedVideos(prefixes: readonly string[]): Promise<boolean> {
    if (prefixes.length === 0) return true
    const where = prefixes.map(() => "LOWER(`title`) LIKE ? ESCAPE '='").join(' OR ')
    const values = prefixes.map((prefix) => `${escapeLikePrefix(prefix)}%`)
    return await this.database.transaction(async (transaction) => {
      await transaction.execute<ResultSetHeader>(`UPDATE \`tb_videos\` SET \`dmca\` = ?, \`status\` = ? WHERE ${where}`, [1, 1, ...values])
      const identities = await transaction.execute<VideoIdentityRow[]>(`SELECT \`host\`, \`host_id\` FROM \`tb_videos\` WHERE ${where}`, values)
      for (const identity of identities) await deleteIdentity(transaction, identity)
      return true
    })
  }

  public async loadSetting(key: 'node_hide_ext_dialog_until'): Promise<string | null> {
    const rows = await this.database.read<SettingRow[]>('SELECT `value` FROM `tb_settings` WHERE `key` = ? LIMIT 1', [key])
    return rows[0] === undefined ? null : String(rows[0].value)
  }

  public async saveSetting(key: 'bypass_host' | 'gdplayer_license' | 'node_hide_ext_dialog_until', value: string): Promise<boolean> {
    await this.database.write<ResultSetHeader>(
      'INSERT INTO `tb_settings` (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
      [key, value]
    )
    return true
  }
}

function escapeLikePrefix(value: string): string {
  return value.replaceAll('=', '==').replaceAll('%', '=%').replaceAll('_', '=_')
}

async function deleteIdentity(transaction: TransactionExecutor, identity: VideoIdentityRow): Promise<void> {
  await transaction.execute<ResultSetHeader>(
    'DELETE FROM `tb_videos_sources` WHERE `host` = ? AND `host_id` = ?',
    [String(identity.host), String(identity.host_id)]
  )
}
