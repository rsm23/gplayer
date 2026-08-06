import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AUTH_COOKIE_NAME, AuthService, authTokenFromRequest, type AuthUser } from '../auth/auth-service.js'
import type { AppConfig } from '../config.js'
import type { PluginAdminService, PluginMutationResult } from '../plugins/plugin-admin-service.js'
import { renderAdminError, renderAdminPlugins, type AdminMessage } from '../player/admin-page.js'

const ADMIN_CSP = "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
const DATABASE_UNAVAILABLE = 'The plugin database is temporarily unavailable.'
const MAX_PLUGIN_BYTES = 100 * 1_024 * 1_024

export async function registerPluginAdminRoutes(app: FastifyInstance, config: AppConfig, auth: AuthService, plugins: PluginAdminService): Promise<void> {
  const adminBase = `/${config.adminDirectory}`
  const loginUrl = `${adminBase}/login/`
  const listUrl = `${adminBase}/plugins/list/`
  const installUrl = `${adminBase}/plugins/install/`
  const statusUrl = `${adminBase}/plugins/status/`
  const uninstallUrl = `${adminBase}/plugins/uninstall/`
  const syncUrl = `${adminBase}/plugins/sync/`
  const scope = 'plugin-mutate'

  app.get(`${adminBase}/plugins`, async (_request, reply) => await reply.redirect(listUrl, 308))
  app.get(`${adminBase}/plugins/list`, async (_request, reply) => await reply.redirect(listUrl, 308))

  app.get(listUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const query = objectValue(request.query)
    try {
      if (stringValue(query.draw) !== '') return reply.type('application/json; charset=utf-8').send(await plugins.records(query))
      const search = stringValue(query.q).slice(0, 50)
      const page = await plugins.records({ draw: 0, start: 0, length: 100, 'search[value]': search, 'order[0][column]': 3, 'order[0][dir]': 'desc' })
      const message = pageMessage(query)
      return reply.type('text/html; charset=utf-8').send(renderAdminPlugins({ adminBase, plugins: page.data, recordsTotal: page.recordsTotal, search, csrfToken: csrfToken(config, tokenFor(request), scope), ...(message === undefined ? {} : { message }) }))
    } catch { return databaseError(reply, adminBase) }
  })

  const synchronize = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    reply.headers({
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow'
    })
    const query = objectValue(request.query)
    const action = stringValue(query.action)
    if (!validSyncSecret(config.secureSalt, stringValue(query.secure)) || stringValue(query.id) === '') return reply.type('text/plain; charset=utf-8').send('Invalid request')
    if (action !== 'ping' && action !== 'download') return reply.type('text/plain; charset=utf-8').send('Invalid action')
    const result = await plugins.syncArchive(query.id).catch(() => ({ status: 'invalid' as const }))
    if (result.status === 'not-found') return reply.type('text/plain; charset=utf-8').send('Not found')
    if (result.status === 'invalid') return reply.type('text/plain; charset=utf-8').send('Invalid')
    if (action === 'ping') return reply.type('text/plain; charset=utf-8').send('ok')
    const fallback = result.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    return reply
      .header('content-disposition', `attachment; filename="${fallback}"`)
      .type('application/octet-stream')
      .send(result.archive)
  }
  app.get(syncUrl.slice(0, -1), synchronize)
  app.get(syncUrl, synchronize)

  app.post(installUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) return jsonOrPageError(reply, adminBase, request, 403, 'The plugin request did not originate from this application.')
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    let submission: Readonly<{ fields: Record<string, unknown>; file?: Buffer }>
    try { submission = await pluginSubmission(request) } catch { return jsonOrPageError(reply, adminBase, request, 400, 'Please select a valid ZIP file.') }
    const redirect = stringValue(submission.fields.redirect) === '1'
    if (redirect && !validCsrfToken(config, tokenFor(request), stringValue(submission.fields.csrf), scope)) return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The plugin request could not be verified.'))
    if (submission.file === undefined) return redirect ? await reply.redirect(`${listUrl}?notice=install&success=0&message=${encodeURIComponent('Please select a valid ZIP file.')}`, 303) : reply.code(400).type('application/json; charset=utf-8').send(legacyMutation({ status: 'invalid', message: 'Please select a valid ZIP file.' }))
    let result: PluginMutationResult
    try { result = await plugins.install(submission.file) } catch { result = { status: 'invalid', message: 'Plugin installation failed.' } }
    if (redirect) return await reply.redirect(`${listUrl}?notice=install&success=${result.status === 'ok' ? '1' : '0'}&message=${encodeURIComponent(result.message)}`, 303)
    return reply.type('application/json; charset=utf-8').send(legacyMutation(result))
  })

  for (const [url, action, notice] of [
    [statusUrl, async (body: Record<string, unknown>) => await plugins.setStatus(body.id, body.status), 'status'],
    [uninstallUrl, async (body: Record<string, unknown>) => await plugins.uninstall(body.id), 'uninstall']
  ] as const) app.post(url, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const body = objectValue(request.body)
    const csrf = stringValue(body.csrf)
    const legacyJson = csrf === ''
    if (!hasSameOrigin(request, config)) {
      const message = 'The plugin request did not originate from this application.'
      return legacyJson
        ? reply.code(403).type('application/json; charset=utf-8').send({ status: 'fail', message })
        : reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, message))
    }
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    if (!legacyJson && !validCsrfToken(config, tokenFor(request), csrf, scope)) return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The plugin request could not be verified.'))
    let result: PluginMutationResult
    try { result = await action(body) } catch { result = { status: 'invalid', message: notice === 'uninstall' ? 'Uninstall failed!' : 'Plugin status failed to update.' } }
    if (legacyJson) return reply.type('application/json; charset=utf-8').send(legacyMutation(result))
    return await reply.redirect(`${listUrl}?notice=${notice}&success=${result.status === 'ok' ? '1' : '0'}&message=${encodeURIComponent(result.message)}`, 303)
  })
}

