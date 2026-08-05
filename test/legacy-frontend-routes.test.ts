import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerLegacyFrontendAliases } from '../src/http/legacy-frontend-routes.js'

describe('legacy frontend route aliases', () => {
  it.each([
    '/sample',
    '/sample/',
    '/sample/anything/here',
    '/sample.php',
    '/sample.custom/',
    '/sample.php/anything/here'
  ])('dispatches %s from the first URI segment', async (url) => {
    const app = Fastify()
    registerLegacyFrontendAliases(app, ['sample'], async (request) => ({ url: request.url }))

    const response = await app.inject({ method: 'GET', url })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ url })
    await app.close()
  })

  it('supports GET and POST controllers while preserving more-specific routes', async () => {
    const app = Fastify()
    app.get('/sample/frame/:slot', async (request) => ({ slot: (request.params as { slot: string }).slot }))
    registerLegacyFrontendAliases(app, ['/sample/'], async () => ({ legacy: true }), { methods: ['GET', 'POST'] })

    const [specific, nestedPost] = await Promise.all([
      app.inject({ method: 'GET', url: '/sample/frame/top' }),
      app.inject({ method: 'POST', url: '/sample.php/nested' })
    ])

    expect(specific.json()).toEqual({ slot: 'top' })
    expect(nestedPost.json()).toEqual({ legacy: true })
    await app.close()
  })

  it('can leave nested and dotted variants disabled', async () => {
    const app = Fastify()
    registerLegacyFrontendAliases(app, ['sample'], async () => 'ok', { nested: false, dotted: false })

    expect((await app.inject({ method: 'GET', url: '/sample' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/sample/' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/sample.php' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/sample/nested' })).statusCode).toBe(404)
    await app.close()
  })

  it.each(['', '/', 'bad/path', ':parameter', 'wild*'])('rejects invalid alias %j', (alias) => {
    const app = Fastify()
    expect(() => registerLegacyFrontendAliases(app, [alias], async () => 'ok')).toThrow('Invalid legacy frontend alias')
  })
})
