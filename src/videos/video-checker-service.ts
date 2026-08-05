import type { SourceApiRequestContext, SourceApiResolver } from '../http/source-api-routes.js'
import type { VideoAccess, VideoAdminService } from './video-admin-service.js'

export type VideoCheckResult =
  | Readonly<{
      status: 'ok'
      message: string
      result: Readonly<{ id: string; videoStatus: 0 | 1; sources: number }>
    }>
  | Readonly<{ status: 'fail'; message: string; result: null }>

export class VideoCheckerService {
  private readonly inFlight = new Set<string>()

  public constructor(
    private readonly videos: VideoAdminService,
    private readonly resolve: SourceApiResolver
  ) {}

  public async check(
    id: unknown,
    access: VideoAccess,
    context: Omit<SourceApiRequestContext, 'downloadable'>
  ): Promise<VideoCheckResult> {
    const normalized = videoId(id)
    if (normalized === null) return failure('The video was not found')
    if (this.inFlight.has(normalized)) return failure('The video is already being checked')

    this.inFlight.add(normalized)
    try {
      const query = await this.videos.sourceQuery(normalized, access)
      if (query === null) return failure('The video was not found')

      let sources: readonly Readonly<Record<string, unknown>>[]
      try {
        sources = (await this.resolve(query, { ...context, downloadable: false })).sources
      } catch {
        return failure('The video availability check failed')
      }

      const updated = await this.videos.status(normalized, sources, access)
      if (updated.status === 'fail') return failure(updated.message)
      const videoStatus = sources.length > 0 ? 0 : 1
      return Object.freeze({
        status: 'ok',
        message: videoStatus === 0 ? 'The video is available' : 'The video is broken',
        result: Object.freeze({ id: normalized, videoStatus, sources: sources.length })
      })
    } finally {
      this.inFlight.delete(normalized)
    }
  }
}

function videoId(value: unknown): string | null {
  const normalized = typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : ''
  return /^(?:0|[1-9]\d{0,19})$/u.test(normalized) ? normalized : null
}

function failure(message: string): VideoCheckResult {
  return Object.freeze({ status: 'fail', message, result: null })
}
