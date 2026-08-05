import { createPool, type RowDataPacket } from 'mysql2/promise'
import type { ExecuteValues } from 'mysql2'
import type { AppConfig, DatabaseEndpointConfig } from '../config.js'

export type SqlValues = readonly ExecuteValues[]

export interface SqlExecutor {
  execute<T>(sql: string, values?: SqlValues): Promise<T>
}

export interface TransactionExecutor extends SqlExecutor {}

export interface DatabaseConnection {
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  execute(sql: string, values?: ExecuteValues[]): Promise<[unknown, unknown]>
  release(): void
}

export interface DatabasePool {
  execute(sql: string, values?: ExecuteValues[]): Promise<[unknown, unknown]>
  getConnection(): Promise<DatabaseConnection>
  end(): Promise<void>
}

export type DatabasePools = Readonly<{ master: DatabasePool; replica?: DatabasePool }>

function endpointIsEqual(left: DatabaseEndpointConfig, right: DatabaseEndpointConfig): boolean {
  return left.host === right.host && left.port === right.port && left.database === right.database && left.user === right.user && left.password === right.password
}

function poolFrom(endpoint: DatabaseEndpointConfig, config: AppConfig['database']): DatabasePool {
  const pool = createPool({
    host: endpoint.host,
    port: endpoint.port,
    database: endpoint.database,
    user: endpoint.user,
    password: endpoint.password,
    charset: 'utf8mb4',
    timezone: 'Z',
    connectTimeout: config.connectTimeoutMs,
    connectionLimit: config.connectionLimit,
    waitForConnections: true,
    enableKeepAlive: true,
    supportBigNumbers: true,
    bigNumberStrings: true
  })
  return {
    execute: async (sql, values = []) => await pool.execute(sql, values),
    getConnection: async () => {
      const connection = await pool.getConnection()
      return {
        beginTransaction: async () => await connection.beginTransaction(),
        commit: async () => await connection.commit(),
        rollback: async () => await connection.rollback(),
        execute: async (sql, values = []) => await connection.execute(sql, values),
        release: () => connection.release()
      }
    },
    end: async () => await pool.end()
  }
}

class Executor implements SqlExecutor {
  public constructor(private readonly target: Pick<DatabasePool, 'execute'>) {}

  public async execute<T>(sql: string, values: SqlValues = []): Promise<T> {
    const [result] = await this.target.execute(sql, [...values])
    return result as T
  }
}

export class Database {
  private readonly master: DatabasePool
  private readonly replica: DatabasePool
  private readonly sharedPool: boolean

  public constructor(config: AppConfig['database'], pools?: DatabasePools) {
    this.master = pools?.master ?? poolFrom(config.master, config)
    this.sharedPool = pools?.replica === undefined && endpointIsEqual(config.master, config.replica)
    this.replica = pools?.replica ?? (this.sharedPool ? this.master : poolFrom(config.replica, config))
  }

  public async read<T extends RowDataPacket[]>(sql: string, values: SqlValues = []): Promise<T> {
    try {
      return await new Executor(this.replica).execute<T>(sql, values)
    } catch (error) {
      if (this.replica === this.master) throw error
      return await new Executor(this.master).execute<T>(sql, values)
    }
  }

  public async write<T>(sql: string, values: SqlValues = []): Promise<T> {
    return await new Executor(this.master).execute<T>(sql, values)
  }

  public async transaction<T>(work: (executor: TransactionExecutor) => Promise<T>): Promise<T> {
    const connection = await this.master.getConnection()
    await connection.beginTransaction()
    try {
      const result = await work(new Executor(connection))
      await connection.commit()
      return result
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  public async close(): Promise<void> {
    if (!this.sharedPool && this.replica !== this.master) await this.replica.end()
    await this.master.end()
  }
}
