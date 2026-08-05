import 'dotenv/config'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'docs/parity-manifest.json'), 'utf8'))
const database = process.env.DB_MASTER_NAME ?? 'gplayer'
const socketPath = process.env.DB_MASTER_SOCKET?.trim()

const connection = await mysql.createConnection({
  ...(socketPath
    ? { socketPath }
    : { host: process.env.DB_MASTER_HOST ?? '127.0.0.1', port: Number(process.env.DB_MASTER_PORT ?? 3306) }),
  database,
  user: process.env.DB_MASTER_USER ?? 'root',
  password: process.env.DB_MASTER_PASSWORD ?? '',
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 10_000),
  charset: 'utf8mb4',
  timezone: 'Z'
})

try {
  const [tableRows] = await connection.execute(
    'SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
    [database]
  )
  const [columnRows] = await connection.execute(
    'SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?',
    [database]
  )
  const [indexRows] = await connection.execute(
    'SELECT TABLE_NAME AS tableName, INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? GROUP BY TABLE_NAME, INDEX_NAME',
    [database]
  )

  const actualTables = new Set(tableRows.filter((row) => row.type === 'BASE TABLE').map((row) => row.name))
  const actualViews = new Set(tableRows.filter((row) => row.type === 'VIEW').map((row) => row.name))
  const actualColumns = new Set(columnRows.map((row) => `${row.tableName}.${row.name}`))
  const actualIndexes = new Set(indexRows.map((row) => `${row.tableName}.${row.name}`))
  const missing = []

  for (const [table, contract] of Object.entries(manifest.database.tables)) {
    if (!actualTables.has(table)) missing.push(`table:${table}`)
    for (const column of contract.columns) if (!actualColumns.has(`${table}.${column.name}`)) missing.push(`column:${table}.${column.name}`)
    for (const index of contract.indexes) if (!actualIndexes.has(`${table}.${index.name}`)) missing.push(`index:${table}.${index.name}`)
  }
  for (const view of manifest.database.views) if (!actualViews.has(view)) missing.push(`view:${view}`)

  let version = 0
  if (actualTables.has('tb_settings')) {
    const [versionRows] = await connection.execute('SELECT `value` FROM `tb_settings` WHERE `key` = ? LIMIT 1', ['updated'])
    version = Number(versionRows[0]?.value ?? 0)
  }
  if (version !== manifest.database.version) missing.push(`database-version:${version || 'missing'} (expected ${manifest.database.version})`)

  if (missing.length > 0) {
    process.stderr.write(`Schema parity audit failed with ${missing.length} missing requirement(s):\n${missing.map((item) => `- ${item}`).join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`Schema parity audit passed: ${actualTables.size} tables, ${actualViews.size} views, database version ${version}.\n`)
  }
} finally {
  await connection.end()
}
