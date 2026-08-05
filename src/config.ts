import 'dotenv/config'
import { isIP } from 'node:net'
import { z } from 'zod'

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  BASE_URL: z.url().default('http://127.0.0.1:3000/'),
  ADMIN_DIR: z.string().regex(/^[A-Za-z0-9_-]+$/).default('administrator'),
  SLUG_EMBED: z.string().regex(/^[A-Za-z0-9_-]+$/).default('e'),
  SLUG_DOWNLOAD: z.string().regex(/^[A-Za-z0-9_-]+$/).default('d'),
  SLUG_REQUEST: z.string().regex(/^[A-Za-z0-9_-]+$/).default('r'),
  SECURE_SALT: z.string().min(16).default('development-only-change-me'),
  BUFFER_SIZE: z.coerce.number().int().positive().default(1_024_000),
  SMALL_BUFFER_SIZE: z.coerce.number().int().positive().default(512_000),
  MAX_DOWNLOAD_SPEED: z.coerce.number().int().nonnegative().default(0),
  TRUST_PROXY: z.string().default('false'),
  DB_MASTER_HOST: z.string().min(1).default('127.0.0.1'),
  DB_MASTER_PORT: z.coerce.number().int().min(1).max(65_535).default(3_306),
  DB_MASTER_NAME: z.string().min(1).default('gplayer'),
  DB_MASTER_USER: z.string().min(1).default('root'),
  DB_MASTER_PASSWORD: z.string().default(''),
  DB_REPLICA_HOST: z.string().min(1).optional(),
  DB_REPLICA_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  DB_REPLICA_NAME: z.string().min(1).optional(),
  DB_REPLICA_USER: z.string().min(1).optional(),
  DB_REPLICA_PASSWORD: z.string().optional(),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DB_CONNECTION_LIMIT: z.coerce.number().int().positive().default(10)
})

export type DatabaseEndpointConfig = Readonly<{
  host: string
  port: number
  database: string
  user: string
  password: string
}>

export type AppConfig = Readonly<{
  nodeEnv: 'development' | 'test' | 'production'
  host: string
  port: number
  baseUrl: URL
  adminDirectory: string
  slugs: Readonly<{
    embed: string
    download: string
    request: string
  }>
  secureSalt: string
  bufferSize: number
  smallBufferSize: number
  maxDownloadSpeed: number
  trustProxy: boolean | readonly string[]
  database: Readonly<{
    master: DatabaseEndpointConfig
    replica: DatabaseEndpointConfig
    connectTimeoutMs: number
    connectionLimit: number
  }>
}>

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment)

  if (parsed.NODE_ENV === 'production' && parsed.SECURE_SALT === 'development-only-change-me') {
    throw new Error('SECURE_SALT must be configured in production')
  }

  return Object.freeze({
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    baseUrl: new URL(parsed.BASE_URL),
    adminDirectory: parsed.ADMIN_DIR,
    slugs: Object.freeze({
      embed: parsed.SLUG_EMBED,
      download: parsed.SLUG_DOWNLOAD,
      request: parsed.SLUG_REQUEST
    }),
    secureSalt: parsed.SECURE_SALT,
    bufferSize: parsed.BUFFER_SIZE,
    smallBufferSize: parsed.SMALL_BUFFER_SIZE,
    maxDownloadSpeed: parsed.MAX_DOWNLOAD_SPEED,
    trustProxy: parseTrustedProxies(parsed.TRUST_PROXY),
    database: Object.freeze({
      master: Object.freeze({
        host: parsed.DB_MASTER_HOST,
        port: parsed.DB_MASTER_PORT,
        database: parsed.DB_MASTER_NAME,
        user: parsed.DB_MASTER_USER,
        password: parsed.DB_MASTER_PASSWORD
      }),
      replica: Object.freeze({
        host: parsed.DB_REPLICA_HOST ?? parsed.DB_MASTER_HOST,
        port: parsed.DB_REPLICA_PORT ?? parsed.DB_MASTER_PORT,
        database: parsed.DB_REPLICA_NAME ?? parsed.DB_MASTER_NAME,
        user: parsed.DB_REPLICA_USER ?? parsed.DB_MASTER_USER,
        password: parsed.DB_REPLICA_PASSWORD ?? parsed.DB_MASTER_PASSWORD
      }),
      connectTimeoutMs: parsed.DB_CONNECT_TIMEOUT_MS,
      connectionLimit: parsed.DB_CONNECTION_LIMIT
    })
  })
}

function parseTrustedProxies(value: string): boolean | readonly string[] {
  const normalized = value.trim().toLowerCase()
  if (normalized === '' || normalized === 'false') return false
  if (normalized === 'true') return true
  const entries = [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))]
  if (entries.length === 0 || entries.some((entry) => !validProxyAddress(entry))) {
    throw new Error('TRUST_PROXY must be true, false, or a comma-separated list of IP addresses/CIDR ranges')
  }
  return Object.freeze(entries)
}

function validProxyAddress(value: string): boolean {
  if (!value.includes('/')) return isIP(value) !== 0
  const [address, prefix, ...remainder] = value.split('/')
  const version = isIP(address ?? '')
  if (version === 0 || remainder.length > 0 || !/^\d+$/.test(prefix ?? '')) return false
  const bits = Number(prefix)
  return Number.isInteger(bits) && bits >= 0 && bits <= (version === 4 ? 32 : 128)
}
