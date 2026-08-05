import type { DriveAdminStore, DriveApiClient } from './drive-admin-service.js'
import type { DriveRuntimeSettingsLoader } from './drive-media-service.js'

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

export type DriveBackgroundStatus = Readonly<{ running: boolean; started: boolean }>

export class DriveBackgroundCoordinator {
  private active: Promise<DriveBackgroundResult> | undefined

  public constructor(
    private readonly worker: Pick<DriveBackgroundWorker, 'runOnce'>,
    private readonly loadSettings: DriveRuntimeSettingsLoader
  ) {}

  public trigger(): DriveBackgroundStatus {
    if (this.active !== undefined) return Object.freeze({ running: true, started: false })
    this.active = Promise.resolve()
      .then(async () => await this.worker.runOnce((await this.loadSettings()).copyAll))
      .catch(() => Object.freeze({ processed: 0, deleted: 0, retained: 0 }))
      .finally(() => { this.active = undefined })
    return Object.freeze({ running: true, started: true })
  }

  public async waitForIdle(): Promise<DriveBackgroundResult | null> {
    return await this.active ?? null
  }
}
