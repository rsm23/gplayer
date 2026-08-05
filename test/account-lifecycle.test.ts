import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AccountLifecycleService, type AccountCreate, type AccountLifecycleStore, type AccountRecord } from '../src/auth/account-lifecycle-service.js'
import { MySqlAccountLifecycleStore } from '../src/auth/mysql-account-lifecycle-store.js'
import { AuthService, type AuthStore, type SessionWrite } from '../src/auth/auth-service.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import type { Database } from '../src/database/database.js'
import type { AccountMailer, OutboundEmail } from '../src/email/smtp-mailer.js'
import { Security } from '../src/security/security.js'
import type { AccountLifecycleSettings, SmtpRuntimeSettings } from '../src/settings/settings-admin-service.js'

const secureSalt = '1234567890123456'
const smtp: SmtpRuntimeSettings = Object.freeze({
  host: 'smtp.example.test',
  port: 587,
  startTls: true,
  username: 'mailer@example.test',
  password: 'smtp-secret',
  senderName: 'GPlayer Mailer',
  replyEmail: 'support@example.test',
  replyName: 'Support'
})

function lifecycleSettings(overrides: Partial<AccountLifecycleSettings> = {}): AccountLifecycleSettings {
  return Object.freeze({
    enableRegistration: true,
    disableConfirmation: false,
    siteName: 'GPlayer',
    recaptchaSiteKey: '',
    recaptchaSecretKey: '',
    smtp,
    ...overrides
  })
}

type MemoryAccount = AccountRecord & Readonly<{ passwordHash: string }>

class MemoryAccountStore implements AccountLifecycleStore {
  public readonly accounts: MemoryAccount[] = []
  public revokedSessions = 0

  public constructor(accounts: readonly MemoryAccount[] = []) {
    this.accounts.push(...accounts)
  }

  public async findConflict(username: string, email: string) {
    return {
      username: this.accounts.some((account) => account.username.toLowerCase() === username.toLowerCase()),
      email: this.accounts.some((account) => account.email.toLowerCase() === email.toLowerCase())
    }
  }

  public async findByIdentifier(identifier: string): Promise<AccountRecord | null> {
    return this.accounts.find((account) => account.username === identifier || account.email === identifier) ?? null
  }

  public async findByEmail(email: string): Promise<AccountRecord | null> {
    return this.accounts.find((account) => account.email === email) ?? null
  }

  public async createAccount(account: AccountCreate): Promise<string | null> {
    if ((await this.findConflict(account.username, account.email)).username || (await this.findConflict(account.username, account.email)).email) return null
    const id = String(this.accounts.length + 1)
    this.accounts.push(Object.freeze({
      id,
      username: account.username,
      email: account.email,
      name: account.name,
      status: account.status,
      updated: account.updated,
      passwordHash: account.passwordHash
    }))
    return id
  }

  public async activatePending(email: string, expectedUpdated: number, updated: number): Promise<boolean> {
    const index = this.accounts.findIndex((account) => account.email === email && account.status === 2 && account.updated === expectedUpdated)
    if (index < 0) return false
    const current = this.accounts[index]
    if (current === undefined) return false
    this.accounts[index] = Object.freeze({ ...current, status: 1, updated })
    return true
  }

  public async resetPassword(email: string, expectedUpdated: number, passwordHash: string, updated: number): Promise<boolean> {
    const index = this.accounts.findIndex((account) => account.email === email && account.updated === expectedUpdated)
    if (index < 0) return false
    const current = this.accounts[index]
    if (current === undefined) return false
    this.accounts[index] = Object.freeze({ ...current, passwordHash, updated })
    this.revokedSessions += 1
    return true
  }
}

class MemoryMailer implements AccountMailer {
  public readonly messages: OutboundEmail[] = []
  public sendResult = true

  public async send(message: OutboundEmail): Promise<boolean> {
    this.messages.push(message)
    return this.sendResult
  }
}

function accountService(
  store: MemoryAccountStore,
  mailer: MemoryMailer,
  now: () => number,
  settings: () => Promise<AccountLifecycleSettings> = async () => lifecycleSettings()
): AccountLifecycleService {
  return new AccountLifecycleService(
    store,
    new Security(secureSalt),
    mailer,
    settings,
    {
      now,
      hashPassword: async (password) => `hash:${password}`,
      registerUrl: new URL('https://player.example/administrator/register/'),
      resetPasswordUrl: new URL('https://player.example/administrator/reset-password/')
    }
  )
}

