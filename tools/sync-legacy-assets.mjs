import { promises as fs } from 'node:fs'
import path from 'node:path'

function sourceArgument() {
  return process.argv.slice(2).find((argument) => argument !== '--') ?? process.env.LEGACY_GDPLAYER_ROOT
}

function excludesPhp(source) {
  return !source.endsWith('.php') && !source.split(path.sep).includes('vendor')
}

async function copyDirectory(source, destination) {
  await fs.mkdir(destination, { recursive: true })
  await fs.cp(source, destination, { recursive: true, force: true, filter: excludesPhp })
}

async function main() {
  const argument = sourceArgument()
  if (!argument) throw new Error('Pass the GDPlayer source root as the first argument or set LEGACY_GDPLAYER_ROOT')

  const sourceRoot = path.resolve(argument)
  await fs.access(path.join(sourceRoot, 'composer.json'))

  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const mappings = [
    ['public', 'public'],
    ['resources', 'resources'],
    ['includes/templates', 'templates/core'],
    ['themes', 'themes']
  ]

  for (const [source, destination] of mappings) {
    await copyDirectory(path.join(sourceRoot, source), path.join(projectRoot, destination))
  }

  process.stdout.write(`Synchronized non-PHP assets from ${sourceRoot}\n`)
}

await main()