async function pluginSubmission(request: FastifyRequest): Promise<Readonly<{ fields: Record<string, unknown>; file?: Buffer }>> {
  if (!request.isMultipart()) throw new Error('Multipart required')
  const fields: Record<string, unknown> = {}
  let file: Buffer | undefined
  for await (const part of request.parts({ limits: { fileSize: MAX_PLUGIN_BYTES, files: 1, fields: 10, parts: 11 } })) {
    if (part.type === 'file') {
      if (part.fieldname !== 'pluginZipFile' || part.filename === '') { part.file.resume(); continue }
      if (!part.filename.toLowerCase().endsWith('.zip')) { part.file.resume(); throw new Error('ZIP required') }
      const content = await part.toBuffer()
      if (part.file.truncated || content.length === 0 || content.length > MAX_PLUGIN_BYTES) throw new Error('File limit exceeded')
      file = content
    } else addField(fields, part.fieldname, part.value)
  }
  return Object.freeze({ fields, ...(file === undefined ? {} : { file }) })
}
function addField(fields: Record<string, unknown>, key: string, value: unknown): void { const current = fields[key]; fields[key] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value] }
function pageMessage(query: Record<string, unknown>): AdminMessage | undefined { const notice = stringValue(query.notice); if (notice === '') return undefined; const success = stringValue(query.success) === '1'; const supplied = stringValue(query.message); const fallback = notice === 'install' ? success ? 'Plugin installed successfully.' : 'Plugin installation failed.' : notice === 'uninstall' ? success ? 'Plugin uninstalled successfully.' : 'Uninstall failed!' : success ? 'Plugin status updated successfully.' : 'Plugin status failed to update.'; return { kind: success ? 'success' : 'error', text: supplied || fallback } }
function legacyMutation(result: PluginMutationResult): Readonly<{ status: 'ok' | 'fail'; message: string; name?: string; icon_uri?: string }> { return Object.freeze({ status: result.status === 'ok' ? 'ok' : 'fail', message: result.message, ...(result.status === 'ok' && result.name !== undefined ? { name: result.name, icon_uri: result.iconUri ?? '' } : {}) }) }
function jsonOrPageError(reply: FastifyReply, adminBase: string, request: FastifyRequest, code: number, message: string): FastifyReply { return request.isMultipart() ? reply.code(code).type('application/json; charset=utf-8').send({ status: 'fail', message }) : reply.code(code).type('text/html; charset=utf-8').send(renderAdminError(adminBase, code === 403 ? 403 : 503, message)) }
function applyAdminHeaders(reply: FastifyReply, config: AppConfig): void { reply.headers({ 'cache-control': 'no-store', pragma: 'no-cache', expires: '0', 'content-security-policy': ADMIN_CSP, 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'x-robots-tag': 'noindex, nofollow', 'access-control-allow-origin': config.baseUrl.origin, vary: 'Origin' }) }
async function authenticatedAdmin(request: FastifyRequest, reply: FastifyReply, adminBase: string, loginUrl: string, auth: AuthService): Promise<AuthUser | null> { try { const user = await auth.authenticate(tokenFor(request), request.headers['user-agent'] ?? ''); if (user === null) await reply.redirect(loginUrl, 302); else if (user.role !== 0 || user.status !== 1) await reply.redirect(`${adminBase}/403/`, 302); return user } catch { reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The authentication database is temporarily unavailable.')); return null } }
function tokenFor(request: FastifyRequest): string { return authTokenFromRequest({ authorization: request.headers.authorization, cookie: request.cookies[AUTH_COOKIE_NAME] }) }
function csrfToken(config: AppConfig, token: string, scope: string): string { return token === '' ? '' : createHmac('sha256', config.secureSalt).update(`${scope}\0${token}`).digest('base64url') }
function validCsrfToken(config: AppConfig, token: string, candidate: string, scope: string): boolean { const expected = csrfToken(config, token, scope); return expected !== '' && candidate.length === expected.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(expected)) }
function validSyncSecret(expected: string, candidate: string): boolean { return candidate.length === expected.length && timingSafeEqual(Buffer.from(expected), Buffer.from(candidate)) }
function hasSameOrigin(request: FastifyRequest, config: AppConfig): boolean { const source = request.headers.origin ?? request.headers.referer; if (source === undefined) return true; try { return new URL(source).origin === config.baseUrl.origin } catch { return false } }
function databaseError(reply: FastifyReply, adminBase: string): FastifyReply { return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, DATABASE_UNAVAILABLE)) }
function objectValue(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function stringValue(value: unknown): string { const scalar = Array.isArray(value) ? value.at(-1) : value; return typeof scalar === 'string' || typeof scalar === 'number' ? String(scalar).trim().slice(0, 1_024) : '' }
