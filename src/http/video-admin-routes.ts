import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AUTH_COOKIE_NAME, AuthService, authTokenFromRequest, type AuthUser } from '../auth/auth-service.js'
import type { AppConfig } from '../config.js'
import { Hosting } from '../core/hosting.js'
import { buildPlayerQuery, type PlayerMediaQuery } from '../core/player-query.js'
import { renderAdminError, renderAdminVideoForm, renderAdminVideos, type AdminMessage } from '../player/admin-page.js'
import { Security } from '../security/security.js'
import { loadRuntimePlayerSettings, type PlayerSettingsLoader } from '../settings/player-runtime.js'
import type { SubtitleAdminService } from '../subtitles/subtitle-admin-service.js'
import { parseBulkSubtitleLines, type StoredVideoDetail, type VideoAccess, type VideoAdminService, type VideoFormSubmission, type VideoLinkSlugs, type VideoMutationResult } from '../videos/video-admin-service.js'
import { VIDEO_BULK_MAX_ITEMS, type VideoBulkService } from '../videos/video-bulk-service.js'
import type { VideoCheckerService } from '../videos/video-checker-service.js'
import { VIDEO_EXPORT_FAIL, VIDEO_EXPORT_SUCCESS, VIDEO_IMPORT_FAIL, type VideoTransferService } from '../videos/video-transfer-service.js'
import type { PluginExtensionRuntime } from '../plugins/plugin-extension-runtime.js'

const ADMIN_CSP = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data: http: https:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
const UNAUTHORIZED = 'You are not authorized to access this feature'

type UploadedPart = Readonly<{ fieldname: string; filename: string; content: Buffer }>
type VideoRequestData = Readonly<{ fields: Record<string, unknown>; files: readonly UploadedPart[] }>

