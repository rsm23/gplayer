export type SchemaSqlValue = string | number | boolean | null

export interface SchemaExecutor {
  execute<T>(sql: string, values?: readonly SchemaSqlValue[]): Promise<T>
}

export type ActualColumn = Readonly<{
  tableName: string
  name: string
  columnType: string
  collation: string | null
  isNullable?: string | boolean
  columnDefault?: string | number | null
  extra?: string
}>

export type ActualIndex = Readonly<{
  tableName: string
  name: string
  nonUnique: number
  indexType: string
  sequence: number
  columnName: string
  subPart: number | null
}>

export type ActualForeignKey = Readonly<{
  tableName: string
  name: string
  columns: string
  referencedTable: string
  referencedColumns: string
  updateRule: string
  deleteRule: string
}>

export type SchemaSnapshot = Readonly<{
  tables: ReadonlyMap<string, string>
  columns: readonly ActualColumn[]
  indexes: readonly ActualIndex[]
  foreignKeys: readonly ActualForeignKey[]
  version: number
}>

export type SchemaMigrationPlan = Readonly<{
  statements: readonly string[]
  createdTables: number
  convertedTables: number
  addedColumns: number
  modifiedColumns: number
  addedIndexes: number
  replacedIndexes: number
  addedForeignKeys: number
  replacedViews: number
  retainedExtraColumns: number
  dataUpgradeStatements: number
  cleanupStatements: number
  removedLegacyArtifacts: number
  previousVersion: number
  targetVersion: number
}>

export type SchemaMigrationResult = Omit<SchemaMigrationPlan, 'statements'> & Readonly<{ executedStatements: number }>

type ColumnContract = Readonly<{ name: string; definition: string }>
type IndexContract = Readonly<{ name: string; definition: string; signature: string; primary: boolean }>
type ForeignKeyContract = Readonly<{ name: string; definition: string; signature: string }>
type TableContract = Readonly<{
  name: string
  columns: readonly ColumnContract[]
  indexes: readonly IndexContract[]
  foreignKeys: readonly ForeignKeyContract[]
  createWithoutForeignKeys: string
}>
type ViewContract = Readonly<{ name: string; createOrReplace: string }>
type DataUpgradePlan = Readonly<{
  beforeColumnChanges: readonly string[]
  afterColumnChanges: readonly string[]
  cleanup: readonly string[]
  removeArtifacts: readonly string[]
}>

