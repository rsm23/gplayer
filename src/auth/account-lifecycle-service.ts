import { hash } from 'bcryptjs'
import type { AccountMailer, OutboundEmail } from '../email/smtp-mailer.js'
import { Security } from '../security/security.js'
import type { AccountLifecycleSettings } from '../settings/settings-admin-service.js'

const TOKEN_LIFETIME_SECONDS = 600

export type AccountRecord = Readonly<{
  id: string
  username: string
  email: string
  name: string
  status: number
  updated: number
}>

export type AccountConflict = Readonly<{ username: boolean; email: boolean }>

export type AccountCreate = Readonly<{
  username: string
  email: string
  name: string
  passwordHash: string
  role: 1
  status: 1 | 2
  created: number
  updated: number
}>

export interface AccountLifecycleStore {
  findConflict(username: string, email: string): Promise<AccountConflict>
  findByIdentifier(identifier: string): Promise<AccountRecord | null>
  findByEmail(email: string): Promise<AccountRecord | null>
  createAccount(account: AccountCreate): Promise<string | null>
  activatePending(email: string, expectedUpdated: number, updated: number): Promise<boolean>
  resetPassword(email: string, expectedUpdated: number, passwordHash: string, updated: number): Promise<boolean>
}

export type AccountSettingsLoader = () => Promise<AccountLifecycleSettings>

export type RegistrationResult =
  | Readonly<{ status: 'registered' | 'pending'; message: string }>
  | Readonly<{ status: 'disabled' | 'invalid'; message: string }>

export type ConfirmationResult = Readonly<{ status: 'ok' | 'invalid'; message: string }>

export type ConfirmationRequestResult =
  | Readonly<{ status: 'accepted'; message: string }>
  | Readonly<{ status: 'invalid' | 'unavailable'; message: string }>

export type ResetRequestResult =
  | Readonly<{ status: 'accepted'; message: string }>
  | Readonly<{ status: 'invalid' | 'unavailable'; message: string }>

export type PasswordResetResult = Readonly<{ status: 'ok' | 'invalid'; message: string }>

export type AccountLifecycleServiceOptions = Readonly<{
  now?: () => number
  hashPassword?: (password: string) => Promise<string>
  registerUrl: URL
  resetPasswordUrl: URL
}>

export class AccountLifecycleService {
  private readonly now: () => number
  private readonly hashPassword: (password: string) => Promise<string>

  public constructor(
    private readonly store: AccountLifecycleStore,
    private readonly security: Security,
    private readonly mailer: AccountMailer,
    private readonly loadSettings: AccountSettingsLoader,
    private readonly options: AccountLifecycleServiceOptions
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.hashPassword = options.hashPassword ?? (async (password) => await hash(password, 10))
  }

  public async settings(): Promise<AccountLifecycleSettings> {
    return await this.loadSettings()
  }

  public async register(input: Record<string, unknown>): Promise<RegistrationResult> {
    const settings = await this.loadSettings()
    if (!settings.enableRegistration) return { status: 'disabled', message: 'Registration is currently disabled.' }

    const fields = registrationFields(input)
    const error = registrationError(fields)
    if (error !== null) return { status: 'invalid', message: error }
    const conflict = await this.store.findConflict(fields.username, fields.email)
    if (conflict.username) return { status: 'invalid', message: 'The username is already registered' }
    if (conflict.email) return { status: 'invalid', message: 'The email address is already registered' }

    const now = this.now()
    const confirmationRequired = !settings.disableConfirmation && settings.smtp !== null
    const passwordHash = await this.hashPassword(fields.password)
    if (confirmationRequired) {
      const token = this.createToken('confirm', fields.email, now, now + TOKEN_LIFETIME_SECONDS)
      const link = tokenUrl(this.options.registerUrl, token)
      const sent = await this.mailer.send(confirmationEmail(settings, fields.name, fields.email, link), settings.smtp)
      if (!sent) return { status: 'invalid', message: 'The confirmation email could not be sent. Try again later.' }
    }

    const id = await this.store.createAccount({
      username: fields.username,
      email: fields.email,
      name: fields.name,
      passwordHash,
      role: 1,
      status: confirmationRequired ? 2 : 1,
      created: now,
      updated: now
    })
    if (id === null) return { status: 'invalid', message: 'Registration failed. Please try again.' }
    return confirmationRequired
      ? {
          status: 'pending',
          message: 'Please check the confirmation email that we sent to your email address. If the message does not go to the inbox then check it in the spam box. Follow the next steps listed there'
        }
      : { status: 'registered', message: 'Registration has been successful! Now you can log in' }
  }