export async function registerVideoAdminRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  videos: VideoAdminService,
  transfers: VideoTransferService,
  subtitles: SubtitleAdminService,
  bulk: VideoBulkService,
  checker: VideoCheckerService,
  loadPlayerSettings?: PlayerSettingsLoader,
  loadImportFileSize?: () => Promise<number>,
  plugins?: Pick<PluginExtensionRuntime, 'executeHook'>
): Promise<void> {
  const security = new Security(config.secureSalt)
  const playerDefaults = { ...config.slugs, adminDirectory: config.adminDirectory }
  const currentVideoSlugs = async (): Promise<VideoLinkSlugs> => {
    const player = await loadRuntimePlayerSettings(loadPlayerSettings, playerDefaults)
    return Object.freeze({ embed: player.slug_embed, download: player.slug_download })
  }
  const adminBase = `/${config.adminDirectory}`
  const loginUrl = `${adminBase}/login/`
  const listUrl = `${adminBase}/videos/list/`
  const newUrl = `${adminBase}/videos/new/`
  const editUrl = `${adminBase}/videos/edit/`
  const deleteUrl = `${adminBase}/videos/delete/`
  const statusUrl = `${adminBase}/videos/status/`
  const bulkUrl = `${adminBase}/videos/bulk/`
  const checkUrl = `${adminBase}/videos/check/`
  const dmcaUrl = `${adminBase}/videos/dmca/`
  const posterRemoveUrl = `${adminBase}/videos/poster/remove/`
  const ajaxUrl = `${adminBase}/ajax/videos/`
  const listAjaxUrl = `${adminBase}/ajax/videos-list/`
  const importUrl = `${adminBase}/videos/import/`
  const exportUrl = `${adminBase}/videos/export/`
  const exportDownloadUrl = `${adminBase}/videos/export/download/`
  const importAjaxUrl = `${adminBase}/ajax/videos-import/`
  const exportAjaxUrl = `${adminBase}/ajax/videos-export/`
  const publicAjaxUrl = `${adminBase}/ajax/`

  app.get(`${adminBase}/videos/list`, async (request, reply) => await redirectWithQuery(request, reply, listUrl))
  app.get(`${adminBase}/videos/new`, async (_request, reply) => await reply.redirect(newUrl, 308))
  app.get(`${adminBase}/videos/edit`, async (request, reply) => await redirectWithQuery(request, reply, editUrl))

  app.get(listUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    try {
      return reply.type('text/html; charset=utf-8').send(await videoListPage(config, request, user, videos, currentVideoSlugs, loadImportFileSize, pageMessage(request)))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The video database is temporarily unavailable.'))
    }
  })

  app.get(newUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    return reply.type('text/html; charset=utf-8').send(renderAdminVideoForm({
      adminBase,
      isAdmin: user.role === 0,
      csrfToken: csrfToken(config, tokenFor(request), 'video-write')
    }))
  })

  app.get(editUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    try {
      const video = await videos.get(objectValue(request.query).id, accessFor(user))
      if (video === null) return reply.code(404).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 404, 'The video was not found'))
      if (user.role !== 0 && video.dmca > 0) return reply.code(451).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'This video is unavailable because of a takedown.'))
      return reply.type('text/html; charset=utf-8').send(await videoFormPage(config, request, user, videos, video, currentVideoSlugs, editPageMessage(request), plugins))
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The video database is temporarily unavailable.'))
    }
  })

  const writeVideo = async (request: FastifyRequest, reply: FastifyReply, edit: boolean): Promise<unknown> => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) return videoOriginError(reply, adminBase)
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    let data: VideoRequestData
    try {
      data = await videoRequestData(request)
    } catch {
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The uploaded video form is invalid.'))
    }
    if (!validCsrfToken(config, tokenFor(request), stringValue(data.fields.csrf), 'video-write')) return videoCsrfError(reply, adminBase)
    const id = data.fields.id ?? objectValue(request.query).id
    const access = accessFor(user)
    let submission: VideoFormSubmission
    try {
      submission = await formSubmission(data, subtitles, access)
    } catch (error) {
      const current = edit ? await videos.get(id, access).catch(() => null) : undefined
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminVideoForm({
        adminBase,
        isAdmin: access.isAdmin,
        csrfToken: csrfToken(config, tokenFor(request), 'video-write'),
        ...(current === undefined || current === null ? {} : formPageData(config, videos, current, await currentVideoSlugs())),
        values: data.fields,
        message: {
          kind: 'error',
          text: error instanceof Error ? error.message : 'The uploaded subtitle file failed to save'
        }
      }))
    }
    const result = edit ? await videos.update(id, submission, access) : await videos.create(submission, access)
    if (result.status === 'ok' && result.id !== undefined) {
      await plugins?.executeHook('video.save', Object.freeze({
        video_id: result.id,
        [edit ? 'update_data' : 'insert_data']: submission,
        post_data: Object.freeze({ ...data.fields }),
        action: edit ? 'edit' : 'create'
      }), Object.freeze({ user: Object.freeze({ id: user.id, role: user.role }) })).catch(() => undefined)
      return await reply.redirect(`${editUrl}?id=${encodeURIComponent(result.id)}&${edit ? 'updated' : 'created'}=1`, 303)
    }

    const current = edit ? await videos.get(id, access).catch(() => null) : undefined
    return reply.code(400).type('text/html; charset=utf-8').send(renderAdminVideoForm({
      adminBase,
      isAdmin: access.isAdmin,
      csrfToken: csrfToken(config, tokenFor(request), 'video-write'),
      ...(current === undefined || current === null ? {} : formPageData(config, videos, current, await currentVideoSlugs())),
      values: data.fields,
      message: { kind: 'error', text: result.message }
    }))
  }

  app.post(newUrl, async (request, reply) => await writeVideo(request, reply, false))
  app.post(editUrl, async (request, reply) => await writeVideo(request, reply, true))

  const formMutation = async (
    request: FastifyRequest,
    reply: FastifyReply,
    operation: (body: Record<string, unknown>, access: VideoAccess) => Promise<VideoMutationResult>,
    returnToList = false
  ): Promise<unknown> => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) return videoOriginError(reply, adminBase)
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'video-mutate') &&
        !validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'video-write')) return videoCsrfError(reply, adminBase)
    const result = await operation(body, accessFor(user))
    const target = returnToList || stringValue(body.id) === '' ? listUrl : `${editUrl}?id=${encodeURIComponent(stringValue(body.id))}`
    return await reply.redirect(`${target}${target.includes('?') ? '&' : '?'}mutation=${result.status === 'ok' ? 'ok' : 'fail'}&message=${encodeURIComponent(result.message)}`, 303)
  }

  app.post(deleteUrl, async (request, reply) => await formMutation(request, reply, async (body, access) => await videos.delete(body.id, access), true))
  app.post(statusUrl, async (request, reply) => await formMutation(request, reply, async (body, access) => await videos.status(body.id, body.sources, access)))

  app.post(bulkUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    reply.type('application/json; charset=utf-8')
    if (!hasSameOrigin(request, config)) return reply.code(403).send(bulkRequestFailure(objectValue(request.body), 'The video request did not originate from this application.'))
    const user = await authenticatedUserJson(request, auth)
    if (user === null) return reply.code(401).send(bulkRequestFailure(objectValue(request.body), UNAUTHORIZED))
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'video-bulk')) {
      return reply.code(403).send(bulkRequestFailure(body, 'The video request could not be verified.'))
    }
    try {
      return reply.send(await bulk.add(body, accessFor(user), sourceContext(request), await currentVideoSlugs()))
    } catch {
      return reply.send(bulkRequestFailure(body, 'The video database is temporarily unavailable.'))
    }
  })

  app.post(checkUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    reply.type('application/json; charset=utf-8')
    if (!hasSameOrigin(request, config)) return reply.code(403).send({ status: 'fail', message: 'The video request did not originate from this application.', result: null })
    const user = await authenticatedUserJson(request, auth)
    if (user === null) return reply.code(401).send({ status: 'fail', message: UNAUTHORIZED, result: null })
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'video-mutate')) {
      return reply.code(403).send({ status: 'fail', message: 'The video request could not be verified.', result: null })
    }
    try {
      return reply.send(await checker.check(body.id, accessFor(user), {
        clientIp: request.ip,
        userAgent: request.headers['user-agent'] ?? '',
        language: request.headers['accept-language'] ?? ''
      }))
    } catch {
      return reply.code(503).send({ status: 'fail', message: 'The video database is temporarily unavailable.', result: null })
    }
  })
  app.post(dmcaUrl, async (request, reply) => await formMutation(request, reply, async (body, access) => await videos.dmca(body.id, body.takedown, access)))
  app.post(posterRemoveUrl, async (request, reply) => await formMutation(request, reply, async (body, access) => await videos.removePoster(body.id, access)))

  app.post(importUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) return videoOriginError(reply, adminBase)
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    try {
      const data = await videoImportRequestData(request, await importMaximumBytes(loadImportFileSize))
      if (!validCsrfToken(config, tokenFor(request), stringValue(data.fields.csrf), 'video-transfer')) return videoCsrfError(reply, adminBase)
      const file = data.files.find((item) => item.fieldname === 'importVideos')
      const result = file === undefined
        ? { status: 'fail' as const, message: VIDEO_IMPORT_FAIL }
        : await transfers.importCsv(file.content, accessFor(user), await currentVideoSlugs())
      return await reply.redirect(`${listUrl}?imported=${result.status === 'ok' ? '1' : '0'}&message=${encodeURIComponent(result.message)}`, 303)
    } catch {
      return await reply.redirect(`${listUrl}?imported=0&message=${encodeURIComponent(VIDEO_IMPORT_FAIL)}`, 303)
    }
  })

  app.post(exportUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) return videoOriginError(reply, adminBase)
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'video-transfer')) return videoCsrfError(reply, adminBase)
    const result = await transfers.exportCsv(body.ids ?? body['ids[]'], accessFor(user))
    if (result.status === 'fail') return await reply.redirect(`${listUrl}?exported=0&message=${encodeURIComponent(result.message)}`, 303)
    return sendCsv(reply, result.csv)
  })

  app.get(exportDownloadUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedUser(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const result = await transfers.exportCsv(objectValue(request.query).ids, accessFor(user))
    if (result.status === 'fail') return reply.code(404).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 404, result.message))
    return sendCsv(reply, result.csv)
  })

  const videoAjax = async (request: FastifyRequest, reply: FastifyReply, listOnly: boolean): Promise<unknown> => {
    applyAdminHeaders(reply, config)
    reply.type('application/json; charset=utf-8')
    let requestData: VideoRequestData
    try {
      requestData = await videoRequestData(request)
    } catch {
      return reply.send(legacyMutation({ status: 'fail', message: 'Invalid parameters' }))
    }
    const data = { ...objectValue(request.query), ...requestData.fields }
    let user: AuthUser | null
    try {
      user = await auth.authenticate(tokenFor(request) || stringValue(data.token), request.headers['user-agent'] ?? '')
    } catch {
      return reply.code(503).send(listOnly ? emptyDataTables(data.draw) : legacyMutation({ status: 'fail', message: 'The video database is temporarily unavailable.' }))
    }
    if (user === null) return reply.send(listOnly ? emptyDataTables(data.draw) : legacyMutation({ status: 'fail', message: UNAUTHORIZED }))
    const access = accessFor(user)
    if (listOnly) {
      try {
        return reply.send(await videos.list(data, access, await currentVideoSlugs()))
      } catch {
        return reply.code(503).send(emptyDataTables(data.draw))
      }
    }

    const action = stringValue(data.action)
    const mutations = new Set(['delete', 'deleteByHostnames', 'deleteSubtitle', 'dmcaTakedown', 'editSubtitle', 'removePoster', 'rename', 'renameMulti', 'updateStatus'])
    if (mutations.has(action)) {
      if (request.method !== 'POST') return reply.code(405).send(legacyMutation({ status: 'fail', message: 'Invalid parameters' }))
      if (!hasSameOrigin(request, config)) return reply.code(403).send(legacyMutation({ status: 'fail', message: 'The video request did not originate from this application.' }))
    }

    try {
      if (action === 'delete') return reply.send(legacyMutation(await videos.delete(data.id, access)))
      if (action === 'deleteByHostnames') return reply.send(legacyMutation(await videos.deleteByHostnames(data.hostnames ?? data['hostnames[]'], access)))
      if (action === 'rename') return reply.send(legacyMutation(await videos.rename(data.id, data.name, access)))
      if (action === 'renameMulti') return reply.send(legacyMutation(await videos.renameMany(serializedFields(data.data), access)))
      if (action === 'updateStatus') return reply.send(legacyMutation(await videos.status(data.id, data.sources, access)))
      if (action === 'dmcaTakedown') return reply.send(legacyMutation(await videos.dmca(data.id, data.takedown, access)))
      if (action === 'removePoster') return reply.send(legacyMutation(await videos.removePoster(data.id, access)))
      if (action === 'deleteSubtitle') return reply.send(legacyMutation(await videos.deleteSubtitle(data.id, access)))
      if (action === 'editSubtitle') {
        let link = data.editSubURL
        const file = requestData.files.find((item) => item.fieldname.replace(/\[\]$/u, '') === 'editSubFile')
        if (stringValue(data.editSubType) === 'file' && file !== undefined) {
          const uploaded = await subtitles.upload({ originalName: file.filename, content: file.content, language: data.editSubLang }, access)
          if (uploaded.status === 'fail') return reply.send(legacyMutation({ status: 'fail', message: 'The subtitle file failed to update' }))
          link = uploaded.data?.sub
        }
        return reply.send(legacyMutation(await videos.editSubtitle(data.editSubId, link, data.editSubLang, access)))
      }
      if (action === 'getAlternatives') {
        const alternatives = await videos.alternatives(data.id, access)
        return reply.send(alternatives === null ? legacyMutation({ status: 'fail', message: 'The video was not found' }) : legacyData(alternatives))
      }
      if (action === 'getSubtitles') {
        const video = await videos.get(data.id, access)
        const result = video?.subtitles.map((item) => Object.freeze({ name: item.language, url: item.link })) ?? []
        return reply.send(legacyData(result))
      }
      if (action === 'getServer') {
        const id = stringValue(data.id)
        let media: PlayerMediaQuery
        let ownerId = access.userId
        if (/^(?:0|[1-9]\d{0,19})$/u.test(id)) {
          const video = await videos.get(id, access)
          if (video === null) return reply.send(legacyMutation({ status: 'fail', message: 'The video was not found' }))
          media = Object.freeze({ source: 'db', id: video.id, uid: video.userId })
          ownerId = video.userId
        } else {
          const hosting = new Hosting(id)
          if (hosting.getHost() === '' || hosting.getID() === '') return reply.send(legacyMutation({ status: 'fail', message: 'The video was not found' }))
          media = Object.freeze({ host: hosting.getHost(), id: hosting.getID(), uid: access.userId })
        }
        const passwordToken = security.encryptURL(request.ip)
        const flags = `token=${encodeURIComponent(passwordToken)}&saved=true&useTitleAsSlug=${encodeURIComponent(stringValue(data.useTitleAsSlug) || 'false')}&uid=${encodeURIComponent(ownerId)}`
        const queryToken = security.encryptURL(`${buildPlayerQuery(media)}&${flags}`)
        const apiUrl = `${new URL('api/', config.baseUrl).href}?${queryToken}-,${security.encryptApiSalt()}`
        return reply.send(legacyData(apiUrl))
      }
      if (action === 'searchSubtitles') {
        const records = await subtitles.records({ draw: 0, start: 0, length: 10, 'search[value]': data.q, 'order[0][column]': 6, 'order[0][dir]': 'desc' }, access)
        return reply.send(records.data.map((item) => Object.freeze({ id: item.fileName, label: item.language, value: item.link })))
      }
      return reply.send(legacyMutation({ status: 'fail', message: 'Invalid parameters' }))
    } catch {
      return reply.code(503).send(legacyMutation({ status: 'fail', message: 'The video database is temporarily unavailable.' }))
    }
  }

  app.route({ method: ['GET', 'POST'], url: listAjaxUrl, handler: async (request, reply) => await videoAjax(request, reply, true) })
  app.route({ method: ['GET', 'POST'], url: ajaxUrl, handler: async (request, reply) => await videoAjax(request, reply, false) })

  app.post(publicAjaxUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    reply.type('application/json; charset=utf-8')
    const body = objectValue(request.body)
    if (stringValue(body.action) !== 'saveBulkProcess') return reply.send(bulkRequestFailure(body, 'Invalid parameters'))
    if (!hasSameOrigin(request, config)) return reply.code(403).send(bulkRequestFailure(body, 'The video request did not originate from this application.'))
    let user: AuthUser | null
    try {
      user = await auth.authenticate(tokenFor(request) || stringValue(body.token), request.headers['user-agent'] ?? '')
    } catch {
      return reply.send(bulkRequestFailure(body, 'The video database is temporarily unavailable.'))
    }
    if (user === null) return reply.send(bulkRequestFailure(body, UNAUTHORIZED))
    try {
      return reply.send(await bulk.add(body, accessFor(user), sourceContext(request), await currentVideoSlugs()))
    } catch {
      return reply.send(bulkRequestFailure(body, 'The video database is temporarily unavailable.'))
    }
  })

  app.post(importAjaxUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    reply.type('application/json; charset=utf-8')
    if (!hasSameOrigin(request, config)) return reply.code(403).send({ status: 'fail', message: VIDEO_IMPORT_FAIL, result: [] })
    const user = await authenticatedUserJson(request, auth)
    if (user === null) return reply.send({ status: 'fail', message: UNAUTHORIZED, result: [] })
    try {
      const data = await videoImportRequestData(request, await importMaximumBytes(loadImportFileSize))
      const file = data.files.find((item) => item.fieldname === 'importVideos')
      return reply.send(file === undefined
        ? { status: 'fail', message: VIDEO_IMPORT_FAIL, result: [] }
        : await transfers.importCsv(file.content, accessFor(user), await currentVideoSlugs()))
    } catch {
      return reply.send({ status: 'fail', message: VIDEO_IMPORT_FAIL, result: [] })
    }
  })

  app.post(exportAjaxUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    reply.type('application/json; charset=utf-8')
    if (!hasSameOrigin(request, config)) return reply.code(403).send({ status: 'fail', message: VIDEO_EXPORT_FAIL, result: null })
    const user = await authenticatedUserJson(request, auth)
    if (user === null) return reply.send({ status: 'fail', message: UNAUTHORIZED, result: null })
    const ids = stringValue(objectValue(request.body).ids)
    const result = await transfers.exportCsv(ids, accessFor(user))
    if (result.status === 'fail') return reply.send({ status: 'fail', message: result.message, result: null })
    const query = new URLSearchParams({ ids }).toString()
    return reply.send({ status: 'ok', message: VIDEO_EXPORT_SUCCESS, result: new URL(`${exportDownloadUrl}?${query}`, config.baseUrl).href })
  })
}

