import { randomBytes } from 'node:crypto'
import { compare } from 'bcryptjs'

const DAY_SECONDS = 86_400
const LEGACY_BCRYPT_DUMMY = '$2y$10$NINj/fIn5uU/k7nZqcpubux7hMyA9FXxV7sfFmplu1oEgduKHp0Ty'

export const AUTH_COOKIE_NAME = 'adv_token'

export type AuthUser = Readonly<{
  id: number
  username: string
  email: string
  name: string
  role: number
  status: number
  created: number
  updated: number
}>

export type StoredAuthUser = AuthUser & Readonly<{ passwordHash: string }>

export type SessionWrite = Readonly<{
  ip: string
  token: string
  userAgent: string
  created: number
  username: string
  expires: number
  state: number
}>

export interface AuthStore {
  findUserByIdentifier(identifier: string): Promise<StoredAuthUser | null>
  findActiveSession(token: string, userAgent: string, now: number): Promise<AuthUser | null>
  createSession(session: SessionWrite): Promise<void>
  recordFailedLogin(session: Omit<SessionWrite, 'expires' | 'state'>): Promise<void>
  revokeSession(token: string): Promise<boolean>
}

export type LoginResult =
  | Readonly<{ status: 'ok'; user: AuthUser; token: string; expires: number }>
  | Readonly<{ status: 'invalid' | 'inactive' | 'pending' }>

export type AuthServiceOptions = Readonly<{
  now?: () => number
  token?: () => string
  verifyPassword?: (password: string, hash: string) => Promise<boolean>
}>

export class AuthService {
  private readonly now: () => number
  private readonly token: () => string
  private readonly verifyPassword: (password: string, hash: string) => Promise<boolean>

  public constructor(
    private readonly store: AuthStore,
    options: AuthServiceOptions = {}
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.token = options.token ?? (() => randomBytes(32).toString('base64url'))
    this.verifyPassword = options.verifyPassword ?? (async (password, hash) => await compare(password, hash))
  }

  public async login(input: Readonly<{
    identifier: string
    password: string
    remember: boolean
    ip: string
    userAgent: string
  }>): Promise<LoginResult> {
    const identifier = normalizeIdentifier(input.identifier)
    const userAgent = normalizeUserAgent(input.userAgent)
    const ip = normalizeIp(input.ip)
    const now = this.now()
    const user = identifier === '' ? null : await this.store.findUserByIdentifier(identifier)
    const validPassword = await this.verifyPassword(input.password, user?.passwordHash ?? LEGACY_BCRYPT_DUMMY)

    if (user === null || input.password === '' || !validPassword) {
      await this.store.recordFailedLogin({ ip, token: '', userAgent, created: now, username: identifier })
      return { status: 'invalid' }
    }
    if (user.status === 2) {
      await this.store.recordFailedLogin({ ip, token: '', userAgent, created: now, username: user.username })
      return { status: 'pending' }
    }
    if (user.status !== 1) {
      await this.store.recordFailedLogin({ ip, token: '', userAgent, created: now, username: user.username })
      return { status: 'inactive' }
    }

    const token = this.token()
    const expires = now + (input.remember ? 7 : 1) * DAY_SECONDS
    await this.store.createSession({
      ip,
      token,
      userAgent,
      created: now,
      username: user.username,
      expires,
      state: 0
    })
    return { status: 'ok', user: publicUser(user), token, expires }
  }

  public async authenticate(token: string, userAgent: string): Promise<AuthUser | null> {
    const normalizedToken = normalizeToken(token)
    const normalizedUserAgent = normalizeUserAgent(userAgent)
    if (normalizedToken === '' || normalizedUserAgent === '') return null
    return await this.store.findActiveSession(normalizedToken, normalizedUserAgent, this.now())
  }

  public async logout(token: string): Promise<boolean> {
    const normalized = normalizeToken(token)
    return normalized !== '' && await this.store.revokeSession(normalized)
  }
}

export function authTokenFromRequest(input: Readonly<{
  authorization?: string | string[] | undefined
  cookie?: string | undefined
}>): string {
  const authorization = Array.isArray(input.authorization) ? input.authorization[0] : input.authorization
  const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? ''
  return normalizeToken(bearer !== '' ? bearer : input.cookie ?? '')
}

export function publicUser(user: StoredAuthUser): AuthUser {
  return Object.freeze({
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    created: user.created,
    updated: user.updated
  })
}

function normalizeIdentifier(value: string): string {
  return value.trim().slice(0, 254)
}

function normalizeToken(value: string): string {
  const normalized = value.trim()
  return normalized.length >= 8 && normalized.length <= 255 && /^[A-Za-z0-9+/_=-]+$/.test(normalized) ? normalized : ''
}

function normalizeUserAgent(value: string): string {
  return value.trim().slice(0, 255)
}

function normalizeIp(value: string): string {
  return value.trim().slice(0, 45)
}
