import path from 'node:path'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { legacyXxh32, mediaCachePaths } from '../src/background/media-cache-path.js'
import {
  MediaDownloadWorker,
  type CachedMediaSourceRow,
  type MediaDownloadStore
} from '../src/background/media-download-worker.js'
import { MySqlMediaDownloadStore } from '../src/background/mysql-media-download-store.js'
import { registerStreamingRoutes, createStreamingProxyPath } from '../src/http/streaming-routes.js'
import { Security } from '../src/security/security.js'

function response(body: string, status = 200, headers: RequestInit['headers'] = {}): Readonly<{
  url: URL
  status: number
  statusText: string
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}> {
  const result = new Response(body, { status, headers })
  return Object.freeze({
    url: new URL('https://cdn.example/video.mp4'),
    status,
    statusText: result.statusText,
    headers: result.headers,
    body: result.body
  })
}

function cachedRow(overrides: Partial<CachedMediaSourceRow> = {}): CachedMediaSourceRow {
  return Object.freeze({
    id: '1',
    host: 'dailymotion',
    hostId: 'video-id',
    data: JSON.stringify({
      sources: [{ file: 'https://cdn.example/video.mp4', type: 'video/mp4', label: '720p' }],
      referer: 'https://provider.example/embed/video-id',
      cookies: ['session%3Dfixture']
    }),
    userAgent: 'Fixture Browser',
    language: 'fr;q=0.9',
    ...overrides
  })
}

class MemoryDownloadStore implements MediaDownloadStore {
  public rows: CachedMediaSourceRow[] = []
  public async currentServerId() { return null }
  public async listCandidates(afterId: string, limit: number) {
    return this.rows.filter((row) => Number(row.id) > Number(afterId)).slice(0, limit)
  }
}

describe('legacy media cache paths', () => {
  it('matches xxh32 vectors and contains host, ID, and normalized label paths', () => {
    expect(legacyXxh32('')).toBe('02cc5d05')
    expect(legacyXxh32('a')).toBe('550d7456')
    expect(legacyXxh32('abc')).toBe('32d153ff')
    expect(mediaCachePaths('/srv/cache', 'dailymotion', 'video-id', '720P').complete)
      .toBe(path.resolve('/srv/cache/files/dailymotion', legacyXxh32('video-id'), '720p.mp4'))
    expect(mediaCachePaths('/srv/cache', '../../outside', 'id', '../Original').complete.startsWith('/srv/cache/files/')).toBe(true)
  })
})

