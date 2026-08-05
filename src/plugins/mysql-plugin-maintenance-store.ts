import type { RowDataPacket } from 'mysql2/promise'
import type { Database } from '../database/database.js'
import type { PluginMaintenanceStore, PluginRecord } from './plugin-maintenance-worker.js'

type PluginRow = RowDataPacket & Readonly<{
  id: number | string
  name: string
  folder: string
  status: number | string
}>

export class MySqlPluginMaintenanceStore implements PluginMaintenanceStore {
  public constructor(private readonly database: Pick<Database, 'read'>) {}

  public async listPlugins(): Promise<readonly PluginRecord[]> {
    const rows = await this.database.read<PluginRow[]>(
      'SELECT `id`, `name`, `folder`, `status` FROM `tb_plugins` ORDER BY `id` ASC'
    )
    return Object.freeze(rows.map((row) => Object.freeze({
      id: String(row.id),
      name: String(row.name).slice(0, 50),
      folder: String(row.folder).slice(0, 255),
      active: Number(row.status) === 1
    })))
  }
}
