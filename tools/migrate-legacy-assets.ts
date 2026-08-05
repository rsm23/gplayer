import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateLegacyAssets } from '../src/migration/legacy-asset-migrator.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argumentsList = process.argv.slice(2)
const legacyRoot = argumentsList.find((argument) => !argument.startsWith('--'))
const publicRootArgument = argumentsList.find((argument) => argument.startsWith('--public-root='))
const copyOnly = argumentsList.includes('--copy-only')

if (legacyRoot === undefined) {
  throw new Error('Usage: pnpm assets:migrate -- /absolute/path/to/legacy-install [--public-root=/absolute/path/to/public] [--copy-only]')
}

const publicRoot = publicRootArgument === undefined
  ? path.join(projectRoot, 'public')
  : publicRootArgument.slice('--public-root='.length)

const result = await migrateLegacyAssets({
  legacyRoot,
  publicRoot,
  removeSource: !copyOnly
})

process.stdout.write(`Legacy asset migration completed: ${result.copied} copied, ${result.deduplicated} already present, ${result.removedSourceFiles} source files removed, ${result.removedSourceDirectories} empty source directories removed, ${result.conflicts} conflicts, and ${result.skipped} unsafe or unreadable entries skipped.\n`)
for (const item of result.issues) {
  process.stderr.write(`- ${item.reason}: ${item.source}${item.destination === null ? '' : ` -> ${item.destination}`}\n`)
}
if (result.conflicts > 0 || result.skipped > 0) process.exitCode = 1
