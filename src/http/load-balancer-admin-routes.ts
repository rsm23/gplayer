import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AUTH_COOKIE_NAME, AuthService, authTokenFromRequest, type AuthUser } from '../auth/auth-service.js'
import type { AppConfig } from '../config.js'
import { LOAD_BALANCER_CONTINENTS, type LoadBalancerAdminService, type LoadBalancerMutationResult } from '../load-balancers/load-balancer-admin-service.js'
import { renderAdminError, renderAdminLoadBalancerForm, renderAdminLoadBalancers, type AdminMessage } from '../player/admin-page.js'

const ADMIN_CSP = "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
const DATABASE_UNAVAILABLE = 'The load balancer database is temporarily unavailable.'
const UNAUTHORIZED = 'You are not authorized to access this feature'

export async function registerLoadBalancerAdminRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  service: LoadBalancerAdminService,
  hosts: readonly Readonly<{ value: string; label: string }>[]
): Promise<void> {
  const adminBase = `/${config.adminDirectory}`
  const loginUrl = `${adminBase}/login/`
  const listUrl = `${adminBase}/load-balancers/list/`
  const newUrl = `${adminBase}/load-balancers/new/`
  const editUrl = `${adminBase}/load-balancers/edit/`
  const deleteUrl = `${adminBase}/load-balancers/delete/`
  const statusUrl = `${adminBase}/load-balancers/status/`
  const csrfScope = 'load-balancer-mutate'

  app.get(`${adminBase}/load-balancers`, async (_request, reply) => await reply.redirect(listUrl, 308))
  app.get(`${adminBase}/load-balancers/list`, async (_request, reply) => await reply.redirect(listUrl, 308))
  app.get(`${adminBase}/load-balancers/new`, async (_request, reply) => await reply.redirect(newUrl, 308))
  app.get(`${adminBase}/load-balancers/edit`, async (request, reply) => {
    const id = stringValue(objectValue(request.query).id)
    return await reply.redirect(`${editUrl}${id === '' ? '' : `?id=${encodeURIComponent(id)}`}`, 308)
  })

  app.get(listUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const query = objectValue(request.query)
    const search = stringValue(query.q).slice(0, 263)
    try {
      const page = await service.records({ draw: 0, start: 0, length: 100, 'search[value]': search, 'order[0][column]': 6, 'order[0][dir]': 'desc' })
      const message = pageMessage(query)
      return reply.type('text/html; charset=utf-8').send(renderAdminLoadBalancers({
        adminBase, loadBalancers: page.data, recordsTotal: page.recordsTotal, search,
        csrfToken: csrfToken(config, tokenFor(request), csrfScope), ...(message === undefined ? {} : { message })
      }))
    } catch {
      return databaseError(reply, adminBase)
    }
  })

  app.get(newUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    return reply.type('text/html; charset=utf-8').send(renderAdminLoadBalancerForm({ adminBase, hosts, continents: LOAD_BALANCER_CONTINENTS, csrfToken: csrfToken(config, tokenFor(request), csrfScope) }))
  })

  app.get(editUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    try {
      const loadBalancer = await service.get(objectValue(request.query).id)
      if (loadBalancer === null) return reply.code(404).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 404, 'The requested load balancer was not found.'))
      const query = objectValue(request.query)
      const message: AdminMessage | undefined = stringValue(query.created) === '1'
        ? { kind: 'success', text: 'The new load balancer site has been successfully created' }
        : stringValue(query.updated) === '1' ? { kind: 'success', text: 'The load balancer site has been successfully updated' } : undefined
      return reply.type('text/html; charset=utf-8').send(renderAdminLoadBalancerForm({ adminBase, hosts, continents: LOAD_BALANCER_CONTINENTS, loadBalancer, csrfToken: csrfToken(config, tokenFor(request), csrfScope), ...(message === undefined ? {} : { message }) }))
    } catch {
      return databaseError(reply, adminBase)
    }
  })

  const write = async (request: FastifyRequest, reply: FastifyReply, edit: boolean): Promise<unknown> => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) return originError(reply, adminBase)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = normalizedFormBody(objectValue(request.body))
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), csrfScope)) return csrfError(reply, adminBase)
    try {
      const current = edit ? await service.get(body.id) : undefined
      if (edit && current === null) return reply.code(404).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 404, 'The requested load balancer was not found.'))
      const result = edit ? await service.update(body.id, body) : await service.create(body)
      if (result.status === 'ok') return await reply.redirect(`${editUrl}?id=${encodeURIComponent(result.id)}&${edit ? 'updated' : 'created'}=1`, 303)
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminLoadBalancerForm({
        adminBase, hosts, continents: LOAD_BALANCER_CONTINENTS, ...(current === undefined || current === null ? {} : { loadBalancer: current }), values: body,
        csrfToken: csrfToken(config, tokenFor(request), csrfScope), message: { kind: 'error', text: result.message }
      }))
    } catch {
      return databaseError(reply, adminBase)
    }
  }
  app.post(newUrl, async (request, reply) => await write(request, reply, false))
  app.post(editUrl, async (request, reply) => await write(request, reply, true))

  for (const [url, action, notice] of [
    [deleteUrl, async (body: Record<string, unknown>) => await service.delete(body.id), 'deleted'],
    [statusUrl, async (body: Record<string, unknown>) => await service.setStatus(body.id, body.status), 'status']
  ] as const) {
    app.post(url, async (request, reply) => {
      applyAdminHeaders(reply, config)
      if (!hasSameOrigin(request, config)) return originError(reply, adminBase)
      const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
      if (user === null || reply.sent) return
      const body = objectValue(request.body)
      if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), csrfScope)) return csrfError(reply, adminBase)
      try {
        const result = await action(body)
        return await reply.redirect(`${listUrl}?${notice}=${result.status === 'ok' ? '1' : '0'}`, 303)
      } catch { return databaseError(reply, adminBase) }
    })
  }

  const ajax = async (request: FastifyRequest, reply: FastifyReply, listOnly: boolean): Promise<unknown> => {
    applyAdminHeaders(reply, config)
    reply.type('application/json; charset=utf-8')
    const data = { ...objectValue(request.query), ...objectValue(request.body) }
    let user: AuthUser | null
    try { user = await auth.authenticate(tokenFor(request) || stringValue(data.token), request.headers['user-agent'] ?? '') } catch { return reply.code(503).send(emptyDataTables(data.draw)) }
    const action = listOnly ? 'list' : stringValue(data.action)
    if (user?.role !== 0 || user.status !== 1) return reply.send(action === 'list' ? emptyDataTables(data.draw) : legacyMutation({ status: 'invalid', message: UNAUTHORIZED }))
    if (action === 'list') {
      try { return reply.send(await service.list(data)) } catch { return reply.code(503).send(emptyDataTables(data.draw)) }
    }
    if (request.method !== 'POST' || !hasSameOrigin(request, config)) return reply.code(request.method === 'POST' ? 403 : 405).send(legacyMutation({ status: 'invalid', message: 'Invalid parameters' }))
    let result: LoadBalancerMutationResult
    try {
      result = action === 'delete' ? await service.delete(data.id) : action === 'updateStatus' ? await service.setStatus(data.id, data.status) : { status: 'invalid', message: 'Invalid parameters' }
    } catch { return reply.code(503).send(legacyMutation({ status: 'invalid', message: DATABASE_UNAVAILABLE })) }
    return reply.send(legacyMutation(result))
  }
  for (const url of [`${adminBase}/ajax/load-balancer/`, `${adminBase}/ajax/load-balancers/`]) app.route({ method: ['GET', 'POST'], url, handler: async (request, reply) => await ajax(request, reply, false) })
  for (const url of [`${adminBase}/ajax/load-balancer-list/`, `${adminBase}/ajax/load-balancers-list/`]) app.route({ method: ['GET', 'POST'], url, handler: async (request, reply) => await ajax(request, reply, true) })
}