function tokenFrom(message: OutboundEmail): string {
  const url = message.text.split(/\s+/).find((value) => value.startsWith('https://player.example/'))
  if (url === undefined) throw new Error('No account URL was sent')
  return new URL(url).searchParams.get('token') ?? ''
}

const activeAccount: MemoryAccount = Object.freeze({
  id: '8',
  username: 'alex',
  email: 'alex@example.test',
  name: 'Alex Example',
  status: 1,
  updated: 900,
  passwordHash: 'old-hash'
})

describe('AccountLifecycleService', () => {
  it('registers a pending user, sends the legacy-compatible confirmation message, and consumes the link once', async () => {
    let now = 1_000
    const store = new MemoryAccountStore()
    const mailer = new MemoryMailer()
    const service = accountService(store, mailer, () => now)

    await expect(service.register({ name: 'Taylor', user: 'taylor', email: 'TAYLOR@example.test', password: 'password1', retype_password: 'password1' })).resolves.toEqual(expect.objectContaining({ status: 'pending' }))
    expect(store.accounts).toEqual([expect.objectContaining({ username: 'taylor', email: 'taylor@example.test', status: 2, passwordHash: 'hash:password1' })])
    expect(mailer.messages).toHaveLength(1)
    expect(mailer.messages[0]?.html).toContain('expires in 10 minutes')

    const token = tokenFrom(mailer.messages[0]!)
    now = 1_001
    await expect(service.confirm(token)).resolves.toEqual({ status: 'ok', message: 'Your account has been successfully activated! Now you can log in' })
    expect(store.accounts[0]).toEqual(expect.objectContaining({ status: 1, updated: 1_001 }))
    await expect(service.confirm(token)).resolves.toEqual({ status: 'invalid', message: 'The token is invalid' })
  })

  it('creates an immediately active account when confirmation email is disabled', async () => {
    const store = new MemoryAccountStore()
    const mailer = new MemoryMailer()
    const service = accountService(store, mailer, () => 1_000, async () => lifecycleSettings({ disableConfirmation: true }))

    await expect(service.register({ name: 'Taylor', user: 'taylor', email: 'taylor@example.test', password: 'password1', retype_password: 'password1' })).resolves.toEqual({
      status: 'registered',
      message: 'Registration has been successful! Now you can log in'
    })
    expect(store.accounts[0]).toEqual(expect.objectContaining({ status: 1 }))
    expect(mailer.messages).toHaveLength(0)
  })

  it('does not create a pending account when confirmation delivery fails', async () => {
    const store = new MemoryAccountStore()
    const mailer = new MemoryMailer()
    mailer.sendResult = false
    const service = accountService(store, mailer, () => 1_000)

    await expect(service.register({ name: 'Taylor', user: 'taylor', email: 'taylor@example.test', password: 'password1', retype_password: 'password1' })).resolves.toEqual({
      status: 'invalid',
      message: 'The confirmation email could not be sent. Try again later.'
    })
    expect(store.accounts).toHaveLength(0)
  })

  it('preserves registration validation and duplicate diagnostics without retaining passwords', async () => {
    const store = new MemoryAccountStore([activeAccount])
    const service = accountService(store, new MemoryMailer(), () => 1_000)

    await expect(service.register({ name: 'A', user: '', email: 'bad', password: 'short', retype_password: 'different' })).resolves.toEqual({ status: 'invalid', message: 'Username required' })
    await expect(service.register({ name: 'Alex', user: 'alex', email: 'other@example.test', password: 'password1', retype_password: 'password1' })).resolves.toEqual({ status: 'invalid', message: 'The username is already registered' })
    await expect(service.register({ name: 'Other', user: 'other', email: 'alex@example.test', password: 'password1', retype_password: 'password1' })).resolves.toEqual({ status: 'invalid', message: 'The email address is already registered' })
    expect(store.accounts).toHaveLength(1)
  })

  it('returns the same reset-request result for known and unknown accounts', async () => {
    const store = new MemoryAccountStore([activeAccount])
    const mailer = new MemoryMailer()
    const service = accountService(store, mailer, () => 1_000)

    const known = await service.requestPasswordReset('alex')
    const unknown = await service.requestPasswordReset('missing')
    expect(known).toEqual(unknown)
    expect(known.status).toBe('accepted')
    expect(mailer.messages).toHaveLength(1)
  })

  it('resends confirmation without revealing whether a pending account exists', async () => {
    const pending = Object.freeze({ ...activeAccount, status: 2, updated: 950 })
    const store = new MemoryAccountStore([pending])
    const mailer = new MemoryMailer()
    const service = accountService(store, mailer, () => 1_000)

    const known = await service.requestConfirmation('alex')
    const unknown = await service.requestConfirmation('missing')
    expect(known).toEqual(unknown)
    expect(known.status).toBe('accepted')
    expect(mailer.messages).toHaveLength(1)
    expect(tokenFrom(mailer.messages[0]!)).not.toBe('')
  })

  it('resets the password atomically, advances the token version, and revokes active sessions', async () => {
    let now = 1_000
    const store = new MemoryAccountStore([{ ...activeAccount, updated: 1_000 }])
    const mailer = new MemoryMailer()
    const service = accountService(store, mailer, () => now)
    await service.requestPasswordReset('alex@example.test')
    const token = tokenFrom(mailer.messages[0]!)

    await expect(service.resetTokenIsValid(token)).resolves.toBe(true)
    await expect(service.resetPassword(token, 'replacement1', 'replacement1')).resolves.toEqual({ status: 'ok', message: 'Reset password has been successful! Now you can log in' })
    expect(store.accounts[0]).toEqual(expect.objectContaining({ passwordHash: 'hash:replacement1', updated: 1_001 }))
    expect(store.revokedSessions).toBe(1)
    await expect(service.resetTokenIsValid(token)).resolves.toBe(false)
    await expect(service.resetPassword(token, 'replacement2', 'replacement2')).resolves.toEqual({ status: 'invalid', message: 'The token is invalid' })
    now = 2_000
  })

  it('rejects expired and tampered links and refuses unsafe reset without SMTP ownership proof', async () => {
    let now = 1_000
    const store = new MemoryAccountStore([activeAccount])
    const mailer = new MemoryMailer()
    const service = accountService(store, mailer, () => now)
    await service.requestPasswordReset('alex')
    const token = tokenFrom(mailer.messages[0]!)
    now = 1_601
    await expect(service.resetTokenIsValid(token)).resolves.toBe(false)
    await expect(service.resetTokenIsValid(`${token}tampered`)).resolves.toBe(false)

    const noMail = accountService(store, mailer, () => now, async () => lifecycleSettings({ smtp: null }))
    await expect(noMail.requestPasswordReset('alex')).resolves.toEqual({
      status: 'unavailable',
      message: 'Password reset email is not configured. Please contact an administrator.'
    })
  })
})

