import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AUTH_COOKIE_NAME, AuthService, authTokenFromRequest, type AuthUser } from '../auth/auth-service.js'
import type { AppConfig } from '../config.js'
import { renderAdminError, renderAdminSubtitles, type AdminMessage } from '../player/admin-page.js'
import type { SubtitleAccess, SubtitleAdminService, SubtitleMutationResult } from '../subtitles/subtitle-admin-service.js'

const ADMIN_CSP = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
const UNAUTHORIZED = 'You are not authorized to access this feature'

type SubtitleSubmission = Readonly<{
  fields: Record<string, unknown>
  file?: Readonly<{ filename: string; content: Buffer }>
}>

export async function registerSubtitleAdminRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  subtitles: SubtitleAdminService
): Promise<void> {
  const adminBase = `/${config.adminDirectory}`
  const loginUrl = `${adminBase}/login/`
  const pageUrl = `${adminBase}/videos/subtitles/`
  const uploadUrl = `${pageUrl}upload/`
  const renameUrl = `${pageUrl}rename/`
  const deleteUrl = `${pageUrl}delete/`
  const migrateUrl = `${pageUrl}migrate/`
  const ajaxUrl = `${adminBase}/ajax/subtitles/`
  const listAjaxUrl = `${adminBase}/ajax/subtitles-list/`

  app.get(`${adminBase}/videos/subtitles`, async (_request, reply) => await reply.redirect(pageUrl, 308))

  app.get(pageUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    try {
      return reply.type('text/html; charset=utf-8').send(await subtitlePage(config, request, user, subtitles, pageMessage(request)))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The subtitle database is temporarily unavailable.'))
    }
  })

  app.post(uploadUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) return subtitleOriginError(reply, adminBase)
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    let submission: SubtitleSubmission
    try {
      submission = await subtitleSubmission(request)
    } catch {
      return await renderSubtitleError(reply, config, request, user, subtitles, 'The subtitle file failed to upload')
    }
    if (!validCsrfToken(config, tokenFor(request), stringValue(submission.fields.csrf), 'subtitle-upload')) {
      return subtitleCsrfError(reply, adminBase)
    }
    if (submission.file === undefined) {
      return await renderSubtitleError(reply, config, request, user, subtitles, 'The subtitle file failed to upload')
    }
    const result = await subtitles.upload({
      originalName: submission.file.filename,
      content: submission.file.content,
      language: submission.fields.uploadSubLang
    }, accessFor(user))
    if (result.status === 'ok') return await reply.redirect(`${pageUrl}?uploaded=1`, 303)
    return await renderSubtitleError(reply, config, request, user, subtitles, result.message)
  })

  app.post(renameUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) return subtitleOriginError(reply, adminBase)
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'subtitle-rename')) return subtitleCsrfError(reply, adminBase)
    const result = await subtitles.rename(body.id, body.name, accessFor(user))
    if (result.status === 'ok') return await reply.redirect(`${pageUrl}?renamed=1`, 303)
    return await renderSubtitleError(reply, config, request, user, subtitles, result.message)
  })

  app.post(deleteUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) return subtitleOriginError(reply, adminBase)
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'subtitle-delete')) return subtitleCsrfError(reply, adminBase)
    const result = await subtitles.delete(body.id, accessFor(user))
    if (result.status === 'ok') return await reply.redirect(`${pageUrl}?deleted=1`, 303)
    return await renderSubtitleError(reply, config, request, user, subtitles, result.message)
  })

  app.post(migrateUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) return subtitleOriginError(reply, adminBase)
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    if (user.role !== 0) return await reply.redirect(`${adminBase}/403/`, 302)
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'subtitle-migrate')) return subtitleCsrfError(reply, adminBase)
    const result = await subtitles.migrate(body.oldLocation, body.newLocation, accessFor(user))
    if (result.status === 'ok') return await reply.redirect(`${pageUrl}?migrated=1`, 303)
    return await renderSubtitleError(reply, config, request, user, subtitles, result.message)
  })

  const subtitleAjax = async (request: FastifyRequest, reply: FastifyReply, listOnly: boolean): Promise<unknown> => {
    applyAdminHeaders(reply, config)
    reply.type('application/json; charset=utf-8')
    let submission: SubtitleSubmission | undefined
    let data = { ...objectValue(request.query), ...objectValue(request.body) }
    if (request.isMultipart()) {
      try {
        submission = await subtitleSubmission(request)
        data = { ...objectValue(request.query), ...submission.fields }
      } catch {
        return reply.send(legacyMutation({ status: 'fail', message: 'The subtitle file failed to upload' }))
      }
    }

    let user: AuthUser | null
    try {
      user = await auth.authenticate(tokenFor(request) || stringValue(data.token), request.headers['user-agent'] ?? '')
    } catch {
      return reply.code(503).send(listOnly ? emptyDataTables(data.draw) : legacyMutation({ status: 'fail', message: 'The subtitle database is temporarily unavailable.' }))
    }
    if (user === null) return reply.send(listOnly ? emptyDataTables(data.draw) : legacyMutation({ status: 'fail', message: UNAUTHORIZED }))
    const access = accessFor(user)
    if (listOnly) {
      try {
        return reply.send(await subtitles.list(data, access))
      } catch {
        return reply.code(503).send(emptyDataTables(data.draw))
      }
    }

    const action = stringValue(data.action)
    if (['uploadSubtitle', 'rename', 'delete', 'migrate'].includes(action)) {
      if (request.method !== 'POST') return reply.code(405).send(legacyMutation({ status: 'fail', message: 'Invalid parameters' }))
      if (!hasSameOrigin(request, config)) return reply.code(403).send(legacyMutation({ status: 'fail', message: 'The subtitle request did not originate from this application.' }))
    }
    try {
      if (action === 'getHosts') {
        if (!access.isAdmin) return reply.send(legacyMutation({ status: 'fail', message: UNAUTHORIZED }))
        const hosts = await subtitles.hosts(access)
        return reply.send({ status: 'ok', message: 'OK', result: hosts })
      }
      if (action === 'uploadSubtitle') {
        if (submission?.file === undefined) return reply.send(legacyMutation({ status: 'fail', message: 'The subtitle file failed to upload' }))
        const result = await subtitles.upload({
          originalName: submission.file.filename,
          content: submission.file.content,
          language: data.uploadSubLang
        }, access)
        return reply.send(legacyMutation(result))
      }
      if (action === 'rename') return reply.send(legacyMutation(await subtitles.rename(data.id, data.name, access)))
      if (action === 'delete') return reply.send(legacyMutation(await subtitles.delete(data.id, access)))
      if (action === 'migrate') return reply.send(legacyMutation(await subtitles.migrate(data.oldLocation, data.newLocation, access)))
      return reply.send(legacyMutation({ status: 'fail', message: 'Invalid parameters' }))
    } catch {
      return reply.code(503).send(legacyMutation({ status: 'fail', message: 'The subtitle database is temporarily unavailable.' }))
    }
  }

  app.route({ method: ['GET', 'POST'], url: listAjaxUrl, handler: async (request, reply) => await subtitleAjax(request, reply, true) })
  app.route({ method: ['GET', 'POST'], url: ajaxUrl, handler: async (request, reply) => await subtitleAjax(request, reply, false) })
}

