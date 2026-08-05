import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'

describe('legacy AJAX controller routing', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('registers every recovered dispatcher slug with and without a trailing slash', async () => {
    app = await buildApp(loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'https://player.example/',
      SECURE_SALT: '1234567890123456'
    }))
    await app.ready()

    const readWriteSlugs = [
      'admin-api',
      'dashboard',
      'gdrive-accounts',
      'gdrive-accounts-list',
      'gdrive-backup-files',
      'gdrive-backup-files-list',
      'gdrive-backup-queue',
      'gdrive-backup-queue-list',
      'gdrive-files',
      'gdrive-files-list',
      'load-balancers',
      'load-balancers-list',
      'profile',
      'profile-list',
      'sessions',
      'sessions-list',
      'subtitles',
      'subtitles-list',
      'users',
      'users-list',
      'videos',
      'videos-list'
    ] as const

    for (const slug of readWriteSlugs) {
      for (const suffix of ['', '/']) {
        const url = `/administrator/ajax/${slug}${suffix}`
        expect(app.hasRoute({ method: 'GET', url }), `GET ${url}`).toBe(true)
        expect(app.hasRoute({ method: 'POST', url }), `POST ${url}`).toBe(true)
      }
    }

    for (const slug of ['settings', 'videos-export', 'videos-import'] as const) {
      for (const suffix of ['', '/']) {
        const url = `/administrator/ajax/${slug}${suffix}`
        expect(app.hasRoute({ method: 'POST', url }), `POST ${url}`).toBe(true)
      }
    }

    for (const prefix of ['', '/administrator']) {
      for (const suffix of ['', '/']) {
        const url = `${prefix}/ajax/public${suffix}`
        expect(app.hasRoute({ method: 'GET', url }), `GET ${url}`).toBe(true)
        expect(app.hasRoute({ method: 'POST', url }), `POST ${url}`).toBe(true)
      }
    }
  })
})
