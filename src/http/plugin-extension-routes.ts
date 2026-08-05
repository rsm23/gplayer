import { createHmac, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AUTH_COOKIE_NAME, AuthService, authTokenFromRequest, type AuthUser } from '../auth/auth-service.js'
import type { AppConfig } from '../config.js'
import { renderAdminError, renderAdminPluginConfiguration, type AdminMessage } from '../player/admin-page.js'
import type { PluginExtensionRuntime, PluginPageResult } from '../plugins/plugin-extension-runtime.js'

const SLOT_PATTERN = /<div class="plugin-slot" data-plugin-slot="([a-z0-9][a-z0-9._:-]{0,127})"><\/div>/gi
const PAGE_CSP = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data: http: https:; font-src 'self'; connect-src 'self' http: https:; media-src 'self' blob: http: https:; form-action 'self'; base-uri 'none'; frame-ancestors 'self'; object-src 'none'"
const SKIPPED_OVERRIDE_PREFIXES = new Set(['ajax', 'api', 'api-config', 'assets', 'plugins', 'uploads', 'media', 'hls', 'mpd', 'poster', 'subtitle', 'stream-seg', 'stream-ts', 'stream-vid'])

export async function registerPluginExtensionRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  runtime: PluginExtensionRuntime,
  options: Readonly<{
    loadPlayerSlugs?: () => Promise<Readonly<{ slug_embed: string; slug_download: string; slug_request: string }>>
  }> = {}
): Promise<void> {
  const adminBase = `/${config.adminDirectory}`
  const loginUrl = `${adminBase}/login/`

  app.addHook('preHandler', async (request, reply) => {
    if (reply.sent || !['GET', 'POST'].includes(request.method) || request.isMultipart()) return
    const pathname = requestPath(request.url)
    const segments = pathname.split('/').filter(Boolean)
    const backend = segments[0] === config.adminDirectory
    const page = legacyPageName(backend ? segments[1] : segments[0])
    if (SKIPPED_OVERRIDE_PREFIXES.has(page) || legacyPlayerControllerPage(page, config) || page === 'p' || backend && ['login', 'logout', 'register', 'reset-password', '403', '404'].includes(page)) return
    let user: AuthUser | null = null
    if (backend) {
      user = await authenticate(request, auth).catch(() => null)
      if (user === null || user.status !== 1) return
    }
    const result = await runtime.overridePage(page, backend, pageInput(request, config, user, page)).catch(() => null)
    if (result !== null) {
      if (!backend && options.loadPlayerSlugs !== undefined) {
        const playerSlugs = await options.loadPlayerSlugs().catch(() => null)
        if (playerSlugs === null || [playerSlugs.slug_embed, playerSlugs.slug_download, playerSlugs.slug_request].includes(page)) return
      }
      if (request.method === 'POST' && !sameOrigin(request, config)) return reply.code(403).type('text/plain; charset=utf-8').send('The plugin request did not originate from this application.')
      sendPluginPage(reply, result, config)
    }
  })

  const dispatch = async (request: FastifyRequest, reply: FastifyReply, backend: boolean): Promise<unknown> => {
    const params = objectValue(request.params)
    const plugin = scalar(params.plugin)
    const page = scalar(params.page) || 'index'
    let user: AuthUser | null = null
    if (request.method === 'POST' && !sameOrigin(request, config)) return reply.code(403).type('text/html; charset=utf-8').send(backend ? renderAdminError(adminBase, 403, 'The plugin request did not originate from this application.') : 'The plugin request did not originate from this application.')
    if (backend) {
      user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
      if (user === null || reply.sent) return
      if (request.method === 'POST' && !validPluginCsrf(config, tokenFor(request), plugin, scalar(objectValue(request.body).csrf))) return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The plugin request could not be verified.'))
    }
    const result = await runtime.pluginPage(plugin, page, backend, pageInput(request, config, user, page, pluginCsrf(config, tokenFor(request), plugin))).catch(() => null)
    if (result === null) return reply.code(404).type('text/html; charset=utf-8').send(backend ? renderAdminError(adminBase, 404, 'Plugin page not found.') : 'Plugin page not found.')
    return sendPluginPage(reply, result, config)
  }

  for (const route of ['/p/:plugin', '/p/:plugin/', '/p/:plugin/:page', '/p/:plugin/:page/', '/p/:plugin/:page/*']) app.route({ method: ['GET', 'POST'], url: route, handler: async (request, reply) => await dispatch(request, reply, false) })
  for (const route of [`${adminBase}/p/:plugin`, `${adminBase}/p/:plugin/`, `${adminBase}/p/:plugin/:page`, `${adminBase}/p/:plugin/:page/`, `${adminBase}/p/:plugin/:page/*`]) app.route({ method: ['GET', 'POST'], url: route, handler: async (request, reply) => await dispatch(request, reply, true) })

  app.get('/plugins/:plugin/*', async (request, reply) => {
    const params = objectValue(request.params)
    const plugin = scalar(params.plugin)
    const relative = scalar(params['*'])
    const asset = await runtime.asset(plugin, relative).catch(() => null)
    if (asset === null) return reply.code(404).send()
    return reply
      .headers({ 'cache-control': 'public, max-age=300', 'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' })
      .type(asset.type)
      .send(createReadStream(asset.path))
  })

  const configUrl = `${adminBase}/plugins/config/`
  app.get(`${adminBase}/plugins/config`, async (request, reply) => await redirectWithQuery(request, reply, configUrl))
  app.get(configUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const query = objectValue(request.query)
    const configuration = await runtime.configuration(query.id).catch(() => null)
    if (configuration === null) return reply.code(404).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 404, 'Plugin not found.'))
    const requestedPage = scalar(query.page) || 'config'
    if (requestedPage !== 'config') {
      const result = await runtime.pluginPage(configuration.manifest.folder, requestedPage, true, pageInput(request, config, user, requestedPage, pluginCsrf(config, tokenFor(request), configuration.manifest.folder))).catch(() => null)
      if (result === null) return reply.code(404).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 404, 'Plugin page not found.'))
      return sendPluginPage(reply, result, config)
    }
    const message = configurationMessage(query)
    return reply.type('text/html; charset=utf-8').send(renderAdminPluginConfiguration({
      adminBase,
      plugin: configuration.plugin,
      fields: configuration.fields,
      csrfToken: pluginCsrf(config, tokenFor(request), configuration.manifest.folder),
      ...(message === undefined ? {} : { message })
    }))
  })

  app.post(configUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!sameOrigin(request, config)) return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The plugin request did not originate from this application.'))
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    const configuration = await runtime.configuration(body.id ?? objectValue(request.query).id).catch(() => null)
    if (configuration === null) return reply.code(404).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 404, 'Plugin not found.'))
    const csrf = pluginCsrf(config, tokenFor(request), configuration.manifest.folder)
    if (!safeEqual(csrf, scalar(body.csrf))) return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The plugin request could not be verified.'))
    const result = await runtime.saveConfiguration(configuration.plugin.id, body).catch(() => ({ status: 'invalid' as const, message: 'Plugin configuration failed to save.', errors: Object.freeze({}) }))
    if (result.status === 'ok') return await reply.redirect(`${configUrl}?id=${encodeURIComponent(configuration.plugin.id)}&saved=1`, 303)
    return reply.code(400).type('text/html; charset=utf-8').send(renderAdminPluginConfiguration({
      adminBase,
      plugin: configuration.plugin,
      fields: configuration.fields,
      csrfToken: csrf,
      values: body,
      errors: result.errors,
      message: { kind: 'error', text: result.message }
    }))
  })

  app.addHook('onSend', async (request, _reply, payload) => {
    if (typeof payload !== 'string') return payload
    const withSlots = injectLegacySlots(payload, requestPath(request.url), config.adminDirectory)
    const matches = [...withSlots.matchAll(SLOT_PATTERN)]
    if (matches.length === 0) return payload
    const user = await authenticate(request, auth).catch(() => null)
    const isAdmin = user?.status === 1 && user.role === 0
    const context = Object.freeze({ path: requestPath(request.url), method: request.method, query: cloneable(objectValue(request.query)), user: publicUser(user), baseUrl: config.baseUrl.href, adminDirectory: config.adminDirectory })
    const rendered = new Map<string, string>()
    for (const match of matches) {
      const slot = match[1] ?? ''
      if (!rendered.has(slot)) rendered.set(slot, await runtime.renderWidgets(slot, isAdmin, context).catch(() => ''))
    }
    return withSlots.replace(SLOT_PATTERN, (_full, slot: string) => rendered.get(slot) ?? '')
  })
}