describe('Node-native cached media downloader', () => {
  let root = ''

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true })
    root = ''
  })

  it('downloads bounded bypass-host MP4 sources with recovered referer, origin, cookie, UA, and language headers', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-download-'))
    const store = new MemoryDownloadStore()
    store.rows = [cachedRow()]
    const requests: Headers[] = []
    const remote = {
      open: vi.fn(async (request: Readonly<{ headers?: RequestInit['headers'] }>) => {
        requests.push(new Headers(request.headers))
        return response('0123456789', 200, { 'content-length': '10' })
      })
    }
    const worker = new MediaDownloadWorker(store, remote as never, {
      baseUrl: new URL('https://player.example/'),
      cacheRoot: root,
      loadSettings: async () => ({ enabled: true, bypassHosts: ['dailymotion'] }),
      freeSpace: async () => 20 * 1_024 * 1_024 * 1_024
    })

    await expect(worker.runOnce()).resolves.toEqual({
      enabled: true,
      lowSpace: false,
      scanned: 1,
      selected: '1',
      downloaded: 1,
      resumed: 0,
      failed: 0,
      skipped: 0
    })
    const paths = mediaCachePaths(root, 'dailymotion', 'video-id', '720p')
    await expect(readFile(paths.complete, 'utf8')).resolves.toBe('0123456789')
    expect(requests[0]?.get('referer')).toBe('https://provider.example/embed/video-id')
    expect(requests[0]?.get('origin')).toBe('https://provider.example')
    expect(requests[0]?.get('cookie')).toBe('session=fixture')
    expect(requests[0]?.get('user-agent')).toBe('Fixture Browser')
    expect(requests[0]?.get('accept-language')).toBe('fr;q=0.9')
  })

  it('resumes a crash-retained temporary file with a validated content range', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-download-resume-'))
    const paths = mediaCachePaths(root, 'dailymotion', 'video-id', '720p')
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.temporary, '0123')
    const store = new MemoryDownloadStore()
    store.rows = [cachedRow()]
    const ranges: string[] = []
    const worker = new MediaDownloadWorker(store, {
      open: async (request: Readonly<{ headers?: RequestInit['headers'] }>) => {
        ranges.push(new Headers(request.headers).get('range') ?? '')
        return response('456789', 206, { 'content-range': 'bytes 4-9/10', 'content-length': '6' })
      }
    } as never, {
      baseUrl: new URL('https://player.example/'),
      cacheRoot: root,
      loadSettings: async () => ({ enabled: true, bypassHosts: ['dailymotion'] }),
      freeSpace: async () => 20 * 1_024 * 1_024 * 1_024
    })

    await expect(worker.runOnce()).resolves.toMatchObject({ downloaded: 1, resumed: 1, failed: 0 })
    expect(ranges).toEqual(['bytes=4-'])
    await expect(readFile(paths.complete, 'utf8')).resolves.toBe('0123456789')
  })

  it('restarts from byte zero when an upstream ignores Range instead of appending duplicate bytes', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-download-restart-'))
    const paths = mediaCachePaths(root, 'dailymotion', 'video-id', '720p')
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.temporary, 'partial')
    const store = new MemoryDownloadStore()
    store.rows = [cachedRow()]
    const worker = new MediaDownloadWorker(store, { open: async () => response('complete', 200, { 'content-length': '8' }) } as never, {
      baseUrl: new URL('https://player.example/'),
      cacheRoot: root,
      loadSettings: async () => ({ enabled: true, bypassHosts: ['dailymotion'] }),
      freeSpace: async () => 20 * 1_024 * 1_024 * 1_024
    })

    await expect(worker.runOnce()).resolves.toMatchObject({ downloaded: 1, resumed: 0, failed: 0 })
    await expect(readFile(paths.complete, 'utf8')).resolves.toBe('complete')
  })

  it('retains a secret-safe error marker and never starts when disabled or under the 10 GiB threshold', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-download-error-'))
    const store = new MemoryDownloadStore()
    store.rows = [cachedRow()]
    const remote = { open: vi.fn(async () => response('upstream secret body', 502)) }
    const worker = new MediaDownloadWorker(store, remote as never, {
      baseUrl: new URL('https://player.example/'),
      cacheRoot: root,
      loadSettings: async () => ({ enabled: true, bypassHosts: ['dailymotion'] }),
      freeSpace: async () => 20 * 1_024 * 1_024 * 1_024
    })
    await expect(worker.runOnce()).resolves.toMatchObject({ downloaded: 0, failed: 1 })
    const marker = await readFile(mediaCachePaths(root, 'dailymotion', 'video-id', '720p').error, 'utf8')
    expect(JSON.parse(marker)).toEqual({ status: 'failed', code: 'http-502' })
    expect(marker).not.toContain('secret')

    const disabledRemote = { open: vi.fn() }
    const disabled = new MediaDownloadWorker(store, disabledRemote as never, {
      baseUrl: new URL('https://player.example/'), cacheRoot: root,
      loadSettings: async () => ({ enabled: false, bypassHosts: ['dailymotion'] })
    })
    await expect(disabled.runOnce()).resolves.toMatchObject({ enabled: false, scanned: 0 })
    const lowSpace = new MediaDownloadWorker(store, disabledRemote as never, {
      baseUrl: new URL('https://player.example/'), cacheRoot: root,
      loadSettings: async () => ({ enabled: true, bypassHosts: ['dailymotion'] }),
      freeSpace: async () => 10 * 1_024 * 1_024 * 1_024
    })
    await expect(lowSpace.runOnce()).resolves.toMatchObject({ enabled: true, lowSpace: true, scanned: 0 })
    expect(disabledRemote.open).not.toHaveBeenCalled()
  })
})

