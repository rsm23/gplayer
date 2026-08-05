import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Database } from '../database/database.js'
import type { ActiveLoadBalancer, GeneralWorkerStore, ManagedSubtitle } from './general-worker.js'
import type { ProxyMaintenanceConfiguration, ProxyMaintenanceStore } from './proxy-maintenance-worker.js'

type SubtitleRow = RowDataPacket & Readonly<{ id: number | string; file_name: string }>
type LoadBalancerRow = RowDataPacket & Readonly<{ id: number | string; link: string }>
type SettingRow = RowDataPacket & Readonly<{ key: string; value: string }>

export class MySqlGeneralWorkerStore implements GeneralWorkerStore, ProxyMaintenanceStore {
  public constructor(private readonly database: Pick<Database, 'read' | 'write'>) {}

  public async deleteExpiredSources(now: number): Promise<number> {
    const result = await this.database.write<ResultSetHeader>('DELETE FROM `tb_videos_sources` WHERE `expired` <= ?', [now])
    return result.affectedRows
  }

  public async normalizeSubtitleLanguages(): Promise<number> {
    const result = await this.database.write<ResultSetHeader>('UPDATE `tb_subtitle_manager` SET `language` = ? WHERE `language` = ?', ['Unknown CC', ''])
    return result.affectedRows
  }

  public async listActiveLoadBalancers(baseUrl: string): Promise<readonly ActiveLoadBalancer[]> {
    const rows = await this.database.read<LoadBalancerRow[]>(
      'SELECT `id`, `link` FROM `tb_loadbalancers` WHERE `status` = ? AND `link` <> ? ORDER BY `id` ASC',
      [1, baseUrl]
    )
    return Object.freeze(rows.map((row) => Object.freeze({ id: String(row.id), link: String(row.link).slice(0, 2_048) })))
  }

  public async loadProxyConfiguration(): Promise<ProxyMaintenanceConfiguration> {
    const rows = await this.database.read<SettingRow[]>(
      'SELECT `key`, `value` FROM `tb_settings` WHERE `key` IN (?, ?, ?)',
      ['disable_proxy', 'free_proxy', 'proxy_list']
    )
    const values = Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]))
    return Object.freeze({
      disabled: values.disable_proxy === 'true',
      useConfiguredOnly: values.free_proxy === 'true',
      proxies: Object.freeze((values.proxy_list ?? '').split(/\r\n|\n|\r/).map((value) => value.trim()).filter(Boolean).slice(0, 500))
    })
  }

  public async saveProxyList(proxies: readonly string[]): Promise<void> {
    await this.database.write(
      'INSERT INTO `tb_settings` (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
      ['proxy_list', proxies.slice(0, 500).join('\n')]
    )
  }

  public async listManagedSubtitles(host: string, afterId: string, limit: number): Promise<readonly ManagedSubtitle[]> {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)))
    const rows = await this.database.read<SubtitleRow[]>(
      'SELECT `id`, `file_name` FROM `tb_subtitle_manager` WHERE `host` = ? AND `id` > ? ORDER BY `id` ASC LIMIT ?',
      [host, afterId, boundedLimit]
    )
    return Object.freeze(rows.map((row) => Object.freeze({ id: String(row.id), fileName: String(row.file_name).slice(0, 255) })))
  }

  public async deleteManagedSubtitle(id: string, host: string): Promise<boolean> {
    const result = await this.database.write<ResultSetHeader>('DELETE FROM `tb_subtitle_manager` WHERE `id` = ? AND `host` = ?', [id, host])
    return result.affectedRows > 0
  }
}