function injectLegacySlots(payload: string, pathname: string, adminDirectory: string): string {
  if (!payload.includes('</main>')) return payload
  const base = `/${adminDirectory}`
  const path = pathname.replace(/\/+$/, '') || '/'
  const slots: string[] = []
  let top = ''
  let formBottom = ''
  if (path === base || path === `${base}/dashboard`) slots.push('backend.dashboard.main_bottom', 'backend.dashboard.sidebar_bottom', 'backend.dashboard.bottom')
  else if (path === `${base}/plugins/list`) { top = 'backend.plugins.list.top'; slots.push('backend.plugins.list.bottom') }
  else if (path === `${base}/settings` || path.startsWith(`${base}/settings/`)) { formBottom = 'backend.settings.form_bottom'; slots.push('backend.settings.bottom') }
  else if (path === `${base}/users` || path === `${base}/users/list`) { top = 'backend.users.list.top'; slots.push('backend.users.list.bottom') }
  else if (path === `${base}/profile` || path === `${base}/users/profile`) { formBottom = 'backend.users.profile.form_bottom'; slots.push('backend.users.profile.bottom') }
  else if (path === `${base}/users/sessions`) slots.push('backend.users.sessions.bottom')
  else if (path === `${base}/users/new`) { formBottom = 'backend.users.new.form_bottom'; slots.push('backend.users.new.bottom') }
  else if (path === `${base}/users/edit`) { formBottom = 'backend.users.edit.form_bottom'; slots.push('backend.users.edit.bottom') }
  else if (path === `${base}/videos/list`) { top = 'backend.videos.list.top'; slots.push('backend.videos.list.bottom') }
  else if (path === `${base}/videos/new`) { formBottom = 'backend.videos.new.form_bottom'; slots.push('backend.videos.new.bottom') }
  else if (path === `${base}/videos/edit`) { formBottom = 'backend.videos.edit.form_bottom'; slots.push('backend.videos.edit.bottom') }
  else if (path === `${base}/videos/subtitles` || path === `${base}/subtitles/list`) slots.push('backend.videos.subtitles.bottom')
  else if (path === `${base}/load-balancers/list`) slots.push('backend.load_balancers.list.bottom')
  else if (path === `${base}/load-balancers/new`) { formBottom = 'backend.load_balancers.new.form_bottom'; slots.push('backend.load_balancers.new.bottom') }
  else if (path === `${base}/load-balancers/edit`) { formBottom = 'backend.load_balancers.edit.form_bottom'; slots.push('backend.load_balancers.edit.bottom') }
  else if (path === `${base}/gdrive` || path === `${base}/gdrive/accounts` || path === `${base}/gdrive/account/list`) slots.push('backend.gdrive.list.bottom')
  else if (path === `${base}/gdrive/new` || path === `${base}/gdrive/account/new`) { formBottom = 'backend.gdrive.new.form_bottom'; slots.push('backend.gdrive.new.bottom') }
  else if (path === `${base}/gdrive/edit` || path === `${base}/gdrive/account/edit`) { formBottom = 'backend.gdrive.edit.form_bottom'; slots.push('backend.gdrive.edit.bottom') }
  else if (path === `${base}/gdrive/files`) slots.push('backend.gdrive.files.bottom')
  else if (path === `${base}/gdrive/backup-files` || path === `${base}/gdrive/backup/files`) slots.push('backend.gdrive.backup_files.bottom')
  else if (path === `${base}/gdrive/backup-queue` || path === `${base}/gdrive/backup/queue`) slots.push('backend.gdrive.backup_queue.bottom')
  else if (path === `${base}/log`) slots.push('backend.log.bottom')
  let output = payload
  if (top !== '' && !output.includes(`data-plugin-slot="${top}"`)) output = insertBeforeFirstSection(output, marker(top))
  if (formBottom !== '' && !output.includes(`data-plugin-slot="${formBottom}"`)) output = insertBeforePrimaryFormClose(output, marker(formBottom))
  for (const slot of slots) if (!output.includes(`data-plugin-slot="${slot}"`)) output = output.replace('</main>', `${marker(slot)}</main>`)
  return output
}

