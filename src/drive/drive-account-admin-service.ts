const ACCOUNT_COLUMNS = ['id', 'email', 'bypass', 'status', 'created', 'updated'] as const

export type DriveAccountOrderColumn = typeof ACCOUNT_COLUMNS[number]

export type DriveAccountAdminRecord = Readonly<{
  id: string
  email: string
  bypass: number
  status: number
  created: number
  updated: number
  apiKeyConfigured: boolean
  clientIdConfigured: boolean
  clientSecretConfigured: boolean
  refreshTokenConfigured: boolean
}>

export type StoredDriveAccountAdminRecord = DriveAccountAdminRecord & Readonly<{
  apiKey: string
  clientId: string
  clientSecret: string
  refreshToken: string
}>

export type DriveAccountListQuery = Readonly<{
  draw: number
  start: number
  length: number
  search: string
  orderBy: DriveAccountOrderColumn
  orderDir: 'asc' | 'desc'
}>

export type DriveAccountListResult = Readonly<{
  data: readonly DriveAccountAdminRecord[]
  recordsTotal: number
  recordsFiltered: number
}>

export type DriveAccountWrite = Readonly<{
  email: string
  apiKey: string
  clientId: string
  clientSecret: string
  refreshToken: string
  bypass: number
  status: number
  created: number
  updated: number
}>

export interface DriveAccountAdminStore {
  listAccounts(query: DriveAccountListQuery): Promise<DriveAccountListResult>
  getAccount(id: string): Promise<StoredDriveAccountAdminRecord | null>
  emailExists(email: string, excludeId?: string): Promise<boolean>
  createAccount(account: DriveAccountWrite): Promise<string | null>
  updateAccount(id: string, account: DriveAccountWrite): Promise<boolean>
  deleteAccount(id: string): Promise<boolean>
  updateFlag(id: string, column: 'status' | 'bypass', value: number, updated: number): Promise<boolean>
}

export type DriveAccountDataTablesResponse = Readonly<{
  draw: number
  data: readonly Readonly<Pick<DriveAccountAdminRecord, 'id' | 'email' | 'bypass' | 'status' | 'created' | 'updated'>>[]
  recordsTotal: number
  recordsFiltered: number
}>

export type DriveAccountRecordPage = Readonly<{
  draw: number
  data: readonly DriveAccountAdminRecord[]
  recordsTotal: number
  recordsFiltered: number
}>

export type DriveAccountMutationResult =
  | Readonly<{ status: 'ok'; id: string; message: string }>
  | Readonly<{ status: 'invalid'; message: string }>

export class DriveAccountAdminService {
  private readonly now: () => number

  public constructor(
    private readonly store: DriveAccountAdminStore,
    options: Readonly<{ now?: () => number }> = {}
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  }

  public async list(input: Record<string, unknown>): Promise<DriveAccountDataTablesResponse> {
    const page = await this.records(input)
    return Object.freeze({
      draw: page.draw,
      data: Object.freeze(page.data.map(publicListRecord)),
      recordsTotal: page.recordsTotal,
      recordsFiltered: page.recordsFiltered
    })
  }

  public async records(input: Record<string, unknown>): Promise<DriveAccountRecordPage> {
    const query = driveAccountListQuery(input)
    const result = await this.store.listAccounts(query)
    return Object.freeze({
      draw: query.draw,
      data: result.data,
      recordsTotal: result.recordsTotal,
      recordsFiltered: result.recordsFiltered
    })
  }

  public async get(id: unknown): Promise<DriveAccountAdminRecord | null> {
    const normalized = driveAccountId(id)
    if (normalized === null) return null
    const account = await this.store.getAccount(normalized)
    return account === null ? null : publicRecord(account)
  }

  public async create(input: Record<string, unknown>): Promise<DriveAccountMutationResult> {
    const fields = accountFields(input)
    const error = validateFields(fields, true)
    if (error !== null) return { status: 'invalid', message: error }
    if (await this.store.emailExists(fields.email)) {
      return { status: 'invalid', message: 'The email has been used by another google drive account' }
    }
    const now = this.now()
    const id = await this.store.createAccount({ ...fields, created: now, updated: now })
    return id === null
      ? { status: 'invalid', message: 'The google drive account failed to save' }
      : { status: 'ok', id, message: 'The google drive account has been successfully saved' }
  }

  public async update(id: unknown, input: Record<string, unknown>): Promise<DriveAccountMutationResult> {
    const normalized = driveAccountId(id)
    if (normalized === null) return { status: 'invalid', message: 'The requested google drive account was not found' }
    const current = await this.store.getAccount(normalized)
    if (current === null) return { status: 'invalid', message: 'The requested google drive account was not found' }

    const fields = accountFields(input)
    const error = validateFields(fields, false)
    if (error !== null) return { status: 'invalid', message: error }
    if (await this.store.emailExists(fields.email, normalized)) {
      return { status: 'invalid', message: 'The email has been used by another google drive account' }
    }
    const updated = await this.store.updateAccount(normalized, {
      ...fields,
      apiKey: fields.apiKey || current.apiKey,
      clientId: fields.clientId || current.clientId,
      clientSecret: fields.clientSecret || current.clientSecret,
      refreshToken: fields.refreshToken || current.refreshToken,
      created: current.created,
      updated: this.now()
    })
    return updated
      ? { status: 'ok', id: normalized, message: 'The google drive account has been successfully updated' }
      : { status: 'invalid', message: 'The google drive account failed to update' }
  }

