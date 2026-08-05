import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AUTH_COOKIE_NAME, AuthService, authTokenFromRequest, type AuthUser } from '../auth/auth-service.js'
import type { UserAdminService } from '../auth/user-admin-service.js'
import type { AppConfig } from '../config.js'
import { renderAdminCustomHeaderSettings, renderAdminError, renderAdminGeneralSettings, renderAdminPublicSettings, renderAdminShortlinkSettings, renderAdminSiteSettings, renderAdminSmtpSettings, type AdminMessage } from '../player/admin-page.js'
import type { SettingsAdminService } from '../settings/settings-admin-service.js'
import { InvalidSiteAssetError, type SiteAssetManager } from '../settings/site-assets-service.js'

const ADMIN_CSP = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

export async function registerAdminSettingsRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  settings: SettingsAdminService,
  users: UserAdminService,
  siteAssets: SiteAssetManager
): Promise<void> {
  const adminBase = `/${config.adminDirectory}`
  const loginUrl = `${adminBase}/login/`
  const generalUrl = `${adminBase}/settings/general/`
  const publicUrl = `${adminBase}/settings/public/`
  const smtpUrl = `${adminBase}/settings/smtp/`
  const siteUrl = `${adminBase}/settings/site/`
  const shortlinkUrl = `${adminBase}/settings/shortlink/`
  const customHeadersUrl = `${adminBase}/settings/custom-headers/`

  app.get(`${adminBase}/settings/general`, async (_request, reply) => await reply.redirect(generalUrl, 308))
  app.get(`${adminBase}/settings/public`, async (_request, reply) => await reply.redirect(publicUrl, 308))
  app.get(`${adminBase}/settings/smtp`, async (_request, reply) => await reply.redirect(smtpUrl, 308))
  app.get(`${adminBase}/settings/site`, async (_request, reply) => await reply.redirect(siteUrl, 308))
  app.get(`${adminBase}/settings/shortlink`, async (_request, reply) => await reply.redirect(shortlinkUrl, 308))
  app.get(`${adminBase}/settings/custom-headers`, async (_request, reply) => await reply.redirect(customHeadersUrl, 308))

  app.get(generalUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    try {
      const values = await settings.general(config.baseUrl)
      const message: AdminMessage | undefined = stringValue(objectValue(request.query).updated) === '1'
        ? { kind: 'success', text: 'The General Settings have been successfully updated' }
        : undefined
      return reply.type('text/html; charset=utf-8').send(renderAdminGeneralSettings({
        adminBase,
        values,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-general'),
        ...(message === undefined ? {} : { message })
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The settings database is temporarily unavailable.'))
    }
  })

  app.post(generalUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request did not originate from this application.'))
    }
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'settings-general')) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request could not be verified.'))
    }

    try {
      const result = await settings.saveGeneral(body)
      if (result.status === 'ok') return await reply.redirect(`${generalUrl}?updated=1`, 303)
      const values = await settings.general(config.baseUrl)
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminGeneralSettings({
        adminBase,
        values,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-general'),
        message: { kind: 'error', text: result.message }
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The settings database is temporarily unavailable.'))
    }
  })

  app.get(publicUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    try {
      const [values, userOptions] = await Promise.all([settings.publicSettings(), users.options()])
      const message: AdminMessage | undefined = stringValue(objectValue(request.query).updated) === '1'
        ? { kind: 'success', text: 'The Public Settings have been successfully updated' }
        : undefined
      return reply.type('text/html; charset=utf-8').send(renderAdminPublicSettings({
        adminBase,
        values,
        users: userOptions,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-public'),
        ...(message === undefined ? {} : { message })
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The settings database is temporarily unavailable.'))
    }
  })

  app.post(publicUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request did not originate from this application.'))
    }
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'settings-public')) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request could not be verified.'))
    }

    try {
      const requestedUser = stringValue(body.public_video_user)
      if (requestedUser !== '' && await users.get(requestedUser) === null) {
        const [values, userOptions] = await Promise.all([settings.publicSettings(), users.options()])
        return reply.code(400).type('text/html; charset=utf-8').send(renderAdminPublicSettings({
          adminBase,
          values,
          users: userOptions,
          csrfToken: csrfToken(config, tokenFor(request), 'settings-public'),
          message: { kind: 'error', text: 'The public video user is invalid' }
        }))
      }
      const result = await settings.savePublic(body)
      if (result.status === 'ok') return await reply.redirect(`${publicUrl}?updated=1`, 303)
      const [values, userOptions] = await Promise.all([settings.publicSettings(), users.options()])
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminPublicSettings({
        adminBase,
        values,
        users: userOptions,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-public'),
        message: { kind: 'error', text: result.message }
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The settings database is temporarily unavailable.'))
    }
  })

  app.get(smtpUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    try {
      const values = await settings.smtpSettings()
      const message: AdminMessage | undefined = stringValue(objectValue(request.query).updated) === '1'
        ? { kind: 'success', text: 'The SMTP Settings have been successfully updated' }
        : undefined
      return reply.type('text/html; charset=utf-8').send(renderAdminSmtpSettings({
        adminBase,
        values,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-smtp'),
        ...(message === undefined ? {} : { message })
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The settings database is temporarily unavailable.'))
    }
  })

  app.post(smtpUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request did not originate from this application.'))
    }
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'settings-smtp')) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request could not be verified.'))
    }

    try {
      const result = await settings.saveSmtp(body)
      if (result.status === 'ok') return await reply.redirect(`${smtpUrl}?updated=1`, 303)
      const values = await settings.smtpSettings()
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminSmtpSettings({
        adminBase,
        values,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-smtp'),
        message: { kind: 'error', text: result.message }
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The settings database is temporarily unavailable.'))
    }
  })

  app.get(siteUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    try {
      const [values, logoAvailable] = await Promise.all([settings.siteSettings(), siteAssets.hasLogo()])
      const message: AdminMessage | undefined = stringValue(objectValue(request.query).updated) === '1'
        ? { kind: 'success', text: 'The Site Settings have been successfully updated' }
        : undefined
      return reply.type('text/html; charset=utf-8').send(renderAdminSiteSettings({
        adminBase,
        values,
        logoAvailable,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-site'),
        ...(message === undefined ? {} : { message })
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The site settings are temporarily unavailable.'))
    }
  })

  app.post(siteUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request did not originate from this application.'))
    }
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return

    let submission: Readonly<{ fields: Record<string, unknown>; logo?: Buffer }>
    try {
      submission = await siteSubmission(request)
    } catch (error) {
      return await renderSiteValidationError(reply, config, adminBase, request, settings, siteAssets, error instanceof InvalidSiteAssetError ? error.message : 'The logo upload is invalid or exceeds 5 MB')
    }
    if (!validCsrfToken(config, tokenFor(request), stringValue(submission.fields.csrf), 'settings-site')) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request could not be verified.'))
    }

    try {
      if (submission.logo !== undefined) await siteAssets.validateLogo(submission.logo)
      const result = await settings.saveSite(submission.fields)
      if (result.status === 'invalid') {
        return await renderSiteValidationError(reply, config, adminBase, request, settings, siteAssets, result.message)
      }
      const values = await settings.siteSettings()
      await siteAssets.update(values, submission.logo)
      return await reply.redirect(`${siteUrl}?updated=1`, 303)
    } catch (error) {
      if (error instanceof InvalidSiteAssetError) {
        return await renderSiteValidationError(reply, config, adminBase, request, settings, siteAssets, error.message)
      }
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The site settings could not be saved.'))
    }
  })

  app.get(shortlinkUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    try {
      const values = await settings.shortlinkSettings()
      const message: AdminMessage | undefined = stringValue(objectValue(request.query).updated) === '1'
        ? { kind: 'success', text: 'The Shortlink Settings have been successfully updated' }
        : undefined
      return reply.type('text/html; charset=utf-8').send(renderAdminShortlinkSettings({
        adminBase,
        values,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-shortlink'),
        ...(message === undefined ? {} : { message })
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The shortlink settings are temporarily unavailable.'))
    }
  })

  app.post(shortlinkUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request did not originate from this application.'))
    }
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'settings-shortlink')) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request could not be verified.'))
    }

    try {
      const result = await settings.saveShortlink(body)
      if (result.status === 'ok') return await reply.redirect(`${shortlinkUrl}?updated=1`, 303)
      const values = await settings.shortlinkSettings()
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminShortlinkSettings({
        adminBase,
        values,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-shortlink'),
        message: { kind: 'error', text: result.message }
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The shortlink settings could not be saved.'))
    }
  })

  app.get(customHeadersUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    try {
      const rules = await settings.customHeaderSettings()
      const message: AdminMessage | undefined = stringValue(objectValue(request.query).updated) === '1'
        ? { kind: 'success', text: 'The Custom Headers Settings have been successfully updated' }
        : undefined
      return reply.type('text/html; charset=utf-8').send(renderAdminCustomHeaderSettings({
        adminBase,
        rules,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-custom-headers'),
        ...(message === undefined ? {} : { message })
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The custom-header settings are temporarily unavailable.'))
    }
  })

  app.post(customHeadersUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request did not originate from this application.'))
    }
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'settings-custom-headers')) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request could not be verified.'))
    }

    try {
      const result = await settings.saveCustomHeaders(body)
      if (result.status === 'ok') return await reply.redirect(`${customHeadersUrl}?updated=1`, 303)
      const rules = await settings.customHeaderSettings()
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminCustomHeaderSettings({
        adminBase,
        rules,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-custom-headers'),
        message: { kind: 'error', text: result.message }
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The custom-header settings could not be saved.'))
    }
  })
}

