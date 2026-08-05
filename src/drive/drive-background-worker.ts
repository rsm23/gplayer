import type { DriveAdminStore, DriveApiClient } from './drive-admin-service.js'
import type { DriveRuntimeSettingsLoader } from './drive-media-service.js'
import type { StatsWorker } from '../background/stats-worker.js'
import type { GeneralWorker } from '../background/general-worker.js'
import type { SourceRefreshWorker } from '../background/source-refresh-worker.js'
import type { MediaDownloadWorker } from '../background/media-download-worker.js'

export type DriveBackgroundResult = Readonly<{
  processed: number
  deleted: number
  retained: number
}>

export class DriveBackgroundWorker {
  private readonly delay: (milliseconds: number) => Promise<void>
  private readonly random: () => number

  public constructor(
    private readonly store: DriveAdminStore,
    private readonly api: DriveApiClient,
    options: Readonly<{
      delay?: (milliseconds: number) => Promise<void>
      random?: () => number
      batchSize?: number
    }> = {}
  ) {
    this.delay = options.delay ?? (async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.random = options.random ?? Math.random
    this.batchSize = Math.max(1, Math.min(500, Math.trunc(options.batchSize ?? 100)))
  }

  private readonly batchSize: number

  public async runOnce(copyAll: boolean): Promise<DriveBackgroundResult> {
    const queue = await this.store.listPendingQueue(this.batchSize)
    const accounts = copyAll ? [] : await this.store.listActiveAccounts(true)
    const completed = new Set<string>()

    for (const item of queue) {
      if (copyAll) {
        const outcome = await this.api.copyFromAnyOutcome(item.gdrive_id, true)
        if (outcome.status !== 'failed') completed.add(item.gdrive_id)
      } else {
        let itemCompleted = false
        for (const account of accounts) {
          const outcome = await this.api.copyToAccount(item.gdrive_id, account.email, true)
          if (outcome.status !== 'failed') itemCompleted = true
        }
        if (itemCompleted) completed.add(item.gdrive_id)
      }
      await this.delay(500 + Math.floor(Math.max(0, Math.min(0.999999, this.random())) * 1_501))
    }

    const deleted = await this.store.deleteQueueByFileIds([...completed])
    return Object.freeze({ processed: queue.length, deleted, retained: Math.max(0, queue.length - completed.size) })
  }
}

export type BackgroundJobStatus = Readonly<{ running: boolean; started: boolean }>
export type DriveBackgroundStatus = BackgroundJobStatus & Readonly<{
  jobs?: Readonly<Record<string, BackgroundJobStatus>>
}>

export class DriveBackgroundCoordinator {
  private readonly active = new Map<string, Promise<unknown>>()

  public constructor(
    private readonly worker: Pick<DriveBackgroundWorker, 'runOnce'>,
    private readonly loadSettings: DriveRuntimeSettingsLoader,
    private readonly workers: Readonly<{
      stats?: Pick<StatsWorker, 'runOnce'>
      general?: Pick<GeneralWorker, 'runOnce'>
      sourceRefresh?: Pick<SourceRefreshWorker, 'runOnce'>
      mediaDownload?: Pick<MediaDownloadWorker, 'runOnce'>
    }> = {}
  ) {}

  public trigger(): DriveBackgroundStatus {
    const jobs: Record<string, BackgroundJobStatus> = {
      bg_gdrive: this.triggerJob('bg_gdrive', async () => await this.worker.runOnce((await this.loadSettings()).copyAll))
    }
    if (this.workers.stats !== undefined) jobs.bg_stats = this.triggerJob('bg_stats', async () => await this.workers.stats?.runOnce())
    if (this.workers.general !== undefined) jobs.bg_general = this.triggerJob('bg_general', async () => await this.workers.general?.runOnce())
    if (this.workers.sourceRefresh !== undefined) jobs.bg_get = this.triggerJob('bg_get', async () => await this.workers.sourceRefresh?.runOnce())
    if (this.workers.mediaDownload !== undefined) jobs.bg_download = this.triggerJob('bg_download', async () => await this.workers.mediaDownload?.runOnce())
    return Object.freeze({
      running: true,
      started: Object.values(jobs).some((job) => job.started),
      jobs: Object.freeze(jobs)
    })
  }

  public async waitForIdle(): Promise<DriveBackgroundResult | null> {
    const active = this.active.get('bg_gdrive')
    return active === undefined ? null : await active as DriveBackgroundResult | null
  }

  private triggerJob(name: string, run: () => Promise<unknown>): BackgroundJobStatus {
    if (this.active.has(name)) return Object.freeze({ running: true, started: false })
    let promise: Promise<unknown>
    promise = Promise.resolve()
      .then(run)
      .catch(() => null)
      .finally(() => {
        if (this.active.get(name) === promise) this.active.delete(name)
      })
    this.active.set(name, promise)
    return Object.freeze({ running: true, started: true })
  }
}
