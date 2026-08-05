import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateLegacyAssets } from '../src/migration/legacy-asset-migrator.js'

const temporaryRoots: string[] = []

async function fixture(): Promise<Readonly<{ root: string; legacy: string; publicRoot: string }>> {
  const root = await mkdtemp(path.join(tmpdir(), 'gplayer-legacy-assets-'))
  temporaryRoots.push(root)
  return Object.freeze({ root, legacy: path.join(root, 'legacy'), publicRoot: path.join(root, 'node-public') })
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('legacy asset migrator', () => {
  it('flattens both supplied subtitle layouts and images into the Node upload roots', async () => {
    const paths = await fixture()
    await Promise.all([
      mkdir(path.join(paths.legacy, 'subtitles/nested'), { recursive: true }),
      mkdir(path.join(paths.legacy, 'uploads/subtitles'), { recursive: true }),
      mkdir(path.join(paths.legacy, 'uploads/images/posters'), { recursive: true })
    ])
    await Promise.all([
      writeFile(path.join(paths.legacy, 'subtitles/nested/one.srt'), 'caption-one'),
      writeFile(path.join(paths.legacy, 'uploads/subtitles/two.vtt'), 'WEBVTT\n\ncaption-two'),
      writeFile(path.join(paths.legacy, 'uploads/images/posters/cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    ])

    const report = await migrateLegacyAssets({ legacyRoot: paths.legacy, publicRoot: paths.publicRoot })
    expect(report).toMatchObject({ copied: 3, deduplicated: 0, removedSourceFiles: 3, conflicts: 0, skipped: 0, issues: [] })
    await expect(readFile(path.join(paths.publicRoot, 'uploads/subtitles/one.srt'), 'utf8')).resolves.toBe('caption-one')
    await expect(readFile(path.join(paths.publicRoot, 'uploads/subtitles/two.vtt'), 'utf8')).resolves.toBe('WEBVTT\n\ncaption-two')
    await expect(readFile(path.join(paths.publicRoot, 'uploads/images/cover.jpg'))).resolves.toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    await expect(access(path.join(paths.legacy, 'subtitles'))).rejects.toThrow()
    await expect(access(path.join(paths.legacy, 'uploads/subtitles'))).rejects.toThrow()
    await expect(access(path.join(paths.legacy, 'uploads/images'))).rejects.toThrow()
  })

  it('can copy without deleting the legacy source tree', async () => {
    const paths = await fixture()
    const source = path.join(paths.legacy, 'subtitles/kept.srt')
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, 'kept')
    const report = await migrateLegacyAssets({ legacyRoot: paths.legacy, publicRoot: paths.publicRoot, removeSource: false })
    expect(report).toMatchObject({ copied: 1, removedSourceFiles: 0, removedSourceDirectories: 0 })
    await expect(readFile(source, 'utf8')).resolves.toBe('kept')
    await expect(readFile(path.join(paths.publicRoot, 'uploads/subtitles/kept.srt'), 'utf8')).resolves.toBe('kept')
  })

  it('deduplicates byte-identical destinations before removing their source', async () => {
    const paths = await fixture()
    const source = path.join(paths.legacy, 'uploads/images/existing.png')
    const destination = path.join(paths.publicRoot, 'uploads/images/existing.png')
    await Promise.all([mkdir(path.dirname(source), { recursive: true }), mkdir(path.dirname(destination), { recursive: true })])
    await Promise.all([writeFile(source, 'same-bytes'), writeFile(destination, 'same-bytes')])
    const report = await migrateLegacyAssets({ legacyRoot: paths.legacy, publicRoot: paths.publicRoot })
    expect(report).toMatchObject({ copied: 0, deduplicated: 1, removedSourceFiles: 1, conflicts: 0 })
    await expect(access(source)).rejects.toThrow()
    await expect(readFile(destination, 'utf8')).resolves.toBe('same-bytes')
  })

  it('never overwrites a different destination and leaves the source recoverable', async () => {
    const paths = await fixture()
    const source = path.join(paths.legacy, 'subtitles/nested/collision.srt')
    const destination = path.join(paths.publicRoot, 'uploads/subtitles/collision.srt')
    await Promise.all([mkdir(path.dirname(source), { recursive: true }), mkdir(path.dirname(destination), { recursive: true })])
    await Promise.all([writeFile(source, 'legacy'), writeFile(destination, 'node')])
    const report = await migrateLegacyAssets({ legacyRoot: paths.legacy, publicRoot: paths.publicRoot })
    expect(report).toMatchObject({ copied: 0, conflicts: 1, removedSourceFiles: 0 })
    expect(report.issues[0]?.reason).toContain('different destination')
    await expect(readFile(source, 'utf8')).resolves.toBe('legacy')
    await expect(readFile(destination, 'utf8')).resolves.toBe('node')
  })

  it('does not follow symlinks or publish executable and server-control files', async () => {
    const paths = await fixture()
    const sourceRoot = path.join(paths.legacy, 'subtitles')
    const outside = path.join(paths.root, 'outside.srt')
    await mkdir(sourceRoot, { recursive: true })
    await Promise.all([
      writeFile(outside, 'outside'),
      writeFile(path.join(sourceRoot, 'safe.srt'), 'safe'),
      writeFile(path.join(sourceRoot, '.htaccess'), 'server-control'),
      writeFile(path.join(sourceRoot, 'payload.php'), '<?php echo 1;'),
      writeFile(path.join(sourceRoot, 'disguised.srt'), 'before <?= dangerous(); ?> after')
    ])
    await symlink(outside, path.join(sourceRoot, 'linked.srt'))
    const report = await migrateLegacyAssets({ legacyRoot: paths.legacy, publicRoot: paths.publicRoot })
    expect(report).toMatchObject({ copied: 1, skipped: 4, removedSourceFiles: 1 })
    expect(report.issues).toHaveLength(4)
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside')
    await expect(readFile(path.join(paths.publicRoot, 'uploads/subtitles/safe.srt'), 'utf8')).resolves.toBe('safe')
    await expect(access(path.join(paths.publicRoot, 'uploads/subtitles/linked.srt'))).rejects.toThrow()
    await expect(access(path.join(paths.publicRoot, 'uploads/subtitles/payload.php'))).rejects.toThrow()
    await expect(access(path.join(paths.publicRoot, 'uploads/subtitles/disguised.srt'))).rejects.toThrow()
  })

  it('rejects broad roots and source-destination overlap before copying', async () => {
    const paths = await fixture()
    await expect(migrateLegacyAssets({ legacyRoot: path.parse(paths.root).root, publicRoot: paths.publicRoot })).rejects.toThrow('too broad')
    await expect(migrateLegacyAssets({ legacyRoot: paths.legacy, publicRoot: paths.legacy })).rejects.toThrow('overlap')
  })
})
