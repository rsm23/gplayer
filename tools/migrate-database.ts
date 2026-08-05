import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { SchemaMigrator, type SchemaSqlValue } from '../src/database/schema-migrator.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(path.join(projectRoot, 'docs/parity-manifest.json'), 'utf8')) as { database?: { version?: number } }
const schemaSql = await readFile(path.join(projectRoot, 'resources/mysql/mysql.sql'), 'utf8')
const viewsSql = await readFile(path.join(projectRoot, 'resources/mysql/views.sql'), 'utf8')
const databaseName = process.env.DB_MASTER_NAME?.trim() || 'gplayer'
const targetVersion = Number(manifest.database?.version ?? 0)
const socketPath = process.env.DB_MASTER_SOCKET?.trim()

const connection = await mysql.createConnection({
  ...(socketPath === undefined || socketPath === ''
    ? { host: process.env.DB_MASTER_HOST ?? '127.0.0.1', port: Number(process.env.DB_MASTER_PORT ?? 3306) }
    : { socketPath }),
  database: databaseName,
  user: process.env.DB_MASTER_USER ?? 'root',
  password: process.env.DB_MASTER_PASSWORD ?? '',
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 10_000),
  charset: 'utf8mb4',
  timezone: 'Z'
})

try {
  const migrator = new SchemaMigrator({
    execute: async <T>(sql: string, values: readonly SchemaSqlValue[] = []): Promise<T> => {
      const [result] = await connection.query(sql, [...values])
      return result as T
    }
  }, databaseName, schemaSql, viewsSql, targetVersion)
  const result = await migrator.migrate()
  process.stdout.write(`Database migration completed: version ${result.previousVersion || 'unversioned'} -> ${result.targetVersion}; ${result.executedStatements} statements, ${result.createdTables} tables created, ${result.addedColumns} columns added, ${result.modifiedColumns} columns normalized, ${result.addedIndexes + result.replacedIndexes} indexes reconciled, ${result.addedForeignKeys} foreign keys added, ${result.dataUpgradeStatements} versioned data transformations, ${result.cleanupStatements} integrity cleanups, ${result.removedLegacyArtifacts} obsolete artifacts removed, and ${result.replacedViews} views replaced. ${result.retainedExtraColumns} extra columns were retained.\n`)
} finally {
  await connection.end()
}
