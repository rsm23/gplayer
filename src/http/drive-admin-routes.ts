import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AUTH_COOKIE_NAME, AuthService, authTokenFromRequest, type AuthUser } from '../auth/auth-service.js'
import type { AppConfig } from '../config.js'
import type { DriveAccountAdminService, DriveAccountMutationResult } from '../drive/drive-account-admin-service.js'
import type { DriveAdminService, DriveMutationResult } from '../drive/drive-admin-service.js'
import { renderAdminDriveAccountForm, renderAdminDriveAccounts, renderAdminDriveBackups, renderAdminDriveFiles, renderAdminDriveQueue, renderAdminError, type AdminMessage } from '../player/admin-page.js'

const ADMIN_CSP = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
const UNAUTHORIZED = 'You are not authorized to access this feature'
const DATABASE_UNAVAILABLE = 'The google drive account database is temporarily unavailable.'

export async function registerDriveAdminRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  accounts: DriveAccountAdminService,
  drive: DriveAdminService
): Promise<void> {
  const adminBase = `/${config.adminDirectory}`
  const loginUrl = `${adminBase}/login/`
  const listUrl = `${adminBase}/gdrive/`
  const newUrl = `${adminBase}/gdrive/new/`
  const editUrl = `${adminBase}/gdrive/edit/`
  const deleteUrl = `${adminBase}/gdrive/delete/`
  const flagUrl = `${adminBase}/gdrive/flag/`
  const ajaxUrls = [`${adminBase}/ajax/gdrive-account/`, `${adminBase}/ajax/gdrive-accounts/`] as const
  const listAjaxUrls = [`${adminBase}/ajax/gdrive-account-list/`, `${adminBase}/ajax/gdrive-accounts-list/`] as const
  const filesUrl = `${adminBase}/gdrive/files/`
  const fileActionUrl = `${adminBase}/gdrive/files/action/`
  const backupsUrl = `${adminBase}/gdrive/backup-files/`
  const backupDeleteUrl = `${adminBase}/gdrive/backup-files/delete/`
  const queueUrl = `${adminBase}/gdrive/backup-queue/`
  const queueActionUrl = `${adminBase}/gdrive/backup-queue/action/`

  app.get(`${adminBase}/gdrive`, async (_request, reply) => await reply.redirect(listUrl, 308))
  app.get(`${adminBase}/gdrive/new`, async (_request, reply) => await reply.redirect(newUrl, 308))
  app.get(`${adminBase}/gdrive/edit`, async (request, reply) => {
    const id = stringValue(objectValue(request.query).id)
    return await reply.redirect(`${editUrl}${id === '' ? '' : `?id=${encodeURIComponent(id)}`}`, 308)
  })

  app.get(listUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const query = objectValue(request.query)
    const search = stringValue(query.q).slice(0, 100)
    try {
      const page = await accounts.records({
        draw: 0,
        start: 0,
        length: 100,
        'search[value]': search,
        'order[0][column]': 5,
        'order[0][dir]': 'desc'
      })
      const message = pageMessage(query)
      return reply.type('text/html; charset=utf-8').send(renderAdminDriveAccounts({
        adminBase,
        accounts: page.data,
        recordsTotal: page.recordsTotal,
        search,
        mutationCsrfToken: csrfToken(config, tokenFor(request), 'drive-account-mutate'),
        ...(message === undefined ? {} : { message })
      }))
    } catch {
      return databaseError(reply, adminBase)
    }
  })

  app.get(newUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    return reply.type('text/html; charset=utf-8').send(renderAdminDriveAccountForm({
      adminBase,
      csrfToken: csrfToken(config, tokenFor(request), 'drive-account-write')
    }))
  })

  app.get(editUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    try {
      const account = await accounts.get(objectValue(request.query).id)
      if (account === null) return reply.code(404).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 404, 'The requested google drive account was not found.'))
      const message = pageMessage(objectValue(request.query))
      return reply.type('text/html; charset=utf-8').send(renderAdminDriveAccountForm({
        adminBase,
        account,
        csrfToken: csrfToken(config, tokenFor(request), 'drive-account-write'),
        ...(message === undefined ? {} : { message })
      }))
    } catch {
      return databaseError(reply, adminBase)
    }
  })

  const writeAccount = async (request: FastifyRequest, reply: FastifyReply, edit: boolean): Promise<unknown> => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) return originError(reply, adminBase)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'drive-account-write')) return csrfError(reply, adminBase)
    try {
      const existing = edit ? await accounts.get(body.id) : undefined
      if (edit && existing === null) return reply.code(404).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 404, 'The requested google drive account was not found.'))
      const result = edit ? await accounts.update(body.id, body) : await accounts.create(body)
      if (result.status === 'ok') return await reply.redirect(`${editUrl}?id=${encodeURIComponent(result.id)}&${edit ? 'updated' : 'created'}=1`, 303)
      return reply.code(400).type('text/html; charset=utf-8').send(renderAdminDriveAccountForm({
        adminBase,
        ...(existing === undefined || existing === null ? {} : { account: existing }),
        csrfToken: csrfToken(config, tokenFor(request), 'drive-account-write'),
        values: formValues(body),
        message: { kind: 'error', text: result.message }
      }))
    } catch {
      return databaseError(reply, adminBase)
    }
  }

  app.post(newUrl, async (request, reply) => await writeAccount(request, reply, false))
  app.post(editUrl, async (request, reply) => await writeAccount(request, reply, true))

  app.post(deleteUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) return originError(reply, adminBase)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'drive-account-mutate')) return csrfError(reply, adminBase)
    try {
      const result = await accounts.delete(body.id)
      return await reply.redirect(`${listUrl}?deleted=${result.status === 'ok' ? '1' : '0'}`, 303)
    } catch {
      return databaseError(reply, adminBase)
    }
  })

  app.post(flagUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) return originError(reply, adminBase)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'drive-account-mutate')) return csrfError(reply, adminBase)
    const column = stringValue(body.column)
    if (column !== 'status' && column !== 'bypass') return csrfError(reply, adminBase)
    try {
      const result = await accounts.setFlag(body.id, column, body.status)
      return await reply.redirect(`${listUrl}?flag=${result.status === 'ok' ? '1' : '0'}`, 303)
    } catch {
      return databaseError(reply, adminBase)
    }
  })

  const ajax = async (request: FastifyRequest, reply: FastifyReply, listOnly: boolean): Promise<unknown> => {
    applyAdminHeaders(reply, config)
    reply.type('application/json; charset=utf-8')
    const data = { ...objectValue(request.query), ...objectValue(request.body) }
    let user: AuthUser | null
    try {
      user = await auth.authenticate(tokenFor(request) || stringValue(data.token), request.headers['user-agent'] ?? '')
    } catch {
      return reply.code(503).send(listOnly ? emptyDataTables(data.draw) : legacyMutation({ status: 'invalid', message: DATABASE_UNAVAILABLE }))
    }
    const action = listOnly ? 'list' : stringValue(data.action)
    if (user?.role !== 0 || user.status !== 1) return reply.send(action === 'list' ? emptyDataTables(data.draw) : legacyMutation({ status: 'invalid', message: UNAUTHORIZED }))
    if (action === 'list') {
      try {
        return reply.send(await accounts.list(data))
      } catch {
        return reply.code(503).send(emptyDataTables(data.draw))
      }
    }
    if (!['delete', 'updateStatus', 'updateBypass'].includes(action)) return reply.send(legacyMutation({ status: 'invalid', message: 'Invalid parameters' }))
    if (request.method !== 'POST') return reply.code(405).send(legacyMutation({ status: 'invalid', message: 'Invalid parameters' }))
    if (!hasSameOrigin(request, config)) return reply.code(403).send(legacyMutation({ status: 'invalid', message: 'The google drive account request did not originate from this application.' }))
    try {
      const result = action === 'delete'
        ? await accounts.delete(data.id)
        : await accounts.setFlag(data.id, action === 'updateBypass' ? 'bypass' : 'status', data.status)
      return reply.send(legacyMutation(result))
    } catch {
      return reply.code(503).send(legacyMutation({ status: 'invalid', message: DATABASE_UNAVAILABLE }))
    }
  }

  for (const url of listAjaxUrls) {
    app.route({ method: ['GET', 'POST'], url, handler: async (request, reply) => await ajax(request, reply, true) })
  }
  for (const url of ajaxUrls) {
    app.route({ method: ['GET', 'POST'], url, handler: async (request, reply) => await ajax(request, reply, false) })
  }

  app.get(`${adminBase}/gdrive/files`, async (_request, reply) => await reply.redirect(filesUrl, 308))
  app.get(`${adminBase}/gdrive/backup-files`, async (_request, reply) => await reply.redirect(backupsUrl, 308))
  app.get(`${adminBase}/gdrive/backup-queue`, async (_request, reply) => await reply.redirect(queueUrl, 308))

  app.get(filesUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const query = objectValue(request.query)
    const email = stringValue(query.email).slice(0, 100)
    const folderId = stringValue(query.folder_id).slice(0, 50) || 'root'
    const pageToken = stringValue(query.token).slice(0, 2_048)
    const search = stringValue(query.q).slice(0, 255)
    try {
      const [emails, page, sharedDrives] = await Promise.all([
        drive.accountEmails(),
        drive.files({
          draw: 0,
          start: 0,
          length: 100,
          email,
          folder_id: folderId,
          token: pageToken,
          private: query.private,
          onlyFolder: query.onlyFolder,
          'search[value]': search,
          'order[0][column]': 4,
          'order[0][dir]': 'desc'
        }),
        email === '' ? Promise.resolve([]) : drive.sharedDriveRecords(email)
      ])
      const message = driveNotice(query)
      return reply.type('text/html; charset=utf-8').send(renderAdminDriveFiles({
        adminBase,
        accounts: emails,
        sharedDrives,
        files: page.data,
        email,
        folderId,
        search,
        privateOnly: booleanValue(query.private),
        folderOnly: booleanValue(query.onlyFolder),
        nextPageToken: page.token,
        duplicatePageToken: stringValue(query.duplicate_token).slice(0, 2_048),
        csrfToken: csrfToken(config, tokenFor(request), 'drive-file-mutate'),
        ...(message === undefined ? {} : { message })
      }))
    } catch {
      return databaseError(reply, adminBase)
    }
  })

  app.get(backupsUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const query = objectValue(request.query)
    const search = stringValue(query.q).slice(0, 255)
    try {
      const page = await drive.backups({ draw: 0, start: 0, length: 100, 'search[value]': search, 'order[0][column]': 4, 'order[0][dir]': 'desc' })
      const message = driveNotice(query)
      return reply.type('text/html; charset=utf-8').send(renderAdminDriveBackups({ adminBase, backups: page.data, recordsTotal: page.recordsTotal, search, csrfToken: csrfToken(config, tokenFor(request), 'drive-backup-mutate'), ...(message === undefined ? {} : { message }) }))
    } catch {
      return databaseError(reply, adminBase)
    }
  })

  app.get(queueUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const query = objectValue(request.query)
    const search = stringValue(query.q).slice(0, 255)
    try {
      const page = await drive.queue({ draw: 0, start: 0, length: 100, 'search[value]': search, 'order[0][column]': 0, 'order[0][dir]': 'desc' })
      const message = driveNotice(query)
      return reply.type('text/html; charset=utf-8').send(renderAdminDriveQueue({ adminBase, queue: page.data, recordsTotal: page.recordsTotal, search, csrfToken: csrfToken(config, tokenFor(request), 'drive-queue-mutate'), ...(message === undefined ? {} : { message }) }))
    } catch {
      return databaseError(reply, adminBase)
    }
  })

  app.post(fileActionUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) return originError(reply, adminBase)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'drive-file-mutate')) return csrfError(reply, adminBase)
    const action = stringValue(body.action)
    try {
      const result = await driveFileAction(drive, action, body, user)
      const email = stringValue(body.email).slice(0, 100)
      const redirect = new URLSearchParams()
      if (email !== '') redirect.set('email', email)
      const folderId = stringValue(body.folder_id).slice(0, 50)
      if (folderId !== '' && folderId !== 'root') redirect.set('folder_id', folderId)
      redirect.set('notice', action)
      redirect.set('success', result.status === 'ok' ? '1' : '0')
      const duplicateToken = action === 'removeDuplicateFiles' ? mutationNextPageToken(result) : ''
      if (duplicateToken !== '') redirect.set('duplicate_token', duplicateToken)
      return await reply.redirect(`${filesUrl}?${redirect.toString()}`, 303)
    } catch {
      return databaseError(reply, adminBase)
    }
  })

  app.post(backupDeleteUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) return originError(reply, adminBase)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'drive-backup-mutate')) return csrfError(reply, adminBase)
    try {
      const result = await drive.deleteBackup(body.id)
      return await reply.redirect(`${backupsUrl}?notice=deleteBackup&success=${result.status === 'ok' ? '1' : '0'}`, 303)
    } catch {
      return databaseError(reply, adminBase)
    }
  })

  app.post(queueActionUrl, async (request, reply) => {
    applyAdminHeaders(reply, config)
    if (!hasSameOrigin(request, config)) return originError(reply, adminBase)
    const user = await authenticatedAdmin(request, reply, adminBase, loginUrl, auth)
    if (user === null || reply.sent) return
    const body = objectValue(request.body)
    if (!validCsrfToken(config, tokenFor(request), stringValue(body.csrf), 'drive-queue-mutate')) return csrfError(reply, adminBase)
    const action = stringValue(body.action)
    try {
      const result = action === 'copy' ? await drive.copyQueueFile(body.id) : action === 'delete' ? await drive.deleteQueue(body.id) : { status: 'invalid' as const, message: 'Invalid parameters' }
      return await reply.redirect(`${queueUrl}?notice=${encodeURIComponent(action === 'delete' ? 'deleteQueue' : action)}&success=${result.status === 'ok' ? '1' : '0'}`, 303)
    } catch {
      return databaseError(reply, adminBase)
    }
  })

  const driveAjax = async (request: FastifyRequest, reply: FastifyReply, controller: 'file' | 'mirror' | 'queue', listOnly = false): Promise<unknown> => {
    applyAdminHeaders(reply, config)
    reply.type('application/json; charset=utf-8')
    const data = { ...objectValue(request.query), ...objectValue(request.body) }
    let user: AuthUser | null
    try {
      user = await auth.authenticate(tokenFor(request) || stringValue(data.token), request.headers['user-agent'] ?? '')
    } catch {
      return reply.code(503).send(emptyDataTables(data.draw))
    }
    const action = listOnly ? 'list' : stringValue(data.action)
    if (user?.role !== 0 || user.status !== 1) return reply.send(action === 'list' ? emptyDataTables(data.draw) : legacyDriveMutation({ status: 'invalid', message: UNAUTHORIZED }))
    if (action === 'list') {
      try {
        if (controller === 'file') return reply.send(await drive.files(data))
        if (controller === 'mirror') return reply.send(await drive.backups(data))
        return reply.send(await drive.queue(data))
      } catch {
        return reply.code(503).send(emptyDataTables(data.draw))
      }
    }
    if (controller === 'file' && action === 'getSharedDrives') {
      try {
        return reply.send(legacyDriveMutation(await drive.sharedDrives(data.email)))
      } catch {
        return reply.code(503).send(legacyDriveMutation({ status: 'invalid', message: DATABASE_UNAVAILABLE }))
      }
    }
    const allowed = controller === 'file'
      ? ['createNewFolder', 'delete', 'deleteMirror', 'gdriveImport', 'removeDuplicateFiles', 'renameFileFolder', 'updateStatus']
      : controller === 'mirror' ? ['delete'] : ['copy', 'delete']
    if (!allowed.includes(action)) return reply.send(legacyDriveMutation({ status: 'invalid', message: 'Invalid parameters' }))
    if (request.method !== 'POST') return reply.code(405).send(legacyDriveMutation({ status: 'invalid', message: 'Invalid parameters' }))
    if (!hasSameOrigin(request, config)) return reply.code(403).send(legacyDriveMutation({ status: 'invalid', message: 'The google drive request did not originate from this application.' }))
    try {
      const result = controller === 'file'
        ? await driveFileAction(drive, action, data, user)
        : controller === 'mirror'
          ? await drive.deleteBackup(data.id)
          : action === 'copy' ? await drive.copyQueueFile(data.id) : await drive.deleteQueue(data.id)
      return reply.send(legacyDriveMutation(result))
    } catch {
      return reply.code(503).send(legacyDriveMutation({ status: 'invalid', message: DATABASE_UNAVAILABLE }))
    }
  }

  const controllerRoutes = [
    ['file', `${adminBase}/ajax/gdrive-file/`],
    ['file', `${adminBase}/ajax/gdrive-files/`],
    ['mirror', `${adminBase}/ajax/gdrive-mirror/`],
    ['queue', `${adminBase}/ajax/gdrive-queue/`]
  ] as const
  for (const [controller, url] of controllerRoutes) app.route({ method: ['GET', 'POST'], url, handler: async (request, reply) => await driveAjax(request, reply, controller) })
  for (const [controller, url] of [
    ['file', `${adminBase}/ajax/gdrive-file-list/`],
    ['mirror', `${adminBase}/ajax/gdrive-mirror-list/`],
    ['queue', `${adminBase}/ajax/gdrive-queue-list/`]
  ] as const) app.route({ method: ['GET', 'POST'], url, handler: async (request, reply) => await driveAjax(request, reply, controller, true) })
}

