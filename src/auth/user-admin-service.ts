import { hash } from 'bcryptjs'

const USER_COLUMNS = ['name', 'user', 'email', 'status', 'created', 'updated', 'role', 'videos', 'id'] as const
const USER_ROLES = ['Admin', 'User', 'Premium'] as const

export type UserOrderColumn = typeof USER_COLUMNS[number]

export type AdminUserRecord = Readonly<{
  id: string
  name: string
  username: string
  email: string
  status: number
  created: number
  updated: number
  role: number
  videos: number
}>

export type LegacyAdminUser = Readonly<{
  id: string
  name: string
  user: string
  email: string
  status: number
  created: number
  updated: number
  role: string
  videos: number
}>

export type UserListQuery = Readonly<{
  draw: number
  start: number
  length: number
  search: string
  orderBy: UserOrderColumn
  orderDir: 'asc' | 'desc'
}>

export type UserListResult = Readonly<{
  data: readonly AdminUserRecord[]
  recordsTotal: number
  recordsFiltered: number
}>

export type UserWrite = Readonly<{
  name: string
  username: string
  email: string
  passwordHash?: string
  role: number
  status: number
  created: number
  updated: number
}>

export type UserConflict = Readonly<{ username: boolean; email: boolean }>

export interface UserAdminStore {
  listUsers(query: UserListQuery): Promise<UserListResult>
  getUser(id: string): Promise<AdminUserRecord | null>
  findConflict(username: string, email: string, excludeId?: string): Promise<UserConflict>
  createUser(user: UserWrite & Readonly<{ passwordHash: string }>): Promise<string | null>
  updateUser(id: string, user: UserWrite): Promise<boolean>
  updateEmail(id: string, email: string, updated: number): Promise<boolean>
  updateUsername(id: string, username: string, updated: number): Promise<boolean>
  deleteUser(id: string): Promise<boolean>
}

export type UserDataTablesResponse = Readonly<{
  draw: number
  data: readonly LegacyAdminUser[]
  recordsTotal: number
  recordsFiltered: number
}>

export type UserRecordPage = Readonly<{
  draw: number
  data: readonly AdminUserRecord[]
  recordsTotal: number
  recordsFiltered: number
}>

export type UserOption = Readonly<{ id: string; name: string; username: string }>

export type UserMutationResult =
  | Readonly<{ status: 'ok'; id: string; message: string }>
  | Readonly<{ status: 'invalid'; message: string }>

export type UserAdminServiceOptions = Readonly<{
  now?: () => number
  hashPassword?: (password: string) => Promise<string>
}>

export class UserAdminService {
  private readonly now: () => number
  private readonly hashPassword: (password: string) => Promise<string>

  public constructor(
    private readonly store: UserAdminStore,
    options: UserAdminServiceOptions = {}
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.hashPassword = options.hashPassword ?? (async (password) => await hash(password, 10))
  }

  public async list(input: Record<string, unknown>): Promise<UserDataTablesResponse> {
    const result = await this.records(input)
    return Object.freeze({
      draw: result.draw,
      data: Object.freeze(result.data.map(legacyUser)),
      recordsTotal: result.recordsTotal,
      recordsFiltered: result.recordsFiltered
    })
  }

  public async records(input: Record<string, unknown>): Promise<UserRecordPage> {
    const query = userListQuery(input)
    const result = await this.store.listUsers(query)
    return Object.freeze({
      draw: query.draw,
      data: result.data,
      recordsTotal: result.recordsTotal,
      recordsFiltered: result.recordsFiltered
    })
  }

  public async get(id: unknown): Promise<AdminUserRecord | null> {
    const normalized = userId(id)
    return normalized === null ? null : await this.store.getUser(normalized)
  }

  public async options(maximum = 10_000): Promise<readonly UserOption[]> {
    const boundedMaximum = Number.isFinite(maximum) ? Math.min(10_000, Math.max(1, Math.trunc(maximum))) : 10_000
    const options: UserOption[] = []
    let start = 0
    while (options.length < boundedMaximum) {
      const page = await this.store.listUsers({
        draw: 0,
        start,
        length: Math.min(100, boundedMaximum - options.length),
        search: '',
        orderBy: 'name',
        orderDir: 'asc'
      })
      for (const user of page.data) options.push(Object.freeze({ id: user.id, name: user.name, username: user.username }))
      start += page.data.length
      if (page.data.length === 0 || start >= page.recordsFiltered) break
    }
    return Object.freeze(options)
  }

  public async create(input: Record<string, unknown>): Promise<UserMutationResult> {
    const fields = userFields(input)
    const error = validateFields(fields, true)
    if (error !== null) return { status: 'invalid', message: error }
    const conflict = await this.store.findConflict(fields.username, fields.email)
    if (conflict.email) return { status: 'invalid', message: 'The email has been used by another user' }
    if (conflict.username) return { status: 'invalid', message: 'The username has been used by another user' }

    const now = this.now()
    const id = await this.store.createUser({
      ...fields,
      passwordHash: await this.hashPassword(fields.password),
      created: now,
      updated: now
    })
    return id === null
      ? { status: 'invalid', message: 'The new user failed to add' }
      : { status: 'ok', id, message: 'The new user has been successfully created' }
  }

