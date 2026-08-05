import continents from '../../resources/data/json/continents.json' with { type: 'json' }

const LIST_COLUMNS = ['name', 'link', 'connections', 'playbacks', 'status', 'created', 'updated', 'public', 'id'] as const

export type LoadBalancerOrderColumn = typeof LIST_COLUMNS[number]

export type LoadBalancerAdminRecord = Readonly<{
  id: string
  name: string
  link: string
  connections: number
  playbacks: number
  status: number
  public: number
  created: number
  updated: number
  disallowHosts: readonly string[]
  disallowContinents: readonly string[]
}>

export type LoadBalancerListQuery = Readonly<{
  draw: number
  start: number
  length: number
  search: string
  orderBy: LoadBalancerOrderColumn
  orderDir: 'asc' | 'desc'
}>

export type LoadBalancerListResult = Readonly<{
  data: readonly LoadBalancerAdminRecord[]
  recordsTotal: number
  recordsFiltered: number
}>

export type LoadBalancerWrite = Readonly<{
  name: string
  link: string
  status: number
  public: 0
  created: number
  updated: number
  disallowHosts: readonly string[]
  disallowContinents: readonly string[]
}>

export interface LoadBalancerAdminStore {
  listLoadBalancers(query: LoadBalancerListQuery): Promise<LoadBalancerListResult>
  getLoadBalancer(id: string): Promise<LoadBalancerAdminRecord | null>
  linkExists(link: string, excludeId?: string): Promise<boolean>
  createLoadBalancer(value: LoadBalancerWrite): Promise<string | null>
  updateLoadBalancer(id: string, value: LoadBalancerWrite): Promise<boolean>
  deleteLoadBalancer(id: string): Promise<boolean>
  updateStatus(id: string, status: number, updated: number): Promise<boolean>
}

export type LoadBalancerMutationResult =
  | Readonly<{ status: 'ok'; id: string; message: string }>
  | Readonly<{ status: 'invalid'; message: string }>

export type LoadBalancerPage = LoadBalancerListResult & Readonly<{ draw: number }>

export const LOAD_BALANCER_CONTINENTS: Readonly<Record<string, string>> = Object.freeze({ ...continents })

export class LoadBalancerAdminService {
  private readonly hosts: ReadonlySet<string>
  private readonly loadMainSite: () => Promise<string>
  private readonly now: () => number

  public constructor(
    private readonly store: LoadBalancerAdminStore,
    options: Readonly<{ hosts: ReadonlySet<string>; mainSite: URL | (() => URL | Promise<URL>); now?: () => number }>
  ) {
    this.hosts = new Set(options.hosts)
    this.loadMainSite = async () => {
      const mainSite = typeof options.mainSite === 'function' ? await options.mainSite() : options.mainSite
      return normalizedHttpUrl(mainSite.toString()) ?? mainSite.toString()
    }
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  }

  public async records(input: Record<string, unknown>): Promise<LoadBalancerPage> {
    const query = loadBalancerListQuery(input)
    const result = await this.store.listLoadBalancers(query)
    return Object.freeze({ draw: query.draw, ...result })
  }

  public async list(input: Record<string, unknown>): Promise<Readonly<LoadBalancerPage & { data: readonly (LoadBalancerAdminRecord & { slug: string })[] }>> {
    const page = await this.records(input)
    return Object.freeze({
      ...page,
      data: Object.freeze(page.data.map((item) => Object.freeze({ ...item, slug: 'load-balancers' })))
    })
  }

  public async get(id: unknown): Promise<LoadBalancerAdminRecord | null> {
    const normalized = loadBalancerId(id)
    return normalized === null ? null : await this.store.getLoadBalancer(normalized)
  }

  public async create(input: Record<string, unknown>): Promise<LoadBalancerMutationResult> {
    const fields = this.fields(input)
    if ('error' in fields) return { status: 'invalid', message: fields.error }
    if (fields.link === await this.loadMainSite()) return { status: 'invalid', message: 'The main site should not be stored as a load balancer site' }
    if (await this.store.linkExists(fields.link)) return { status: 'invalid', message: 'The load balancer URL is already in use' }
    const now = this.now()
    const id = await this.store.createLoadBalancer({ ...fields, public: 0, created: now, updated: now })
    return id === null
      ? { status: 'invalid', message: 'The new load balancer site failed to save' }
      : { status: 'ok', id, message: 'The new load balancer site has been successfully created' }
  }

