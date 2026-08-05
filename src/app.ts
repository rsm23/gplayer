import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import formbody from '@fastify/formbody'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { createAuthRuntime } from './auth/auth-runtime.js'
import type { AuthService } from './auth/auth-service.js'
import type { SessionAdminService } from './auth/session-admin-service.js'
import type { UserAdminService } from './auth/user-admin-service.js'
import { loadConfig, type AppConfig } from './config.js'
import { registerAdminRoutes } from './http/admin-routes.js'
import { registerAdminSettingsRoutes } from './http/admin-settings-routes.js'
import { registerMediaRoutes } from './http/media-routes.js'
import { registerPlayerRoutes } from './http/player-routes.js'
import { createSourceApiRuntime } from './http/source-api-runtime.js'
import type { SettingsAdminService } from './settings/settings-admin-service.js'
import { registerSourceApiRoutes, type SourceApiRouteOptions } from './http/source-api-routes.js'
import { registerStreamingRoutes } from './http/streaming-routes.js'
import { applyPublicPageHeaders, registerSystemRoutes } from './http/system-routes.js'
import { publicErrors, renderPublicError } from './player/public-page.js'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))

export type AppDependencies = Readonly<{
  sourceApi?: SourceApiRouteOptions
  auth?: AuthService
  sessions?: SessionAdminService
  users?: UserAdminService
  settings?: SettingsAdminService
}>

export async function buildApp(
  config: AppConfig = loadConfig(),
  dependencies: AppDependencies = {}
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.nodeEnv !== 'test',
    trustProxy: true,
    requestIdHeader: 'x-request-id'
  })

  await app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
    exposedHeaders: ['content-length', 'content-range', 'accept-ranges']
  })

  await app.register(formbody)
  await app.register(cookie)

  const authRuntime = createAuthRuntime(app, config)

  await registerSystemRoutes(app, config)
  await registerAdminRoutes(
    app,
    config,
    dependencies.auth ?? authRuntime.auth,
    dependencies.sessions ?? authRuntime.sessions,
    dependencies.users ?? authRuntime.users
  )
  await registerAdminSettingsRoutes(app, config, dependencies.auth ?? authRuntime.auth, dependencies.settings ?? authRuntime.settings)
  await registerPlayerRoutes(app, config)
  await registerSourceApiRoutes(app, config, dependencies.sourceApi ?? createSourceApiRuntime(app, config))
  await registerMediaRoutes(app, config)
  await registerStreamingRoutes(app, config)

  await app.register(fastifyStatic, {
    root: path.resolve(currentDirectory, '../public'),
    prefix: '/',
    decorateReply: false,
    wildcard: false
  })

  app.setNotFoundHandler(async (_request, reply) => {
    applyPublicPageHeaders(reply, true)
    reply.code(404).type('text/html; charset=utf-8')
    return renderPublicError(publicErrors[404])
  })

  return app
}
