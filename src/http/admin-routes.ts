import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AUTH_COOKIE_NAME, AuthService, authTokenFromRequest, type AuthUser } from '../auth/auth-service.js'
import type { SessionAdminService } from '../auth/session-admin-service.js'
import type { AppConfig } from '../config.js'
import { renderAdminDashboard, renderAdminError, renderAdminLoginPage, renderAdminSessions, type AdminMessage } from '../player/admin-page.js'

const ADMIN_CSP = "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
const SESSION_DELETE_FAIL = 'The session failed to delete'
const SESSION_DELETE_SUCCESS = 'The session has been successfully deleted'
const UNAUTHORIZED = 'You are not authorized to access this feature'

export async function registerAdminRoutes(app: FastifyInstance, config: AppConfig, auth: AuthService, sessions: SessionAdminService): Promise<void> {
  const adminBase = `/${config.adminDirectory}`
  const loginUrl = `${adminBase}/login/`
  const dashboardUrl = `${adminBase}/dashboard/`
  const sessionsUrl = `${adminBase}/users/sessions/`
  const sessionDeleteUrl = `${adminBase}/users/sessions/delete/`
  const sessionAjaxUrl = `${adminBase}/ajax/sessions/`
  const sessionListAjaxUrl = `${adminBase}/ajax/sessions-list/`

  app.get(adminBase, async (_request, reply) => await reply.redirect(`${adminBase}/`, 308))
  app.get(`${adminBase}/`, async (request, reply) => {
    const user = await currentUser(request, auth).catch(() => null)
    return await reply.redirect(user === null ? loginUrl : dashboardUrl, 302)
  })
  app.get(`${adminBase}/login`, async (_request, reply) => await reply.redirect(loginUrl, 308))
  app.get(`${adminBase}/dashboard`, async (_request, reply) => await reply.redirect(dashboardUrl, 308))
  app.get(`${adminBase}/users/sessions`, async (_request, reply) => await reply.redirect(sessionsUrl, 308))

  app.get(loginUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const query = objectValue(request.query)
    if ('username' in query || 'password' in query) return await reply.redirect(loginUrl, 303)

    if (booleanValue(query.logout)) {
      await auth.logout(tokenFor(request)).catch(() => false)
      clearAuthCookie(reply, config)
      return reply.type('text/html; charset=utf-8').send(renderAdminLoginPage(adminBase, {
        kind: 'success',
        text: 'You have successfully logged out.'
      }))
    }

    const user = await currentUser(request, auth).catch(() => null)
    if (user !== null) return await reply.redirect(dashboardUrl, 302)
    return reply.type('text/html; charset=utf-8').send(renderAdminLoginPage(adminBase))
  })

  app.post(loginUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The login request did not originate from this application.'))
    }
    const body = objectValue(request.body)
    const identifier = stringValue(body.username)
    const password = stringValue(body.password, false)
    if (identifier.trim() === '' || password === '') {
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminLoginPage(adminBase, {
        kind: 'error',
        text: 'Username and password are required.'
      }))
    }

    try {
      const result = await auth.login({
        identifier,
        password,
        remember: booleanValue(body.remember),
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? ''
      })
      if (result.status !== 'ok') {
        const message: AdminMessage = result.status === 'pending'
          ? { kind: 'error', text: 'Your account is awaiting approval.' }
          : result.status === 'inactive'
            ? { kind: 'error', text: 'Your account is currently inactive. Please contact an administrator.' }
            : { kind: 'error', text: 'Incorrect username or password. Try again.' }
        return reply.code(401).type('text/html; charset=utf-8').send(renderAdminLoginPage(adminBase, message))
      }

      reply.setCookie(AUTH_COOKIE_NAME, result.token, {
        path: '/',
        expires: new Date(result.expires * 1_000),
        httpOnly: true,
        secure: config.baseUrl.protocol === 'https:',
        sameSite: 'strict'
      })
      return await reply.redirect(dashboardUrl, 303)
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The authentication database is temporarily unavailable.'))
    }
  })

  app.get(dashboardUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    let user: AuthUser | null
    try {
      user = await currentUser(request, auth)
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The authentication database is temporarily unavailable.'))
    }
    if (user === null) return await reply.redirect(loginUrl, 302)
    return reply.type('text/html; charset=utf-8').send(renderAdminDashboard(adminBase, user))
  })

  app.get(sessionsUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    if (user.role !== 0) return await reply.redirect(`${adminBase}/403/`, 302)

    try {
      const page = await sessions.list({
        draw: 0,
        start: 0,
        length: 100,
        'order[0][column]': 5,
        'order[0][dir]': 'desc'
      })
      const query = objectValue(request.query)
      const message: AdminMessage | undefined = stringValue(query.deleted) === '1'
        ? { kind: 'success', text: SESSION_DELETE_SUCCESS }
        : stringValue(query.deleted) === '0'
          ? { kind: 'error', text: SESSION_DELETE_FAIL }
          : undefined
      return reply.type('text/html; charset=utf-8').send(renderAdminSessions({
        adminBase,
        sessions: page.data,
        recordsTotal: page.recordsTotal,
        csrfToken: csrfToken(config, tokenFor(request)),
        ...(message === undefined ? {} : { message })
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The session database is temporarily unavailable.'))
    }
  })

  app.post(sessionDeleteUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The session request did not originate from this application.'))
    }
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    if (user.role !== 0) return await reply.redirect(`${adminBase}/403/`, 302)

    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf))) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The session request could not be verified.'))
    }
    try {
      const deleted = await sessions.delete(body.id)
      return await reply.redirect(`${sessionsUrl}?deleted=${deleted ? '1' : '0'}`, 303)
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The session database is temporarily unavailable.'))
    }
  })

  const sessionAjax = async (request: FastifyRequest, reply: FastifyReply, listOnly: boolean): Promise<unknown> => {
    applyAdminHeaders(reply, config)
    reply.type('application/json; charset=utf-8')
    const data = { ...objectValue(request.query), ...objectValue(request.body) }
    let user: AuthUser | null
    try {
      user = await auth.authenticate(tokenFor(request) || stringValue(data.token), request.headers['user-agent'] ?? '')
    } catch {
      return reply.code(503).send(legacyJson('fail', 'The session database is temporarily unavailable.'))
    }
    if (user?.role !== 0) return reply.send(legacyJson('fail', UNAUTHORIZED))

    const action = listOnly ? 'list' : stringValue(data.action)
    try {
      if (action === 'list') return reply.send(await sessions.list(data))
      if (action === 'delete') {
        if (!hasSameOrigin(request, config)) return reply.code(403).send(legacyJson('fail', 'The session request did not originate from this application.'))
        const deleted = await sessions.delete(data.id)
        return reply.send(legacyJson(deleted ? 'ok' : 'fail', deleted ? SESSION_DELETE_SUCCESS : SESSION_DELETE_FAIL))
      }
      return reply.send(legacyJson('fail', 'Invalid parameters'))
    } catch {
      return reply.code(503).send(legacyJson('fail', 'The session database is temporarily unavailable.'))
    }
  }

  app.route({
    method: ['GET', 'POST'],
    url: sessionListAjaxUrl,
    handler: async (request, reply) => await sessionAjax(request, reply, true)
  })
  app.route({
    method: ['GET', 'POST'],
    url: sessionAjaxUrl,
    handler: async (request, reply) => await sessionAjax(request, reply, false)
  })

  app.post(`${adminBase}/logout/`, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The logout request did not originate from this application.'))
    }
    await auth.logout(tokenFor(request)).catch(() => false)
    clearAuthCookie(reply, config)
    return await reply.redirect(loginUrl, 303)
  })

  app.get(`${adminBase}/403/`, async (_request, reply) => {
    applyAdminHeaders(reply, config)
    return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'You are not allowed to access this administration page.'))
  })
}