export class SchemaMigrator {
  public constructor(
    private readonly executor: SchemaExecutor,
    private readonly databaseName: string,
    private readonly schemaSql: string,
    private readonly viewsSql: string,
    private readonly targetVersion: number
  ) {
    if (!/^[A-Za-z0-9_$-]{1,64}$/.test(databaseName)) throw new Error('The database name is invalid')
    if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) throw new Error('The target database version is invalid')
  }

  public async migrate(): Promise<SchemaMigrationResult> {
    const lockName = `gplayer:schema:${this.databaseName}`.slice(0, 64)
    const lockRows = await this.executor.execute<Array<{ acquired: number | string | null }>>('SELECT GET_LOCK(?, 30) AS `acquired`', [lockName])
    if (Number(lockRows[0]?.acquired ?? 0) !== 1) throw new Error('Could not acquire the database migration lock')
    try {
      const snapshot = await this.snapshot()
      const plan = buildSchemaMigrationPlan(this.schemaSql, this.viewsSql, snapshot, this.targetVersion)
      for (const statement of plan.statements) await this.executor.execute(statement)
      const versionRows = await this.executor.execute<Array<{ value: string | number }>>('SELECT `value` FROM `tb_settings` WHERE `key` = ? LIMIT 1', ['updated'])
      if (Number(versionRows[0]?.value ?? 0) !== this.targetVersion) throw new Error('The database migration did not persist the target schema version')
      const { statements: _statements, ...summary } = plan
      return Object.freeze({ ...summary, executedStatements: _statements.length })
    } finally {
      await this.executor.execute('SELECT RELEASE_LOCK(?) AS `released`', [lockName])
    }
  }

  private async snapshot(): Promise<SchemaSnapshot> {
    const tables = await this.executor.execute<Array<{ name: string; collation: string | null }>>(
      "SELECT `TABLE_NAME` AS `name`, `TABLE_COLLATION` AS `collation` FROM `information_schema`.`TABLES` WHERE `TABLE_SCHEMA` = ? AND `TABLE_TYPE` = 'BASE TABLE'",
      [this.databaseName]
    )
    const columns = await this.executor.execute<Array<{ tableName: string; name: string; columnType: string; collation: string | null; isNullable: string; columnDefault: string | number | null; extra: string }>>(
      'SELECT `TABLE_NAME` AS `tableName`, `COLUMN_NAME` AS `name`, `COLUMN_TYPE` AS `columnType`, `COLLATION_NAME` AS `collation`, `IS_NULLABLE` AS `isNullable`, `COLUMN_DEFAULT` AS `columnDefault`, `EXTRA` AS `extra` FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA` = ?',
      [this.databaseName]
    )
    const indexes = await this.executor.execute<Array<{ tableName: string; name: string; nonUnique: number; indexType: string; sequence: number; columnName: string; subPart: number | null }>>(
      'SELECT `TABLE_NAME` AS `tableName`, `INDEX_NAME` AS `name`, `NON_UNIQUE` AS `nonUnique`, `INDEX_TYPE` AS `indexType`, `SEQ_IN_INDEX` AS `sequence`, `COLUMN_NAME` AS `columnName`, `SUB_PART` AS `subPart` FROM `information_schema`.`STATISTICS` WHERE `TABLE_SCHEMA` = ? ORDER BY `TABLE_NAME`, `INDEX_NAME`, `SEQ_IN_INDEX`',
      [this.databaseName]
    )
    const foreignKeys = await this.executor.execute<Array<{ tableName: string; name: string; columns: string; referencedTable: string; referencedColumns: string; updateRule: string; deleteRule: string }>>(
      "SELECT k.`TABLE_NAME` AS `tableName`, k.`CONSTRAINT_NAME` AS `name`, GROUP_CONCAT(k.`COLUMN_NAME` ORDER BY k.`ORDINAL_POSITION`) AS `columns`, k.`REFERENCED_TABLE_NAME` AS `referencedTable`, GROUP_CONCAT(k.`REFERENCED_COLUMN_NAME` ORDER BY k.`ORDINAL_POSITION`) AS `referencedColumns`, r.`UPDATE_RULE` AS `updateRule`, r.`DELETE_RULE` AS `deleteRule` FROM `information_schema`.`KEY_COLUMN_USAGE` k JOIN `information_schema`.`REFERENTIAL_CONSTRAINTS` r ON r.`CONSTRAINT_SCHEMA` = k.`CONSTRAINT_SCHEMA` AND r.`TABLE_NAME` = k.`TABLE_NAME` AND r.`CONSTRAINT_NAME` = k.`CONSTRAINT_NAME` WHERE k.`CONSTRAINT_SCHEMA` = ? AND k.`REFERENCED_TABLE_NAME` IS NOT NULL GROUP BY k.`TABLE_NAME`, k.`CONSTRAINT_NAME`, k.`REFERENCED_TABLE_NAME`, r.`UPDATE_RULE`, r.`DELETE_RULE`",
      [this.databaseName]
    )
    const tableMap = new Map(tables.map((table) => [String(table.name), String(table.collation ?? '')]))
    let version = 0
    const settingsColumns = new Set(columns.filter((column) => column.tableName === 'tb_settings').map((column) => column.name))
    if (tableMap.has('tb_settings') && settingsColumns.has('key') && settingsColumns.has('value')) {
      const rows = await this.executor.execute<Array<{ value: string | number }>>('SELECT `value` FROM `tb_settings` WHERE `key` = ? LIMIT 1', ['updated'])
      version = Number(rows[0]?.value ?? 0)
    }
    return Object.freeze({
      tables: tableMap,
      columns: Object.freeze(columns.map((column) => Object.freeze({ ...column }))),
      indexes: Object.freeze(indexes.map((index) => Object.freeze({ ...index }))),
      foreignKeys: Object.freeze(foreignKeys.map((foreignKey) => Object.freeze({ ...foreignKey }))),
      version: Number.isSafeInteger(version) && version > 0 ? version : 0
    })
  }
}

