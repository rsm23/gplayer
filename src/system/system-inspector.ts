import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { getHeapStatistics } from 'node:v8'
import { readFile, readdir, statfs } from 'node:fs/promises'

const executeFile = promisify(execFile)

export type UsageStatus = Readonly<{
  total: number
  used: number
  free: number
  percent: number
}>

export type OperatingSystemStatus = Readonly<{
  cpu: number
  os: string
  uptime: number
}>

export type RuntimeServiceStatus = Readonly<{
  status: boolean
  name: string
  version?: string
  sapi?: string
  limit?: string
  curl?: Readonly<{
    version: string
    ssl_version: string
    brotli: string
  }>
}>

export type SystemServicesStatus = Readonly<Record<string, RuntimeServiceStatus>>

export type SystemStatusSnapshot = Readonly<{
  cpu: number
  os: string
  uptime: number
  ram: UsageStatus
  disk: UsageStatus
  services: SystemServicesStatus
}>

export interface SystemInspector {
  operatingSystem(): Promise<OperatingSystemStatus>
  ramUsage(): Promise<UsageStatus>
  diskUsage(): Promise<UsageStatus>
  services(): Promise<SystemServicesStatus>
}

export type NodeSystemInspectorOptions = Readonly<{
  loadAverage?: () => readonly number[]
  cpuCount?: () => number
  uptime?: () => number
  totalMemory?: () => number
  freeMemory?: () => number
  operatingSystem?: () => Promise<string>
  diskUsage?: () => Promise<UsageStatus>
  processNames?: () => Promise<ReadonlySet<string>>
  nodeVersion?: string
  opensslVersion?: string
  brotliVersion?: string
  heapLimit?: () => number
  platform?: NodeJS.Platform
}>

export class NodeSystemInspector implements SystemInspector {
  private readonly loadAverage: () => readonly number[]
  private readonly cpuCount: () => number
  private readonly uptime: () => number
  private readonly totalMemory: () => number
  private readonly freeMemory: () => number
  private readonly loadOperatingSystem: () => Promise<string>
  private readonly loadDiskUsage: () => Promise<UsageStatus>
  private readonly loadProcessNames: () => Promise<ReadonlySet<string>>
  private readonly nodeVersion: string
  private readonly opensslVersion: string
  private readonly brotliVersion: string
  private readonly heapLimit: () => number

  public constructor(baseDirectory: string, options: NodeSystemInspectorOptions = {}) {
    const platform = options.platform ?? process.platform
    this.loadAverage = options.loadAverage ?? os.loadavg
    this.cpuCount = options.cpuCount ?? (() => Math.max(1, os.cpus().length))
    this.uptime = options.uptime ?? os.uptime
    this.totalMemory = options.totalMemory ?? os.totalmem
    this.freeMemory = options.freeMemory ?? os.freemem
    this.loadOperatingSystem = options.operatingSystem ?? operatingSystemName
    this.loadDiskUsage = options.diskUsage ?? (async () => await filesystemUsage(baseDirectory))
    this.loadProcessNames = options.processNames ?? (async () => await processNames(platform))
    this.nodeVersion = options.nodeVersion ?? process.versions.node
    this.opensslVersion = options.opensslVersion ?? process.versions.openssl ?? 'N/A'
    this.brotliVersion = options.brotliVersion ?? process.versions.brotli ?? 'N/A'
    this.heapLimit = options.heapLimit ?? (() => getHeapStatistics().heap_size_limit)
  }

  public async operatingSystem(): Promise<OperatingSystemStatus> {
    const load = finitePositive(this.loadAverage()[0])
    const cpu = roundPercent(load / Math.max(1, this.cpuCount()) * 100)
    const uptime = finitePositive(this.uptime())
    return Object.freeze({ cpu, os: await this.loadOperatingSystem(), uptime })
  }

  public async ramUsage(): Promise<UsageStatus> {
    return usage(this.totalMemory(), this.freeMemory())
  }

  public async diskUsage(): Promise<UsageStatus> {
    return await this.loadDiskUsage()
  }

