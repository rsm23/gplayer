import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  SchemaMigrator,
  buildSchemaMigrationPlan,
  parseSchemaInventory,
  type ActualColumn,
  type ActualForeignKey,
  type ActualIndex,
  type SchemaExecutor,
  type SchemaSnapshot,
  type SchemaSqlValue
} from '../src/database/schema-migrator.js'

const schemaSql = await readFile(path.resolve('resources/mysql/mysql.sql'), 'utf8')
const viewsSql = await readFile(path.resolve('resources/mysql/views.sql'), 'utf8')

function snapshot(input: Partial<SchemaSnapshot> = {}): SchemaSnapshot {
  return Object.freeze({
    tables: input.tables ?? new Map(),
    columns: input.columns ?? Object.freeze([]),
    indexes: input.indexes ?? Object.freeze([]),
    foreignKeys: input.foreignKeys ?? Object.freeze([]),
    version: input.version ?? 0
  })
}

function column(tableName: string, name: string, columnType: string, collation: string | null = null, input: Partial<ActualColumn> = {}): ActualColumn {
  return Object.freeze({ tableName, name, columnType, collation, ...input })
}

function index(tableName: string, name: string, columnName: string, input: Partial<ActualIndex> = {}): ActualIndex {
  return Object.freeze({ tableName, name, columnName, nonUnique: input.nonUnique ?? 1, indexType: input.indexType ?? 'BTREE', sequence: input.sequence ?? 1, subPart: input.subPart ?? null })
}

function foreignKey(input: Partial<ActualForeignKey> = {}): ActualForeignKey {
  return Object.freeze({
    tableName: input.tableName ?? 'tb_videos',
    name: input.name ?? 'FK_tb_videos_uid_tb_users_id',
    columns: input.columns ?? 'uid',
    referencedTable: input.referencedTable ?? 'tb_users',
    referencedColumns: input.referencedColumns ?? 'id',
    updateRule: input.updateRule ?? 'RESTRICT',
    deleteRule: input.deleteRule ?? 'CASCADE'
  })
}

describe('schema inventory parser', () => {
  it('extracts the complete final table and view inventory without dump mutations', () => {
    const inventory = parseSchemaInventory(schemaSql, viewsSql)
    expect(inventory.tables).toHaveLength(20)
    expect(inventory.tables).toEqual(expect.arrayContaining(['tb_users', 'tb_settings', 'tb_videos', 'tb_videos_sources', 'tmp_videos_sources']))
    expect(inventory.views).toEqual(['vw_loadbalancers', 'vw_subtitle_manager', 'vw_users', 'vw_videos'])
  })
})

