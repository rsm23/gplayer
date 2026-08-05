import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AUTH_COOKIE_NAME, AuthService, authTokenFromRequest, type AuthUser } from '../auth/auth-service.js'
import type { SessionAdminService } from '../auth/session-admin-service.js'
import type { UserAdminService } from '../auth/user-admin-service.js'
import type { AppConfig } from '../config.js'
import { renderAdminDashboard, renderAdminError, renderAdminLoginPage, renderAdminSessions, renderAdminUserForm, renderAdminUsers, type AdminMessage } from '../player/admin-page.js'

const ADMIN_CSP = "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
const SESSION_DELETE_FAIL = 'The session failed to delete'
const SESSION_DELETE_SUCCESS = 'The session has been successfully deleted'
const UNAUTHORIZED = 'You are not authorized to access this feature'
const USER_DELETE_FAIL = 'The user failed to delete'
const USER_DELETE_SUCCESS = 'The user has been successfully deleted'

export async function registerAdminRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  sessions: SessionAdminService,
  users: UserAdminService,
  loadRegistrationEnabled: () => Promise<boolean> = async () => false
): Promise<void> {
  const adminBase = `/${config.adminDirectory}`
  const loginUrl = `${adminBase}/login/`
  const dashboardUrl = `${adminBase}/dashboard/`
  const usersUrl = `${adminBase}/users/`
  const userNewUrl = `${adminBase}/users/new/`
  const userEditUrl = `${adminBase}/users/edit/`
  const userDeleteUrl = `${adminBase}/users/delete/`
  const userAjaxUrl = `${adminBase}/ajax/users/`
  const userListAjaxUrl = `${adminBase}/ajax/users-list/`
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
  app.get(`${adminBase}/users`, async (_request, reply) => await reply.redirect(usersUrl, 308))
  app.get(`${adminBase}/users/new`, async (_request, reply) => await reply.redirect(userNewUrl, 308))
  app.get(`${adminBase}/users/edit`, async (request, reply) => {
    const id = stringValue(objectValue(request.query).id)
    return await reply.redirect(`${userEditUrl}${id === '' ? '' : `?id=${encodeURIComponent(id)}`}`, 308)
  })
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
      }, await registrationEnabled(loadRegistrationEnabled)))
    }

    const user = await currentUser(request, auth).catch(() => null)
    if (user !== null) return await reply.redirect(dashboardUrl, 302)
    return reply.type('text/html; charset=utf-8').send(renderAdminLoginPage(
      adminBase,
      accountLoginMessage(stringValue(query.account)),
      await registrationEnabled(loadRegistrationEnabled)
    ))
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
      }, await registrationEnabled(loadRegistrationEnabled)))
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
        return reply.code(401).type('text/html; charset=utf-8').send(renderAdminLoginPage(adminBase, message, await registrationEnabled(loadRegistrationEnabled)))
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

  app.get(usersUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    if (user.role !== 0) return await reply.redirect(`${adminBase}/403/`, 302)

    const query = objectValue(request.query)
    const search = stringValue(query.q).slice(0, 254)
    try {
      const page = await users.records({
        draw: 0,
        start: 0,
        length: 100,
        'search[value]': search,
        'order[0][column]': 5,
        'order[0][dir]': 'desc'
      })
      const message: AdminMessage | undefined = stringValue(query.deleted) === '1'
        ? { kind: 'success', text: USER_DELETE_SUCCESS }
        : stringValue(query.deleted) === '0'
          ? { kind: 'error', text: USER_DELETE_FAIL }
          : undefined
      return reply.type('text/html; charset=utf-8').send(renderAdminUsers({
        adminBase,
        users: page.data,
        recordsTotal: page.recordsTotal,
        csrfToken: csrfToken(config, tokenFor(request), 'user-delete'),
        search,
        ...(message === undefined ? {} : { message })
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The user database is temporarily unavailable.'))
    }
  })

  app.get(userNewUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    if (user.role !== 0) return await reply.redirect(`${adminBase}/403/`, 302)
    return reply.type('text/html; charset=utf-8').send(renderAdminUserForm({
      adminBase,
      csrfToken: csrfToken(config, tokenFor(request), 'user-write')
    }))
  })

  app.get(userEditUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const current = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (current === null || reply.sent) return
    if (current.role !== 0) return await reply.redirect(`${adminBase}/403/`, 302)

    const query = objectValue(request.query)
    try {
      const user = await users.get(query.id)
      if (user === null) return reply.code(404).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 404, 'The requested user was not found.'))
      const message: AdminMessage | undefined = booleanValue(query.created)
        ? { kind: 'success', text: 'The new user has been successfully created' }
        : booleanValue(query.updated)
          ? { kind: 'success', text: 'The user details have been successfully updated' }
          : undefined
      return reply.type('text/html; charset=utf-8').send(renderAdminUserForm({
        adminBase,
        user,
        csrfToken: csrfToken(config, tokenFor(request), 'user-write'),
        ...(message === undefined ? {} : { message })
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The user database is temporarily unavailable.'))
    }
  })

  const writeUser = async (request: FastifyRequest, reply: FastifyReply, edit: boolean): Promise<unknown> => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The user request did not originate from this application.'))
    }
    const current = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (current === null || reply.sent) return
    if (current.role !== 0) return await reply.redirect(`${adminBase}/403/`, 302)

    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'user-write')) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The user request could not be verified.'))
    }

    try {
      const existing = edit ? await users.get(body.id) : undefined
      if (edit && existing === null) return reply.code(404).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 404, 'The requested user was not found.'))
      const result = edit ? await users.update(body.id, body) : await users.create(body)
      if (result.status === 'ok') {
        return await reply.redirect(`${userEditUrl}?id=${encodeURIComponent(result.id)}&${edit ? 'updated' : 'created'}=1`, 303)
      }
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminUserForm({
        adminBase,
        ...(existing === undefined || existing === null ? {} : { user: existing }),
        csrfToken: csrfToken(config, tokenFor(request), 'user-write'),
        values: userFormValues(body),
        message: { kind: 'error', text: result.message }
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The user database is temporarily unavailable.'))
    }
  }

  app.post(userNewUrl, async (request, reply) => await writeUser(request, reply, false))
  app.post(userEditUrl, async (request, reply) => await writeUser(request, reply, true))

  app.post(userDeleteUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The user request did not originate from this application.'))
    }
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    if (user.role !== 0) return await reply.redirect(`${adminBase}/403/`, 302)
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'user-delete')) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The user request could not be verified.'))
    }
    try {
      const deleted = await users.delete(body.id)
      return await reply.redirect(`${usersUrl}?deleted=${deleted ? '1' : '0'}`, 303)
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The user database is temporarily unavailable.'))
    }
  })

  const userAjax = async (request: FastifyRequest, reply: FastifyReply, listOnly: boolean): Promise<unknown> => {
    applyAdminHeaders(reply, config)
    reply.type('application/json; charset=utf-8')
    const data = { ...objectValue(request.query), ...objectValue(request.body) }
    const requestToken = tokenFor(request) || stringValue(data.token)
    let user: AuthUser | null
    try {
      user = await auth.authenticate(requestToken, request.headers['user-agent'] ?? '')
    } catch {
      return reply.code(503).send(legacyJson('fail', 'The user database is temporarily unavailable.'))
    }

    if (listOnly) {
      if (user?.role !== 0) return reply.send(emptyDataTables(data.draw))
      try {
        return reply.send(await users.list(data))
      } catch {
        return reply.code(503).send(legacyJson('fail', 'The user database is temporarily unavailable.'))
      }
    }
    if (user === null) return reply.send(legacyJson('fail', UNAUTHORIZED))

    const action = stringValue(data.action)
    if (['delete', 'editEmail', 'editUsername'].includes(action)) {
      if (request.method !== 'POST') return reply.code(405).send(legacyJson('fail', 'Invalid parameters'))
      if (!hasSameOrigin(request, config)) return reply.code(403).send(legacyJson('fail', 'The user request did not originate from this application.'))
    }
    try {
      if (action === 'delete') {
        if (user.role !== 0) return reply.send(legacyJson('fail', UNAUTHORIZED))
        const deleted = await users.delete(data.id)
        return reply.send(legacyJson(deleted ? 'ok' : 'fail', deleted ? USER_DELETE_SUCCESS : USER_DELETE_FAIL))
      }
      if (action === 'editEmail' || action === 'editUsername') {
        const result = action === 'editEmail'
          ? await users.editEmail(user.id, data.email)
          : await users.editUsername(user.id, data.user)
        if (result.status === 'ok') {
          await auth.logout(requestToken).catch(() => false)
          clearAuthCookie(reply, config)
        }
        return reply.send(legacyJson(result.status === 'ok' ? 'ok' : 'fail', result.message))
      }
      return reply.send(legacyJson('fail', 'Invalid parameters'))
    } catch {
      return reply.code(503).send(legacyJson('fail', 'The user database is temporarily unavailable.'))
    }
  }

  app.route({
    method: ['GET', 'POST'],
    url: userListAjaxUrl,
    handler: async (request, reply) => await userAjax(request, reply, true)
  })
  app.route({
    method: ['GET', 'POST'],
    url: userAjaxUrl,
    handler: async (request, reply) => await userAjax(request, reply, false)
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
        csrfToken: csrfToken(config, tokenFor(request), 'session-delete'),
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
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'session-delete')) {
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
    if (user?.role !== 0) return reply.send(listOnly ? emptyDataTables(data.draw) : legacyJson('fail', UNAUTHORIZED))

    const action = listOnly ? 'list' : stringValue(data.action)
    try {
      if (action === 'list') return reply.send(await sessions.list(data))
      if (action === 'delete') {
        if (request.method !== 'POST') return reply.code(405).send(legacyJson('fail', 'Invalid parameters'))
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
    'referrer-policy': 'same-origin',
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

async function registrationEnabled(loader: () => Promise<boolean>): Promise<boolean> {
  try {
    return await loader()
  } catch {
    return false
  }
}

function accountLoginMessage(value: string): AdminMessage | undefined {
  if (value === 'confirmed') return { kind: 'success', text: 'Your account has been successfully activated! Now you can log in' }
  if (value === 'registered') return { kind: 'success', text: 'Registration has been successful! Now you can log in' }
  if (value === 'password-reset') return { kind: 'success', text: 'Reset password has been successful! Now you can log in' }
  if (value === 'invalid-token') return { kind: 'error', text: 'The token is invalid' }
  return undefined
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

function csrfToken(config: AppConfig, token: string, scope: string): string {
  if (token === '') return ''
  return createHmac('sha256', config.secureSalt).update(`${scope}\0${token}`).digest('base64url')
}

function validCsrfToken(config: AppConfig, token: string, candidate: string, scope: string): boolean {
  const expected = csrfToken(config, token, scope)
  if (expected === '' || candidate.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))
}

function legacyJson(status: 'ok' | 'fail', message: string): Readonly<{ status: 'ok' | 'fail'; message: string; result: null }> {
  return Object.freeze({ status, message, result: null })
}

function emptyDataTables(draw: unknown): Readonly<{ draw: number; data: readonly never[]; recordsTotal: 0; recordsFiltered: 0 }> {
  const parsed = Number.parseInt(stringValue(draw), 10)
  return Object.freeze({
    draw: Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0,
    data: Object.freeze([]),
    recordsTotal: 0,
    recordsFiltered: 0
  })
}

function userFormValues(body: Record<string, unknown>): Readonly<Record<string, string>> {
  return Object.freeze({
    name: stringValue(body.name).slice(0, 50),
    user: stringValue(body.user).slice(0, 50),
    email: stringValue(body.email).slice(0, 254),
    role: stringValue(body.role).slice(0, 1),
    status: stringValue(body.status).slice(0, 1)
  })
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