async function videoListPage(
  config: AppConfig,
  request: FastifyRequest,
  user: AuthUser,
  videos: VideoAdminService,
  loadSlugs: () => Promise<VideoLinkSlugs>,
  loadImportFileSize?: () => Promise<number>,
  message?: AdminMessage
): Promise<string> {
  const query = objectValue(request.query)
  const search = stringValue(query.q).slice(0, 254)
  const status = filterValue(query.status, 0, 2)
  const dmca = filterValue(query.dmca, 0, 1)
  const records = await videos.records({
    draw: 0,
    start: 0,
    length: 100,
    'search[value]': search,
    'order[0][column]': 10,
    'order[0][dir]': 'desc',
    status: status || 'null',
    dmca: dmca || 'null'
  }, accessFor(user), await loadSlugs())
  return renderAdminVideos({
    adminBase: `/${config.adminDirectory}`,
    videos: records.data,
    recordsTotal: records.recordsTotal,
    search,
    status,
    dmca,
    isAdmin: user.role === 0,
    mutationCsrfToken: csrfToken(config, tokenFor(request), 'video-mutate'),
    bulkCsrfToken: csrfToken(config, tokenFor(request), 'video-bulk'),
    transferCsrfToken: csrfToken(config, tokenFor(request), 'video-transfer'),
    importFileSizeKiB: await importFileSize(loadImportFileSize),
    ...(message === undefined ? {} : { message })
  })
}

