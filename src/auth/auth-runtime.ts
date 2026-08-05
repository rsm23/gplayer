import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.js'
import { Database } from '../database/database.js'
import { AuthService, type AuthStore } from './auth-service.js'
import { MySqlAuthStore } from './mysql-auth-store.js'
import { MySqlSessionAdminStore } from './mysql-session-admin-store.js'
import { MySqlUserAdminStore } from './mysql-user-admin-store.js'
import { SessionAdminService, type SessionAdminStore } from './session-admin-service.js'
import { UserAdminService, type UserAdminStore } from './user-admin-service.js'
import { MySqlSettingsAdminStore } from '../settings/mysql-settings-admin-store.js'
import { SettingsAdminService, type SettingsAdminStore } from '../settings/settings-admin-service.js'
import { MySqlSubtitleAdminStore } from '../subtitles/mysql-subtitle-admin-store.js'
import type { SubtitleAdminStore } from '../subtitles/subtitle-admin-service.js'
import { MySqlVideoAdminStore } from '../videos/mysql-video-admin-store.js'
import type { VideoAdminStore } from '../videos/video-admin-service.js'

export type AuthRuntime = Readonly<{
  auth: AuthService
  sessions: SessionAdminService
  users: UserAdminService
  settings: SettingsAdminService
  subtitleStore: SubtitleAdminStore
  videoStore: VideoAdminStore
}>

export function createAuthRuntime(app: FastifyInstance, config: AppConfig): AuthRuntime {
  let database: Database | undefined
  let authStore: MySqlAuthStore | undefined
  let sessionStore: MySqlSessionAdminStore | undefined
  let userStore: MySqlUserAdminStore | undefined
  let settingsStore: MySqlSettingsAdminStore | undefined
  let subtitleStore: MySqlSubtitleAdminStore | undefined
  let videoStore: MySqlVideoAdminStore | undefined

  const currentDatabase = (): Database => {
    database ??= new Database(config.database)
    return database
  }
  const currentAuthStore = (): MySqlAuthStore => {
    authStore ??= new MySqlAuthStore(currentDatabase())
    return authStore
  }
  const currentSessionStore = (): MySqlSessionAdminStore => {
    sessionStore ??= new MySqlSessionAdminStore(currentDatabase())
    return sessionStore
  }
  const currentUserStore = (): MySqlUserAdminStore => {
    userStore ??= new MySqlUserAdminStore(currentDatabase())
    return userStore
  }
  const currentSettingsStore = (): MySqlSettingsAdminStore => {
    settingsStore ??= new MySqlSettingsAdminStore(currentDatabase())
    return settingsStore
  }
  const currentSubtitleStore = (): MySqlSubtitleAdminStore => {
    subtitleStore ??= new MySqlSubtitleAdminStore(currentDatabase())
    return subtitleStore
  }
  const currentVideoStore = (): MySqlVideoAdminStore => {
    videoStore ??= new MySqlVideoAdminStore(currentDatabase())
    return videoStore
  }

  const lazyStore: AuthStore = {
    findUserByIdentifier: async (identifier) => await currentAuthStore().findUserByIdentifier(identifier),
    findActiveSession: async (token, userAgent, now) => await currentAuthStore().findActiveSession(token, userAgent, now),
    createSession: async (session) => await currentAuthStore().createSession(session),
    recordFailedLogin: async (session) => await currentAuthStore().recordFailedLogin(session),
    revokeSession: async (token) => await currentAuthStore().revokeSession(token)
  }
  const lazySessionStore: SessionAdminStore = {
    listSessions: async (query) => await currentSessionStore().listSessions(query),
    deleteSession: async (id) => await currentSessionStore().deleteSession(id)
  }
  const lazyUserStore: UserAdminStore = {
    listUsers: async (query) => await currentUserStore().listUsers(query),
    getUser: async (id) => await currentUserStore().getUser(id),
    findConflict: async (username, email, excludeId) => await currentUserStore().findConflict(username, email, excludeId),
    createUser: async (user) => await currentUserStore().createUser(user),
    updateUser: async (id, user) => await currentUserStore().updateUser(id, user),
    updateEmail: async (id, email, updated) => await currentUserStore().updateEmail(id, email, updated),
    updateUsername: async (id, username, updated) => await currentUserStore().updateUsername(id, username, updated),
    deleteUser: async (id) => await currentUserStore().deleteUser(id)
  }
  const lazySettingsStore: SettingsAdminStore = {
    getAll: async () => await currentSettingsStore().getAll(),
    upsertMany: async (entries) => await currentSettingsStore().upsertMany(entries),
    deleteAll: async () => await currentSettingsStore().deleteAll()
  }
  const lazySubtitleStore: SubtitleAdminStore = {
    listSubtitles: async (query, access) => await currentSubtitleStore().listSubtitles(query, access),
    getSubtitle: async (id, access) => await currentSubtitleStore().getSubtitle(id, access),
    insertSubtitle: async (value) => await currentSubtitleStore().insertSubtitle(value),
    deleteSubtitle: async (id, access, links) => await currentSubtitleStore().deleteSubtitle(id, access, links),
    renameSubtitle: async (id, access, fileName, oldSuffix, link, updated) => await currentSubtitleStore().renameSubtitle(id, access, fileName, oldSuffix, link, updated),
    listSubtitleHosts: async () => await currentSubtitleStore().listSubtitleHosts(),
    migrateSubtitleHost: async (oldHost, newHost, updated) => await currentSubtitleStore().migrateSubtitleHost(oldHost, newHost, updated)
  }
  const lazyVideoStore: VideoAdminStore = {
    listVideos: async (query, access) => await currentVideoStore().listVideos(query, access),
    getVideo: async (id, access) => await currentVideoStore().getVideo(id, access),
    getPublicVideo: async (idOrSlug) => await currentVideoStore().getPublicVideo(idOrSlug),
    slugExists: async (slug, excludeId) => await currentVideoStore().slugExists(slug, excludeId),
    createVideo: async (value) => await currentVideoStore().createVideo(value),
    updateVideo: async (id, access, value) => await currentVideoStore().updateVideo(id, access, value),
    deleteVideo: async (id, access) => await currentVideoStore().deleteVideo(id, access),
    renameVideo: async (id, access, title, updated) => await currentVideoStore().renameVideo(id, access, title, updated),
    renameVideos: async (ids, access, transform, updated) => await currentVideoStore().renameVideos(ids, access, transform, updated),
    updateVideoStatus: async (id, access, status) => await currentVideoStore().updateVideoStatus(id, access, status),
    updateVideoDmca: async (id, takedown, updated) => await currentVideoStore().updateVideoDmca(id, takedown, updated),
    updateVideoPoster: async (id, access, poster, updated) => await currentVideoStore().updateVideoPoster(id, access, poster, updated),
    deleteVideoSubtitle: async (id, access) => await currentVideoStore().deleteVideoSubtitle(id, access),
    updateVideoSubtitle: async (id, access, link, language, updated) => await currentVideoStore().updateVideoSubtitle(id, access, link, language, updated),
    deleteVideosByHosts: async (hosts) => await currentVideoStore().deleteVideosByHosts(hosts)
  }

  app.addHook('onClose', async () => {
    await database?.close()
  })

  return Object.freeze({
    auth: new AuthService(lazyStore),
    sessions: new SessionAdminService(lazySessionStore),
    users: new UserAdminService(lazyUserStore),
    settings: new SettingsAdminService(lazySettingsStore),
    subtitleStore: lazySubtitleStore,
    videoStore: lazyVideoStore
  })
}