  public async update(id: unknown, input: Record<string, unknown>): Promise<LoadBalancerMutationResult> {
    const normalized = loadBalancerId(id)
    if (normalized === null) return { status: 'invalid', message: 'The requested load balancer was not found' }
    const current = await this.store.getLoadBalancer(normalized)
    if (current === null) return { status: 'invalid', message: 'The requested load balancer was not found' }
    const fields = this.fields(input)
    if ('error' in fields) return { status: 'invalid', message: fields.error }
    if (fields.link === await this.loadMainSite()) return { status: 'invalid', message: 'The main site should not be stored as a load balancer site' }
    if (await this.store.linkExists(fields.link, normalized)) return { status: 'invalid', message: 'The load balancer URL is already in use' }
    const updated = await this.store.updateLoadBalancer(normalized, { ...fields, public: 0, created: current.created, updated: this.now() })
    return updated
      ? { status: 'ok', id: normalized, message: 'The load balancer site has been successfully updated' }
      : { status: 'invalid', message: 'The load balancer site failed to update' }
  }

  public async delete(id: unknown): Promise<LoadBalancerMutationResult> {
    const normalized = loadBalancerId(id)
    const deleted = normalized !== null && await this.store.deleteLoadBalancer(normalized)
    return deleted
      ? { status: 'ok', id: normalized, message: 'The load balancer server deleted successfully' }
      : { status: 'invalid', message: 'The load balancer server failed to delete' }
  }

  public async setStatus(id: unknown, value: unknown): Promise<LoadBalancerMutationResult> {
    const normalized = loadBalancerId(id)
    const status = binaryFlag(value)
    const updated = normalized !== null && status !== null && await this.store.updateStatus(normalized, status, this.now())
    return updated
      ? { status: 'ok', id: normalized, message: 'The load balancer server has been successfully updated' }
      : { status: 'invalid', message: 'The load balancer server failed to update' }
  }

  private fields(input: Record<string, unknown>): ParsedFields | Readonly<{ error: string }> {
    const name = stringValue(input.name).trim()
    if (name === '' || name.length > 50 || hasUnsafeControls(name)) return { error: 'The load balancer name is invalid' }
    const link = normalizedHttpUrl(stringValue(input.link).trim())
    if (link === null || link.length > 263) return { error: 'The load balancer homepage URL is invalid' }
    const requestedHosts = stringArray(input['disallow_hosts[]'] ?? input.disallow_hosts ?? input.disallowHosts)
    const requestedContinents = stringArray(input['disallow_continent[]'] ?? input.disallow_continent ?? input.disallowContinents)
    const disallowHosts = unique(requestedHosts.filter((host) => this.hosts.has(host)))
    const disallowContinents = unique(requestedContinents.filter((continent) => continent in LOAD_BALANCER_CONTINENTS))
    return Object.freeze({ name, link, status: binaryFlag(input.status) ?? 0, disallowHosts, disallowContinents })
  }
}

type ParsedFields = Readonly<{
  name: string
  link: string
  status: number
  disallowHosts: readonly string[]
  disallowContinents: readonly string[]
}>

export function loadBalancerListQuery(input: Record<string, unknown>): LoadBalancerListQuery {
  const search = recordValue(input.search)
  const order = recordValue(arrayValue(input.order)[0])
  const index = boundedInteger(order.column ?? input['order[0][column]'], 6, 0, LIST_COLUMNS.length - 1)
  return Object.freeze({
    draw: boundedInteger(input.draw, 0, 0, Number.MAX_SAFE_INTEGER),
    start: boundedInteger(input.start, 0, 0, 1_000_000),
    length: boundedInteger(input.length, 10, 1, 100),
    search: stringValue(search.value ?? input['search[value]']).trim().slice(0, 263),
    orderBy: LIST_COLUMNS[index] ?? 'updated',
    orderDir: stringValue(order.dir ?? input['order[0][dir]']).toLowerCase() === 'asc' ? 'asc' : 'desc'
  })
}

export function loadBalancerId(value: unknown): string | null {
  const normalized = stringValue(value).trim()
  if (!/^[1-9]\d{0,9}$/.test(normalized)) return null
  try { return BigInt(normalized) <= 4_294_967_295n ? normalized : null } catch { return null }
}

function normalizedHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null
    if (url.hostname === '' || /[\u0000-\u001f\u007f]/.test(value)) return null
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
    return url.toString()
  } catch {
    return null
  }
}

function stringArray(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).map(stringValue).map((item) => item.trim()).filter(Boolean)
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)])
}

function binaryFlag(value: unknown): number | null {
  if (Array.isArray(value)) return value.some((item) => binaryFlag(item) === 1) ? 1 : 0
  const normalized = stringValue(value).trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'on') return 1
  if (normalized === '0' || normalized === 'false' || normalized === '' || normalized === 'off') return 0
  return null
}

function hasUnsafeControls(value: string): boolean { return /[\u0000-\u001f\u007f]/.test(value) }
function stringValue(value: unknown): string { return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '' }
function recordValue(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function arrayValue(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : [] }
function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(stringValue(value), 10)
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback
}