function applyAdminHeaders(reply: FastifyReply, config: AppConfig): void {
  reply.headers({
    'cache-control': 'no-store',
    pragma: 'no-cache',
    expires: '0',
    'content-security-policy': ADMIN_CSP,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'x-robots-tag': 'noindex, nofollow',
    'access-control-allow-origin': config.baseUrl.origin,
    vary: 'Origin'
  })
}

async function authenticatedUser(
  request: FastifyRequest,
  reply: FastifyReply,
  adminBase: string,
  loginUrl: string,
  auth: AuthService
): Promise<AuthUser | null> {
  try {
    const user = await currentUser(request, auth)
    if (user === null) await reply.redirect(loginUrl, 302)
    return user
  } catch {
    reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The authentication database is temporarily unavailable.'))
    return null
  }
}

async function currentUser(request: FastifyRequest, auth: AuthService): Promise<AuthUser | null> {
  return await auth.authenticate(tokenFor(request), request.headers['user-agent'] ?? '')
}

function tokenFor(request: FastifyRequest): string {
  return authTokenFromRequest({
    authorization: request.headers.authorization,
    cookie: request.cookies[AUTH_COOKIE_NAME]
  })
}

function clearAuthCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(AUTH_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    secure: config.baseUrl.protocol === 'https:',
    sameSite: 'strict'
  })
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown, trim = true): string {
  const result = typeof value === 'string' ? value.slice(0, 1_024) : ''
  return trim ? result.trim() : result
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on'
}

function csrfToken(config: AppConfig, token: string): string {
  if (token === '') return ''
  return createHmac('sha256', config.secureSalt).update(`session-delete\0${token}`).digest('base64url')
}

function validCsrfToken(config: AppConfig, token: string, candidate: string): boolean {
  const expected = csrfToken(config, token)
  if (expected === '' || candidate.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))
}

function legacyJson(status: 'ok' | 'fail', message: string): Readonly<{ status: 'ok' | 'fail'; message: string; result: null }> {
  return Object.freeze({ status, message, result: null })
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
