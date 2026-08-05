import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const ignoredDirectories = new Set(['vendor', '.git', 'cache', 'tmp'])

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(absolute))
    else if (entry.isFile()) files.push(absolute)
  }
  return files
}

function relativeNames(root, files) {
  return files.map((file) => path.relative(root, file).split(path.sep).join('/')).sort()
}

function withoutExtension(file) {
  return path.basename(file, path.extname(file))
}

function filesUnder(files, prefix, extension) {
  return files.filter((file) => file.startsWith(prefix) && (!extension || file.endsWith(extension)))
}

async function phpDeclarations(root, phpFiles) {
  const declarations = []
  for (const relative of phpFiles) {
    const content = await fs.readFile(path.join(root, relative), 'utf8')
    const namespace = content.match(/namespace\s+([^;]+);/)?.[1] ?? ''
    const className = content.match(/(?:final\s+|abstract\s+)?(?:class|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1]
    const methods = [...content.matchAll(/public\s+(?:static\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1])
    if (className || methods.length > 0) declarations.push({ file: relative, namespace, className: className ?? null, publicMethods: [...new Set(methods)].sort() })
  }
  return declarations
}

function databaseSchema(sql) {
  const tables = {}
  for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS `([^`]+)` \(([\s\S]*?)\n\) ENGINE=/g)) {
    const [, name, body] = match
    const lines = body.split(/\r?\n/)
    const columns = []
    const indexes = []
    const foreignKeys = []
    for (const line of lines) {
      const column = line.match(/^\s*`([^`]+)`\s+(.+?)(?:,)?$/)
      if (column) columns.push({ name: column[1], definition: column[2] })
      const index = line.match(/^\s*(UNIQUE\s+|FULLTEXT\s+)?KEY\s+`([^`]+)`\s+\((.+)\)(?:,)?$/)
      if (index) indexes.push({ name: index[2], kind: (index[1] ?? 'INDEX').trim(), columns: index[3] })
      const foreignKey = line.match(/^\s*CONSTRAINT\s+`([^`]+)`\s+FOREIGN KEY\s+\((.+?)\)\s+REFERENCES\s+`([^`]+)`\s+\((.+?)\)(.*?)(?:,)?$/)
      if (foreignKey) foreignKeys.push({ name: foreignKey[1], columns: foreignKey[2], referencedTable: foreignKey[3], referencedColumns: foreignKey[4], actions: foreignKey[5].trim() })
    }
    tables[name] = { columns, indexes, foreignKeys }
  }

  const views = [...sql.matchAll(/CREATE[^;\n]*\sVIEW\s+`([^`]+)`\s+AS/gi)].map((match) => match[1]).sort()
  const version = Number(sql.match(/INSERT IGNORE INTO `tb_settings`[^;]+\(1, 'updated', '(\d+)'\)/s)?.[1] ?? 0)
  return { version, tables, views }
}

async function main() {
  const argumentsWithoutSeparator = process.argv.slice(2).filter((argument) => argument !== '--')
  const sourceRoot = path.resolve(argumentsWithoutSeparator[0] ?? process.env.LEGACY_GDPLAYER_ROOT ?? '')
  if (!sourceRoot || sourceRoot === path.parse(sourceRoot).root) throw new Error('Pass the GDPlayer source root as the first argument or set LEGACY_GDPLAYER_ROOT')
  await fs.access(path.join(sourceRoot, 'composer.json'))

  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const absoluteFiles = await walk(sourceRoot)
  const files = relativeNames(sourceRoot, absoluteFiles)
  const phpFiles = files.filter((file) => file.endsWith('.php'))
  const hash = createHash('sha256')
  for (const relative of files) {
    hash.update(relative)
    hash.update(await fs.readFile(path.join(sourceRoot, relative)))
  }

  const composer = JSON.parse(await fs.readFile(path.join(sourceRoot, 'composer.json'), 'utf8'))
  const mysqlSchema = await fs.readFile(path.join(sourceRoot, 'resources/mysql/mysql.sql'), 'utf8')
  const extensionCounts = Object.groupBy(files, (file) => path.extname(file).toLowerCase() || '(none)')
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: {
      product: composer.name,
      version: composer.version,
      digestSha256: hash.digest('hex'),
      fileCount: files.length,
      phpFileCount: phpFiles.length,
      twigFileCount: files.filter((file) => file.endsWith('.twig')).length,
      extensionCounts: Object.fromEntries(Object.entries(extensionCounts).map(([extension, members]) => [extension, members.length]).sort())
    },
    routes: {
      frontend: filesUnder(files, 'includes/views/frontend/', '.php').filter((file) => file.split('/').length === 4).map(withoutExtension).sort(),
      backend: filesUnder(files, 'includes/views/backend/', '.php').map((file) => file.replace('includes/views/backend/', '').replace(/\.php$/, '')).sort(),
      ajaxControllers: filesUnder(files, 'includes/classes/Ajax/', '.php').map(withoutExtension).sort()
    },
    features: {
      hostingAdapters: filesUnder(files, 'includes/classes/Hosting/', '.php').map(withoutExtension).sort(),
      databaseMigrations: filesUnder(files, 'includes/classes/Database/MySQL/Migration/', '.php').map(withoutExtension).sort(),
      backgroundWorkers: files.filter((file) => /^includes\/bg_.+\.php$/.test(file)).map(withoutExtension).sort(),
      twigTemplates: files.filter((file) => file.endsWith('.twig')),
      staticAssets: files.filter((file) => file.startsWith('public/') && !file.endsWith('.php')),
      plugins: files.filter((file) => file.startsWith('plugins/')),
      themes: files.filter((file) => file.startsWith('themes/'))
    },
    database: databaseSchema(mysqlSchema),
    phpDeclarations: await phpDeclarations(sourceRoot, phpFiles)
  }

  const output = path.join(projectRoot, 'docs', 'parity-manifest.json')
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`Wrote ${output}\n`)
  process.stdout.write(`Source ${manifest.source.product} ${manifest.source.version}: ${manifest.source.fileCount} files, ${manifest.features.hostingAdapters.length} hosting adapters, ${manifest.routes.frontend.length} frontend routes, ${manifest.routes.backend.length} backend routes\n`)
}

await main()