  public async confirm(token: string): Promise<ConfirmationResult> {
    const parsed = this.parseToken(token, 'confirm')
    if (parsed === null) return invalidToken()
    const account = await this.store.findByEmail(parsed.email)
    if (account === null || account.status !== 2 || account.updated !== parsed.version) return invalidToken()
    const activated = await this.store.activatePending(
      parsed.email,
      parsed.version,
      Math.max(this.now(), parsed.version + 1)
    )
    return activated
      ? { status: 'ok', message: 'Your account has been successfully activated! Now you can log in' }
      : invalidToken()
  }

  public async requestConfirmation(identifierValue: unknown): Promise<ConfirmationRequestResult> {
    const identifier = stringValue(identifierValue).trim().slice(0, 254)
    if (identifier === '') return { status: 'invalid', message: 'Username required' }
    const settings = await this.loadSettings()
    if (settings.disableConfirmation || settings.smtp === null) {
      return { status: 'unavailable', message: 'Confirmation email is not configured. Please contact an administrator.' }
    }
    const account = await this.store.findByIdentifier(identifier)
    if (account !== null && account.status === 2) {
      const now = this.now()
      const token = this.createToken('confirm', account.email, account.updated, now + TOKEN_LIFETIME_SECONDS)
      const link = tokenUrl(this.options.registerUrl, token)
      await this.mailer.send(confirmationEmail(settings, account.name, account.email, link), settings.smtp)
    }
    return {
      status: 'accepted',
      message: 'If a pending account matches that username or email, a new confirmation link has been sent. Check your inbox and spam folder.'
    }
  }

  public async requestPasswordReset(identifierValue: unknown): Promise<ResetRequestResult> {
    const identifier = stringValue(identifierValue).trim().slice(0, 254)
    if (identifier === '') return { status: 'invalid', message: 'Username required' }
    const settings = await this.loadSettings()
    if (settings.disableConfirmation || settings.smtp === null) {
      return { status: 'unavailable', message: 'Password reset email is not configured. Please contact an administrator.' }
    }

    const account = await this.store.findByIdentifier(identifier)
    if (account !== null) {
      const now = this.now()
      const token = this.createToken('reset', account.email, account.updated, now + TOKEN_LIFETIME_SECONDS)
      const link = tokenUrl(this.options.resetPasswordUrl, token)
      await this.mailer.send(resetEmail(settings, account, link), settings.smtp)
    }
    return {
      status: 'accepted',
      message: 'If an account matches that username or email, a password reset link has been sent. Check your inbox and spam folder.'
    }
  }

  public async resetTokenIsValid(token: string): Promise<boolean> {
    const parsed = this.parseToken(token, 'reset')
    if (parsed === null) return false
    const account = await this.store.findByEmail(parsed.email)
    return account !== null && account.updated === parsed.version
  }

  public async resetPassword(token: string, passwordValue: unknown, retypeValue: unknown): Promise<PasswordResetResult> {
    const password = stringValue(passwordValue, false).slice(0, 1_024)
    const retypePassword = stringValue(retypeValue, false).slice(0, 1_024)
    const error = passwordError(password, retypePassword)
    if (error !== null) return { status: 'invalid', message: error }
    const parsed = this.parseToken(token, 'reset')
    if (parsed === null) return invalidPasswordToken()
    const account = await this.store.findByEmail(parsed.email)
    if (account === null || account.updated !== parsed.version) return invalidPasswordToken()
    const updated = Math.max(this.now(), parsed.version + 1)
    const saved = await this.store.resetPassword(
      parsed.email,
      parsed.version,
      await this.hashPassword(password),
      updated
    )
    return saved
      ? { status: 'ok', message: 'Reset password has been successful! Now you can log in' }
      : invalidPasswordToken()
  }

  private createToken(purpose: 'confirm' | 'reset', email: string, version: number, expires: number): string {
    return this.security.encryptURL(`${purpose}|${email}|${version}|${expires}`)
  }