function applyAdminHeaders(reply: FastifyReply, config: AppConfig): void {
  reply.headers({
    'cache-control': 'no-store',
    pragma: 'no-cache',
    expires: '0',
    'content-security-policy': ADMIN_CSP,
    'referrer-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'x-robots-tag': 'noindex, nofollow',
    'access-control-allow-origin': config.baseUrl.origin,
    vary: 'Origin'
  })
}

async function authenticatedAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  adminBase: string,
  loginUrl: string,
  auth: AuthService
): Promise<AuthUser | null> {
  try {
    const user = await auth.authenticate(tokenFor(request), request.headers['user-agent'] ?? '')
    if (user === null) await reply.redirect(loginUrl, 302)
    else if (user.role !== 0 || user.status !== 1) await reply.redirect(`${adminBase}/403/`, 302)
    return user
  } catch {
    reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, 'The authentication database is temporarily unavailable.'))
    return null
  }
}

function pageMessage(query: Record<string, unknown>): AdminMessage | undefined {
  if (stringValue(query.created) === '1') return { kind: 'success', text: 'The google drive account has been successfully saved' }
  if (stringValue(query.updated) === '1') return { kind: 'success', text: 'The google drive account has been successfully updated' }
  if (stringValue(query.deleted) === '1') return { kind: 'success', text: 'The account has been deleted successfully' }
  if (stringValue(query.deleted) === '0') return { kind: 'error', text: 'The account failed to delete' }
  if (stringValue(query.flag) === '1') return { kind: 'success', text: 'The account status has been successfully updated' }
  if (stringValue(query.flag) === '0') return { kind: 'error', text: 'The account status failed to update' }
  return undefined
}