async function videoFormPage(
  config: AppConfig,
  request: FastifyRequest,
  user: AuthUser,
  videos: VideoAdminService,
  video: StoredVideoDetail,
  loadSlugs: () => Promise<VideoLinkSlugs>,
  message?: AdminMessage,
  plugins?: Pick<PluginExtensionRuntime, 'executeHook'>
): Promise<string> {
  const hookData = await plugins?.executeHook('video.edit.load', Object.freeze({ video_id: video.id, video_data: video }), Object.freeze({ user: Object.freeze({ id: user.id, role: user.role }) })).catch(() => undefined)
  return renderAdminVideoForm({
    adminBase: `/${config.adminDirectory}`,
    isAdmin: user.role === 0,
    csrfToken: csrfToken(config, tokenFor(request), 'video-write'),
    ...formPageData(config, videos, video, await loadSlugs()),
    ...(hookData?.plugin_data !== undefined ? { pluginData: hookData.plugin_data } : {}),
    ...(message === undefined ? {} : { message })
  })
}

function formPageData(config: AppConfig, videos: VideoAdminService, video: StoredVideoDetail, slugs: VideoLinkSlugs): Readonly<{
  video: StoredVideoDetail
  mainUrl: string
  alternativeUrls: readonly string[]
  posterUrl: string
  embedUrl: string
  downloadUrl: string
  embedCode: string
}> {
  const embedUrl = new URL(`${slugs.embed}/${encodeURIComponent(video.slug)}`, config.baseUrl).href
  const downloadUrl = new URL(`${slugs.download}/${encodeURIComponent(video.slug)}`, config.baseUrl).href
  return Object.freeze({
    video,
    mainUrl: hostingUrl(video.host, video.hostId),
    alternativeUrls: Object.freeze(video.alternatives.map((item) => hostingUrl(item.host, item.hostId))),
    posterUrl: videos.posterUrl(video.poster),
    embedUrl,
    downloadUrl,
    embedCode: `<iframe title="${escapeHtmlAttribute(video.title)}" src="${escapeHtmlAttribute(embedUrl)}" loading="lazy" frameborder="0" width="640" height="320" allowfullscreen></iframe>`
  })
}