function marker(slot: string): string { return `<div class="plugin-slot" data-plugin-slot="${slot}"></div>` }
function insertBeforeFirstSection(payload: string, value: string): string { const index = payload.indexOf('<section'); return index < 0 ? payload.replace('</main>', `${value}</main>`) : `${payload.slice(0, index)}${value}${payload.slice(index)}` }
function insertBeforePrimaryFormClose(payload: string, value: string): string { const form = payload.search(/<form[^>]+class="[^"]*(?:admin-settings-form|admin-user-form|settings-form|video-editor-form)[^"]*"/i); if (form < 0) return payload.replace('</main>', `${value}</main>`); const end = payload.indexOf('</form>', form); return end < 0 ? payload.replace('</main>', `${value}</main>`) : `${payload.slice(0, end)}${value}${payload.slice(end)}` }

function sendPluginPage(reply: FastifyReply, result: PluginPageResult, config: AppConfig): FastifyReply {
  reply.headers({ 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP, 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN', 'access-control-allow-origin': config.baseUrl.origin, vary: 'Origin', ...result.headers })
  return reply.code(result.status).type(result.contentType).send(result.body)
}

function pageInput(request: FastifyRequest, config: AppConfig, user: AuthUser | null, page: string, csrf = ''): Readonly<Record<string, unknown>> {
  return Object.freeze({
    method: request.method,
    path: requestPath(request.url),
    page,
    query: cloneable(objectValue(request.query)),
    body: cloneable(objectValue(request.body)),
    user: publicUser(user),
    baseUrl: config.baseUrl.href,
    adminDirectory: config.adminDirectory,
    csrf
  })
}

function publicUser(user: AuthUser | null): Readonly<Record<string, unknown>> | null { return user === null ? null : Object.freeze({ id: user.id, name: user.name, username: user.username, email: user.email, role: user.role, status: user.status }) }
function cloneable(value: Record<string, unknown>): Readonly<Record<string, unknown>> { try { return Object.freeze(structuredClone(value)) } catch { return Object.freeze({}) } }
function requestPath(url: string): string { try { return new URL(url, 'http://gplayer.invalid').pathname } catch { return '/' } }
function legacyPageName(value: string | undefined): string { return (value ?? '').split('.', 1)[0]?.trim() || 'index' }
function legacyPlayerControllerPage(page: string, config: AppConfig): boolean {
  return ['e', 'd', 'r', config.slugs.embed, config.slugs.download, config.slugs.request].includes(page)
}
function objectValue(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function scalar(value: unknown): string { const item = Array.isArray(value) ? value.at(-1) : value; return typeof item === 'string' || typeof item === 'number' ? String(item).trim().slice(0, 100_000) : '' }
function tokenFor(request: FastifyRequest): string { return authTokenFromRequest({ authorization: request.headers.authorization, cookie: request.cookies[AUTH_COOKIE_NAME] }) }
function pluginCsrf(config: AppConfig, token: string, plugin: string): string { return token === '' ? '' : createHmac('sha256', config.secureSalt).update(`plugin-page\0${plugin}\0${token}`).digest('base64url') }
function validPluginCsrf(config: AppConfig, token: string, plugin: string, candidate: string): boolean { return safeEqual(pluginCsrf(config, token, plugin), candidate) }
function safeEqual(expected: string, candidate: string): boolean { return expected !== '' && expected.length === candidate.length && timingSafeEqual(Buffer.from(expected), Buffer.from(candidate)) }
function sameOrigin(request: FastifyRequest, config: AppConfig): boolean { const source = request.headers.origin ?? request.headers.referer; if (source === undefined) return true; try { return new URL(source).origin === config.baseUrl.origin } catch { return false } }
async function authenticate(request: FastifyRequest, auth: AuthService): Promise<AuthUser | null> { return await auth.authenticate(tokenFor(request), request.headers['user-agent'] ?? '') }
async function authenticatedUser(request: FastifyRequest, reply: FastifyReply, adminBase: string, loginUrl: string, auth: AuthService): Promise<AuthUser | null> { try { const user = await authenticate(request, auth); if (user === null || user.status !== 1) await reply.redirect(loginUrl, 302); return user } catch { reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The authentication database is temporarily unavailable.')); return null } }
async function authenticatedAdmin(request: FastifyRequest, reply: FastifyReply, adminBase: string, loginUrl: string, auth: AuthService): Promise<AuthUser | null> { const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth); if (user !== null && user.role !== 0 && !reply.sent) await reply.redirect(`${adminBase}/403/`, 302); return user?.role === 0 ? user : null }
function applyAdminHeaders(reply: FastifyReply, config: AppConfig): void { reply.headers({ 'cache-control': 'no-store', pragma: 'no-cache', expires: '0', 'content-security-policy': PAGE_CSP, 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'x-robots-tag': 'noindex, nofollow', 'access-control-allow-origin': config.baseUrl.origin, vary: 'Origin' }) }
async function redirectWithQuery(request: FastifyRequest, reply: FastifyReply, target: string): Promise<FastifyReply> { const query = request.url.split('?', 2)[1]; return await reply.redirect(`${target}${query === undefined ? '' : `?${query}`}`, 308) }
function configurationMessage(query: Record<string, unknown>): AdminMessage | undefined { return scalar(query.saved) === '1' ? { kind: 'success', text: 'Plugin configuration saved successfully.' } : undefined }
