import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AUTH_COOKIE_NAME, AuthService, authTokenFromRequest, type AuthUser } from '../auth/auth-service.js'
import type { AppConfig } from '../config.js'
import type { PrivateAdminService } from '../system/private-admin-service.js'

const ADMIN_CSP = "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
const INVALID_PARAMETERS = 'Invalid parameters'
const UNAUTHORIZED = 'You are not authorized to access this feature'
const UNAVAILABLE = 'The private administration service is temporarily unavailable'

export async function registerPrivateAdminRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  service: PrivateAdminService
): Promise<void> {
  const url = `/${config.adminDirectory}/ajax/private/`
  app.route({
    method: ['GET', 'POST'],
    url,
    handler: async (request, reply) => {
      applyAdminHeaders(reply, config)
      reply.type('application/json; charset=utf-8')
      const data = { ...objectValue(request.query), ...objectValue(request.body) }
      let user: AuthUser | null
      try {
        user = await auth.authenticate(tokenFor(request) || stringValue(data.token), request.headers['user-agent'] ?? '')
      } catch {
        return reply.code(503).send(legacy('fail', UNAVAILABLE, null))
      }
      if (user?.role !== 0 || user.status !== 1) return reply.send(legacy('fail', UNAUTHORIZED, null))

      const action = stringValue(data.action)
      if (action === 'serverStatus') {
        try {
          return reply.send(legacy('ok', '', await service.serverStatus(data.group)))
        } catch {
          return reply.code(503).send(legacy('fail', UNAVAILABLE, null))
        }
      }
      if (action !== 'clearVideoCache' && action !== 'clearLoadBalancer') {
        return reply.send(legacy('fail', INVALID_PARAMETERS, null))
      }
      if (request.method !== 'POST') return reply.code(405).send(legacy('fail', INVALID_PARAMETERS, null))
      if (!hasSameOrigin(request, config)) return reply.code(403).send(legacy('fail', 'The private administration request did not originate from this application', null))
      try {
        return reply.send(action === 'clearVideoCache' ? await service.clearVideoCache(data.id) : await service.clearLoadBalancer())
      } catch {
        return reply.code(503).send(legacy('fail', UNAVAILABLE, null))
      }
    }
  })
}

function legacy(status: 'ok' | 'fail', message: string, result: unknown): Readonly<{ status: 'ok' | 'fail'; message: string; result: unknown }> {
  return Object.freeze({ status, message, result })
}

function applyAdminHeaders(reply: FastifyReply, config: AppConfig): void {
  reply.headers({
    'cache-control': 'no-store',
    pragma: 'no-cache',
    expires: '0',
    'content-security-policy': ADMIN_CSP,
    'referrer-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'x-robots-tag': 'noindex, nofollow',
    'access-control-allow-origin': config.baseUrl.origin,
    vary: 'Origin'
  })
}

function tokenFor(request: FastifyRequest): string {
  return authTokenFromRequest({ authorization: request.headers.authorization, cookie: request.cookies[AUTH_COOKIE_NAME] })
}

function hasSameOrigin(request: FastifyRequest, config: AppConfig): boolean {
  const source = request.headers.origin ?? request.headers.referer
  if (source === undefined) return true
  try {
    return new URL(source).origin === config.baseUrl.origin
  } catch {
    return false
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string {
  const scalar = Array.isArray(value) ? value.at(-1) : value
  return typeof scalar === 'string' || typeof scalar === 'number' ? String(scalar).trim().slice(0, 2_048) : ''
}