async function formSubmission(data: VideoRequestData, subtitles: SubtitleAdminService, access: VideoAccess): Promise<VideoFormSubmission> {
  const urls = fieldArray(data.fields, 'sub-url[]', 'sub-url')
  const languages = fieldArray(data.fields, 'lang-url[]', 'lang-url')
  const attached = urls.map((url, index) => Object.freeze({ url, language: languages[index] ?? 'Unknown CC' }))
  attached.push(...parseBulkSubtitleLines(data.fields.multiSubUrls))

  for (const file of data.files.filter((item) => ['multiSubFiles', 'sub-file'].includes(item.fieldname.replace(/\[\]$/u, '')))) {
    const uploaded = await subtitles.upload({ originalName: file.filename, content: file.content, language: 'Unknown CC' }, access)
    if (uploaded.status === 'fail' || uploaded.data?.sub === undefined) throw new Error(uploaded.message || 'The uploaded subtitle file failed to save')
    attached.push(Object.freeze({ url: uploaded.data.sub, language: uploaded.data.lang ?? 'Unknown CC' }))
  }
  const poster = data.files.find((item) => item.fieldname.replace(/\[\]$/u, '') === 'poster-file')
  const alternatives = [
    ...fieldArray(data.fields, 'altLinks[]', 'altLinks'),
    ...stringValue(data.fields.multiAltUrls).split(/\r?\n/u)
  ]
  return Object.freeze({
    title: data.fields.title,
    mainUrl: data.fields.host_id,
    slug: data.fields.slug,
    posterUrl: data.fields['poster-url'],
    alternatives: Object.freeze(alternatives),
    subtitles: Object.freeze(attached),
    ...(poster === undefined ? {} : { posterFile: Object.freeze({ originalName: poster.filename, content: poster.content }) })
  })
}