describe('schema migration planner', () => {
  it('builds a non-destructive fresh-schema plan without demo accounts', () => {
    const plan = buildSchemaMigrationPlan(schemaSql, viewsSql, snapshot(), 101)
    expect(plan.createdTables).toBe(20)
    expect(plan.replacedViews).toBe(4)
    expect(plan.previousVersion).toBe(0)
    expect(plan.targetVersion).toBe(101)
    expect(plan.statements.filter((statement) => statement.startsWith('CREATE TABLE IF NOT EXISTS'))).toHaveLength(20)
    expect(plan.statements.filter((statement) => statement.startsWith('CREATE OR REPLACE'))).toHaveLength(4)
    const sql = plan.statements.join('\n')
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|DELETE FROM|RENAME TABLE/i)
    expect(sql).not.toContain('admin@gplayer.local')
    expect(sql).not.toContain('demo@gplayer.local')
    expect(sql).not.toContain('$2y$')
    expect(sql).toContain("INSERT IGNORE INTO `tb_settings` (`key`, `value`) VALUES ('updated', 101)")
    expect(sql).toContain('SQL SECURITY INVOKER VIEW `vw_users`')
  })

  it('converges missing and drifted settings fields while retaining unknown columns', () => {
    const plan = buildSchemaMigrationPlan(schemaSql, viewsSql, snapshot({
      tables: new Map([['tb_settings', 'latin1_swedish_ci']]),
      columns: Object.freeze([
        column('tb_settings', 'id', 'int unsigned'),
        column('tb_settings', 'key', 'varchar(100)', 'utf8mb4_general_ci'),
        column('tb_settings', 'legacy_extension_data', 'text', 'utf8mb4_unicode_ci')
      ]),
      indexes: Object.freeze([index('tb_settings', 'PRIMARY', 'id', { nonUnique: 0 })]),
      version: 84
    }), 101)
    expect(plan.createdTables).toBe(19)
    expect(plan.convertedTables).toBe(1)
    expect(plan.addedColumns).toBe(1)
    expect(plan.modifiedColumns).toBe(1)
    expect(plan.addedIndexes).toBe(1)
    expect(plan.retainedExtraColumns).toBe(1)
    const sql = plan.statements.join('\n')
    expect(sql).toContain('CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
    expect(sql).toContain('ADD COLUMN `value` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL')
    expect(sql).toContain('MODIFY COLUMN `key` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL')
    expect(sql).toContain('ADD UNIQUE KEY `key_idx` (`key`)')
    expect(sql).not.toContain('DROP COLUMN `legacy_extension_data`')
  })

  it('replaces a mismatched named secondary index but refuses primary-key drift', () => {
    const baseColumns = Object.freeze([
      column('tb_settings', 'id', 'int unsigned'),
      column('tb_settings', 'key', 'varchar(150)', 'utf8mb4_unicode_ci'),
      column('tb_settings', 'value', 'mediumtext', 'utf8mb4_unicode_ci')
    ])
    const replacement = buildSchemaMigrationPlan(schemaSql, viewsSql, snapshot({
      tables: new Map([['tb_settings', 'utf8mb4_unicode_ci']]),
      columns: baseColumns,
      indexes: Object.freeze([
        index('tb_settings', 'PRIMARY', 'id', { nonUnique: 0 }),
        index('tb_settings', 'key_idx', 'key', { nonUnique: 1 })
      ]),
      version: 101
    }), 101)
    expect(replacement.replacedIndexes).toBe(1)
    expect(replacement.statements).toContain('ALTER TABLE `tb_settings` DROP INDEX `key_idx`, ADD UNIQUE KEY `key_idx` (`key`)')

    expect(() => buildSchemaMigrationPlan(schemaSql, viewsSql, snapshot({
      tables: new Map([['tb_settings', 'utf8mb4_unicode_ci']]),
      columns: baseColumns,
      indexes: Object.freeze([index('tb_settings', 'PRIMARY', 'key', { nonUnique: 0 })]),
      version: 101
    }), 101)).toThrow('primary key')
  })

  it('orders legacy data preservation and cleanup before rebuilding constraints', () => {
    const legacyColumns = Object.freeze([
      column('tb_settings', 'id', 'int unsigned'),
      column('tb_settings', 'key', 'varchar(150)', 'latin1_swedish_ci'),
      column('tb_settings', 'value', 'mediumtext', 'latin1_swedish_ci'),
      column('tb_users', 'id', 'int unsigned'),
      column('tb_users', 'user', 'varchar(50)', 'utf8mb4_unicode_ci'),
      column('tb_videos', 'id', 'bigint unsigned'),
      column('tb_videos', 'title', 'text', 'utf8mb4_unicode_ci'),
      column('tb_videos', 'host', 'varchar(50)', 'utf8mb4_unicode_ci'),
      column('tb_videos', 'host_id', 'text', 'utf8mb4_unicode_ci'),
      column('tb_videos', 'poster', 'text', 'utf8mb4_unicode_ci'),
      column('tb_videos', 'uid', 'int unsigned'),
      column('tb_videos_short', 'vid', 'bigint unsigned'),
      column('tb_videos_short', 'key', 'varchar(150)', 'utf8mb4_unicode_ci'),
      column('tb_stats', 'id', 'bigint unsigned'),
      column('tb_stats', 'ua', 'varchar(500)', 'utf8mb4_unicode_ci'),
      column('tb_stats_ua', 'id', 'int unsigned'),
      column('tb_stats_ua', 'ua', 'varchar(500)', 'utf8mb4_unicode_ci')
    ])
    const plan = buildSchemaMigrationPlan(schemaSql, viewsSql, snapshot({
      tables: new Map([
        ['tb_settings', 'latin1_swedish_ci'],
        ['tb_users', 'utf8mb4_unicode_ci'],
        ['tb_videos', 'utf8mb4_unicode_ci'],
        ['tb_videos_short', 'utf8mb4_unicode_ci'],
        ['tb_stats', 'utf8mb4_unicode_ci'],
        ['tb_stats_ua', 'utf8mb4_unicode_ci']
      ]),
      columns: legacyColumns,
      indexes: Object.freeze([
        index('tb_settings', 'PRIMARY', 'id', { nonUnique: 0 }),
        index('tb_settings', 'key_idx', 'key', { nonUnique: 0 }),
        index('tb_videos', 'PRIMARY', 'id', { nonUnique: 0 }),
        index('tb_stats', 'PRIMARY', 'id', { nonUnique: 0 }),
        index('tb_stats_ua', 'PRIMARY', 'id', { nonUnique: 0 }),
        index('tb_stats_ua', 'ua_idx', 'ua', { nonUnique: 0 })
      ]),
      version: 84
    }), 101)
    const sql = plan.statements.join('\n')
    expect(plan.dataUpgradeStatements).toBeGreaterThan(10)
    expect(plan.cleanupStatements).toBeGreaterThan(2)
    expect(plan.removedLegacyArtifacts).toBeGreaterThan(1)
    expect(sql).toContain('LEFT JOIN `tb_videos_short` legacy')
    expect(sql).toContain('CREATE TEMPORARY TABLE `gplayer_stats_ua_upgrade`')
    expect(sql).toContain("UPDATE `tb_videos` SET `host` = 'earnvids'")
    expect(sql).toContain('DROP TABLE IF EXISTS `tb_videos_short`')
    expect(sql).not.toContain('INSERT IGNORE INTO `tb_users`')
    const captureStats = plan.statements.findIndex((statement) => statement.startsWith('INSERT INTO `gplayer_stats_ua_upgrade`'))
    const modifyStats = plan.statements.findIndex((statement) => statement.startsWith('ALTER TABLE `tb_stats` MODIFY COLUMN `ua`'))
    const restoreStats = plan.statements.findIndex((statement) => statement.startsWith('UPDATE `tb_stats` stat JOIN `gplayer_stats_ua_upgrade`'))
    const removeLegacyShort = plan.statements.indexOf('DROP TABLE IF EXISTS `tb_videos_short`')
    const addVideoForeignKey = plan.statements.findIndex((statement) => statement.startsWith('ALTER TABLE `tb_videos` ADD CONSTRAINT'))
    expect(captureStats).toBeLessThan(modifyStats)
    expect(modifyStats).toBeLessThan(restoreStats)
    expect(restoreStats).toBeLessThan(addVideoForeignKey)
    expect(addVideoForeignKey).toBeLessThan(removeLegacyShort)
  })

  it('does not rerun versioned data cleanup on an already-current database', () => {
    const plan = buildSchemaMigrationPlan(schemaSql, viewsSql, snapshot({
      tables: new Map([['tb_settings', 'utf8mb4_unicode_ci']]),
      columns: Object.freeze([
        column('tb_settings', 'id', 'int unsigned'),
        column('tb_settings', 'key', 'varchar(150)', 'utf8mb4_unicode_ci'),
        column('tb_settings', 'value', 'mediumtext', 'utf8mb4_unicode_ci')
      ]),
      indexes: Object.freeze([
        index('tb_settings', 'PRIMARY', 'id', { nonUnique: 0 }),
        index('tb_settings', 'key_idx', 'key', { nonUnique: 0 })
      ]),
      version: 101
    }), 101)
    expect(plan.dataUpgradeStatements).toBe(0)
    expect(plan.cleanupStatements).toBe(0)
    expect(plan.removedLegacyArtifacts).toBe(0)
  })

  it('converges older version markers from schema state instead of version-specific branches', () => {
    const legacyShape = {
      tables: new Map([['tb_settings', 'latin1_swedish_ci']]),
      columns: Object.freeze([
        column('tb_settings', 'id', 'int unsigned'),
        column('tb_settings', 'key', 'varchar(100)', 'latin1_swedish_ci')
      ]),
      indexes: Object.freeze([index('tb_settings', 'PRIMARY', 'id', { nonUnique: 0 })])
    }
    const plans = [0, 84, 100].map((version) => buildSchemaMigrationPlan(
      schemaSql,
      viewsSql,
      snapshot({ ...legacyShape, version }),
      101
    ))

    expect(plans.map((plan) => plan.previousVersion)).toEqual([0, 84, 100])
    expect(plans[0]?.statements).toEqual(plans[1]?.statements)
    expect(plans[1]?.statements).toEqual(plans[2]?.statements)
    for (const plan of plans) {
      expect(plan.targetVersion).toBe(101)
      expect(plan.createdTables).toBe(19)
      expect(plan.convertedTables).toBe(1)
      expect(plan.addedColumns).toBe(1)
      expect(plan.modifiedColumns).toBe(1)
      expect(plan.statements.at(-1)).toContain("('updated', 101)")
    }
  })

  it('reconciles nullability, defaults, and auto-increment metadata when introspection provides it', () => {
    const plan = buildSchemaMigrationPlan(schemaSql, viewsSql, snapshot({
      tables: new Map([['tb_settings', 'utf8mb4_unicode_ci']]),
      columns: Object.freeze([
        column('tb_settings', 'id', 'int unsigned', null, { isNullable: 'YES', columnDefault: null, extra: '' }),
        column('tb_settings', 'key', 'varchar(150)', 'utf8mb4_unicode_ci', { isNullable: 'YES', columnDefault: null, extra: '' }),
        column('tb_settings', 'value', 'mediumtext', 'utf8mb4_unicode_ci', { isNullable: 'YES', columnDefault: null, extra: '' })
      ]),
      indexes: Object.freeze([
        index('tb_settings', 'PRIMARY', 'id', { nonUnique: 0 }),
        index('tb_settings', 'key_idx', 'key', { nonUnique: 0 })
      ]),
      version: 101
    }), 101)
    expect(plan.modifiedColumns).toBe(3)
    expect(plan.statements).toEqual(expect.arrayContaining([
      'ALTER TABLE `tb_settings` MODIFY COLUMN `id` int(10) unsigned NOT NULL AUTO_INCREMENT',
      'ALTER TABLE `tb_settings` MODIFY COLUMN `key` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL',
      'ALTER TABLE `tb_settings` MODIFY COLUMN `value` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL'
    ]))
  })

  it('drops a conflicting current foreign key before restoring the supplied rule', () => {
    const plan = buildSchemaMigrationPlan(schemaSql, viewsSql, snapshot({
      tables: new Map([
        ['tb_users', 'utf8mb4_unicode_ci'],
        ['tb_videos', 'utf8mb4_unicode_ci']
      ]),
      columns: Object.freeze([
        column('tb_users', 'id', 'int unsigned'),
        column('tb_videos', 'id', 'bigint unsigned'),
        column('tb_videos', 'uid', 'int unsigned')
      ]),
      indexes: Object.freeze([
        index('tb_users', 'PRIMARY', 'id', { nonUnique: 0 }),
        index('tb_videos', 'PRIMARY', 'id', { nonUnique: 0 })
      ]),
      foreignKeys: Object.freeze([foreignKey({ updateRule: 'CASCADE' })]),
      version: 101
    }), 101)
    const drop = plan.statements.indexOf('ALTER TABLE `tb_videos` DROP FOREIGN KEY `FK_tb_videos_uid_tb_users_id`')
    const add = plan.statements.findIndex((statement) => statement.startsWith('ALTER TABLE `tb_videos` ADD CONSTRAINT `FK_tb_videos_uid_tb_users_id`'))
    expect(drop).toBeGreaterThanOrEqual(0)
    expect(add).toBeGreaterThan(drop)
  })

  it('refuses to downgrade a newer database version', () => {
    expect(() => buildSchemaMigrationPlan(schemaSql, viewsSql, snapshot({ version: 102 }), 101)).toThrow('newer than supported')
  })
})

