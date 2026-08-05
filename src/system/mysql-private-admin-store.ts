import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Database, TransactionExecutor } from '../database/database.js'
import type { PrivateAdminStore, PrivateCacheIdentity, PrivateLoadBalancerCacheClear, PrivateVideoCacheClear } from './private-admin-service.js'

type VideoIdentityRow = RowDataPacket & Readonly<{ host: string; host_id: string }>
type LoadBalancerRow = RowDataPacket & Readonly<{ id: string | number }>

export class MySqlPrivateAdminStore implements PrivateAdminStore {
  public constructor(private readonly database: Pick<Database, 'transaction'>) {}

  public async clearVideoSources(id: string): Promise<PrivateVideoCacheClear> {
    return await this.database.transaction(async (transaction) => {
      const videos = await transaction.execute<VideoIdentityRow[]>(
        'SELECT `host`, `host_id` FROM `tb_videos` WHERE `id` = ? LIMIT 1 FOR UPDATE',
        [id]
      )
      const video = videos[0]
      if (video === undefined) return Object.freeze({ found: false, identities: Object.freeze([]), primarySourcesCleared: false, alternativeSourcesCleared: false })
      const alternatives = await transaction.execute<VideoIdentityRow[]>(
        'SELECT `host`, `host_id` FROM `tb_videos_alternatives` WHERE `vid` = ? ORDER BY `id` ASC',
        [id]
      )
      const identities = Object.freeze([identity(video), ...alternatives.map(identity)])
      await deleteIdentity(transaction, identities[0] as PrivateCacheIdentity)
      for (const alternative of identities.slice(1)) await deleteIdentity(transaction, alternative)
      return Object.freeze({
        found: true,
        identities,
        primarySourcesCleared: true,
        alternativeSourcesCleared: alternatives.length > 0
      })
    })
  }

  public async clearLoadBalancerSources(link: string): Promise<PrivateLoadBalancerCacheClear> {
    return await this.database.transaction(async (transaction) => {
      const rows = await transaction.execute<LoadBalancerRow[]>(
        'SELECT `id` FROM `tb_loadbalancers` WHERE `link` = ? LIMIT 1 FOR UPDATE',
        [link]
      )
      const row = rows[0]
      if (row === undefined) return Object.freeze({ found: false, sourcesCleared: false })
      await transaction.execute<ResultSetHeader>('DELETE FROM `tb_videos_sources` WHERE `sid` = ?', [String(row.id)])
      return Object.freeze({ found: true, sourcesCleared: true })
    })
  }
}

async function deleteIdentity(transaction: TransactionExecutor, value: PrivateCacheIdentity): Promise<void> {
  await transaction.execute<ResultSetHeader>(
    'DELETE FROM `tb_videos_sources` WHERE `host` = ? AND `host_id` = ?',
    [value.host, value.hostId]
  )
}

function identity(row: VideoIdentityRow): PrivateCacheIdentity {
  return Object.freeze({ host: String(row.host), hostId: String(row.host_id) })
}
