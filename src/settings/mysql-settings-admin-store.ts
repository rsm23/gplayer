import type { RowDataPacket } from 'mysql2/promise'
import type { Database } from '../database/database.js'
import type { SettingEntry, SettingsAdminStore } from './settings-admin-service.js'

type SettingRow = RowDataPacket & Readonly<{ key: string; value: string }>

export class MySqlSettingsAdminStore implements SettingsAdminStore {
  public constructor(private readonly database: Pick<Database, 'read' | 'write'>) {}

  public async getAll(): Promise<Readonly<Record<string, string>>> {
    const rows = await this.database.read<SettingRow[]>('SELECT `key`, `value` FROM `tb_settings`')
    const result: Record<string, string> = {}
    for (const row of rows) result[String(row.key)] = String(row.value)
    return Object.freeze(result)
  }

  public async upsertMany(entries: readonly SettingEntry[]): Promise<void> {
    if (entries.length === 0) return
    const placeholders = entries.map(() => '(?, ?)').join(', ')
    const values = entries.flatMap((entry) => [entry.key, entry.value])
    await this.database.write(
      `INSERT INTO \`tb_settings\` (\`key\`, \`value\`) VALUES ${placeholders} ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)`,
      values
    )
  }
}