function normalizedFormBody(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, disallow_hosts: body['disallow_hosts[]'] ?? body.disallow_hosts ?? [], disallow_continent: body['disallow_continent[]'] ?? body.disallow_continent ?? [] }
}
function pageMessage(query: Record<string, unknown>): AdminMessage | undefined {
  if (stringValue(query.deleted) !== '') return { kind: stringValue(query.deleted) === '1' ? 'success' : 'error', text: stringValue(query.deleted) === '1' ? 'The load balancer server deleted successfully' : 'The load balancer server failed to delete' }
  if (stringValue(query.status) !== '') return { kind: stringValue(query.status) === '1' ? 'success' : 'error', text: stringValue(query.status) === '1' ? 'The load balancer server has been successfully updated' : 'The load balancer server failed to update' }
  return undefined
}
function legacyMutation(result: LoadBalancerMutationResult): Readonly<{ status: 'ok' | 'fail'; message: string; result: null }> { return Object.freeze({ status: result.status === 'ok' ? 'ok' : 'fail', message: result.message, result: null }) }
function emptyDataTables(draw: unknown): Readonly<{ draw: number; data: readonly never[]; recordsTotal: 0; recordsFiltered: 0 }> { const parsed = Number.parseInt(stringValue(draw), 10); return Object.freeze({ draw: Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0, data: Object.freeze([]), recordsTotal: 0, recordsFiltered: 0 }) }
function applyAdminHeaders(reply: FastifyReply, config: AppConfig): void { reply.headers({ 'cache-control': 'no-store', pragma: 'no-cache', expires: '0', 'content-security-policy': ADMIN_CSP, 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'x-robots-tag': 'noindex, nofollow', 'access-control-allow-origin': config.baseUrl.origin, vary: 'Origin' }) }
async function authenticatedAdmin(request: FastifyRequest, reply: FastifyReply, adminBase: string, loginUrl: string, auth: AuthService): Promise<AuthUser | null> { try { const user = await auth.authenticate(tokenFor(request), request.headers['user-agent'] ?? ''); if (user === null) await reply.redirect(loginUrl, 302); else if (user.role !== 0 || user.status !== 1) await reply.redirect(`${adminBase}/403/`, 302); return user } catch { reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The authentication database is temporarily unavailable.')); return null } }
function tokenFor(request: FastifyRequest): string { return authTokenFromRequest({ authorization: request.headers.authorization, cookie: request.cookies[AUTH_COOKIE_NAME] }) }
function csrfToken(config: AppConfig, token: string, scope: string): string { return token === '' ? '' : createHmac('sha256', config.secureSalt).update(`${scope}\0${token}`).digest('base64url') }
function validCsrfToken(config: AppConfig, token: string, candidate: string, scope: string): boolean { const expected = csrfToken(config, token, scope); return expected !== '' && candidate.length === expected.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(expected)) }
function hasSameOrigin(request: FastifyRequest, config: AppConfig): boolean { const source = request.headers.origin ?? request.headers.referer; if (source === undefined) return true; try { return new URL(source).origin === config.baseUrl.origin } catch { return false } }
function originError(reply: FastifyReply, adminBase: string): FastifyReply { return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The load balancer request did not originate from this application.')) }
function csrfError(reply: FastifyReply, adminBase: string): FastifyReply { return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The load balancer request could not be verified.')) }
function databaseError(reply: FastifyReply, adminBase: string): FastifyReply { return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, DATABASE_UNAVAILABLE)) }
function objectValue(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function stringValue(value: unknown): string { const scalar = Array.isArray(value) ? value.at(-1) : value; return typeof scalar === 'string' || typeof scalar === 'number' ? String(scalar).trim().slice(0, 2_048) : '' }