  public async services(): Promise<SystemServicesStatus> {
    const names = new Set([...await this.loadProcessNames()].map((name) => name.trim().toLowerCase()))
    const running = (...candidates: readonly string[]): boolean => candidates.some((candidate) => names.has(candidate))
    const curl = Object.freeze({
      version: 'Node.js fetch',
      ssl_version: this.opensslVersion === 'N/A' ? 'N/A' : `OpenSSL/${this.opensslVersion}`,
      brotli: this.brotliVersion
    })
    return Object.freeze({
      apache: Object.freeze({ status: running('apache', 'apache2', 'httpd'), name: 'Apache' }),
      litespeed: Object.freeze({ status: running('litespeed', 'lshttpd'), name: 'LiteSpeed' }),
      nginx: Object.freeze({ status: running('nginx'), name: 'NGINX' }),
      memcached: Object.freeze({ status: running('memcached'), name: 'Memcached' }),
      redis: Object.freeze({ status: running('redis', 'redis-server'), name: 'Redis' }),
      php: Object.freeze({ status: false, name: 'PHP', version: 'Not used', sapi: 'Node.js', limit: 'N/A', curl }),
      node: Object.freeze({
        status: true,
        name: 'Node.js',
        version: this.nodeVersion,
        sapi: 'Node.js',
        limit: formatBytes(this.heapLimit()),
        curl
      })
    })
  }
}

export async function systemStatusSnapshot(inspector: SystemInspector): Promise<SystemStatusSnapshot> {
  const [operatingSystem, ram, disk, services] = await Promise.all([
    inspector.operatingSystem(),
    inspector.ramUsage(),
    inspector.diskUsage(),
    inspector.services()
  ])
  return Object.freeze({ ...operatingSystem, ram, disk, services })
}

async function operatingSystemName(): Promise<string> {
  if (process.platform === 'linux') {
    const release = await readFile('/etc/os-release', 'utf8').catch(() => '')
    const match = release.match(/^PRETTY_NAME=(?:"([^"]+)"|'([^']+)'|([^\r\n]+))$/m)
    const prettyName = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim()
    if (prettyName !== '') return prettyName
  }
  return `${os.type()} ${os.release()}`.trim()
}

async function filesystemUsage(baseDirectory: string): Promise<UsageStatus> {
  const target = path.resolve(baseDirectory)
  const details = await statfs(target)
  const blockSize = Number(details.bsize)
  const total = Number(details.blocks) * blockSize
  const free = Number(details.bavail) * blockSize
  return usage(total, free)
}

async function processNames(platform: NodeJS.Platform): Promise<ReadonlySet<string>> {
  if (platform === 'linux') return await linuxProcessNames()
  if (platform === 'win32') return await windowsProcessNames()
  return await posixProcessNames()
}

async function linuxProcessNames(): Promise<ReadonlySet<string>> {
  const entries = await readdir('/proc', { withFileTypes: true }).catch(() => [])
  const names = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(async (entry) => await readFile(`/proc/${entry.name}/comm`, 'utf8').catch(() => '')))
  return new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean))
}

async function posixProcessNames(): Promise<ReadonlySet<string>> {
  try {
    const result = await executeFile('ps', ['-A', '-o', 'comm='], { timeout: 1_000, maxBuffer: 1_048_576 })
    return new Set(result.stdout.split(/\r?\n/u).map((line) => path.basename(line.trim()).toLowerCase()).filter(Boolean))
  } catch {
    return new Set()
  }
}

async function windowsProcessNames(): Promise<ReadonlySet<string>> {
  try {
    const result = await executeFile('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 1_000, maxBuffer: 1_048_576 })
    return new Set(result.stdout.split(/\r?\n/u).map((line) => line.match(/^"([^"]+)"/)?.[1] ?? '').map((name) => name.toLowerCase().replace(/\.exe$/u, '')).filter(Boolean))
  } catch {
    return new Set()
  }
}

function usage(totalValue: number, freeValue: number): UsageStatus {
  const total = Math.max(0, Math.trunc(Number.isFinite(totalValue) ? totalValue : 0))
  const free = Math.max(0, Math.min(total, Math.trunc(Number.isFinite(freeValue) ? freeValue : 0)))
  const used = total - free
  return Object.freeze({ total, used, free, percent: total > 0 ? roundPercent(used / total * 100) : 0 })
}

function finitePositive(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0
}

function roundPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100
}

function formatBytes(value: number): string {
  const bytes = finitePositive(value)
  if (bytes === 0) return 'N/A'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1_024)))
  return `${Math.round(bytes / 1_024 ** exponent * 10) / 10} ${units[exponent]}`
}