describe('MySqlAccountLifecycleStore', () => {
  it('uses parameterized legacy tables and revokes sessions in the password transaction', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([{ id: 8, user: 'alex', email: 'alex@example.test', name: 'Alex', status: 1, updated: 900 }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 2 })
    const database = {
      read: vi.fn().mockResolvedValue([{ id: 8, user: 'alex', email: 'alex@example.test', name: 'Alex', status: 1, updated: 900 }]),
      write: vi.fn().mockResolvedValue({ insertId: 9, affectedRows: 1 }),
      transaction: vi.fn(async (work: (executor: { execute: typeof execute }) => Promise<unknown>) => await work({ execute }))
    }
    const store = new MySqlAccountLifecycleStore(database as unknown as Pick<Database, 'read' | 'write' | 'transaction'>)

    await expect(store.findByIdentifier('alex')).resolves.toEqual(expect.objectContaining({ username: 'alex' }))
    await expect(store.createAccount({ username: 'new', email: 'new@example.test', name: 'New', passwordHash: 'hash', role: 1, status: 2, created: 1_000, updated: 1_000 })).resolves.toBe('9')
    await expect(store.resetPassword('alex@example.test', 900, 'new-hash', 1_000)).resolves.toBe(true)
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), ['alex@example.test', 900])
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE `tb_sessions`'), ['alex'])
    for (const call of [...database.read.mock.calls, ...database.write.mock.calls, ...execute.mock.calls]) expect(call[0]).not.toContain('alex@example.test')
  })
})