async function videoRequestData(request: FastifyRequest): Promise<VideoRequestData> {
  if (!request.isMultipart()) return Object.freeze({ fields: { ...objectValue(request.body) }, files: Object.freeze([]) })
  const fields: Record<string, unknown> = {}
  const files: UploadedPart[] = []
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (part.filename === '') {
        part.file.resume()
        continue
      }
      const content = await part.toBuffer()
      if (part.file.truncated) throw new Error('File limit exceeded')
      files.push(Object.freeze({ fieldname: part.fieldname, filename: part.filename, content }))
      continue
    }
    addField(fields, part.fieldname, part.value)
  }
  return Object.freeze({ fields, files: Object.freeze(files) })
}

function addField(fields: Record<string, unknown>, key: string, value: unknown): void {
  const current = fields[key]
  if (current === undefined) fields[key] = value
  else if (Array.isArray(current)) current.push(value)
  else fields[key] = [current, value]
}

function fieldArray(fields: Record<string, unknown>, primary: string, fallback: string): unknown[] {
  const value = fields[primary] ?? fields[fallback]
  return Array.isArray(value) ? value : value === undefined ? [] : [value]
}

function serializedFields(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, item] of new URLSearchParams(stringValue(value))) result[key] = item
  return result
}

function pageMessage(request: FastifyRequest): AdminMessage | undefined {
  const query = objectValue(request.query)
  if (stringValue(query.imported) === '1') return { kind: 'success', text: boundedMessage(query.message, 'The new video list has been successfully imported') }
  if (stringValue(query.imported) === '0') return { kind: 'error', text: boundedMessage(query.message, VIDEO_IMPORT_FAIL) }
  if (stringValue(query.exported) === '0') return { kind: 'error', text: boundedMessage(query.message, VIDEO_EXPORT_FAIL) }
  if (stringValue(query.mutation) === 'ok') return { kind: 'success', text: boundedMessage(query.message, 'The video has been successfully updated') }
  if (stringValue(query.mutation) === 'fail') return { kind: 'error', text: boundedMessage(query.message, 'The video failed to update') }
  return undefined
}

