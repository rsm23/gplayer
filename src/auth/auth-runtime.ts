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

export type AuthRuntime = Readonly<{
  auth: AuthService
  sessions: SessionAdminService
  users: UserAdminService
  settings: SettingsAdminService
}>

export function createAuthRuntime(app: FastifyInstance, config: AppConfig): AuthRuntime {
  let database: Database | undefined
  let authStore: MySqlAuthStore | undefined
  let sessionStore: MySqlSessionAdminStore | undefined
  let userStore: MySqlUserAdminStore | undefined
  let settingsStore: MySqlSettingsAdminStore | undefined

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

  app.addHook('onClose', async () => {
    await database?.close()
  })

  return Object.freeze({
    auth: new AuthService(lazyStore),
    sessions: new SessionAdminService(lazySessionStore),
    users: new UserAdminService(lazyUserStore),
    settings: new SettingsAdminService(lazySettingsStore)
  })
}