async function driveFileAction(drive: DriveAdminService, action: string, data: Record<string, unknown>, user: AuthUser): Promise<DriveMutationResult> {
  if (action === 'createNewFolder') return await drive.createFolder(data)
  if (action === 'delete') return await drive.deleteFile(data)
  if (action === 'deleteMirror') return await drive.deleteMirrorRecord(data.id)
  if (action === 'gdriveImport') return await drive.importFile(data, { userId: String(user.id), isAdmin: true })
  if (action === 'removeDuplicateFiles') return await drive.removeDuplicates(data)
  if (action === 'renameFileFolder') return await drive.rename(data)
  if (action === 'updateStatus') return await drive.setPublic(data)
  return { status: 'invalid', message: 'Invalid parameters' }
}

function driveNotice(query: Record<string, unknown>): AdminMessage | undefined {
  const action = stringValue(query.notice)
  const success = stringValue(query.success) === '1'
  const messages: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
    createNewFolder: ['The new file/folder has been created successfully', 'The new file/folder failed to create'],
    delete: ['The file/folder has been successfully deleted', 'The file/folder failed to delete'],
    deleteMirror: ['The mirror file has been successfully deleted', 'The mirror file failed to delete'],
    gdriveImport: ['The file has been successfully imported', 'The file failed to import'],
    removeDuplicateFiles: ['Duplicate files have been successfully removed', 'Duplicate files failed to remove'],
    renameFileFolder: ['The file/folder has been successfully updated', 'The file/folder failed to update'],
    updateStatus: ['The file/folder has been successfully updated', 'The file/folder failed to update'],
    deleteBackup: ['The backup file has been successfully deleted', 'The backup file failed to delete'],
    copy: ['The queued file has been copied successfully', 'Cannot copy the file! Try again later'],
    deleteQueue: ['The backup queue has been successfully deleted', 'The backup queue failed to delete']
  })
  const selected = messages[action]
  return selected === undefined ? undefined : { kind: success ? 'success' : 'error', text: selected[success ? 0 : 1] ?? '' }
}