async function videoImportRequestData(request: FastifyRequest, maximumBytes: number): Promise<VideoRequestData> {
  if (!request.isMultipart()) throw new Error('CSV import must use multipart encoding')
  const fields: Record<string, unknown> = {}
  const files: UploadedPart[] = []
  for await (const part of request.parts({ limits: { fieldNameSize: 100, fieldSize: 100_000, fields: 10, files: 1, parts: 11, fileSize: maximumBytes } })) {
    if (part.type === 'field') {
      addField(fields, part.fieldname, part.value)
      continue
    }
    if (part.fieldname !== 'importVideos' || part.filename === '' || !part.filename.toLowerCase().endsWith('.csv')) {
      part.file.resume()
      continue
    }
    const content = await part.toBuffer()
    if (part.file.truncated || content.length >= maximumBytes) throw new Error('CSV import exceeds its configured limit')
    files.push(Object.freeze({ fieldname: part.fieldname, filename: part.filename, content }))
  }
  return Object.freeze({ fields, files: Object.freeze(files) })
}

async function importFileSize(loader?: () => Promise<number>): Promise<number> {
  try {
    const size = loader === undefined ? 1024 : await loader()
    return Number.isSafeInteger(size) && size > 0 ? size : 1024
  } catch {
    return 1024
  }
}

async function importMaximumBytes(loader?: () => Promise<number>): Promise<number> {
  const kibibytes = await importFileSize(loader)
  const bytes = kibibytes * 1024
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 1024 * 1024
}

async function authenticatedUserJson(request: FastifyRequest, auth: AuthService): Promise<AuthUser | null> {
  try {
    const token = tokenFor(request) || stringValue(objectValue(request.body).token)
    return await auth.authenticate(token, request.headers['user-agent'] ?? '')
  } catch {
    return null
  }
}