async function subtitlePage(
  config: AppConfig,
  request: FastifyRequest,
  user: AuthUser,
  subtitles: SubtitleAdminService,
  message?: AdminMessage
): Promise<string> {
  const query = objectValue(request.query)
  const search = stringValue(query.q).slice(0, 254)
  const access = accessFor(user)
  const [records, hosts] = await Promise.all([
    subtitles.records({
      draw: 0,
      start: 0,
      length: 100,
      'search[value]': search,
      'order[0][column]': 6,
      'order[0][dir]': 'desc'
    }, access),
    access.isAdmin ? subtitles.hosts(access) : Promise.resolve(Object.freeze([]) as readonly string[])
  ])
  const token = tokenFor(request)
  return renderAdminSubtitles({
    adminBase: `/${config.adminDirectory}`,
    subtitles: records.data,
    recordsTotal: records.recordsTotal,
    search,
    isAdmin: access.isAdmin,
    hosts,
    uploadCsrfToken: csrfToken(config, token, 'subtitle-upload'),
    renameCsrfToken: csrfToken(config, token, 'subtitle-rename'),
    deleteCsrfToken: csrfToken(config, token, 'subtitle-delete'),
    migrateCsrfToken: csrfToken(config, token, 'subtitle-migrate'),
    ...(message === undefined ? {} : { message })
  })
}