  private parseToken(tokenValue: string, purpose: 'confirm' | 'reset'): Readonly<{ email: string; version: number }> | null {
    const token = tokenValue.trim()
    if (token === '' || token.length > 2_048) return null
    const decrypted = this.security.decryptURLStrict(token)
    if (decrypted === null) return null
    const [actualPurpose, email, versionText, expiresText, ...extra] = decrypted.split('|')
    const version = Number(versionText)
    const expires = Number(expiresText)
    if (
      extra.length > 0 || actualPurpose !== purpose || !validEmail(email ?? '') ||
      !Number.isSafeInteger(version) || version < 0 ||
      !Number.isSafeInteger(expires) || expires < this.now()
    ) return null
    return Object.freeze({ email: email ?? '', version })
  }
}

type RegistrationFields = Readonly<{
  name: string
  username: string
  email: string
  password: string
  retypePassword: string
}>

function registrationFields(input: Record<string, unknown>): RegistrationFields {
  return Object.freeze({
    name: stringValue(input.name).trim().slice(0, 50),
    username: stringValue(input.user ?? input.username).trim().slice(0, 50),
    email: stringValue(input.email).trim().toLowerCase().slice(0, 254),
    password: stringValue(input.password, false).slice(0, 1_024),
    retypePassword: stringValue(input.retype_password ?? input.retypePassword, false).slice(0, 1_024)
  })
}

function registrationError(fields: RegistrationFields): string | null {
  if (fields.name === '') return 'The full name is required'
  if (fields.username === '') return 'Username required'
  if (fields.email === '') return 'Email address required'
  if (!validEmail(fields.email)) return 'The email address is invalid'
  return passwordError(fields.password, fields.retypePassword)
}

function passwordError(password: string, retypePassword: string): string | null {
  if (password === '') return 'Password is required'
  if (retypePassword === '') return 'Confirm password is required'
  if (password.length < 8 || password.includes(' ')) return 'Password must be longer than 8 characters'
  if (password !== retypePassword) return 'Confirm password does not match password'
  return null
}

function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(value)
}

function tokenUrl(base: URL, token: string): URL {
  const result = new URL(base)
  result.search = ''
  result.searchParams.set('token', token)
  return result
}

function confirmationEmail(settings: AccountLifecycleSettings, name: string, email: string, link: URL): OutboundEmail {
  const safeName = escapeHtml(name)
  const safeSite = escapeHtml(settings.siteName)
  const safeLink = escapeHtml(link.toString())
  return Object.freeze({
    recipientName: name,
    recipientEmail: email,
    subject: `Confirmation email (${settings.siteName}) | ${name}`,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirmation email</title></head><body><h1>Hi ${safeName},</h1><p>Thank you for registering on ${safeSite}. Please confirm your email by opening <a href="${safeLink}" target="_blank" rel="noopener">${safeLink}</a>.</p><p>This link expires in 10 minutes and can be used once.</p></body></html>`,
    text: `Hi ${name},\n\nThank you for registering on ${settings.siteName}. Confirm your email within 10 minutes: ${link.toString()}\n`
  })
}

function resetEmail(settings: AccountLifecycleSettings, account: AccountRecord, link: URL): OutboundEmail {
  const safeName = escapeHtml(account.name)
  const safeSite = escapeHtml(settings.siteName)
  const safeLink = escapeHtml(link.toString())
  return Object.freeze({
    recipientName: account.name,
    recipientEmail: account.email,
    subject: `Reset password (${settings.siteName}) | ${account.name}`,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reset password</title></head><body><h1>Hi ${safeName},</h1><p>A password reset was requested for your ${safeSite} account. Open <a href="${safeLink}" target="_blank" rel="noopener">${safeLink}</a> to choose a new password.</p><p>This link expires in 10 minutes and can be used once. Ignore this email if you did not request it.</p></body></html>`,
    text: `Hi ${account.name},\n\nReset your ${settings.siteName} password within 10 minutes: ${link.toString()}\n\nIgnore this email if you did not request it.\n`
  })
}

function invalidToken(): ConfirmationResult {
  return Object.freeze({ status: 'invalid', message: 'The token is invalid' })
}

function invalidPasswordToken(): PasswordResetResult {
  return Object.freeze({ status: 'invalid', message: 'The token is invalid' })
}

function stringValue(value: unknown, trim = true): string {
  const result = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  return trim ? result.trim() : result
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
}