function sendCsv(reply: FastifyReply, csv: string): FastifyReply {
  const timestamp = new Date().toISOString().replaceAll(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
  return reply
    .header('content-disposition', `attachment; filename="gplayer-videos-${timestamp}.csv"`)
    .header('x-content-type-options', 'nosniff')
    .type('text/csv; charset=utf-8')
    .send(csv)
}

function editPageMessage(request: FastifyRequest): AdminMessage | undefined {
  const query = objectValue(request.query)
  if (stringValue(query.created) === '1') return { kind: 'success', text: 'The video has been successfully created' }
  if (stringValue(query.updated) === '1') return { kind: 'success', text: 'The video has been successfully updated' }
  return pageMessage(request)
}

function boundedMessage(value: unknown, fallback: string): string {
  const normalized = stringValue(value).slice(0, 255)
  return normalized || fallback
}

function legacyMutation(result: VideoMutationResult): Readonly<Record<string, unknown>> {
  return Object.freeze({ status: result.status, message: result.message, result: result.id ?? null })
}

function legacyData(result: unknown): Readonly<Record<string, unknown>> {
  return Object.freeze({ status: 'ok', message: 'OK', result })
}

function sourceContext(request: FastifyRequest): Readonly<{ clientIp: string; userAgent: string; language: string }> {
  return Object.freeze({
    clientIp: request.ip,
    userAgent: request.headers['user-agent'] ?? '',
    language: request.headers['accept-language'] ?? ''
  })
}

function bulkRequestFailure(input: Record<string, unknown>, message: string): Readonly<Record<string, unknown>> {
  const total = strictBoundedInteger(input.total, 1, VIDEO_BULK_MAX_ITEMS)
  const offset = strictBoundedInteger(input.offset, 0, Math.max(0, (total ?? 0) - 1))
  return Object.freeze({
    status: 'fail',
    message,
    result: Object.freeze(total === null || offset === null
      ? { offset: 0, next: 0, total: 0 }
      : { offset, next: offset + 1, total })
  })
}

function strictBoundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  const normalized = stringValue(value)
  if (!/^(?:0|[1-9]\d*)$/u.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null
}

function emptyDataTables(draw: unknown): Readonly<{ draw: number; data: readonly never[]; recordsTotal: 0; recordsFiltered: 0 }> {
  const parsed = Number.parseInt(stringValue(draw), 10)
  return Object.freeze({ draw: Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0, data: Object.freeze([]), recordsTotal: 0, recordsFiltered: 0 })
}

function hostingUrl(host: string, hostId: string): string {
  return new Hosting().setHost(host).setID(hostId).getDownloadLink()
}

function accessFor(user: AuthUser): VideoAccess {
  return Object.freeze({ userId: String(user.id), isAdmin: user.role === 0 })
}

function filterValue(value: unknown, minimum: number, maximum: number): string {
  const normalized = stringValue(value)
  const parsed = Number(normalized)
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? normalized : ''
}

async function redirectWithQuery(request: FastifyRequest, reply: FastifyReply, target: string): Promise<FastifyReply> {
  const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''
  return await reply.redirect(`${target}${query}`, 308)
}

function videoOriginError(reply: FastifyReply, adminBase: string): FastifyReply {
  return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The video request did not originate from this application.'))
}

function videoCsrfError(reply: FastifyReply, adminBase: string): FastifyReply {
  return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The video request could not be verified.'))
}

function applyAdminHeaders(reply: FastifyReply, config: AppConfig): void {
  reply.headers({
    'cache-control': 'no-store', pragma: 'no-cache', expires: '0', 'content-security-policy': ADMIN_CSP,
    'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
    'x-robots-tag': 'noindex, nofollow', 'access-control-allow-origin': config.baseUrl.origin, vary: 'Origin'
  })
}

async function authenticatedUser(request: FastifyRequest, reply: FastifyReply, adminBase: string, loginUrl: string, auth: AuthService): Promise<AuthUser | null> {
  try {
    const user = await auth.authenticate(tokenFor(request), request.headers['user-agent'] ?? '')
    if (user === null) await reply.redirect(loginUrl, 302)
    return user
  } catch {
    reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The authentication database is temporarily unavailable.'))
    return null
  }
}

function tokenFor(request: FastifyRequest): string {
  return authTokenFromRequest({ authorization: request.headers.authorization, cookie: request.cookies[AUTH_COOKIE_NAME] })
}

function csrfToken(config: AppConfig, token: string, scope: string): string {
  if (token === '') return ''
  return createHmac('sha256', config.secureSalt).update(`${scope}\0${token}`).digest('base64url')
}

function validCsrfToken(config: AppConfig, token: string, candidate: string, scope: string): boolean {
  const expected = csrfToken(config, token, scope)
  if (expected === '' || candidate.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))
}

function hasSameOrigin(request: FastifyRequest, config: AppConfig): boolean {
  const source = request.headers.origin ?? request.headers.referer
  if (source === undefined) return true
  try {
    return new URL(source).origin === config.baseUrl.origin
  } catch {
    return false
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 100_000).trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
