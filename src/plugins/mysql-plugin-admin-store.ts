import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Database } from '../database/database.js'
import type { PluginAdminRecord, PluginAdminStore, PluginListQuery, PluginListResult, PluginWrite } from './plugin-admin-service.js'
import type { PluginRecord } from './plugin-maintenance-worker.js'

type PluginRow = RowDataPacket & Readonly<{ id: number | string; name: string; folder: string; config: string; status: number | string; created: number | string; updated: number | string }>
type CountRow = RowDataPacket & Readonly<{ total: number | string }>
type InsertResult = Readonly<{ insertId?: number | string }>
const ORDER_COLUMNS = Object.freeze({ name: '`name`', status: '`status`', created: '`created`', updated: '`updated`', id: '`id`' })
const COLUMNS = '`id`, `name`, `folder`, `config`, `status`, `created`, `updated`'

export class MySqlPluginAdminStore implements PluginAdminStore {
  public constructor(private readonly database: Pick<Database, 'read' | 'write'>) {}
  public async listPlugins(query: PluginListQuery): Promise<PluginListResult> {
    const search = query.search === '' ? undefined : `${query.search}%`
    const where = search === undefined ? '' : ' WHERE `name` LIKE ?'
    const values = search === undefined ? [] : [search]
    const [rows, totalRows, filteredRows] = await Promise.all([
      this.database.read<PluginRow[]>(`SELECT ${COLUMNS} FROM \`tb_plugins\`${where} ORDER BY ${ORDER_COLUMNS[query.orderBy]} ${query.orderDir === 'asc' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`, [...values, query.length, query.start]),
      this.database.read<CountRow[]>('SELECT COUNT(*) AS `total` FROM `tb_plugins`'),
      search === undefined ? Promise.resolve<CountRow[]>([]) : this.database.read<CountRow[]>(`SELECT COUNT(*) AS \`total\` FROM \`tb_plugins\`${where}`, values)
    ])
    const recordsTotal = countValue(totalRows[0]?.total)
    return Object.freeze({ data: Object.freeze(rows.map(pluginRow)), recordsTotal, recordsFiltered: search === undefined ? recordsTotal : countValue(filteredRows[0]?.total) })
  }
  public async listPluginRecords(): Promise<readonly PluginRecord[]> {
    const rows = await this.database.read<PluginRow[]>('SELECT `id`, `name`, `folder`, `status` FROM `tb_plugins` ORDER BY `id` ASC')
    return Object.freeze(rows.map((row) => Object.freeze({ id: String(row.id), name: String(row.name), folder: String(row.folder), active: Number(row.status) === 1 })))
  }
  public async getPlugin(id: string): Promise<PluginAdminRecord | null> { const rows = await this.database.read<PluginRow[]>(`SELECT ${COLUMNS} FROM \`tb_plugins\` WHERE \`id\` = ? LIMIT 1`, [id]); return rows[0] === undefined ? null : pluginRow(rows[0]) }
  public async findPlugin(name: string, folder: string): Promise<PluginAdminRecord | null> { const rows = await this.database.read<PluginRow[]>(`SELECT ${COLUMNS} FROM \`tb_plugins\` WHERE \`name\` = ? AND \`folder\` = ? LIMIT 1`, [name, folder]); return rows[0] === undefined ? null : pluginRow(rows[0]) }
  public async createPlugin(value: PluginWrite): Promise<string | null> { const result = await this.database.write<InsertResult>('INSERT INTO `tb_plugins` (`name`, `folder`, `config`, `status`, `created`, `updated`) VALUES (?, ?, ?, ?, ?, ?)', writeValues(value)); return result.insertId === undefined || String(result.insertId) === '0' ? null : String(result.insertId) }
  public async updatePlugin(id: string, value: PluginWrite): Promise<boolean> { const result = await this.database.write<ResultSetHeader>('UPDATE `tb_plugins` SET `name` = ?, `folder` = ?, `config` = ?, `status` = ?, `created` = ?, `updated` = ? WHERE `id` = ?', [...writeValues(value), id]); return result.affectedRows > 0 }
  public async updateStatus(id: string, status: number, updated: number): Promise<boolean> { const result = await this.database.write<ResultSetHeader>('UPDATE `tb_plugins` SET `status` = ?, `updated` = ? WHERE `id` = ?', [status, updated, id]); return result.affectedRows > 0 }
  public async deletePlugin(id: string): Promise<boolean> { const result = await this.database.write<ResultSetHeader>('DELETE FROM `tb_plugins` WHERE `id` = ?', [id]); return result.affectedRows > 0 }
}
function writeValues(value: PluginWrite): readonly (string | number)[] { return [value.name, value.folder, JSON.stringify(value.config), value.status, value.created, value.updated] }
function pluginRow(row: PluginRow): PluginAdminRecord { return Object.freeze({ id: String(row.id), name: String(row.name), folder: String(row.folder), config: jsonObject(row.config), status: Number(row.status) === 1 ? 1 : 0, created: integerValue(row.created), updated: integerValue(row.updated) }) }
function jsonObject(value: string): Readonly<Record<string, unknown>> { try { const parsed: unknown = JSON.parse(value); return Object.freeze(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed as Record<string, unknown> } : {}) } catch { return Object.freeze({}) } }
function countValue(value: number | string | undefined): number { return Math.max(0, integerValue(value ?? 0)) }
function integerValue(value: number | string): number { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0 }
