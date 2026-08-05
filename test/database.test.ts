import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { Database } from '../src/database/database.js'
import { quoteIdentifier, SelectQuery } from '../src/database/query-builder.js'

function fakeConnection() {
  return {
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    execute: vi.fn(async () => [[{ id: 1 }], []] as [unknown, unknown]),
    release: vi.fn()
  }
}

function fakePool(result: unknown = [{ id: 1 }]) {
  const connection = fakeConnection()
  return {
    execute: vi.fn(async () => [result, []] as [unknown, unknown]),
    getConnection: vi.fn(async () => connection),
    end: vi.fn(async () => undefined),
    connection
  }
}

const databaseConfig = loadConfig({
  NODE_ENV: 'test',
  SECURE_SALT: '1234567890123456',
  DB_MASTER_HOST: 'master',
  DB_REPLICA_HOST: 'replica'
}).database

describe('Database', () => {
  it('uses the replica for reads and master for writes', async () => {
    const master = fakePool()
    const replica = fakePool([{ id: 2 }])
    const database = new Database(databaseConfig, { master, replica })

    await expect(database.read('SELECT * FROM tb_videos')).resolves.toEqual([{ id: 2 }])
    await database.write('UPDATE tb_videos SET views = views + 1 WHERE id = ?', [1])
    expect(replica.execute).toHaveBeenCalledOnce()
    expect(master.execute).toHaveBeenCalledOnce()
  })

  it('falls back to master when the replica is unavailable', async () => {
    const master = fakePool([{ id: 3 }])
    const replica = fakePool()
    replica.execute.mockRejectedValueOnce(new Error('replica unavailable'))
    const database = new Database(databaseConfig, { master, replica })

    await expect(database.read('SELECT 1')).resolves.toEqual([{ id: 3 }])
  })

  it('commits successful transactions and releases the connection', async () => {
    const master = fakePool()
    const database = new Database(databaseConfig, { master })

    await expect(database.transaction(async (transaction) => await transaction.execute('SELECT 1'))).resolves.toEqual([{ id: 1 }])
    expect(master.connection.beginTransaction).toHaveBeenCalledOnce()
    expect(master.connection.commit).toHaveBeenCalledOnce()
    expect(master.connection.rollback).not.toHaveBeenCalled()
    expect(master.connection.release).toHaveBeenCalledOnce()
  })

  it('rolls back failed transactions', async () => {
    const master = fakePool()
    const database = new Database(databaseConfig, { master })

    await expect(database.transaction(async () => { throw new Error('failed') })).rejects.toThrow('failed')
    expect(master.connection.rollback).toHaveBeenCalledOnce()
    expect(master.connection.commit).not.toHaveBeenCalled()
    expect(master.connection.release).toHaveBeenCalledOnce()
  })
})

describe('SelectQuery', () => {
  it('compiles bound queries with validated identifiers', () => {
    expect(new SelectQuery('tb_videos')
      .select('id', 'title')
      .where('status', 1)
      .whereIn('host', ['gdrive', 'youtube'])
      .groupBy('id')
      .orderBy('created', 'DESC')
      .limit(25, 50)
      .compile()).toEqual({
      sql: 'SELECT `id`, `title` FROM `tb_videos` WHERE `status` = ? AND `host` IN (?, ?) GROUP BY `id` ORDER BY `created` DESC LIMIT ? OFFSET ?',
      values: [1, 'gdrive', 'youtube', 25, 50]
    })
  })

  it('rejects identifier injection', () => {
    expect(() => quoteIdentifier('tb_videos; DROP TABLE tb_users')).toThrow(/Invalid SQL identifier/)
  })
})