describe('schema migrator execution', () => {
  it('locks one master connection, parameterizes introspection, and executes the safe plan', async () => {
    const calls: Array<readonly [string, readonly SchemaSqlValue[]]> = []
    const execute = vi.fn(async (sql: string, values: readonly SchemaSqlValue[] = []): Promise<unknown> => {
      calls.push([sql, values])
      if (sql.startsWith('SELECT GET_LOCK')) return [{ acquired: 1 }]
      if (sql.startsWith('SELECT RELEASE_LOCK')) return [{ released: 1 }]
      if (sql.includes('information_schema')) return []
      if (sql.startsWith('SELECT `value` FROM `tb_settings`')) return [{ value: '101' }]
      return {}
    })
    const executor: SchemaExecutor = {
      execute: async <T>(sql: string, values: readonly SchemaSqlValue[] = []): Promise<T> => await execute(sql, values) as T
    }
    const result = await new SchemaMigrator(executor, 'gplayer_test', schemaSql, viewsSql, 101).migrate()
    expect(result.createdTables).toBe(20)
    expect(result.executedStatements).toBeGreaterThan(24)
    expect(calls[0]).toEqual(['SELECT GET_LOCK(?, 30) AS `acquired`', ['gplayer:schema:gplayer_test']])
    expect(calls.at(-1)).toEqual(['SELECT RELEASE_LOCK(?) AS `released`', ['gplayer:schema:gplayer_test']])
    for (const [sql, values] of calls.filter(([sql]) => sql.includes('information_schema'))) expect(values).toEqual(['gplayer_test'])
    const executedSql = calls.map(([sql]) => sql).join('\n')
    expect(executedSql).not.toMatch(/DROP TABLE|DROP COLUMN|DELETE FROM|RENAME TABLE/i)
    expect(executedSql).not.toContain('$2y$')
  })

  it('does not inspect or mutate the schema when the advisory lock is unavailable', async () => {
    const execute = vi.fn(async (): Promise<unknown> => [{ acquired: 0 }])
    const migrator = new SchemaMigrator({ execute: async <T>(): Promise<T> => await execute() as T }, 'gplayer', schemaSql, viewsSql, 101)
    await expect(migrator.migrate()).rejects.toThrow('migration lock')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('treats a partial settings table without its version column as unversioned', async () => {
    const calls: string[] = []
    const execute = vi.fn(async (sql: string, _values: readonly SchemaSqlValue[] = []): Promise<unknown> => {
      calls.push(sql)
      if (sql.startsWith('SELECT GET_LOCK')) return [{ acquired: 1 }]
      if (sql.startsWith('SELECT RELEASE_LOCK')) return [{ released: 1 }]
      if (sql.includes('information_schema`.`TABLES')) return [{ name: 'tb_settings', collation: 'latin1_swedish_ci' }]
      if (sql.includes('information_schema`.`COLUMNS')) return [
        { tableName: 'tb_settings', name: 'id', columnType: 'int unsigned', collation: null },
        { tableName: 'tb_settings', name: 'key', columnType: 'varchar(100)', collation: 'latin1_swedish_ci' }
      ]
      if (sql.includes('information_schema`.`STATISTICS')) return [
        { tableName: 'tb_settings', name: 'PRIMARY', nonUnique: 0, indexType: 'BTREE', sequence: 1, columnName: 'id', subPart: null }
      ]
      if (sql.includes('information_schema`.`KEY_COLUMN_USAGE')) return []
      if (sql.startsWith('SELECT `value` FROM `tb_settings`')) return [{ value: '101' }]
      return {}
    })
    const migrator = new SchemaMigrator({ execute: async <T>(sql: string, values: readonly SchemaSqlValue[] = []): Promise<T> => await execute(sql, values) as T }, 'gplayer_partial', schemaSql, viewsSql, 101)
    const result = await migrator.migrate()
    expect(result.previousVersion).toBe(0)
    expect(result.addedColumns).toBe(1)
    expect(calls.filter((sql) => sql.startsWith('SELECT `value` FROM `tb_settings`'))).toHaveLength(1)
  })

  it('fails when the target schema version cannot be read back after migration', async () => {
    const execute = vi.fn(async (sql: string): Promise<unknown> => {
      if (sql.startsWith('SELECT GET_LOCK')) return [{ acquired: 1 }]
      if (sql.startsWith('SELECT RELEASE_LOCK')) return [{ released: 1 }]
      if (sql.includes('information_schema')) return []
      if (sql.startsWith('SELECT `value` FROM `tb_settings`')) return []
      return {}
    })
    const migrator = new SchemaMigrator({ execute: async <T>(sql: string): Promise<T> => await execute(sql) as T }, 'gplayer_readback', schemaSql, viewsSql, 101)
    await expect(migrator.migrate()).rejects.toThrow('did not persist the target schema version')
    expect(execute).toHaveBeenLastCalledWith('SELECT RELEASE_LOCK(?) AS `released`')
  })
})