describe('cached media playback', () => {
  let root = ''

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true })
    root = ''
  })

  it('serves complete cached MP4 files with full, HEAD, Range, and 416 responses without contacting upstream', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-cache-route-'))
    const paths = mediaCachePaths(root, 'dailymotion', 'video-id', '720p')
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.complete, '0123456789')
    const app = Fastify()
    const config = loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: 'fixture-secure-salt' })
    const remote = { open: vi.fn() }
    await registerStreamingRoutes(app, config, { remoteStream: remote as never, cacheRoot: root, loadFileCacheEnabled: async () => true })
    const target = new URL('https://cdn.example/video.mp4')
    const security = new Security(config.secureSalt)
    const identity = { host: 'dailymotion', id: 'video-id', label: '720p', title: 'Café film.mkv' }
    const route = createStreamingProxyPath('stream-vid', target, security, identity)

    const full = await app.inject({ method: 'GET', url: route })
    expect(full.statusCode).toBe(200)
    expect(full.body).toBe('0123456789')
    expect(full.headers['accept-ranges']).toBe('bytes')
    expect(full.headers['content-type']).toBe('application/octet-stream')
    expect(full.headers['content-range']).toBe('bytes 0-9/10')
    expect(full.headers['cache-control']).toBe('public, max-age=3600')
    expect(full.headers['x-cache']).toBe('HIT')
    expect(full.headers['content-disposition']).toBe("inline; filename=\"Cafe film-720p.mp4\"; filename*=UTF-8''Caf%C3%A9%20film-720p.mp4")
    const partial = await app.inject({ method: 'GET', url: route, headers: { range: 'bytes=3-6' } })
    expect(partial.statusCode).toBe(206)
    expect(partial.body).toBe('3456')
    expect(partial.headers['content-range']).toBe('bytes 3-6/10')
    const apple = await app.inject({ method: 'GET', url: route, headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' } })
    expect(apple.statusCode).toBe(200)
    expect(apple.headers['content-type']).toBe('video/mp4')
    const downloadRoute = createStreamingProxyPath('stream-vid', target, security, { ...identity, downloadable: true })
    const download = await app.inject({ method: 'GET', url: downloadRoute })
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-disposition']).toBe("attachment; filename=\"Cafe film-720p.mp4\"; filename*=UTF-8''Caf%C3%A9%20film-720p.mp4")
    const head = await app.inject({ method: 'HEAD', url: route })
    expect(head.statusCode).toBe(200)
    expect(head.body).toBe('')
    expect(head.headers['content-length']).toBe('10')
    expect(head.headers['content-range']).toBe('bytes 0-9/10')
    const invalid = await app.inject({ method: 'GET', url: route, headers: { range: 'bytes=100-200' } })
    expect(invalid.statusCode).toBe(416)
    expect(invalid.headers['content-range']).toBe('bytes */10')
    expect(remote.open).not.toHaveBeenCalled()
    await app.close()
  })

  it('retains Stream-style headers when a reverse proxy offloads a cached MP4', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gplayer-cache-offload-'))
    const paths = mediaCachePaths(root, 'dailymotion', 'offload-id', '1080p')
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.complete, '0123456789')
    const app = Fastify()
    const config = loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: 'fixture-secure-salt' })
    const remote = { open: vi.fn() }
    await registerStreamingRoutes(app, config, {
      remoteStream: remote as never,
      cacheRoot: root,
      loadCacheSettings: async () => ({ enabled: true, maxAgeSeconds: 7_200, mode: 'nginx' })
    })
    const security = new Security(config.secureSalt)
    const target = new URL('https://cdn.example/offload.mp4')
    const identity = { host: 'dailymotion', id: 'offload-id', label: '1080p', title: 'Example.mp4' }
    const route = createStreamingProxyPath('stream-vid', target, security, identity)

    const full = await app.inject({ method: 'GET', url: route })
    expect(full.statusCode).toBe(200)
    expect(full.headers['content-type']).toBe('application/octet-stream')
    expect(full.headers['content-disposition']).toBe('inline')
    expect(full.headers['cache-control']).toBe('public, max-age=7200')
    expect(full.headers['content-range']).toBeUndefined()
    expect(full.headers['x-cache']).toBeUndefined()
    expect(full.headers['x-cache-server']).toBe('HIT')
    expect(full.headers['x-accel-redirect']).toMatch(/^\/cache-files\//)

    const head = await app.inject({ method: 'HEAD', url: route })
    expect(head.statusCode).toBe(200)
    expect(head.headers['content-type']).toBe('video/mp4')
    const downloadRoute = createStreamingProxyPath('stream-vid', target, security, { ...identity, downloadable: true })
    const download = await app.inject({ method: 'GET', url: downloadRoute })
    expect(download.headers['content-disposition']).toBe("attachment; filename*=UTF-8''Example-1080p.mp4")
    expect(remote.open).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('MySQL media download store', () => {
  it('parameterizes load-balancer lookup and grouped source cursor scans', async () => {
    const reads: Array<readonly [string, readonly unknown[]]> = []
    const database = {
      read: async <T>(sql: string, values: readonly unknown[] = []): Promise<T> => {
        reads.push([sql, values])
        if (sql.includes('tb_loadbalancers')) return [{ id: 4 }] as T
        return [{ id: 9, host: 'Dailymotion', host_id: 'abc', data: '{}', ua: 'UA', lang: 'en' }] as T
      }
    }
    const store = new MySqlMediaDownloadStore(database as never)
    await expect(store.currentServerId('https://player.example/')).resolves.toBe('4')
    await expect(store.listCandidates('7', 500, '4')).resolves.toEqual([{
      id: '9', host: 'dailymotion', hostId: 'abc', data: '{}', userAgent: 'UA', language: 'en'
    }])
    expect(reads[0]?.[1]).toEqual(['https://player.example/'])
    expect(reads[0]?.[0]).toContain('FROM `tb_loadbalancers`')
    expect(reads[1]?.[1]).toEqual(['7', '4', 100])
    expect(reads.every(([sql]) => !sql.includes('player.example') && !sql.includes('Dailymotion'))).toBe(true)
  })
})