class EmptyAuthStore implements AuthStore {
  public async findUserByIdentifier(): Promise<null> { return null }
  public async findActiveSession(): Promise<null> { return null }
  public async createSession(_session: SessionWrite): Promise<void> {}
  public async recordFailedLogin(_session: Omit<SessionWrite, 'expires' | 'state'>): Promise<void> {}
  public async revokeSession(): Promise<boolean> { return false }
}

describe('account lifecycle routes', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('renders discoverable registration/recovery pages and completes registration confirmation', async () => {
    let now = 1_000
    const settings = lifecycleSettings()
    const store = new MemoryAccountStore()
    const mailer = new MemoryMailer()
    const accounts = accountService(store, mailer, () => now, async () => settings)
    app = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: secureSalt }), {
      auth: new AuthService(new EmptyAuthStore()),
      accounts,
      accountSettings: async () => settings,
      recaptchaVerifier: { verify: async () => true }
    })

    const login = await app.inject({ method: 'GET', url: '/administrator/login/' })
    expect(login.body).toContain('/administrator/register/')
    expect(login.body).toContain('/administrator/register/resend/')
    expect(login.body).toContain('/administrator/reset-password/')
    const register = await app.inject({ method: 'GET', url: '/administrator/register/' })
    expect(register.statusCode).toBe(200)
    expect(register.body).toContain('name="retype_password"')
    expect(register.body).toContain('data-account-availability')
    expect(register.headers['cache-control']).toBe('no-store')
    expect(register.headers['content-security-policy']).toContain("connect-src 'self'")

    const created = await app.inject({
      method: 'POST',
      url: '/administrator/register/',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://player.example' },
      payload: 'name=Taylor&user=taylor&email=taylor%40example.test&password=password1&retype_password=password1'
    })
    expect(created.statusCode).toBe(200)
    expect(created.body).toContain('Please check the confirmation email')
    expect(created.body).not.toContain('password1')

    now = 1_001
    const confirmation = await app.inject({ method: 'GET', url: `/administrator/register/?token=${encodeURIComponent(tokenFrom(mailer.messages[0]!))}` })
    expect(confirmation.statusCode).toBe(303)
    expect(confirmation.headers.location).toBe('/administrator/login/?account=confirmed')
    const confirmed = await app.inject({ method: 'GET', url: String(confirmation.headers.location) })
    expect(confirmed.body).toContain('successfully activated')
  })

  it('sends a generic reset response, accepts the single-use link, and rejects cross-origin posts', async () => {
    const settings = lifecycleSettings()
    const store = new MemoryAccountStore([activeAccount])
    const mailer = new MemoryMailer()
    const accounts = accountService(store, mailer, () => 1_000, async () => settings)
    app = await buildApp(loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://player.example/', SECURE_SALT: secureSalt }), {
      auth: new AuthService(new EmptyAuthStore()),
      accounts,
      accountSettings: async () => settings,
      recaptchaVerifier: { verify: async () => true }
    })

    const rejected = await app.inject({
      method: 'POST',
      url: '/administrator/reset-password/',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      payload: 'action=confirm&username=alex'
    })
    expect(rejected.statusCode).toBe(403)

    const requested = await app.inject({
      method: 'POST',
      url: '/administrator/reset-password/',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://player.example' },
      payload: 'action=confirm&username=alex'
    })
    expect(requested.statusCode).toBe(200)
    expect(requested.body).toContain('If an account matches')
    const token = tokenFrom(mailer.messages[0]!)

    const form = await app.inject({ method: 'GET', url: `/administrator/reset-password/?token=${encodeURIComponent(token)}` })
    expect(form.statusCode).toBe(200)
    expect(form.body).toContain('name="action" value="save"')
    const reset = await app.inject({
      method: 'POST',
      url: '/administrator/reset-password/',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://player.example' },
      payload: `action=save&token=${encodeURIComponent(token)}&password=replacement1&retype_password=replacement1`
    })
    expect(reset.statusCode).toBe(303)
    expect(reset.headers.location).toBe('/administrator/login/?account=password-reset')
    expect(store.revokedSessions).toBe(1)
  })
})
