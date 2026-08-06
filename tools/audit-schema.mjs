import 'dotenv/config'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schemaSql = await fs.readFile(path.join(projectRoot, 'resources/mysql/mysql.sql'), 'utf8')
const viewsSql = await fs.readFile(path.join(projectRoot, 'resources/mysql/views.sql'), 'utf8')
const schema = parseSchemaContract(schemaSql, viewsSql)
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

  for (const table of schema.tables) {
    if (!actualTables.has(table.name)) missing.push(`table:${table.name}`)
    for (const column of table.columns) if (!actualColumns.has(`${table.name}.${column}`)) missing.push(`column:${table.name}.${column}`)
    for (const index of table.indexes) if (!actualIndexes.has(`${table.name}.${index}`)) missing.push(`index:${table.name}.${index}`)
  }
  for (const view of schema.views) if (!actualViews.has(view)) missing.push(`view:${view}`)

  let version = 0
  if (actualTables.has('tb_settings')) {
    const [versionRows] = await connection.execute('SELECT `value` FROM `tb_settings` WHERE `key` = ? LIMIT 1', ['updated'])
    version = Number(versionRows[0]?.value ?? 0)
  }
  if (version !== schema.version) missing.push(`database-version:${version || 'missing'} (expected ${schema.version})`)

  if (missing.length > 0) {
    process.stderr.write(`Schema audit failed with ${missing.length} missing requirement(s):\n${missing.map((item) => `- ${item}`).join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`Schema audit passed: ${actualTables.size} tables, ${actualViews.size} views, database version ${version}.\n`)
  }
} finally {
  await connection.end()
}

function parseSchemaContract(schemaSource, viewSource) {
  const tables = []
  const tablePattern = /CREATE TABLE IF NOT EXISTS `([^`]+)`\s*\(([\s\S]*?)\n\)\s*ENGINE=/gu
  for (const match of schemaSource.replaceAll('\r\n', '\n').matchAll(tablePattern)) {
    const columns = []
    const indexes = []
    for (const rawLine of String(match[2] ?? '').split('\n')) {
      const line = rawLine.trim().replace(/,$/u, '')
      const column = line.match(/^`([^`]+)`\s+/u)
      if (column !== null) {
        columns.push(column[1])
        continue
      }
      if (line.startsWith('PRIMARY KEY')) {
        indexes.push('PRIMARY')
        continue
      }
      const index = line.match(/^(?:UNIQUE |FULLTEXT )?KEY\s+`([^`]+)`/u)
      if (index !== null) indexes.push(index[1])
    }
    tables.push(Object.freeze({ name: match[1], columns: Object.freeze(columns), indexes: Object.freeze(indexes) }))
  }

  const views = [...viewSource.matchAll(/\sVIEW\s+`([^`]+)`\s+AS/giu)].map((match) => match[1])
  const version = Number(schemaSource.match(/\(\s*\d+\s*,\s*'updated'\s*,\s*'(\d+)'\s*\)/u)?.[1] ?? 0)
  if (tables.length === 0 || views.length === 0 || !Number.isSafeInteger(version) || version < 1) {
    throw new Error('The bundled SQL schema contract is incomplete')
  }
  return Object.freeze({ tables: Object.freeze(tables), views: Object.freeze(views), version })
}