function formValues(body: Record<string, unknown>): Readonly<Record<string, string>> {
  return Object.freeze({
    email: stringValue(body.email).slice(0, 100),
    bypass: stringValue(body.bypass).slice(0, 1),
    status: stringValue(body.status).slice(0, 1)
  })
}

function legacyMutation(result: DriveAccountMutationResult): Readonly<{ status: 'ok' | 'fail'; message: string; result: null }> {
  return Object.freeze({ status: result.status === 'ok' ? 'ok' : 'fail', message: result.message, result: null })
}

function legacyDriveMutation(result: DriveMutationResult): Readonly<{ status: 'ok' | 'fail'; message: string; result: unknown }> {
  return Object.freeze({ status: result.status === 'ok' ? 'ok' : 'fail', message: result.message, result: result.status === 'ok' && 'result' in result ? result.result ?? null : null })
}

function mutationNextPageToken(result: DriveMutationResult): string {
  if (result.status !== 'ok' || !('result' in result)) return ''
  return stringValue(objectValue(result.result).nextPageToken).slice(0, 2_048)
}

function emptyDataTables(draw: unknown): Readonly<{ draw: number; data: readonly never[]; recordsTotal: 0; recordsFiltered: 0 }> {
  const parsed = Number.parseInt(stringValue(draw), 10)
  return Object.freeze({ draw: Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0, data: Object.freeze([]), recordsTotal: 0, recordsFiltered: 0 })
}

function originError(reply: FastifyReply, adminBase: string): FastifyReply {
  return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The google drive account request did not originate from this application.'))
}

function csrfError(reply: FastifyReply, adminBase: string): FastifyReply {
  return reply.code(403).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 403, 'The google drive account request could not be verified.'))
}

function databaseError(reply: FastifyReply, adminBase: string): FastifyReply {
  return reply.code(503).type('text/html; charset=utf-8').send(renderAdminError(adminBase, 503, DATABASE_UNAVAILABLE))
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
  const scalar = Array.isArray(value) ? value.at(-1) : value
  return typeof scalar === 'string' || typeof scalar === 'number' ? String(scalar).trim().slice(0, 1_024) : ''
}

function booleanValue(value: unknown): boolean {
  const scalar = Array.isArray(value) ? value.at(-1) : value
  return scalar === true || scalar === 1 || scalar === '1' || scalar === 'true' || scalar === 'on'
}
