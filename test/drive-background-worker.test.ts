import { describe, expect, it, vi } from 'vitest'
import { DriveBackgroundCoordinator, DriveBackgroundWorker } from '../src/drive/drive-background-worker.js'
import type { DriveQueueRecord } from '../src/drive/drive-admin-service.js'

const queue: readonly DriveQueueRecord[] = Object.freeze([
  { id: '1', gdrive_id: 'missingFileABC' },
  { id: '2', gdrive_id: 'failedFileABCD' },
  { id: '3', gdrive_id: 'copiedFileABCD' }
])

describe('Node-native Drive background queue', () => {
  it('removes missing and copied all-account jobs while retaining copy failures', async () => {
    const removed: string[][] = []
    const delays: number[] = []
    const store = {
      listPendingQueue: vi.fn(async () => queue),
      listActiveAccounts: vi.fn(async () => []),
      deleteQueueByFileIds: vi.fn(async (ids: readonly string[]) => {
        removed.push([...ids])
        return ids.length
      })
    }
    const api = {
      copyFromAnyOutcome: vi.fn(async (id: string) => ({
        status: id.startsWith('missing') ? 'missing' as const : id.startsWith('failed') ? 'failed' as const : 'copied' as const,
        located: null
      }))
    }
    const worker = new DriveBackgroundWorker(store as never, api as never, {
      delay: async (milliseconds) => { delays.push(milliseconds) },
      random: () => 0.5,
      batchSize: 25
    })

    await expect(worker.runOnce(true)).resolves.toEqual({ processed: 3, deleted: 2, retained: 1 })
    expect(store.listPendingQueue).toHaveBeenCalledWith(25)
    expect(removed).toEqual([['missingFileABC', 'copiedFileABCD']])
    expect(delays).toEqual([1250, 1250, 1250])
  })

  it('matches per-account first-pass cleanup and retains only universal copy failures', async () => {
    const accounts = [{ email: 'one@example.test' }, { email: 'two@example.test' }]
    const deleted: string[][] = []
    const store = {
      listPendingQueue: vi.fn(async () => queue.slice(0, 2)),
      listActiveAccounts: vi.fn(async () => accounts),
      deleteQueueByFileIds: vi.fn(async (ids: readonly string[]) => { deleted.push([...ids]); return ids.length })
    }
    const api = {
      copyToAccount: vi.fn(async (id: string, email: string) => ({
        status: id.startsWith('missing') && email.startsWith('one') ? 'missing' as const : 'failed' as const,
        located: null
      }))
    }
    const worker = new DriveBackgroundWorker(store as never, api as never, { delay: async () => {}, random: () => 0 })

    await expect(worker.runOnce(false)).resolves.toEqual({ processed: 2, deleted: 1, retained: 1 })
    expect(store.listActiveAccounts).toHaveBeenCalledWith(true)
    expect(api.copyToAccount).toHaveBeenCalledTimes(4)
    expect(deleted).toEqual([['missingFileABC']])
  })

  it('coalesces overlapping ping triggers into one background run', async () => {
    let release: ((value: Readonly<{ processed: number; deleted: number; retained: number }>) => void) | undefined
    const runOnce = vi.fn()
      .mockImplementationOnce(async () => await new Promise<Readonly<{ processed: number; deleted: number; retained: number }>>((resolve) => { release = resolve }))
      .mockResolvedValue({ processed: 0, deleted: 0, retained: 0 })
    const loadSettings = vi.fn(async () => ({ copy: true, copyAll: true }))
    const coordinator = new DriveBackgroundCoordinator({ runOnce }, loadSettings)

    expect(coordinator.trigger()).toEqual({ running: true, started: true })
    expect(coordinator.trigger()).toEqual({ running: true, started: false })
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledOnce())
    expect(runOnce).toHaveBeenCalledWith(true)
    release?.({ processed: 1, deleted: 1, retained: 0 })
    await expect(coordinator.waitForIdle()).resolves.toEqual({ processed: 1, deleted: 1, retained: 0 })
    expect(coordinator.trigger()).toEqual({ running: true, started: true })
    await expect(coordinator.waitForIdle()).resolves.toEqual({ processed: 0, deleted: 0, retained: 0 })
  })
})
