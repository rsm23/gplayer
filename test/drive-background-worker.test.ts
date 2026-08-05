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

    expect(coordinator.trigger()).toEqual({ running: true, started: true, jobs: { bg_gdrive: { running: true, started: true } } })
    expect(coordinator.trigger()).toEqual({ running: true, started: false, jobs: { bg_gdrive: { running: true, started: false } } })
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledOnce())
    expect(runOnce).toHaveBeenCalledWith(true)
    release?.({ processed: 1, deleted: 1, retained: 0 })
    await expect(coordinator.waitForIdle()).resolves.toEqual({ processed: 1, deleted: 1, retained: 0 })
    expect(coordinator.trigger()).toEqual({ running: true, started: true, jobs: { bg_gdrive: { running: true, started: true } } })
    await expect(coordinator.waitForIdle()).resolves.toEqual({ processed: 0, deleted: 0, retained: 0 })
  })

  it('starts and coalesces Drive and stats jobs independently', async () => {
    const drive = { runOnce: vi.fn(async () => ({ processed: 0, deleted: 0, retained: 0 })) }
    const stats = { runOnce: vi.fn(async () => ({ acquired: true, cleaned: 0, processed: 0, enriched: 0 })) }
    const general = { runOnce: vi.fn(async () => ({ expiredSources: 0, normalizedSubtitles: 0, missingSubtitles: 0, temporaryEntries: 0, cacheCleared: false, lowSpace: false, loadBalancersChecked: 0, loadBalancersFailed: 0, proxyDisabled: false, proxiesDiscovered: 0, proxiesChecked: 0, proxiesValid: 0, pluginsActive: 0, pluginsSynchronized: 0, pluginsFailed: 0, pluginBackgroundsRunning: 0, phpPluginBackgroundsUnsupported: 0, activeConnections: null })) }
    const sourceRefresh = { runOnce: vi.fn(async () => ({ pending: 0 })) }
    const mediaDownload = { runOnce: vi.fn(async () => ({ scanned: 0 })) }
    const coordinator = new DriveBackgroundCoordinator(drive, async () => ({ copy: false, copyAll: false }), { stats, general, sourceRefresh: sourceRefresh as never, mediaDownload: mediaDownload as never })
    expect(coordinator.trigger()).toEqual({
      running: true,
      started: true,
      jobs: {
        bg_gdrive: { running: true, started: true },
        bg_stats: { running: true, started: true },
        bg_general: { running: true, started: true },
        bg_get: { running: true, started: true },
        bg_download: { running: true, started: true }
      }
    })
    expect(coordinator.trigger()).toEqual({
      running: true,
      started: false,
      jobs: {
        bg_gdrive: { running: true, started: false },
        bg_stats: { running: true, started: false },
        bg_general: { running: true, started: false },
        bg_get: { running: true, started: false },
        bg_download: { running: true, started: false }
      }
    })
    await vi.waitFor(() => {
      expect(drive.runOnce).toHaveBeenCalledOnce()
      expect(stats.runOnce).toHaveBeenCalledOnce()
      expect(general.runOnce).toHaveBeenCalledOnce()
      expect(sourceRefresh.runOnce).toHaveBeenCalledOnce()
      expect(mediaDownload.runOnce).toHaveBeenCalledOnce()
    })
  })
})
