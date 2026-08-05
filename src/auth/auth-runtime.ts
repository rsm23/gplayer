import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.js'
import { Database } from '../database/database.js'
import { AuthService, type AuthStore } from './auth-service.js'
import { MySqlAuthStore } from './mysql-auth-store.js'
import { MySqlSessionAdminStore } from './mysql-session-admin-store.js'
import { SessionAdminService, type SessionAdminStore } from './session-admin-service.js'

export type AuthRuntime = Readonly<{
  auth: AuthService
  sessions: SessionAdminService
}>

export function createAuthRuntime(app: FastifyInstance, config: AppConfig): AuthRuntime {
  let database: Database | undefined
  let authStore: MySqlAuthStore | undefined
  let sessionStore: MySqlSessionAdminStore | undefined

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

  app.addHook('onClose', async () => {
    await database?.close()
  })

  return Object.freeze({
    auth: new AuthService(lazyStore),
    sessions: new SessionAdminService(lazySessionStore)
  })
}
