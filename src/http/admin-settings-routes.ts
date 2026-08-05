import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AUTH_COOKIE_NAME, AuthService, authTokenFromRequest, type AuthUser } from '../auth/auth-service.js'
import type { UserAdminService } from '../auth/user-admin-service.js'
import type { AppConfig } from '../config.js'
import { renderAdminAdsSettings, renderAdminCustomHeaderSettings, renderAdminError, renderAdminGeneralSettings, renderAdminHostingSettings, renderAdminMiscSettings, renderAdminPlayerSettings, renderAdminPublicSettings, renderAdminResetSettings, renderAdminShortlinkSettings, renderAdminSiteSettings, renderAdminSmtpSettings, type AdminMessage } from '../player/admin-page.js'
import type { SettingsAdminService } from '../settings/settings-admin-service.js'
import { InvalidSiteAssetError, type SiteAssetManager } from '../settings/site-assets-service.js'
import { InvalidVastAssetError, type VastAssetManager } from '../settings/vast-assets-service.js'

const ADMIN_CSP = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

export async function registerAdminSettingsRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  settings: SettingsAdminService,
  users: UserAdminService,
  siteAssets: SiteAssetManager,
  vastAssets: VastAssetManager,
  supportedHosts: ReadonlySet<string>,
  hostingHosts: ReadonlySet<string> = supportedHosts
): Promise<void> {
  const adminBase = `/${config.adminDirectory}`
  const playerDefaults = { ...config.slugs, adminDirectory: config.adminDirectory }
  const loginUrl = `${adminBase}/login/`
  const generalUrl = `${adminBase}/settings/general/`
  const publicUrl = `${adminBase}/settings/public/`
  const smtpUrl = `${adminBase}/settings/smtp/`
  const siteUrl = `${adminBase}/settings/site/`
  const shortlinkUrl = `${adminBase}/settings/shortlink/`
  const customHeadersUrl = `${adminBase}/settings/custom-headers/`
  const playerUrl = `${adminBase}/settings/player/`
  const hostingUrl = `${adminBase}/settings/hosting/`
  const miscUrl = `${adminBase}/settings/misc/`
  const adsUrl = `${adminBase}/settings/ads/`
  const resetUrl = `${adminBase}/settings/reset/`
  const syncUrl = `${adminBase}/settings/sync/`
  const vastCreateUrl = `${adsUrl}vast/create/`
  const vastDeleteUrl = `${adsUrl}vast/delete/`
  const settingsAjaxUrl = `${adminBase}/ajax/settings/`

  app.get(`${adminBase}/settings/general`, async (_request, reply) => await reply.redirect(generalUrl, 308))
  app.get(`${adminBase}/settings/public`, async (_request, reply) => await reply.redirect(publicUrl, 308))
  app.get(`${adminBase}/settings/smtp`, async (_request, reply) => await reply.redirect(smtpUrl, 308))
  app.get(`${adminBase}/settings/site`, async (_request, reply) => await reply.redirect(siteUrl, 308))
  app.get(`${adminBase}/settings/shortlink`, async (_request, reply) => await reply.redirect(shortlinkUrl, 308))
  app.get(`${adminBase}/settings/custom-headers`, async (_request, reply) => await reply.redirect(customHeadersUrl, 308))
  app.get(`${adminBase}/settings/player`, async (_request, reply) => await reply.redirect(playerUrl, 308))
  app.get(`${adminBase}/settings/hosting`, async (_request, reply) => await reply.redirect(hostingUrl, 308))
  app.get(`${adminBase}/settings/misc`, async (_request, reply) => await reply.redirect(miscUrl, 308))
  app.get(`${adminBase}/settings/ads`, async (_request, reply) => await reply.redirect(adsUrl, 308))
  app.get(`${adminBase}/settings/reset`, async (_request, reply) => await reply.redirect(resetUrl, 308))

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

  app.get(playerUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    try {
      const values = await settings.playerSettings(playerDefaults)
      const message: AdminMessage | undefined = stringValue(objectValue(request.query).updated) === '1'
        ? { kind: 'success', text: 'The Player Settings have been successfully updated' }
        : undefined
      return reply.type('text/html; charset=utf-8').send(renderAdminPlayerSettings({
        adminBase,
        values,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-player'),
        ...(message === undefined ? {} : { message })
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The player settings are temporarily unavailable.'))
    }
  })

  app.post(playerUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request did not originate from this application.'))
    }
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'settings-player')) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request could not be verified.'))
    }

    try {
      const result = await settings.savePlayer(body, playerDefaults)
      if (result.status === 'ok') return await reply.redirect(`${playerUrl}?updated=1`, 303)
      const values = await settings.playerSettings(playerDefaults)
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminPlayerSettings({
        adminBase,
        values,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-player'),
        message: { kind: 'error', text: result.message }
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The player settings could not be saved.'))
    }
  })

  app.get(hostingUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    try {
      const values = await settings.hostingSettings(hostingHosts)
      const message: AdminMessage | undefined = stringValue(objectValue(request.query).updated) === '1'
        ? { kind: 'success', text: 'The Hosting Settings have been successfully updated' }
        : undefined
      return reply.type('text/html; charset=utf-8').send(renderAdminHostingSettings({
        adminBase,
        values,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-hosting'),
        ...(message === undefined ? {} : { message })
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The hosting settings are temporarily unavailable.'))
    }
  })

  app.post(hostingUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request did not originate from this application.'))
    }
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'settings-hosting')) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request could not be verified.'))
    }

    try {
      const result = await settings.saveHosting(body, hostingHosts)
      if (result.status === 'ok') return await reply.redirect(`${hostingUrl}?updated=1`, 303)
      const values = await settings.hostingSettings(hostingHosts)
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminHostingSettings({
        adminBase,
        values,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-hosting'),
        message: { kind: 'error', text: result.message }
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The hosting settings could not be saved.'))
    }
  })

  app.get(resetUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const message: AdminMessage | undefined = stringValue(objectValue(request.query).reset) === '1'
      ? { kind: 'success', text: 'The Reset Settings have been successfully reset' }
      : undefined
    return reply.type('text/html; charset=utf-8').send(renderAdminResetSettings({
      adminBase,
      csrfToken: csrfToken(config, tokenFor(request), 'settings-reset'),
      ...(message === undefined ? {} : { message })
    }))
  })

  app.post(resetUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request did not originate from this application.'))
    }
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'settings-reset')) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request could not be verified.'))
    }

    try {
      const result = await settings.resetSettings(body)
      if (result.status === 'ok') return await reply.redirect(`${resetUrl}?reset=1`, 303)
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminResetSettings({
        adminBase,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-reset'),
        message: { kind: 'error', text: result.message }
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The settings could not be reset.'))
    }
  })

  app.post(syncUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    let user: AuthUser | null
    try {
      user = await auth.authenticate(tokenFor(request), request.headers['user-agent'] ?? '')
    } catch {
      return reply.code(503).send({ status: 'fail', message: 'The authentication database is temporarily unavailable.' })
    }
    if (user === null || user.role !== 0) return reply.send({ status: 'fail', message: 'Access denied' })

    try {
      const result = await settings.synchronizeCacheMode(objectValue(request.body))
      if (result.status === 'invalid') return reply.code(400).send({ status: 'fail', message: result.message })
      return reply.send({ status: 'ok', message: result.message })
    } catch {
      return reply.code(503).send({ status: 'fail', message: 'The load balancer settings could not be synchronized.' })
    }
  })

  app.get(miscUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    try {
      const values = await settings.miscSettings(supportedHosts)
      const message: AdminMessage | undefined = stringValue(objectValue(request.query).updated) === '1'
        ? { kind: 'success', text: 'The Misc Settings have been successfully updated' }
        : undefined
      return reply.type('text/html; charset=utf-8').send(renderAdminMiscSettings({
        adminBase,
        values,
        supportedHosts,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-misc'),
        ...(message === undefined ? {} : { message })
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The misc settings are temporarily unavailable.'))
    }
  })

  app.post(miscUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request did not originate from this application.'))
    }
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'settings-misc')) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request could not be verified.'))
    }

    try {
      const result = await settings.saveMisc(body, supportedHosts)
      if (result.status === 'ok') return await reply.redirect(`${miscUrl}?updated=1`, 303)
      const values = await settings.miscSettings(supportedHosts)
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminMiscSettings({
        adminBase,
        values,
        supportedHosts,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-misc'),
        message: { kind: 'error', text: result.message }
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The misc settings could not be saved.'))
    }
  })

  app.get(adsUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    try {
      const [values, assets] = await Promise.all([settings.adsSettings(), vastAssets.list()])
      const query = objectValue(request.query)
      const message: AdminMessage | undefined = stringValue(query.updated) === '1'
        ? { kind: 'success', text: 'The Ads Settings have been successfully updated' }
        : stringValue(query.vast) === 'created'
          ? { kind: 'success', text: 'VAST ad file has been generated successfully' }
          : stringValue(query.vast) === 'deleted'
            ? { kind: 'success', text: 'The VAST ad file has been successfully deleted' }
            : undefined
      return reply.type('text/html; charset=utf-8').send(renderAdminAdsSettings({
        adminBase,
        values,
        vastAssets: assets,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-ads'),
        vastCreateCsrfToken: csrfToken(config, tokenFor(request), 'settings-ads-vast-create'),
        vastDeleteCsrfToken: csrfToken(config, tokenFor(request), 'settings-ads-vast-delete'),
        ...(message === undefined ? {} : { message })
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The ads settings are temporarily unavailable.'))
    }
  })

  app.post(adsUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request did not originate from this application.'))
    }
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'settings-ads')) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request could not be verified.'))
    }

    try {
      const result = await settings.saveAds(body)
      if (result.status === 'ok') return await reply.redirect(`${adsUrl}?updated=1`, 303)
      const [values, assets] = await Promise.all([settings.adsSettings(), vastAssets.list()])
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminAdsSettings({
        adminBase,
        values,
        vastAssets: assets,
        csrfToken: csrfToken(config, tokenFor(request), 'settings-ads'),
        vastCreateCsrfToken: csrfToken(config, tokenFor(request), 'settings-ads-vast-create'),
        vastDeleteCsrfToken: csrfToken(config, tokenFor(request), 'settings-ads-vast-delete'),
        message: { kind: 'error', text: result.message }
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The ads settings could not be saved.'))
    }
  })

  app.post(vastCreateUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request did not originate from this application.'))
    }
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'settings-ads-vast-create')) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request could not be verified.'))
    }

    try {
      const site = await settings.siteSettings()
      const asset = await vastAssets.create(body, site.site_name)
      await settings.addCustomVastName(asset.name)
      return await reply.redirect(`${adsUrl}?vast=created#custom-vast`, 303)
    } catch (error) {
      if (error instanceof InvalidVastAssetError) {
        return await renderAdsValidationError(reply, config, adminBase, request, settings, vastAssets, error.message)
      }
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'VAST ad file failed to generate.'))
    }
  })

  app.post(vastDeleteUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request did not originate from this application.'))
    }
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'settings-ads-vast-delete')) {
      return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The settings request could not be verified.'))
    }

    try {
      const name = stringValue(body.file_name)
      if (!await vastAssets.delete(name)) {
        return await renderAdsValidationError(reply, config, adminBase, request, settings, vastAssets, 'The VAST ad file failed to delete')
      }
      await settings.removeCustomVastName(name)
      return await reply.redirect(`${adsUrl}?vast=deleted#custom-vast`, 303)
    } catch (error) {
      if (error instanceof InvalidVastAssetError) {
        return await renderAdsValidationError(reply, config, adminBase, request, settings, vastAssets, error.message)
      }
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The VAST ad file failed to delete.'))
    }
  })

  app.post(settingsAjaxUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) {
      return reply.code(403).send({ status: 'fail', message: 'The settings request did not originate from this application.' })
    }
    const user = await authenticatedAdministrator(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    const action = stringValue(body.action)

    if (action === 'createCustomVast') {
      try {
        const site = await settings.siteSettings()
        const asset = await vastAssets.create(body, site.site_name)
        await settings.addCustomVastName(asset.name)
        return reply.send({ status: 'ok', message: 'VAST ad file has been generated successfully', data: asset.url })
      } catch {
        return reply.send({ status: 'fail', message: 'VAST ad file failed to generate' })
      }
    }

    if (action === 'deleteCustomVast') {
      try {
        const name = stringValue(body.file_name)
        if (!await vastAssets.delete(name)) return reply.send({ status: 'fail', message: 'The VAST ad file failed to delete' })
        await settings.removeCustomVastName(name)
        return reply.send({ status: 'ok', message: 'The VAST ad file has been successfully deleted' })
      } catch {
        return reply.send({ status: 'fail', message: 'The VAST ad file failed to delete' })
      }
    }

    return reply.code(400).send({ status: 'fail', message: 'The settings action is not supported' })
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

async function renderAdsValidationError(
  reply: FastifyReply,
  config: AppConfig,
  adminBase: string,
  request: FastifyRequest,
  settings: SettingsAdminService,
  vastAssets: VastAssetManager,
  message: string
): Promise<FastifyReply> {
  const [values, assets] = await Promise.all([settings.adsSettings(), vastAssets.list()])
  return reply.code(400).type('text/html; charset=utf-8').send(renderAdminAdsSettings({
    adminBase,
    values,
    vastAssets: assets,
    csrfToken: csrfToken(config, tokenFor(request), 'settings-ads'),
    vastCreateCsrfToken: csrfToken(config, tokenFor(request), 'settings-ads-vast-create'),
    vastDeleteCsrfToken: csrfToken(config, tokenFor(request), 'settings-ads-vast-delete'),
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