async function siteSubmission(request: FastifyRequest): Promise<Readonly<{ fields: Record<string, unknown>; logo?: Buffer }>> {
  if (!request.isMultipart()) throw new InvalidSiteAssetError('The site settings form must use multipart encoding')
  const fields: Record<string, unknown> = {}
  let logo: Buffer | undefined
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (part.fieldname !== 'favicon' || part.filename === '') {
        part.file.resume()
        continue
      }
      if (part.mimetype !== 'image/png' || !part.filename.toLowerCase().endsWith('.png')) {
        part.file.resume()
        throw new InvalidSiteAssetError('The logo must be uploaded as a PNG file')
      }
      logo = await part.toBuffer()
      continue
    }
    addField(fields, part.fieldname, part.value)
  }
  return Object.freeze({ fields, ...(logo === undefined ? {} : { logo }) })
}

function addField(fields: Record<string, unknown>, key: string, value: unknown): void {
  const current = fields[key]
  if (current === undefined) fields[key] = value
  else if (Array.isArray(current)) current.push(value)
  else fields[key] = [current, value]
}

async function renderSiteValidationError(
  reply: FastifyReply,
  config: AppConfig,
  adminBase: string,
  request: FastifyRequest,
  settings: SettingsAdminService,
  siteAssets: SiteAssetManager,
  message: string
): Promise<FastifyReply> {
  const [values, logoAvailable] = await Promise.all([settings.siteSettings(), siteAssets.hasLogo()])
  return reply.code(400).type('text/html; charset=utf-8').send(renderAdminSiteSettings({
    adminBase,
    values,
    logoAvailable,
    csrfToken: csrfToken(config, tokenFor(request), 'settings-site'),
    message: { kind: 'error', text: message }
  }))
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

async function authenticatedAdministrator(
  request: FastifyRequest,
  reply: FastifyReply,
  adminBase: string,
  loginUrl: string,
  auth: AuthService
): Promise<AuthUser | null> {
  let user: AuthUser | null
  try {
    user = await auth.authenticate(tokenFor(request), request.headers['user-agent'] ?? '')
  } catch {
    reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The authentication database is temporarily unavailable.'))
    return null
  }
  if (user === null) {
    await reply.redirect(loginUrl, 302)
    return null
  }
  if (user.role !== 0) {
    await reply.redirect(`${adminBase}/403/`, 302)
    return null
  }
  return user
}

function csrfToken(config: AppConfig, token: string, scope: string): string {
  if (token === '') return ''
  return createHmac('sha256', config.secureSalt).update(`${scope}\0${token}`).digest('base64url')
}

function validCsrfToken(config: AppConfig, token: string, candidate: string, scope: string): boolean {
  const expected = csrfToken(config, token, scope)
  return expected !== '' && candidate.length === expected.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))
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

function tokenFor(request: FastifyRequest): string {
  return authTokenFromRequest({
    authorization: request.headers.authorization,
    cookie: request.cookies[AUTH_COOKIE_NAME]
  })
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}
