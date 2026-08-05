import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { legacyXxh32 } from '../src/background/media-cache-path.js'
import { StreamCache } from '../src/stream/stream-cache.js'

let root = ''
let now = Date.now()

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gplayer-stream-cache-'))
  now = Date.now()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('StreamCache', () => {
  it('uses the recovered host, ID, URL hash hierarchy and expires stale entries', async () => {
    const cache = new StreamCache(root, () => now)
    const identity = { host: 'direct', id: 'video-id' }
    const target = new URL('https://cdn.example/path/segment.ts?token=fixture')
    await cache.writeText(identity, target, 'segment-data')

    const entry = await cache.read(identity, target, 60)
    const targetHash = legacyXxh32(target.toString())
    expect(entry?.file).toBe(path.join(root, 'files', 'direct', legacyXxh32(identity.id), targetHash.slice(0, 2), `${targetHash}.cache`))
    expect(entry?.offloadPath).toBe(`/cache-files/direct/${legacyXxh32(identity.id)}/${targetHash.slice(0, 2)}/${targetHash}.cache`)
    expect(await readFile(entry?.file ?? '', 'utf8')).toBe('segment-data')

    now += 61_000
    expect(await cache.read(identity, target, 60)).toBeNull()
  })

  it('captures an upstream stream atomically and restores safe response metadata', async () => {
    const cache = new StreamCache(root, () => now)
    const identity = { host: 'direct', id: 'stream-id' }
    const target = new URL('https://cdn.example/chunk.m4s')
    const response = new Response('stream-body', {
      headers: {
        'content-type': 'video/iso.segment',
        etag: '"fixture"',
        'x-private-upstream': 'must-not-persist'
      }
    })
    if (response.body === null) throw new Error('Expected a response body')

    cache.capture(identity, target, response.body, response.headers, 1_024)
    const entry = await cache.read(identity, target, 60)

    expect(entry).not.toBeNull()
    expect(await readFile(entry?.file ?? '', 'utf8')).toBe('stream-body')
    expect(entry?.headers).toEqual({ 'content-type': 'video/iso.segment', etag: '"fixture"' })
  })

  it('rejects oversized cache captures without publishing a partial file', async () => {
    const cache = new StreamCache(root, () => now)
    const identity = { host: 'direct', id: 'stream-id' }
    const target = new URL('https://cdn.example/oversized.ts')
    const body = new Response('too-large').body
    if (body === null) throw new Error('Expected a response body')

    cache.capture(identity, target, body, new Headers(), 3)

    expect(await cache.read(identity, target, 60)).toBeNull()
  })

  it('hashes untrusted provider labels instead of allowing a path escape', async () => {
    const cache = new StreamCache(root, () => now)
    const target = new URL('https://cdn.example/segment.ts')
    await cache.writeText({ host: '../../outside', id: '../video' }, target, 'safe')

    const entry = await cache.read({ host: '../../outside', id: '../video' }, target, 60)
    expect(entry?.file.startsWith(`${path.resolve(root, 'files')}${path.sep}`)).toBe(true)
    expect(entry?.file).toContain(`host-${legacyXxh32('../../outside')}`)
  })
})