export function buildSchemaMigrationPlan(
  schemaSql: string,
  viewsSql: string,
  snapshot: SchemaSnapshot,
  targetVersion: number
): SchemaMigrationPlan {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) throw new Error('The target database version is invalid')
  if (snapshot.version > targetVersion) throw new Error(`The database schema version ${snapshot.version} is newer than supported version ${targetVersion}`)
  const tables = parseTableContracts(schemaSql)
  const views = parseViewContracts(viewsSql)
  if (tables.length === 0) throw new Error('The schema does not contain any table contracts')
  if (!tables.some((table) => table.name === 'tb_settings')) throw new Error('The schema does not contain the settings version table')
  const statements: string[] = []
  const missingTables = new Set(tables.filter((table) => !snapshot.tables.has(table.name)).map((table) => table.name))
  const upgradeExistingDatabase = snapshot.tables.size > 0 && snapshot.version < targetVersion
  const actualColumns = groupedColumns(snapshot.columns)
  const columnsNeedingModification = new Set<string>()
  for (const table of tables) {
    const columns = actualColumns.get(table.name)
    if (columns === undefined) continue
    for (const expected of table.columns) {
      const actual = columns.get(expected.name)
      if (actual !== undefined && columnRequiresModification(expected, actual)) columnsNeedingModification.add(`${table.name}:${expected.name}`)
    }
  }
  const droppedIndexes = new Set<string>()
  const droppedForeignKeys = new Set<string>()
  let convertedTables = 0
  let addedColumns = 0
  let modifiedColumns = 0
  let addedIndexes = 0
  let replacedIndexes = 0
  let addedForeignKeys = 0
  let retainedExtraColumns = 0

  for (const table of tables) {
    if (missingTables.has(table.name)) continue
    const expectedForeignKeyNames = new Set(table.foreignKeys.map((foreignKey) => foreignKey.name))
    const expectedForeignKeyColumns = new Set(table.foreignKeys.map((foreignKey) => foreignKeyLocalColumns(foreignKey.definition)))
    for (const foreignKey of snapshot.foreignKeys) {
      if (foreignKey.tableName !== table.name) continue
      const localColumns = normalizedFields(foreignKey.columns)
      if (!expectedForeignKeyNames.has(foreignKey.name) && !expectedForeignKeyColumns.has(localColumns)) continue
      const exact = table.foreignKeys.some((expected) => `${table.name}:${expected.signature}` === foreignKeySignature(foreignKey))
      const touchesModifiedColumn = localColumns.split(',').some((column) => columnsNeedingModification.has(`${table.name}:${column}`)) || normalizedFields(foreignKey.referencedColumns).split(',').some((column) => columnsNeedingModification.has(`${foreignKey.referencedTable}:${column}`))
      if (!upgradeExistingDatabase && exact && !touchesModifiedColumn) continue
      statements.push(`ALTER TABLE ${identifier(table.name)} DROP FOREIGN KEY ${identifier(foreignKey.name)}`)
      droppedForeignKeys.add(`${foreignKey.tableName}:${foreignKey.name}`)
    }
  }

  if (upgradeExistingDatabase) {
    const actualIndexes = groupedIndexes(snapshot.indexes)
    for (const table of tables) {
      if (missingTables.has(table.name)) continue
      const indexes = actualIndexes.get(table.name) ?? new Map<string, string>()
      for (const index of table.indexes) {
        if (index.primary || !indexes.has(index.name)) continue
        statements.push(`ALTER TABLE ${identifier(table.name)} DROP INDEX ${identifier(index.name)}`)
        droppedIndexes.add(`${table.name}:${index.name}`)
      }
    }
  }

  for (const table of tables) {
    if (missingTables.has(table.name)) {
      statements.push(table.createWithoutForeignKeys)
      continue
    }
    if (snapshot.tables.get(table.name)?.toLowerCase() !== 'utf8mb4_unicode_ci') {
      statements.push(`ALTER TABLE ${identifier(table.name)} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      convertedTables += 1
    }
  }

  const actualIndexes = groupedIndexes(snapshot.indexes)
  for (const table of tables) {
    if (missingTables.has(table.name)) continue
    const columns = actualColumns.get(table.name) ?? new Map<string, ActualColumn>()
    const expectedNames = new Set(table.columns.map((column) => column.name))
    retainedExtraColumns += [...columns.keys()].filter((name) => !expectedNames.has(name)).length
    for (const column of table.columns) {
      const actual = columns.get(column.name)
      if (actual === undefined) {
        statements.push(`ALTER TABLE ${identifier(table.name)} ADD COLUMN ${identifier(column.name)} ${column.definition}`)
        addedColumns += 1
      }
    }
  }

  const dataUpgrade = buildDataUpgradePlan(snapshot, targetVersion)
  statements.push(...dataUpgrade.beforeColumnChanges)

  for (const table of tables) {
    if (missingTables.has(table.name)) continue
    const columns = actualColumns.get(table.name) ?? new Map<string, ActualColumn>()
    for (const column of table.columns) {
      const actual = columns.get(column.name)
      if (actual !== undefined && columnRequiresModification(column, actual)) {
        statements.push(`ALTER TABLE ${identifier(table.name)} MODIFY COLUMN ${identifier(column.name)} ${column.definition}`)
        modifiedColumns += 1
      }
    }
  }

  statements.push(...dataUpgrade.afterColumnChanges)
  statements.push(...dataUpgrade.cleanup)

  for (const table of tables) {
    if (missingTables.has(table.name)) continue
    const indexes = actualIndexes.get(table.name) ?? new Map<string, string>()
    for (const index of table.indexes) {
      const wasDropped = droppedIndexes.has(`${table.name}:${index.name}`)
      const actualSignature = wasDropped ? undefined : indexes.get(index.name)
      if (actualSignature === undefined) {
        statements.push(`ALTER TABLE ${identifier(table.name)} ADD ${index.definition}`)
        if (wasDropped) replacedIndexes += 1
        else addedIndexes += 1
      } else if (actualSignature !== index.signature) {
        if (index.primary) throw new Error(`The primary key for ${table.name} does not match the expected schema`)
        statements.push(`ALTER TABLE ${identifier(table.name)} DROP INDEX ${identifier(index.name)}, ADD ${index.definition}`)
        replacedIndexes += 1
      }
    }
  }

  const actualForeignKeys = new Set(snapshot.foreignKeys.filter((foreignKey) => !droppedForeignKeys.has(`${foreignKey.tableName}:${foreignKey.name}`)).map(foreignKeySignature))
  for (const table of tables) {
    for (const foreignKey of table.foreignKeys) {
      if (actualForeignKeys.has(`${table.name}:${foreignKey.signature}`)) continue
      statements.push(`ALTER TABLE ${identifier(table.name)} ADD ${foreignKey.definition}`)
      addedForeignKeys += 1
    }
  }

  statements.push(...dataUpgrade.removeArtifacts)
  for (const view of views) statements.push(view.createOrReplace)
  statements.push("INSERT IGNORE INTO `tb_settings` (`key`, `value`) VALUES ('updated', ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)".replace('?', String(targetVersion)))

  return Object.freeze({
    statements: Object.freeze(statements),
    createdTables: missingTables.size,
    convertedTables,
    addedColumns,
    modifiedColumns,
    addedIndexes,
    replacedIndexes,
    addedForeignKeys,
    replacedViews: views.length,
    retainedExtraColumns,
    dataUpgradeStatements: dataUpgrade.beforeColumnChanges.length + dataUpgrade.afterColumnChanges.length,
    cleanupStatements: dataUpgrade.cleanup.length,
    removedLegacyArtifacts: dataUpgrade.removeArtifacts.length,
    previousVersion: snapshot.version,
    targetVersion
  })
}

function buildDataUpgradePlan(snapshot: SchemaSnapshot, targetVersion: number): DataUpgradePlan {
  const empty = Object.freeze({
    beforeColumnChanges: Object.freeze([]),
    afterColumnChanges: Object.freeze([]),
    cleanup: Object.freeze([]),
    removeArtifacts: Object.freeze([])
  })
  if (snapshot.tables.size === 0 || snapshot.version >= targetVersion) return empty

  const columns = groupedColumns(snapshot.columns)
  const hasTable = (table: string): boolean => snapshot.tables.has(table)
  const hasColumn = (table: string, column: string): boolean => columns.get(table)?.has(column) === true
  const beforeColumnChanges: string[] = []
  const afterColumnChanges: string[] = []
  const cleanup: string[] = []
  const removeArtifacts: string[] = []

  if (hasTable('tb_settings') && hasColumn('tb_settings', 'key') && hasColumn('tb_settings', 'value')) {
    beforeColumnChanges.push("UPDATE `tb_settings` SET `value` = 'jwplayer' WHERE `key` LIKE 'jwplayer-%'")
    cleanup.push("DELETE FROM `tb_settings` WHERE `key` IN ('custom-hostnames', 'download-urls', 'update_vw_videos', 'update_indexes_constraits')")
    cleanup.push('DELETE newer FROM `tb_settings` newer JOIN `tb_settings` keeper ON newer.`key` = keeper.`key` AND newer.`id` > keeper.`id`')
  }

  if (hasTable('tb_videos') && hasColumn('tb_videos', 'id')) {
    if (hasColumn('tb_videos', 'title')) beforeColumnChanges.push('UPDATE `tb_videos` SET `title` = LEFT(`title`, 255) WHERE CHAR_LENGTH(`title`) > 255')
    if (hasColumn('tb_videos', 'host_id')) beforeColumnChanges.push('UPDATE `tb_videos` SET `host_id` = LEFT(`host_id`, 2048) WHERE CHAR_LENGTH(`host_id`) > 2048')
    if (hasColumn('tb_videos', 'poster')) beforeColumnChanges.push('UPDATE `tb_videos` SET `poster` = LEFT(`poster`, 2048) WHERE CHAR_LENGTH(`poster`) > 2048')
    if (hasColumn('tb_videos', 'host')) {
      beforeColumnChanges.push("UPDATE `tb_videos` SET `host` = 'earnvids' WHERE `host` IN ('vidhide', 'filelions')")
      beforeColumnChanges.push("UPDATE `tb_videos` SET `host` = 'goodstream' WHERE `host` = 'goodstream1'")
      beforeColumnChanges.push("UPDATE `tb_videos` SET `host` = 'streamhg' WHERE `host` = 'streamwish'")
    }
    if (hasTable('tb_videos_short') && hasColumn('tb_videos_short', 'vid') && hasColumn('tb_videos_short', 'key')) {
      beforeColumnChanges.push("UPDATE `tb_videos` video LEFT JOIN `tb_videos_short` legacy ON legacy.`vid` = video.`id` SET video.`slug` = COALESCE(NULLIF(LEFT(legacy.`key`, 150), ''), CAST(UUID() AS CHAR(36))) WHERE video.`slug` IS NULL OR video.`slug` = ''")
    } else {
      beforeColumnChanges.push("UPDATE `tb_videos` SET `slug` = CAST(UUID() AS CHAR(36)) WHERE `slug` IS NULL OR `slug` = ''")
    }
    beforeColumnChanges.push('DROP TEMPORARY TABLE IF EXISTS `gplayer_duplicate_slugs`')
    beforeColumnChanges.push("CREATE TEMPORARY TABLE `gplayer_duplicate_slugs` (`slug` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL, `keep_id` bigint(20) unsigned NOT NULL, PRIMARY KEY (`slug`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci AS SELECT `slug`, MIN(`id`) AS `keep_id` FROM `tb_videos` WHERE `slug` IS NOT NULL AND `slug` <> '' GROUP BY `slug` HAVING COUNT(*) > 1")
    beforeColumnChanges.push('UPDATE `tb_videos` video JOIN `gplayer_duplicate_slugs` duplicate ON duplicate.`slug` = video.`slug` AND duplicate.`keep_id` <> video.`id` SET video.`slug` = CAST(UUID() AS CHAR(36))')
    beforeColumnChanges.push('DROP TEMPORARY TABLE `gplayer_duplicate_slugs`')
  }

  const statsUaColumn = columns.get('tb_stats_ua')?.get('ua')
  const statsColumn = columns.get('tb_stats')?.get('ua')
  const rawStatsUserAgent = statsColumn !== undefined && !isNumericColumnType(statsColumn.columnType)
  if (hasTable('tb_stats_ua') && statsUaColumn !== undefined) {
    beforeColumnChanges.push('UPDATE `tb_stats_ua` SET `ua` = LEFT(`ua`, 255) WHERE CHAR_LENGTH(`ua`) > 255')
    if (!rawStatsUserAgent && hasTable('tb_stats') && statsColumn !== undefined) {
      beforeColumnChanges.push('UPDATE `tb_stats` stat JOIN `tb_stats_ua` duplicate ON duplicate.`id` = stat.`ua` JOIN (SELECT `ua`, MIN(`id`) AS `keep_id` FROM `tb_stats_ua` GROUP BY `ua` HAVING COUNT(*) > 1) keeper ON keeper.`ua` = duplicate.`ua` SET stat.`ua` = keeper.`keep_id` WHERE stat.`ua` <> keeper.`keep_id`')
    }
    beforeColumnChanges.push('DELETE duplicate FROM `tb_stats_ua` duplicate JOIN `tb_stats_ua` keeper ON duplicate.`ua` = keeper.`ua` AND duplicate.`id` > keeper.`id`')
  }

  if (rawStatsUserAgent && hasTable('tb_stats') && hasColumn('tb_stats', 'id')) {
    beforeColumnChanges.push('DROP TEMPORARY TABLE IF EXISTS `gplayer_stats_ua_upgrade`')
    beforeColumnChanges.push('CREATE TEMPORARY TABLE `gplayer_stats_ua_upgrade` (`id` bigint(20) unsigned NOT NULL, `ua` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci')
    beforeColumnChanges.push('INSERT INTO `gplayer_stats_ua_upgrade` (`id`, `ua`) SELECT `id`, LEFT(CAST(`ua` AS CHAR), 255) FROM `tb_stats`')
    beforeColumnChanges.push("INSERT INTO `tb_stats_ua` (`ua`) SELECT legacy.`ua` FROM (SELECT DISTINCT `ua` FROM `gplayer_stats_ua_upgrade` WHERE `ua` <> '') legacy LEFT JOIN `tb_stats_ua` existing ON existing.`ua` = legacy.`ua` WHERE existing.`id` IS NULL")
    beforeColumnChanges.push("UPDATE `tb_stats` SET `ua` = '0'")
    afterColumnChanges.push('UPDATE `tb_stats` stat JOIN `gplayer_stats_ua_upgrade` legacy ON legacy.`id` = stat.`id` JOIN `tb_stats_ua` user_agent ON user_agent.`ua` = legacy.`ua` SET stat.`ua` = user_agent.`id`')
    afterColumnChanges.push("DELETE stat FROM `tb_stats` stat JOIN `gplayer_stats_ua_upgrade` legacy ON legacy.`id` = stat.`id` WHERE legacy.`ua` = ''")
    afterColumnChanges.push('DROP TEMPORARY TABLE `gplayer_stats_ua_upgrade`')
  }

  if (hasTable('tb_videos_hash') && hasColumn('tb_videos_hash', 'data')) {
    beforeColumnChanges.push("UPDATE `tb_videos_hash` SET `data` = '' WHERE `data` IS NULL OR `data` = '{}'")
  }

  if (hasTable('tb_maxmind') && hasColumn('tb_maxmind', 'id') && hasColumn('tb_maxmind', 'ip')) {
    cleanup.push('DELETE duplicate FROM `tb_maxmind` duplicate JOIN `tb_maxmind` keeper ON duplicate.`ip` = keeper.`ip` AND duplicate.`id` > keeper.`id`')
  }

  if (hasTable('tb_gdrive_duplicate') && hasTable('tb_gdrive_auth')) cleanup.push('DELETE duplicate FROM `tb_gdrive_duplicate` duplicate LEFT JOIN `tb_gdrive_auth` account ON duplicate.`gdrive_email` = account.`email` WHERE account.`email` IS NULL')
  if (hasTable('tb_gdrive_mirrors') && hasTable('tb_gdrive_auth')) cleanup.push('DELETE mirror FROM `tb_gdrive_mirrors` mirror LEFT JOIN `tb_gdrive_auth` account ON mirror.`mirror_email` = account.`email` WHERE account.`email` IS NULL')
  if (hasTable('tb_subtitle_manager') && hasTable('tb_users')) cleanup.push('DELETE subtitle FROM `tb_subtitle_manager` subtitle LEFT JOIN `tb_users` user ON subtitle.`uid` = user.`id` WHERE user.`id` IS NULL')
  if (hasTable('tb_subtitles') && hasTable('tb_users')) cleanup.push('DELETE subtitle FROM `tb_subtitles` subtitle LEFT JOIN `tb_users` user ON subtitle.`uid` = user.`id` WHERE user.`id` IS NULL')
  if (hasTable('tb_sessions') && hasTable('tb_users')) cleanup.push('DELETE session FROM `tb_sessions` session LEFT JOIN `tb_users` user ON session.`username` = user.`user` WHERE user.`user` IS NULL')
  if (hasTable('tb_videos') && hasTable('tb_users')) cleanup.push('DELETE video FROM `tb_videos` video LEFT JOIN `tb_users` user ON video.`uid` = user.`id` WHERE user.`id` IS NULL')
  if (hasTable('tb_subtitles') && hasTable('tb_videos')) cleanup.push('DELETE subtitle FROM `tb_subtitles` subtitle LEFT JOIN `tb_videos` video ON subtitle.`vid` = video.`id` WHERE video.`id` IS NULL')
  if (hasTable('tb_videos_alternatives') && hasTable('tb_videos')) cleanup.push('DELETE alternative FROM `tb_videos_alternatives` alternative LEFT JOIN `tb_videos` video ON alternative.`vid` = video.`id` WHERE video.`id` IS NULL')
  if (hasTable('tb_stats') && hasTable('tb_videos')) cleanup.push('DELETE stat FROM `tb_stats` stat LEFT JOIN `tb_videos` video ON stat.`vid` = video.`id` WHERE video.`id` IS NULL')
  if (hasTable('tb_stats') && hasTable('tb_stats_ua')) cleanup.push('DELETE stat FROM `tb_stats` stat LEFT JOIN `tb_stats_ua` user_agent ON stat.`ua` = user_agent.`id` WHERE user_agent.`id` IS NULL')
  if (hasTable('tb_videos_sources') && hasTable('tb_loadbalancers')) cleanup.push('UPDATE `tb_videos_sources` source LEFT JOIN `tb_loadbalancers` server ON source.`sid` = server.`id` SET source.`sid` = NULL WHERE source.`sid` IS NOT NULL AND server.`id` IS NULL')

  for (const table of ['bk_videos', 'bk_videos_short', 'bk_maxmind', 'bk_stats', 'bk_stats_ua', 'tb_videos_short', 'tb_stats_recap', 'tb_tmp_videos_sources', 'tb_plugins2']) {
    if (hasTable(table)) removeArtifacts.push(`DROP TABLE IF EXISTS ${identifier(table)}`)
  }
  removeArtifacts.push('DROP VIEW IF EXISTS `vw_stats`')

  return Object.freeze({
    beforeColumnChanges: Object.freeze(beforeColumnChanges),
    afterColumnChanges: Object.freeze(afterColumnChanges),
    cleanup: Object.freeze(cleanup),
    removeArtifacts: Object.freeze(removeArtifacts)
  })
}

export function parseSchemaInventory(schemaSql: string, viewsSql: string): Readonly<{ tables: readonly string[]; views: readonly string[] }> {
  return Object.freeze({
    tables: Object.freeze(parseTableContracts(schemaSql).map((table) => table.name)),
    views: Object.freeze(parseViewContracts(viewsSql).map((view) => view.name))
  })
}

function parseTableContracts(source: string): readonly TableContract[] {
  const normalized = source.replaceAll('\r\n', '\n')
  const result: TableContract[] = []
  const pattern = /CREATE TABLE IF NOT EXISTS `([^`]+)`\s*\(([\s\S]*?)\n\)\s*(ENGINE=[^;]+);/g
  for (const match of normalized.matchAll(pattern)) {
    const name = validatedName(match[1] ?? '')
    const rawItems = (match[2] ?? '').split('\n').map((line) => line.trim().replace(/,$/, '')).filter(Boolean)
    const columns: ColumnContract[] = []
    const indexes: IndexContract[] = []
    const foreignKeys: ForeignKeyContract[] = []
    for (const item of rawItems) {
      const column = item.match(/^`([^`]+)`\s+(.+)$/)
      if (column !== null) {
        columns.push(Object.freeze({ name: validatedName(column[1] ?? ''), definition: column[2] ?? '' }))
        continue
      }
      if (/^(?:PRIMARY KEY|UNIQUE KEY|FULLTEXT KEY|KEY)\b/.test(item)) {
        indexes.push(indexContract(item))
        continue
      }
      if (/^CONSTRAINT\b/.test(item)) foreignKeys.push(foreignKeyContract(item))
    }
    if (columns.length === 0) throw new Error(`Table ${name} does not contain columns`)
    const createItems = rawItems.filter((item) => !/^CONSTRAINT\b/.test(item))
    result.push(Object.freeze({
      name,
      columns: Object.freeze(columns),
      indexes: Object.freeze(indexes),
      foreignKeys: Object.freeze(foreignKeys),
      createWithoutForeignKeys: `CREATE TABLE IF NOT EXISTS ${identifier(name)} (\n  ${createItems.join(',\n  ')}\n) ${match[3] ?? ''}`
    }))
  }
  return Object.freeze(result)
}

function parseViewContracts(source: string): readonly ViewContract[] {
  const normalized = source.replaceAll('\r\n', '\n')
  const result: ViewContract[] = []
  const pattern = /CREATE\s+ALGORITHM=UNDEFINED\s+SQL SECURITY DEFINER\s+VIEW\s+`([^`]+)`\s+AS\s+([\s\S]*?)\s*;/gi
  for (const match of normalized.matchAll(pattern)) {
    const name = validatedName(match[1] ?? '')
    result.push(Object.freeze({
      name,
      createOrReplace: `CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY INVOKER VIEW ${identifier(name)} AS ${String(match[2] ?? '').trim()}`
    }))
  }
  return Object.freeze(result)
}

function indexContract(definition: string): IndexContract {
  const primary = definition.startsWith('PRIMARY KEY')
  const name = primary ? 'PRIMARY' : validatedName(definition.match(/^(?:UNIQUE |FULLTEXT )?KEY\s+`([^`]+)`/)?.[1] ?? '')
  const kind = primary ? 'PRIMARY' : definition.startsWith('UNIQUE KEY') ? 'UNIQUE' : definition.startsWith('FULLTEXT KEY') ? 'FULLTEXT' : 'INDEX'
  const fields = definition.match(/\((.*)\)$/)?.[1]
  if (fields === undefined) throw new Error(`Index ${name} has an invalid definition`)
  return Object.freeze({ name, definition, signature: `${kind}:${normalizedFields(fields)}`, primary })
}

function foreignKeyContract(definition: string): ForeignKeyContract {
  const match = definition.match(/^CONSTRAINT\s+`([^`]+)`\s+FOREIGN KEY\s+\(([^)]+)\)\s+REFERENCES\s+`([^`]+)`\s+\(([^)]+)\)(.*)$/i)
  if (match === null) throw new Error('A foreign-key definition is invalid')
  const name = validatedName(match[1] ?? '')
  const updateRule = normalizedRule(match[5]?.match(/ON UPDATE\s+([A-Z ]+?)(?:\s+ON DELETE|$)/i)?.[1] ?? 'RESTRICT')
  const deleteRule = normalizedRule(match[5]?.match(/ON DELETE\s+([A-Z ]+?)(?:\s+ON UPDATE|$)/i)?.[1] ?? 'RESTRICT')
  const signature = `${normalizedFields(match[2] ?? '')}->${validatedName(match[3] ?? '')}(${normalizedFields(match[4] ?? '')}):${updateRule}:${deleteRule}`
  return Object.freeze({ name, definition, signature })
}

function groupedColumns(columns: readonly ActualColumn[]): Map<string, Map<string, ActualColumn>> {
  const result = new Map<string, Map<string, ActualColumn>>()
  for (const column of columns) {
    const table = result.get(column.tableName) ?? new Map<string, ActualColumn>()
    table.set(column.name, column)
    result.set(column.tableName, table)
  }
  return result
}

function groupedIndexes(indexes: readonly ActualIndex[]): Map<string, Map<string, string>> {
  const rows = new Map<string, Map<string, ActualIndex[]>>()
  for (const index of indexes) {
    const table = rows.get(index.tableName) ?? new Map<string, ActualIndex[]>()
    const values = table.get(index.name) ?? []
    values.push(index)
    table.set(index.name, values)
    rows.set(index.tableName, table)
  }
  const result = new Map<string, Map<string, string>>()
  for (const [tableName, table] of rows) {
    const signatures = new Map<string, string>()
    for (const [name, values] of table) {
      const sorted = [...values].sort((left, right) => left.sequence - right.sequence)
      const first = sorted[0]
      const kind = name === 'PRIMARY' ? 'PRIMARY' : first?.indexType.toUpperCase() === 'FULLTEXT' ? 'FULLTEXT' : Number(first?.nonUnique ?? 1) === 0 ? 'UNIQUE' : 'INDEX'
      const fields = sorted.map((value) => `${value.columnName.toLowerCase()}${value.subPart === null ? '' : `(${value.subPart})`}`).join(',')
      signatures.set(name, `${kind}:${fields}`)
    }
    result.set(tableName, signatures)
  }
  return result
}

function columnRequiresModification(expected: ColumnContract, actual: ActualColumn): boolean {
  const desired = expected.definition.toLowerCase()
  const type = desired.match(/^([a-z]+)(?:\(([^)]+)\))?/) ?? []
  const actualType = actual.columnType.toLowerCase()
  const current = actualType.match(/^([a-z]+)(?:\(([^)]+)\))?/) ?? []
  if (type[1] !== current[1]) return true
  if (!['tinyint', 'smallint', 'mediumint', 'int', 'bigint'].includes(String(type[1] ?? '')) && String(type[2] ?? '') !== String(current[2] ?? '')) return true
  if (desired.includes(' unsigned') && !actualType.includes(' unsigned')) return true
  const desiredCollation = desired.match(/collate\s+([a-z0-9_]+)/)?.[1]
  if (desiredCollation !== undefined && desiredCollation !== String(actual.collation ?? '').toLowerCase()) return true
  if (actual.isNullable !== undefined) {
    const nullable = String(actual.isNullable).toUpperCase() === 'YES' || actual.isNullable === true
    const expectedNullable = /(?:^|\s)NULL(?:\s|$)/i.test(expected.definition) && !/(?:^|\s)NOT NULL(?:\s|$)/i.test(expected.definition)
    if (nullable !== expectedNullable) return true
  }
  if ('columnDefault' in actual) {
    const expectedDefault = expected.definition.match(/DEFAULT\s+(NULL|'(?:''|[^'])*'|"(?:""|[^"])*"|[^\s]+)/i)?.[1]
    const normalizedExpectedDefault = expectedDefault === undefined || expectedDefault.toUpperCase() === 'NULL'
      ? null
      : expectedDefault.replace(/^(['"])(.*)\1$/, '$2').replaceAll("''", "'").replaceAll('""', '"')
    const actualDefault = actual.columnDefault === null || actual.columnDefault === undefined ? null : String(actual.columnDefault)
    const normalizedActualDefault = actualDefault?.toUpperCase() === 'NULL' ? null : actualDefault
    if (normalizedActualDefault !== normalizedExpectedDefault) return true
  }
  if (actual.extra !== undefined && /\bauto_increment\b/i.test(expected.definition) !== /\bauto_increment\b/i.test(actual.extra)) return true
  return false
}

function foreignKeySignature(value: ActualForeignKey): string {
  return `${value.tableName}:${normalizedFields(value.columns)}->${validatedName(value.referencedTable)}(${normalizedFields(value.referencedColumns)}):${normalizedRule(value.updateRule)}:${normalizedRule(value.deleteRule)}`
}

function foreignKeyLocalColumns(definition: string): string {
  const fields = definition.match(/FOREIGN KEY\s+\(([^)]+)\)/i)?.[1]
  if (fields === undefined) throw new Error('A foreign-key definition is invalid')
  return normalizedFields(fields)
}

function isNumericColumnType(columnType: string): boolean {
  return /^(?:tinyint|smallint|mediumint|int|bigint)(?:\(|\s|$)/i.test(columnType.trim())
}

function normalizedFields(value: string): string {
  return value.split(',').map((field) => field.trim().replaceAll('`', '').replaceAll(' ', '').toLowerCase()).join(',')
}

function normalizedRule(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ').toUpperCase()
  return normalized === 'NO ACTION' ? 'RESTRICT' : normalized
}

function identifier(value: string): string {
  return `\`${validatedName(value)}\``
}

function validatedName(value: string): string {
  if (!/^[A-Za-z0-9_$-]{1,64}$/.test(value)) throw new Error('The schema contains an invalid identifier')
  return value
}
