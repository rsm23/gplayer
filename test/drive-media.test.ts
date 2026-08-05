import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { DriveMediaService } from '../src/drive/drive-media-service.js'
import type { DriveLocatedFile, DriveMediaRequest } from '../src/drive/drive-admin-service.js'
import { registerDriveMediaRoutes } from '../src/http/drive-media-routes.js'
import { Security } from '../src/security/security.js'
import { RemoteStream } from '../src/stream/remote-stream.js'

const fileId = 'sourceFileABC'
const email = 'drive@example.test'
const secureSalt = 'drive-media-test-salt'
const accessToken = 'oauth-access-token-secret'
const apiKey = 'drive-api-key-secret'

const located: DriveLocatedFile = Object.freeze({
  email,
  file: Object.freeze({
    id: fileId,
    title: 'Movie.mp4',
    originalFilename: 'Movie.mp4',
    description: '',
    mimeType: 'video/mp4',
    iconLink: '',
    shared: false,
    modifiedDate: '',
    webContentLink: '',
    embedLink: '',
    alternateLink: '',
    fileExtension: 'mp4',
    fileSize: '1024',
    md5Checksum: '',
    sha1Checksum: '',
    sha256Checksum: ''
  })
})

describe('credentialed Drive media service', () => {
  it('creates an encrypted same-origin source while keeping credentials server-side', async () => {
    const enqueueQueue = vi.fn(async () => true)
    const api = {
      locateFile: vi.fn(async () => located),
      copyFromAnyOutcome: vi.fn(async () => ({ status: 'copied' as const, located })),
      mediaRequest: vi.fn(async (): Promise<DriveMediaRequest> => ({
        target: new URL(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`),
        authorization: `Bearer ${accessToken}`
      }))
    }
    const service = new DriveMediaService(
      { enqueueQueue } as never,
      api as never,
      new Security(secureSalt, { randomBytes: (size) => Buffer.alloc(size, 9) }),
      new URL('https://player.example/')
    )

    await service.enqueue(fileId)
    const source = await service.resolve(fileId, email, false)
    expect(source).toMatchObject({
      file: expect.stringMatching(/^https:\/\/player\.example\/gdrive-media\//),
      type: 'video/mp4',
      label: 'Original',
      proxy: false,
      title: 'Movie.mp4',
      image: `https://drive.google.com/thumbnail?id=${fileId}&authuser=0&sz=w9999`
    })
    expect(JSON.stringify(source)).not.toContain(accessToken)
    expect(JSON.stringify(source)).not.toContain(apiKey)
    expect(JSON.stringify(source)).not.toContain(email)
    expect(enqueueQueue).toHaveBeenCalledWith(fileId, false)

    const token = new URL(String(source?.file)).pathname.split('/').at(-1) ?? ''
    await expect(service.mediaRequest(token)).resolves.toEqual(expect.objectContaining({ authorization: `Bearer ${accessToken}` }))
    expect(api.mediaRequest).toHaveBeenCalledWith(email, fileId)
    await expect(service.mediaRequest('not-a-valid-token')).resolves.toBeNull()
  })

  it('uses the copy workflow only when the caller enables the fallback', async () => {
    const api = {
      locateFile: vi.fn(async () => located),
      copyFromAnyOutcome: vi.fn(async () => ({ status: 'existing' as const, located }))
    }
    const service = new DriveMediaService({} as never, api as never, new Security(secureSalt), new URL('https://player.example/'))
    await service.resolve(fileId, email, false)
    await service.resolve(fileId, email, true)
    expect(api.locateFile).toHaveBeenCalledWith(fileId, email)
    expect(api.copyFromAnyOutcome).toHaveBeenCalledWith(fileId, true)
  })
})

describe('credentialed Drive media route', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('proxies GET ranges and HEAD with OAuth and API keys absent from the client response', async () => {
    const requests: Array<Readonly<{ url: string; method: string; authorization: string; range: string }>> = []
    const fetchImplementation: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      requests.push({
        url: String(input),
        method: String(init?.method),
        authorization: headers.get('authorization') ?? '',
        range: headers.get('range') ?? ''
      })
      const partial = headers.has('range')
      return new Response(init?.method === 'HEAD' ? null : 'video-bytes', {
        status: partial ? 206 : 200,
        headers: {
          'content-type': 'video/mp4',
          'accept-ranges': 'bytes',
          ...(partial ? { 'content-range': 'bytes 0-10/11' } : { 'content-length': '11' })
        }
      })
    }
    const service = {
      mediaRequest: vi.fn(async () => ({
        target: new URL(`http://127.0.0.1:9010/drive/v3/files/${fileId}?alt=media&key=${apiKey}`),
        authorization: `Bearer ${accessToken}`
      }))
    }
    app = Fastify()
    await registerDriveMediaRoutes(app, service as never, {
      remoteStream: new RemoteStream(fetchImplementation),
      allowPrivateNetworks: true
    })

    const get = await app.inject({ method: 'GET', url: '/gdrive-media/encrypted-token', headers: { range: 'bytes=0-10' } })
    expect(get.statusCode).toBe(206)
    expect(get.body).toBe('video-bytes')
    expect(get.headers['content-range']).toBe('bytes 0-10/11')
    expect(get.headers['cache-control']).toBe('private, no-store')
    expect(get.body + JSON.stringify(get.headers)).not.toContain(accessToken)
    expect(get.body + JSON.stringify(get.headers)).not.toContain(apiKey)

    const head = await app.inject({ method: 'HEAD', url: '/gdrive-media/encrypted-token' })
    expect(head.statusCode).toBe(200)
    expect(head.body).toBe('')
    expect(requests).toEqual([
      expect.objectContaining({ method: 'GET', authorization: `Bearer ${accessToken}`, range: 'bytes=0-10', url: expect.stringContaining(`key=${apiKey}`) }),
      expect.objectContaining({ method: 'HEAD', authorization: `Bearer ${accessToken}`, range: '', url: expect.stringContaining(`key=${apiKey}`) })
    ])
  })

  it('rejects invalid media tokens without opening an upstream request', async () => {
    const service = { mediaRequest: vi.fn(async () => null) }
    app = Fastify()
    await registerDriveMediaRoutes(app, service as never)
    const response = await app.inject({ method: 'GET', url: '/gdrive-media/invalid' })
    expect(response.statusCode).toBe(404)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(service.mediaRequest).toHaveBeenCalledWith('invalid')
  })
})
