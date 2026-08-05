const SESSION_COLUMNS = ['id', 'username', 'ip', 'useragent', 'created', 'expires'] as const

export type SessionOrderColumn = typeof SESSION_COLUMNS[number]

export type AdminSession = Readonly<{
  id: string
  username: string
  ip: string
  useragent: string
  created: number
  expires: number
}>

export type SessionListQuery = Readonly<{
  draw: number
  start: number
  length: number
  search: string
  orderBy: SessionOrderColumn
  orderDir: 'asc' | 'desc'
}>

export type SessionListResult = Readonly<{
  data: readonly AdminSession[]
  recordsTotal: number
  recordsFiltered: number
}>

export interface SessionAdminStore {
  listSessions(query: SessionListQuery): Promise<SessionListResult>
  deleteSession(id: string): Promise<boolean>
}

export type DataTablesResponse = Readonly<{
  draw: number
  data: readonly AdminSession[]
  recordsTotal: number
  recordsFiltered: number
}>

export class SessionAdminService {
  public constructor(private readonly store: SessionAdminStore) {}

  public async list(input: Record<string, unknown>): Promise<DataTablesResponse> {
    const query = sessionListQuery(input)
    const result = await this.store.listSessions(query)
    return Object.freeze({ draw: query.draw, ...result })
  }

  public async delete(id: unknown): Promise<boolean> {
    const normalized = sessionId(id)
    return normalized !== null && await this.store.deleteSession(normalized)
  }
}

export function sessionListQuery(input: Record<string, unknown>): SessionListQuery {
  const nestedSearch = recordValue(input.search)
  const nestedOrder = arrayValue(input.order)[0]
  const orderRecord = recordValue(nestedOrder)
  const orderIndex = boundedInteger(
    orderRecord.column ?? input['order[0][column]'],
    5,
    0,
    SESSION_COLUMNS.length - 1
  )
  const direction = stringValue(orderRecord.dir ?? input['order[0][dir]']).toLowerCase()

  return Object.freeze({
    draw: boundedInteger(input.draw, 0, 0, Number.MAX_SAFE_INTEGER),
    start: boundedInteger(input.start, 0, 0, 1_000_000),
    length: boundedInteger(input.length, 10, 1, 100),
    search: stringValue(nestedSearch.value ?? input['search[value]']).trim().slice(0, 255),
    orderBy: SESSION_COLUMNS[orderIndex] ?? 'expires',
    orderDir: direction === 'asc' ? 'asc' : 'desc'
  })
}

export function sessionId(value: unknown): string | null {
  const normalized = stringValue(value).trim()
  return /^[1-9]\d{0,19}$/.test(normalized) ? normalized : null
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(stringValue(value), 10)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}
