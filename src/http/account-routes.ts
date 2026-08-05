import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AUTH_COOKIE_NAME, AuthService, authTokenFromRequest } from '../auth/auth-service.js'
import type { AccountLifecycleService } from '../auth/account-lifecycle-service.js'
import type { AppConfig } from '../config.js'
import {
  renderAdminError,
  renderAdminConfirmationRequestPage,
  renderAdminRegistrationPage,
  renderAdminResetPasswordPage,
  renderAdminResetRequestPage,
  type AdminMessage
} from '../player/admin-page.js'

const BASE_ACCOUNT_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
const CAPTCHA_ACCOUNT_CSP = "default-src 'none'; script-src 'self' https://www.google.com https://www.gstatic.com; style-src 'self' 'unsafe-inline' https://www.gstatic.com; img-src 'self' data: https://www.google.com https://www.gstatic.com; frame-src https://www.google.com; connect-src 'self' https://www.google.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

export type AccountRouteOptions = Readonly<{
  verifyRecaptcha: (secret: string, responseToken: string, remoteIp: string) => Promise<boolean>
}>

export async function registerAccountRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  accounts: AccountLifecycleService,
  options: AccountRouteOptions
): Promise<void> {
  const adminBase = `/${config.adminDirectory}`
  const loginUrl = `${adminBase}/login/`
  const dashboardUrl = `${adminBase}/dashboard/`
  const registerUrl = `${adminBase}/register/`
  const resendUrl = `${adminBase}/register/resend/`
  const resetUrl = `${adminBase}/reset-password/`

  app.get(`${adminBase}/register`, async (_request, reply) => await reply.redirect(registerUrl, 308))
  app.get(`${adminBase}/register/resend`, async (_request, reply) => await reply.redirect(resendUrl, 308))
  app.get(`${adminBase}/reset-password`, async (_request, reply) => await reply.redirect(resetUrl, 308))

  app.get(registerUrl, async (request, reply) => {
    if (await authenticated(request, auth)) return await reply.redirect(dashboardUrl, 302)
    let settings
    try {
      settings = await accounts.settings()
    } catch {
      applyAccountHeaders(reply, config, false)
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'Account settings are temporarily unavailable.'))
    }
    applyAccountHeaders(reply, config, settings.recaptchaSiteKey !== '')
    const token = stringValue(objectValue(request.query).token).slice(0, 2_048)
    if (token !== '') {
      try {
        const result = await accounts.confirm(token)
        return await reply.redirect(`${loginUrl}?account=${result.status === 'ok' ? 'confirmed' : 'invalid-token'}`, 303)
      } catch {
        return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The account database is temporarily unavailable.'))
      }
    }
    if (!settings.enableRegistration) return await reply.redirect(loginUrl, 302)
    return reply.type('text/html; charset=utf-8').send(renderAdminRegistrationPage({ adminBase, recaptchaSiteKey: settings.recaptchaSiteKey }))
  })

  app.post(registerUrl, async (request, reply) => {
    if (!hasSameOrigin(request, config)) return accountOriginError(reply, adminBase)
    if (await authenticated(request, auth)) return await reply.redirect(dashboardUrl, 303)
    const body = objectValue(request.body)
    let settings
    try {
      settings = await accounts.settings()
    } catch {
      applyAccountHeaders(reply, config, false)
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'Account settings are temporarily unavailable.'))
    }
    applyAccountHeaders(reply, config, settings.recaptchaSiteKey !== '')
    if (!settings.enableRegistration) return await reply.redirect(loginUrl, 303)
    const captchaValid = await options.verifyRecaptcha(settings.recaptchaSecretKey, stringValue(body['g-recaptcha-response'], false), request.ip)
    if (!captchaValid) {
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminRegistrationPage({
        adminBase,
        recaptchaSiteKey: settings.recaptchaSiteKey,
        values: registrationValues(body),
        message: { kind: 'error', text: 'The security code you entered is incorrect! Try again' }
      }))
    }
    try {
      const result = await accounts.register(body)
      if (result.status === 'registered') return await reply.redirect(`${loginUrl}?account=registered`, 303)
      if (result.status === 'pending') {
        return reply.type('text/html; charset=utf-8').send(renderAdminRegistrationPage({
          adminBase,
          recaptchaSiteKey: settings.recaptchaSiteKey,
          message: { kind: 'success', text: result.message }
        }))
      }
      if (result.status === 'disabled') return await reply.redirect(loginUrl, 303)
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminRegistrationPage({
        adminBase,
        recaptchaSiteKey: settings.recaptchaSiteKey,
        values: registrationValues(body),
        message: { kind: 'error', text: result.message }
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The account database is temporarily unavailable.'))
    }
  })

  app.get(resendUrl, async (request, reply) => {
    if (await authenticated(request, auth)) return await reply.redirect(dashboardUrl, 302)
    try {
      const settings = await accounts.settings()
      applyAccountHeaders(reply, config, settings.recaptchaSiteKey !== '')
      return reply.type('text/html; charset=utf-8').send(renderAdminConfirmationRequestPage({ adminBase, recaptchaSiteKey: settings.recaptchaSiteKey }))
    } catch {
      applyAccountHeaders(reply, config, false)
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'Account settings are temporarily unavailable.'))
    }
  })

  app.post(resendUrl, async (request, reply) => {
    if (!hasSameOrigin(request, config)) return accountOriginError(reply, adminBase)
    if (await authenticated(request, auth)) return await reply.redirect(dashboardUrl, 303)
    const body = objectValue(request.body)
    let settings
    try {
      settings = await accounts.settings()
    } catch {
      applyAccountHeaders(reply, config, false)
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'Account settings are temporarily unavailable.'))
    }
    applyAccountHeaders(reply, config, settings.recaptchaSiteKey !== '')
    const captchaValid = await options.verifyRecaptcha(settings.recaptchaSecretKey, stringValue(body['g-recaptcha-response'], false), request.ip)
    if (!captchaValid) {
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminConfirmationRequestPage({
        adminBase,
        recaptchaSiteKey: settings.recaptchaSiteKey,
        values: { username: stringValue(body.username).slice(0, 254) },
        message: { kind: 'error', text: 'The security code you entered is incorrect! Try again' }
      }))
    }
    try {
      const result = await accounts.requestConfirmation(body.username)
      const message: AdminMessage = { kind: result.status === 'accepted' ? 'success' : 'error', text: result.message }
      return reply.code(result.status === 'invalid' ? 400 : result.status === 'unavailable' ? 503 : 200).type('text/html; charset=utf-8').send(renderAdminConfirmationRequestPage({
        adminBase,
        recaptchaSiteKey: settings.recaptchaSiteKey,
        values: { username: stringValue(body.username).slice(0, 254) },
        message
      }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The account database is temporarily unavailable.'))
    }
  })

  app.get(resetUrl, async (request, reply) => {
    if (await authenticated(request, auth)) return await reply.redirect(dashboardUrl, 302)
    let settings
    try {
      settings = await accounts.settings()
    } catch {
      applyAccountHeaders(reply, config, false)
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'Account settings are temporarily unavailable.'))
    }
    applyAccountHeaders(reply, config, settings.recaptchaSiteKey !== '')
    const token = stringValue(objectValue(request.query).token).slice(0, 2_048)
    if (token === '') return reply.type('text/html; charset=utf-8').send(renderAdminResetRequestPage({ adminBase, recaptchaSiteKey: settings.recaptchaSiteKey }))
    try {
      if (!await accounts.resetTokenIsValid(token)) {
        return reply.code(400).type('text/html; charset=utf-8').send(renderAdminResetRequestPage({
          adminBase,
          recaptchaSiteKey: settings.recaptchaSiteKey,
          message: { kind: 'error', text: 'The token is invalid' }
        }))
      }
      return reply.type('text/html; charset=utf-8').send(renderAdminResetPasswordPage({ adminBase, recaptchaSiteKey: settings.recaptchaSiteKey, token }))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The account database is temporarily unavailable.'))
    }
  })

  app.post(resetUrl, async (request, reply) => {
    if (!hasSameOrigin(request, config)) return accountOriginError(reply, adminBase)
    if (await authenticated(request, auth)) return await reply.redirect(dashboardUrl, 303)
    const body = objectValue(request.body)
    let settings
    try {
      settings = await accounts.settings()
    } catch {
      applyAccountHeaders(reply, config, false)
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'Account settings are temporarily unavailable.'))
    }
    applyAccountHeaders(reply, config, settings.recaptchaSiteKey !== '')
    const captchaValid = await options.verifyRecaptcha(settings.recaptchaSecretKey, stringValue(body['g-recaptcha-response'], false), request.ip)
    if (!captchaValid) return resetError(reply, adminBase, settings.recaptchaSiteKey, body, 'The security code you entered is incorrect! Try again')

    const action = stringValue(body.action)
    if (action === 'confirm') {
      try {
        const result = await accounts.requestPasswordReset(body.username)
        const message: AdminMessage = { kind: result.status === 'accepted' ? 'success' : 'error', text: result.message }
        return reply.code(result.status === 'invalid' ? 400 : result.status === 'unavailable' ? 503 : 200).type('text/html; charset=utf-8').send(renderAdminResetRequestPage({
          adminBase,
          recaptchaSiteKey: settings.recaptchaSiteKey,
          values: { username: stringValue(body.username).slice(0, 254) },
          message
        }))
      } catch {
        return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The account database is temporarily unavailable.'))
      }
    }

    if (action === 'save') {
      const token = stringValue(body.token).slice(0, 2_048)
      try {
        const result = await accounts.resetPassword(token, body.password, body.retype_password)
        if (result.status === 'ok') return await reply.redirect(`${loginUrl}?account=password-reset`, 303)
        const tokenValid = await accounts.resetTokenIsValid(token)
        return reply.code(400).type('text/html; charset=utf-8').send(tokenValid
          ? renderAdminResetPasswordPage({ adminBase, recaptchaSiteKey: settings.recaptchaSiteKey, token, message: { kind: 'error', text: result.message } })
          : renderAdminResetRequestPage({ adminBase, recaptchaSiteKey: settings.recaptchaSiteKey, message: { kind: 'error', text: result.message } }))
      } catch {
        return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The account database is temporarily unavailable.'))
      }
    }

    return reply.code(400).type('text/html; charset=utf-8').send(renderAdminResetRequestPage({
      adminBase,
      recaptchaSiteKey: settings.recaptchaSiteKey,
      message: { kind: 'error', text: 'The password reset request is invalid.' }
    }))
  })
}