async function renderSubtitleError(
  reply: FastifyReply,
  config: AppConfig,
  request: FastifyRequest,
  user: AuthUser,
  subtitles: SubtitleAdminService,
  text: string
): Promise<FastifyReply> {
  return reply.code(400).type('text/html; charset=utf-8').send(await subtitlePage(config, request, user, subtitles, { kind: 'error', text }))
}

async function subtitleSubmission(request: FastifyRequest): Promise<SubtitleSubmission> {
  if (!request.isMultipart()) throw new Error('Multipart encoding required')
  const fields: Record<string, unknown> = {}
  let file: Readonly<{ filename: string; content: Buffer }> | undefined
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (part.fieldname !== 'uploadSubFile' || part.filename === '') {
        part.file.resume()
        continue
      }
      const content = await part.toBuffer()
      if (part.file.truncated) throw new Error('File limit exceeded')
      file = Object.freeze({ filename: part.filename, content })
      continue
    }
    addField(fields, part.fieldname, part.value)
  }
  return Object.freeze({ fields, ...(file === undefined ? {} : { file }) })
}

function addField(fields: Record<string, unknown>, key: string, value: unknown): void {
  const current = fields[key]
  if (current === undefined) fields[key] = value
  else if (Array.isArray(current)) current.push(value)
  else fields[key] = [current, value]
}

function accessFor(user: AuthUser): SubtitleAccess {
  return Object.freeze({ userId: String(user.id), isAdmin: user.role === 0 })
}

function pageMessage(request: FastifyRequest): AdminMessage | undefined {
  const query = objectValue(request.query)
  if (stringValue(query.uploaded) === '1') return { kind: 'success', text: 'The subtitle file has been uploaded successfully' }
  if (stringValue(query.renamed) === '1') return { kind: 'success', text: 'The subtitle has been successfully renamed' }
  if (stringValue(query.deleted) === '1') return { kind: 'success', text: 'The subtitle file has been successfully deleted' }
  if (stringValue(query.migrated) === '1') return { kind: 'success', text: 'Migration of the subtitle files has been successful' }
  return undefined
}

function legacyMutation(result: SubtitleMutationResult): Readonly<Record<string, unknown>> {
  return Object.freeze({
    status: result.status,
    message: result.message,
    result: result.data ?? null,
    ...(result.data === undefined ? {} : { data: result.data })
  })
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

function subtitleOriginError(reply: FastifyReply, adminBase: string): FastifyReply {
  return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The subtitle request did not originate from this application.'))
}

function subtitleCsrfError(reply: FastifyReply, adminBase: string): FastifyReply {
  return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The subtitle request could not be verified.'))
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
    const user = await auth.authenticate(tokenFor(request), request.headers['user-agent'] ?? '')
    if (user === null) await reply.redirect(loginUrl, 302)
    return user
  } catch {
    reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The authentication database is temporarily unavailable.'))
    return null
  }
}

function tokenFor(request: FastifyRequest): string {
  return authTokenFromRequest({ authorization: request.headers.authorization, cookie: request.cookies[AUTH_COOKIE_NAME] })
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
  return typeof value === 'string' ? value.slice(0, 4_096).trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}