  public async delete(id: unknown): Promise<DriveAccountMutationResult> {
    const normalized = driveAccountId(id)
    const deleted = normalized !== null && await this.store.deleteAccount(normalized)
    return deleted
      ? { status: 'ok', id: normalized, message: 'The account has been deleted successfully' }
      : { status: 'invalid', message: 'The account failed to delete' }
  }

  public async setFlag(id: unknown, column: 'status' | 'bypass', value: unknown): Promise<DriveAccountMutationResult> {
    const normalized = driveAccountId(id)
    const flag = binaryFlag(value)
    const updated = normalized !== null && flag !== null && await this.store.updateFlag(normalized, column, flag, this.now())
    return updated
      ? { status: 'ok', id: normalized, message: 'The account status has been successfully updated' }
      : { status: 'invalid', message: 'The account status failed to update' }
  }
}

export function driveAccountListQuery(input: Record<string, unknown>): DriveAccountListQuery {
  const search = recordValue(input.search)
  const order = recordValue(arrayValue(input.order)[0])
  const index = boundedInteger(order.column ?? input['order[0][column]'], 5, 0, ACCOUNT_COLUMNS.length - 1)
  return Object.freeze({
    draw: boundedInteger(input.draw, 0, 0, Number.MAX_SAFE_INTEGER),
    start: boundedInteger(input.start, 0, 0, 1_000_000),
    length: boundedInteger(input.length, 10, 1, 100),
    search: stringValue(search.value ?? input['search[value]']).trim().slice(0, 100),
    orderBy: ACCOUNT_COLUMNS[index] ?? 'updated',
    orderDir: stringValue(order.dir ?? input['order[0][dir]']).toLowerCase() === 'asc' ? 'asc' : 'desc'
  })
}

export function driveAccountId(value: unknown): string | null {
  const normalized = stringValue(value).trim()
  if (!/^[1-9]\d{0,9}$/.test(normalized)) return null
  try {
    return BigInt(normalized) <= 4_294_967_295n ? normalized : null
  } catch {
    return null
  }
}

function publicRecord(account: StoredDriveAccountAdminRecord): DriveAccountAdminRecord {
  return Object.freeze({
    id: account.id,
    email: account.email,
    bypass: account.bypass,
    status: account.status,
    created: account.created,
    updated: account.updated,
    apiKeyConfigured: account.apiKeyConfigured,
    clientIdConfigured: account.clientIdConfigured,
    clientSecretConfigured: account.clientSecretConfigured,
    refreshTokenConfigured: account.refreshTokenConfigured
  })
}

function publicListRecord(account: DriveAccountAdminRecord): Readonly<Pick<DriveAccountAdminRecord, 'id' | 'email' | 'bypass' | 'status' | 'created' | 'updated'>> {
  return Object.freeze({
    id: account.id,
    email: account.email,
    bypass: account.bypass,
    status: account.status,
    created: account.created,
    updated: account.updated
  })
}

type ParsedAccountFields = Readonly<{
  email: string
  apiKey: string
  clientId: string
  clientSecret: string
  refreshToken: string
  bypass: number
  status: number
}>

function accountFields(input: Record<string, unknown>): ParsedAccountFields {
  return Object.freeze({
    email: stringValue(input.email).trim().toLowerCase().slice(0, 100),
    apiKey: secretValue(input.api_key ?? input.apiKey, 50),
    clientId: secretValue(input.client_id ?? input.clientId, 100),
    clientSecret: secretValue(input.client_secret ?? input.clientSecret, 50),
    refreshToken: secretValue(input.refresh_token ?? input.refreshToken, 150),
    bypass: binaryFlag(input.bypass) ?? 0,
    status: binaryFlag(input.status) ?? 0
  })
}

function validateFields(fields: ParsedAccountFields, credentialsRequired: boolean): string | null {
  if (fields.email === '' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) return 'The email is invalid'
  if (credentialsRequired && fields.apiKey === '') return 'The API key is required'
  if (credentialsRequired && fields.clientId === '') return 'The client ID is required'
  if (credentialsRequired && fields.clientSecret === '') return 'The client secret is required'
  if (credentialsRequired && fields.refreshToken === '') return 'The refresh token is required'
  if ([fields.apiKey, fields.clientId, fields.clientSecret, fields.refreshToken].some(hasUnsafeControls)) return 'The account credentials are invalid'
  return null
}

function hasUnsafeControls(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}

function secretValue(value: unknown, maximum: number): string {
  return stringValue(value, false).trim().slice(0, maximum)
}

function binaryFlag(value: unknown): 0 | 1 | null {
  const normalized = stringValue(value).trim().toLowerCase()
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return 1
  if (['0', 'false', 'off', 'no', ''].includes(normalized)) return 0
  return null
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(stringValue(value), 10)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}

function stringValue(value: unknown, trim = true): string {
  const scalar = Array.isArray(value) ? value.at(-1) : value
  const result = typeof scalar === 'string' || typeof scalar === 'number' ? String(scalar) : ''
  return trim ? result.trim() : result
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}