function resetError(reply: FastifyReply, adminBase: string, recaptchaSiteKey: string, body: Record<string, unknown>, message: string): FastifyReply {
  const token = stringValue(body.token).slice(0, 2_048)
  return reply.code(400).type('text/html; charset=utf-8').send(token === ''
    ? renderAdminResetRequestPage({ adminBase, recaptchaSiteKey, values: { username: stringValue(body.username).slice(0, 254) }, message: { kind: 'error', text: message } })
    : renderAdminResetPasswordPage({ adminBase, recaptchaSiteKey, token, message: { kind: 'error', text: message } }))
}

function applyAccountHeaders(reply: FastifyReply, config: AppConfig, recaptcha: boolean): void {
  reply.headers({
    'cache-control': 'no-store',
    pragma: 'no-cache',
    expires: '0',
    'content-security-policy': recaptcha ? CAPTCHA_ACCOUNT_CSP : BASE_ACCOUNT_CSP,
    'referrer-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'x-robots-tag': 'noindex, nofollow',
    'access-control-allow-origin': config.baseUrl.origin,
    vary: 'Origin'
  })
}

async function authenticated(request: FastifyRequest, auth: AuthService): Promise<boolean> {
  try {
    return await auth.authenticate(authTokenFromRequest({
      authorization: request.headers.authorization,
      cookie: request.cookies[AUTH_COOKIE_NAME]
    }), request.headers['user-agent'] ?? '') !== null
  } catch {
    return false
  }
}

function registrationValues(body: Record<string, unknown>): Readonly<Record<string, string>> {
  return Object.freeze({
    name: stringValue(body.name).slice(0, 50),
    user: stringValue(body.user ?? body.username).slice(0, 50),
    email: stringValue(body.email).slice(0, 254)
  })
}

function accountOriginError(reply: FastifyReply, adminBase: string): FastifyReply {
  return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The account request did not originate from this application.'))
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

function stringValue(value: unknown, trim = true): string {
  const result = typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 8_192) : ''
  return trim ? result.trim() : result
}