  public async update(id: unknown, input: Record<string, unknown>): Promise<UserMutationResult> {
    const normalizedId = userId(id)
    if (normalizedId === null || await this.store.getUser(normalizedId) === null) {
      return { status: 'invalid', message: 'The requested user was not found' }
    }

    const fields = userFields(input)
    const error = validateFields(fields, false)
    if (error !== null) return { status: 'invalid', message: error }
    const conflict = await this.store.findConflict(fields.username, fields.email, normalizedId)
    if (conflict.email) return { status: 'invalid', message: 'The email has been used by another user' }
    if (conflict.username) return { status: 'invalid', message: 'The username has been used by another user' }

    const passwordHash = fields.password === '' ? undefined : await this.hashPassword(fields.password)
    const updated = await this.store.updateUser(normalizedId, {
      name: fields.name,
      username: fields.username,
      email: fields.email,
      role: fields.role,
      status: fields.status,
      created: 0,
      updated: this.now(),
      ...(passwordHash === undefined ? {} : { passwordHash })
    })
    return updated
      ? { status: 'ok', id: normalizedId, message: 'The user details have been successfully updated' }
      : { status: 'invalid', message: 'The user details failed to update' }
  }

  public async delete(id: unknown): Promise<boolean> {
    const normalized = userId(id)
    return normalized !== null && await this.store.deleteUser(normalized)
  }

  public async editEmail(id: number | string, value: unknown): Promise<UserMutationResult> {
    const normalizedId = userId(id)
    const email = stringValue(value).trim().toLowerCase().slice(0, 254)
    if (normalizedId === null || email === '' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { status: 'invalid', message: 'Email address is required' }
    }
    const current = await this.store.getUser(normalizedId)
    if (current === null) return { status: 'invalid', message: 'The email address failed to update' }
    const conflict = await this.store.findConflict(current.username, email, normalizedId)
    if (conflict.email) return { status: 'invalid', message: 'The email address is already in use by another user' }
    const updated = await this.store.updateEmail(normalizedId, email, this.now())
    return updated
      ? { status: 'ok', id: normalizedId, message: 'The email address has been successfully updated. Please re-login' }
      : { status: 'invalid', message: 'The email address failed to update' }
  }

  public async editUsername(id: number | string, value: unknown): Promise<UserMutationResult> {
    const normalizedId = userId(id)
    const username = stringValue(value).trim().slice(0, 50)
    if (normalizedId === null || username === '') return { status: 'invalid', message: 'Email address is required' }
    const current = await this.store.getUser(normalizedId)
    if (current === null) return { status: 'invalid', message: 'The username failed to update' }
    const conflict = await this.store.findConflict(username, current.email, normalizedId)
    if (conflict.username) return { status: 'invalid', message: 'The email address is already in use by another user' }
    const updated = await this.store.updateUsername(normalizedId, username, this.now())
    return updated
      ? { status: 'ok', id: normalizedId, message: 'The username has been successfully updated. Please re-login' }
      : { status: 'invalid', message: 'The username failed to update' }
  }
}

export function userListQuery(input: Record<string, unknown>): UserListQuery {
  const nestedSearch = recordValue(input.search)
  const nestedOrder = arrayValue(input.order)[0]
  const orderRecord = recordValue(nestedOrder)
  const orderIndex = boundedInteger(
    orderRecord.column ?? input['order[0][column]'],
    5,
    0,
    USER_COLUMNS.length - 1
  )
  const direction = stringValue(orderRecord.dir ?? input['order[0][dir]']).toLowerCase()
  return Object.freeze({
    draw: boundedInteger(input.draw, 0, 0, Number.MAX_SAFE_INTEGER),
    start: boundedInteger(input.start, 0, 0, 1_000_000),
    length: boundedInteger(input.length, 10, 1, 100),
    search: stringValue(nestedSearch.value ?? input['search[value]']).trim().slice(0, 254),
    orderBy: USER_COLUMNS[orderIndex] ?? 'updated',
    orderDir: direction === 'asc' ? 'asc' : 'desc'
  })
}

export function userId(value: unknown): string | null {
  const normalized = stringValue(value).trim()
  if (!/^[1-9]\d{0,9}$/.test(normalized)) return null
  try {
    return BigInt(normalized) <= 4_294_967_295n ? normalized : null
  } catch {
    return null
  }
}

export function userRoleLabel(role: number): string {
  return USER_ROLES[role] ?? USER_ROLES[1]
}

function legacyUser(user: AdminUserRecord): LegacyAdminUser {
  return Object.freeze({
    id: user.id,
    name: user.name,
    user: user.username,
    email: user.email,
    status: user.status,
    created: user.created,
    updated: user.updated,
    role: userRoleLabel(user.role),
    videos: user.videos
  })
}

type ParsedUserFields = Readonly<{
  name: string
  username: string
  email: string
  password: string
  retypePassword: string
  role: number
  status: number
}>

function userFields(input: Record<string, unknown>): ParsedUserFields {
  return Object.freeze({
    name: stringValue(input.name).trim().slice(0, 50),
    username: stringValue(input.user ?? input.username).trim().slice(0, 50),
    email: stringValue(input.email).trim().toLowerCase().slice(0, 254),
    password: stringValue(input.password, false).slice(0, 1_024),
    retypePassword: stringValue(input.retype_password ?? input.retypePassword, false).slice(0, 1_024),
    role: boundedInteger(input.role, -1, -1, 2),
    status: boundedInteger(input.status, -1, -1, 2)
  })
}

function validateFields(fields: ParsedUserFields, passwordRequired: boolean): string | null {
  if (fields.name === '') return 'The full name is required'
  if (fields.username === '') return 'The username is required'
  if (fields.email === '' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) return 'The email is invalid'
  if (fields.role < 0) return 'The user role is required'
  if (fields.status < 0) return 'The status is required'
  if (passwordRequired && fields.password === '') return 'The new password is required'
  if (fields.password !== '' && (fields.password.length < 8 || fields.password.includes(' '))) return 'The new password is too weak'
  if (fields.password !== fields.retypePassword) return 'The confirm new password must match the new password'
  return null
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(stringValue(value), 10)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}

function stringValue(value: unknown, trim = true): string {
  const result = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  return trim ? result.trim() : result
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}
