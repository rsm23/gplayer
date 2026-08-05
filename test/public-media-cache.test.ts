import { mkdtemp, mkdir, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { legacyXxh32 } from '../src/background/media-cache-path.js'
import { PublicMediaCache } from '../src/stream/public-media-cache.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

describe('PublicMediaCache', () => {
  it('uses the legacy public uploads hierarchy and xxh32 URL key', async () => {
    const root = await temporaryRoot('gplayer-public-cache-')
    const cache = new PublicMediaCache(root, new URL('https://player.example/'))
    const target = new URL('https://media.example/caption.srt?token=fixture')
    await cache.write('subtitle', target, Buffer.from('WEBVTT\n\n'), 1_024)

    await expect(cache.read('subtitle', target)).resolves.toMatchObject({
      file: path.join(root, 'uploads/subtitles/tmp', `${legacyXxh32(target.toString())}.cache`),
      url: new URL(`https://player.example/uploads/subtitles/tmp/${legacyXxh32(target.toString())}.cache`),
      size: 8
    })
  })

  it('does not publish an oversized streaming capture and removes temporary files', async () => {
    const root = await temporaryRoot('gplayer-public-cache-limit-')
    const cache = new PublicMediaCache(root, new URL('https://player.example/'))
    const target = new URL('https://media.example/poster.jpg')
    const body = Readable.toWeb(Readable.from([Buffer.alloc(32)])) as ReadableStream<Uint8Array>
    cache.capture('poster', target, body, 8)

    await expect(cache.read('poster', target)).resolves.toBeNull()
    const directory = path.join(root, 'uploads/images/tmp')
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('makes a concurrent reader wait for an atomic streaming publication', async () => {
    const root = await temporaryRoot('gplayer-public-cache-concurrent-')
    const cache = new PublicMediaCache(root, new URL('https://player.example/'))
    const target = new URL('https://media.example/poster.jpg')
    const body = Readable.toWeb(Readable.from([Buffer.from('first-'), Buffer.from('poster')])) as ReadableStream<Uint8Array>
    cache.capture('poster', target, body, 1_024)

    await expect(cache.read('poster', target)).resolves.toMatchObject({ size: 12 })
    await expect(readdir(path.join(root, 'uploads/images/tmp'))).resolves.toEqual([
      `${legacyXxh32(target.toString())}.cache`
    ])
  })

  it('rejects cache directories that resolve outside the configured public root', async () => {
    const root = await temporaryRoot('gplayer-public-cache-root-')
    const outside = await temporaryRoot('gplayer-public-cache-outside-')
    await mkdir(path.join(root, 'uploads/images'), { recursive: true })
    await symlink(outside, path.join(root, 'uploads/images/tmp'))
    const cache = new PublicMediaCache(root, new URL('https://player.example/'))

    await expect(cache.write(
      'poster',
      new URL('https://media.example/poster.jpg'),
      Buffer.from('image'),
      1_024
    )).rejects.toThrow(/escaped/)
    await expect(readdir(outside)).resolves.toEqual([])
  })
})
