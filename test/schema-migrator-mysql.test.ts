import { readFile } from 'node:fs/promises'
import path from 'node:path'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'
import { describe, expect, it } from 'vitest'
import { SchemaMigrator, type SchemaSqlValue } from '../src/database/schema-migrator.js'

const socketPath = process.env.GPLAYER_TEST_MYSQL_SOCKET?.trim()
const configuredSocketPath = socketPath ?? ''
const mysqlUser = process.env.GPLAYER_TEST_MYSQL_USER?.trim() || process.env.USER || ''
const mysqlPassword = process.env.GPLAYER_TEST_MYSQL_PASSWORD ?? ''

async function scalar(connection: Connection, sql: string): Promise<unknown> {
  const [rows] = await connection.query<RowDataPacket[]>(sql)
  return rows[0]?.value
}

describe.runIf(socketPath !== undefined && socketPath !== '')('schema migrator MySQL compatibility fixture', () => {
  it('upgrades a version-84 production-shaped schema without losing valid records', async () => {
    const databaseName = `gplayer_migration_${process.pid}_${Date.now()}`
    const schemaSql = await readFile(path.resolve('resources/mysql/mysql.sql'), 'utf8')
    const viewsSql = await readFile(path.resolve('resources/mysql/views.sql'), 'utf8')
    const fixtureSql = await readFile(path.resolve('test/fixtures/mysql-schema-v84.sql'), 'utf8')
    const admin = await mysql.createConnection({ socketPath: configuredSocketPath, user: mysqlUser, password: mysqlPassword, multipleStatements: true })
    let connection: Connection | undefined
    try {
      await admin.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      connection = await mysql.createConnection({ socketPath: configuredSocketPath, user: mysqlUser, password: mysqlPassword, database: databaseName, multipleStatements: true })
      await connection.query(fixtureSql)
      const executed: string[] = []
      const executor = {
        execute: async <T>(sql: string, values: readonly SchemaSqlValue[] = []): Promise<T> => {
          executed.push(sql)
          const [result] = await connection!.query(sql, [...values])
          return result as T
        }
      }
      const result = await new SchemaMigrator(executor, databaseName, schemaSql, viewsSql, 101).migrate()
      expect(result.previousVersion).toBe(84)
      expect(result.dataUpgradeStatements).toBeGreaterThan(10)
      expect(result.cleanupStatements).toBeGreaterThan(5)
      expect(await scalar(connection, "SELECT CAST(`value` AS UNSIGNED) AS `value` FROM `tb_settings` WHERE `key` = 'updated'" )).toBe(101)
      expect(await scalar(connection, "SELECT COUNT(*) AS `value` FROM `tb_settings` WHERE `key` = 'updated'" )).toBe(1)
      expect(await scalar(connection, "SELECT `value` FROM `tb_settings` WHERE `key` = 'jwplayer-license'" )).toBe('jwplayer')
      expect(await scalar(connection, "SELECT COUNT(*) AS `value` FROM `tb_settings` WHERE `key` = 'custom-hostnames'" )).toBe(0)
      expect(await scalar(connection, 'SELECT COUNT(*) AS `value` FROM `tb_videos`')).toBe(1)
      expect(await scalar(connection, 'SELECT CHAR_LENGTH(`title`) AS `value` FROM `tb_videos` WHERE `id` = 11')).toBe(255)
      expect(await scalar(connection, 'SELECT CHAR_LENGTH(`host_id`) AS `value` FROM `tb_videos` WHERE `id` = 11')).toBe(2048)
      expect(await scalar(connection, 'SELECT CHAR_LENGTH(`poster`) AS `value` FROM `tb_videos` WHERE `id` = 11')).toBe(2048)
      expect(await scalar(connection, 'SELECT `host` AS `value` FROM `tb_videos` WHERE `id` = 11')).toBe('earnvids')
      expect(await scalar(connection, 'SELECT `slug` AS `value` FROM `tb_videos` WHERE `id` = 11')).toBe('legacy-slug')
      expect(await scalar(connection, 'SELECT COUNT(*) AS `value` FROM `tb_stats`')).toBe(2)
      expect(await scalar(connection, "SELECT COUNT(DISTINCT user_agent.`id`) AS `value` FROM `tb_stats` stat JOIN `tb_stats_ua` user_agent ON user_agent.`id` = stat.`ua` WHERE user_agent.`ua` = 'Legacy Browser'" )).toBe(1)
      expect(await scalar(connection, "SELECT COUNT(*) AS `value` FROM `tb_videos_hash` WHERE `data` = ''" )).toBe(2)
      expect(await scalar(connection, "SELECT `IS_NULLABLE` AS `value` FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'tb_videos_hash' AND `COLUMN_NAME` = 'data'" )).toBe('NO')
      expect(await scalar(connection, "SELECT COUNT(*) AS `value` FROM `tb_maxmind` WHERE `ip` = '198.51.100.0'" )).toBe(1)
      expect(await scalar(connection, "SELECT COUNT(*) AS `value` FROM `tb_gdrive_duplicate` WHERE `gdrive_id` = 'orphan'" )).toBe(0)
      expect(await scalar(connection, "SELECT COUNT(*) AS `value` FROM `tb_gdrive_mirrors` WHERE `mirror_id` = 'orphan'" )).toBe(0)
      expect(await scalar(connection, "SELECT COUNT(*) AS `value` FROM `tb_sessions` WHERE `username` = 'missing'" )).toBe(0)
      expect(await scalar(connection, "SELECT COUNT(*) AS `value` FROM `tb_subtitle_manager` WHERE `uid` = 999" )).toBe(0)
      expect(await scalar(connection, 'SELECT COUNT(*) AS `value` FROM `tb_subtitles`')).toBe(1)
      expect(await scalar(connection, 'SELECT COUNT(*) AS `value` FROM `tb_videos_alternatives`')).toBe(1)
      expect(await scalar(connection, "SELECT COUNT(*) AS `value` FROM `information_schema`.`TABLES` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'tb_videos_short'" )).toBe(0)

      executed.length = 0
      const current = await new SchemaMigrator(executor, databaseName, schemaSql, viewsSql, 101).migrate()
      expect(current.previousVersion).toBe(101)
      expect(current.dataUpgradeStatements).toBe(0)
      expect(current.cleanupStatements).toBe(0)
      expect(current.removedLegacyArtifacts).toBe(0)
      expect(executed.filter((sql) => sql.startsWith('ALTER TABLE'))).toEqual([])
      expect(current.executedStatements).toBe(5)
    } finally {
      if (connection !== undefined) await connection.end()
      await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``)
      await admin.end()
    }
  }, 30_000)
})
