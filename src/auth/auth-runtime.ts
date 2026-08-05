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
import { MySqlDriveStore } from '../drive/mysql-drive-store.js'
import type { DriveStore } from '../drive/drive-sharer-service.js'
import { DriveAccountAdminService, type DriveAccountAdminStore } from '../drive/drive-account-admin-service.js'
import { MySqlDriveAccountAdminStore } from '../drive/mysql-drive-account-admin-store.js'
import { MySqlDriveAdminStore } from '../drive/mysql-drive-admin-store.js'
import type { DriveAdminStore } from '../drive/drive-admin-service.js'
import { MySqlStatsWorkerStore } from '../background/mysql-stats-worker-store.js'
import type { StatsWorkerStore } from '../background/stats-worker.js'
import { MySqlGeneralWorkerStore } from '../background/mysql-general-worker-store.js'
import type { GeneralWorkerStore } from '../background/general-worker.js'
import type { ProxyMaintenanceStore } from '../background/proxy-maintenance-worker.js'
import { MySqlSourceRefreshStore } from '../background/mysql-source-refresh-store.js'
import type { SourceRefreshStore } from '../background/source-refresh-worker.js'
import { MySqlMediaDownloadStore } from '../background/mysql-media-download-store.js'
import type { MediaDownloadStore } from '../background/media-download-worker.js'
import { MySqlPluginMaintenanceStore } from '../plugins/mysql-plugin-maintenance-store.js'
import type { PluginMaintenanceStore } from '../plugins/plugin-maintenance-worker.js'
import { MySqlLoadBalancerAdminStore } from '../load-balancers/mysql-load-balancer-admin-store.js'
import type { LoadBalancerAdminStore } from '../load-balancers/load-balancer-admin-service.js'
import { MySqlPluginAdminStore } from '../plugins/mysql-plugin-admin-store.js'
import type { PluginAdminStore } from '../plugins/plugin-admin-service.js'
import { MySqlAccountLifecycleStore } from './mysql-account-lifecycle-store.js'
import type { AccountLifecycleStore } from './account-lifecycle-service.js'
import { MySqlDashboardAdminStore } from '../dashboard/mysql-dashboard-admin-store.js'
import type { DashboardAdminStore } from '../dashboard/dashboard-admin-service.js'
import { MySqlPrivateAdminStore } from '../system/mysql-private-admin-store.js'
import type { PrivateAdminStore } from '../system/private-admin-service.js'
import { MySqlSettingsMaintenanceStore } from '../settings/mysql-settings-maintenance-store.js'
import type { SettingsMaintenanceStore } from '../settings/settings-maintenance-service.js'
import { MySqlViewCounterStore } from '../stats/mysql-view-counter-store.js'
import type { ViewCounterStore } from '../stats/view-counter-service.js'

export type AuthRuntime = Readonly<{
  auth: AuthService
  sessions: SessionAdminService
  users: UserAdminService
  settings: SettingsAdminService
  subtitleStore: SubtitleAdminStore
  videoStore: VideoAdminStore
  driveStore: DriveStore
  driveAccounts: DriveAccountAdminService
  driveAdminStore: DriveAdminStore
  statsWorkerStore: StatsWorkerStore
  viewCounterStore: ViewCounterStore
  generalWorkerStore: GeneralWorkerStore
  proxyMaintenanceStore: ProxyMaintenanceStore
  pluginMaintenanceStore: PluginMaintenanceStore
  sourceRefreshStore: SourceRefreshStore
  mediaDownloadStore: MediaDownloadStore
  loadBalancerAdminStore: LoadBalancerAdminStore
  pluginAdminStore: PluginAdminStore
  accountLifecycleStore: AccountLifecycleStore
  dashboardStore: DashboardAdminStore
  privateAdminStore: PrivateAdminStore
  settingsMaintenanceStore: SettingsMaintenanceStore
}>

export function createAuthRuntime(app: FastifyInstance, config: AppConfig): AuthRuntime {
  let database: Database | undefined
  let authStore: MySqlAuthStore | undefined
  let sessionStore: MySqlSessionAdminStore | undefined
  let userStore: MySqlUserAdminStore | undefined
  let settingsStore: MySqlSettingsAdminStore | undefined
  let subtitleStore: MySqlSubtitleAdminStore | undefined
  let videoStore: MySqlVideoAdminStore | undefined
  let driveStore: MySqlDriveStore | undefined
  let driveAccountStore: MySqlDriveAccountAdminStore | undefined
  let driveAdminStore: MySqlDriveAdminStore | undefined
  let statsWorkerStore: MySqlStatsWorkerStore | undefined
  let viewCounterStore: MySqlViewCounterStore | undefined
  let generalWorkerStore: MySqlGeneralWorkerStore | undefined
  let pluginMaintenanceStore: MySqlPluginMaintenanceStore | undefined
  let sourceRefreshStore: MySqlSourceRefreshStore | undefined
  let mediaDownloadStore: MySqlMediaDownloadStore | undefined
  let loadBalancerAdminStore: MySqlLoadBalancerAdminStore | undefined
  let pluginAdminStore: MySqlPluginAdminStore | undefined
  let accountLifecycleStore: MySqlAccountLifecycleStore | undefined
  let dashboardStore: MySqlDashboardAdminStore | undefined
  let privateAdminStore: MySqlPrivateAdminStore | undefined
  let settingsMaintenanceStore: MySqlSettingsMaintenanceStore | undefined

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
  const currentDriveStore = (): MySqlDriveStore => {
    driveStore ??= new MySqlDriveStore(currentDatabase())
    return driveStore
  }
  const currentDriveAccountStore = (): MySqlDriveAccountAdminStore => {
    driveAccountStore ??= new MySqlDriveAccountAdminStore(currentDatabase())
    return driveAccountStore
  }
  const currentDriveAdminStore = (): MySqlDriveAdminStore => {
    driveAdminStore ??= new MySqlDriveAdminStore(currentDatabase())
    return driveAdminStore
  }
  const currentStatsWorkerStore = (): MySqlStatsWorkerStore => {
    statsWorkerStore ??= new MySqlStatsWorkerStore(currentDatabase())
    return statsWorkerStore
  }
  const currentViewCounterStore = (): MySqlViewCounterStore => {
    viewCounterStore ??= new MySqlViewCounterStore(currentDatabase())
    return viewCounterStore
  }
  const currentGeneralWorkerStore = (): MySqlGeneralWorkerStore => {
    generalWorkerStore ??= new MySqlGeneralWorkerStore(currentDatabase())
    return generalWorkerStore
  }
  const currentPluginMaintenanceStore = (): MySqlPluginMaintenanceStore => {
    pluginMaintenanceStore ??= new MySqlPluginMaintenanceStore(currentDatabase())
    return pluginMaintenanceStore
  }
  const currentSourceRefreshStore = (): MySqlSourceRefreshStore => {
    sourceRefreshStore ??= new MySqlSourceRefreshStore(currentDatabase())
    return sourceRefreshStore
  }
  const currentMediaDownloadStore = (): MySqlMediaDownloadStore => {
    mediaDownloadStore ??= new MySqlMediaDownloadStore(currentDatabase())
    return mediaDownloadStore
  }
  const currentLoadBalancerAdminStore = (): MySqlLoadBalancerAdminStore => {
    loadBalancerAdminStore ??= new MySqlLoadBalancerAdminStore(currentDatabase())
    return loadBalancerAdminStore
  }
  const currentPluginAdminStore = (): MySqlPluginAdminStore => {
    pluginAdminStore ??= new MySqlPluginAdminStore(currentDatabase())
    return pluginAdminStore
  }
  const currentAccountLifecycleStore = (): MySqlAccountLifecycleStore => {
    accountLifecycleStore ??= new MySqlAccountLifecycleStore(currentDatabase())
    return accountLifecycleStore
  }
  const currentDashboardStore = (): MySqlDashboardAdminStore => {
    dashboardStore ??= new MySqlDashboardAdminStore(currentDatabase())
    return dashboardStore
  }
  const currentPrivateAdminStore = (): MySqlPrivateAdminStore => {
    privateAdminStore ??= new MySqlPrivateAdminStore(currentDatabase())
    return privateAdminStore
  }
  const currentSettingsMaintenanceStore = (): MySqlSettingsMaintenanceStore => {
    settingsMaintenanceStore ??= new MySqlSettingsMaintenanceStore(currentDatabase())
    return settingsMaintenanceStore
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
  const lazyDriveStore: DriveStore = {
    listActiveBypassAccounts: async () => await currentDriveStore().listActiveBypassAccounts(),
    listMirrors: async (fileId, limit) => await currentDriveStore().listMirrors(fileId, limit),
    saveMirror: async (sourceId, mirrorId, email, created) => await currentDriveStore().saveMirror(sourceId, mirrorId, email, created)
  }
  const lazyDriveAccountStore: DriveAccountAdminStore = {
    listAccounts: async (query) => await currentDriveAccountStore().listAccounts(query),
    getAccount: async (id) => await currentDriveAccountStore().getAccount(id),
    emailExists: async (email, excludeId) => await currentDriveAccountStore().emailExists(email, excludeId),
    createAccount: async (account) => await currentDriveAccountStore().createAccount(account),
    updateAccount: async (id, account) => await currentDriveAccountStore().updateAccount(id, account),
    deleteAccount: async (id) => await currentDriveAccountStore().deleteAccount(id),
    updateFlag: async (id, column, value, updated) => await currentDriveAccountStore().updateFlag(id, column, value, updated)
  }
  const lazyDriveAdminStore: DriveAdminStore = {
    listActiveAccounts: async (bypassOnly) => await currentDriveAdminStore().listActiveAccounts(bypassOnly),
    listMirrors: async (fileId, limit) => await currentDriveAdminStore().listMirrors(fileId, limit),
    saveMirror: async (sourceId, mirrorId, email, created) => await currentDriveAdminStore().saveMirror(sourceId, mirrorId, email, created),
    deleteMirrorsForFile: async (fileId) => await currentDriveAdminStore().deleteMirrorsForFile(fileId),
    deleteMirrorRecord: async (id) => await currentDriveAdminStore().deleteMirrorRecord(id),
    listBackups: async (query) => await currentDriveAdminStore().listBackups(query),
    getBackup: async (id) => await currentDriveAdminStore().getBackup(id),
    deleteBackupsByMirrorId: async (mirrorId) => await currentDriveAdminStore().deleteBackupsByMirrorId(mirrorId),
    listQueue: async (query) => await currentDriveAdminStore().listQueue(query),
    deleteQueue: async (id) => await currentDriveAdminStore().deleteQueue(id),
    listPendingQueue: async (limit) => await currentDriveAdminStore().listPendingQueue(limit),
    enqueueQueue: async (fileId, delayed) => await currentDriveAdminStore().enqueueQueue(fileId, delayed),
    deleteQueueByFileIds: async (fileIds) => await currentDriveAdminStore().deleteQueueByFileIds(fileIds),
    duplicateExists: async (fingerprint) => await currentDriveAdminStore().duplicateExists(fingerprint),
    saveFingerprint: async (fingerprint) => await currentDriveAdminStore().saveFingerprint(fingerprint)
  }
  const lazyStatsWorkerStore: StatsWorkerStore = {
    acquire: async (now) => await currentStatsWorkerStore().acquire(now),
    release: async () => await currentStatsWorkerStore().release(),
    cleanupInvalid: async () => await currentStatsWorkerStore().cleanupInvalid(),
    listMissingGeo: async (afterId, limit) => await currentStatsWorkerStore().listMissingGeo(afterId, limit),
    saveGeo: async (ip, details) => await currentStatsWorkerStore().saveGeo(ip, details)
  }
  const lazyViewCounterStore: ViewCounterStore = {
    capture: async (input) => await currentViewCounterStore().capture(input)
  }
  const lazyGeneralWorkerStore: GeneralWorkerStore = {
    deleteExpiredSources: async (now) => await currentGeneralWorkerStore().deleteExpiredSources(now),
    normalizeSubtitleLanguages: async () => await currentGeneralWorkerStore().normalizeSubtitleLanguages(),
    saveActiveConnections: async (baseUrl, connections) => await currentGeneralWorkerStore().saveActiveConnections(baseUrl, connections),
    listActiveLoadBalancers: async (baseUrl) => await currentGeneralWorkerStore().listActiveLoadBalancers(baseUrl),
    listManagedSubtitles: async (host, afterId, limit) => await currentGeneralWorkerStore().listManagedSubtitles(host, afterId, limit),
    deleteManagedSubtitle: async (id, host) => await currentGeneralWorkerStore().deleteManagedSubtitle(id, host)
  }
  const lazyProxyMaintenanceStore: ProxyMaintenanceStore = {
    loadProxyConfiguration: async () => await currentGeneralWorkerStore().loadProxyConfiguration(),
    saveProxyList: async (proxies) => await currentGeneralWorkerStore().saveProxyList(proxies)
  }
  const lazyPluginMaintenanceStore: PluginMaintenanceStore = {
    listPlugins: async () => await currentPluginMaintenanceStore().listPlugins()
  }
  const lazySourceRefreshStore: SourceRefreshStore = {
    maintainLegacyData: async () => await currentSourceRefreshStore().maintainLegacyData(),
    getLastCleanup: async () => await currentSourceRefreshStore().getLastCleanup(),
    truncatePendingSources: async () => await currentSourceRefreshStore().truncatePendingSources(),
    saveLastCleanup: async (timestamp) => await currentSourceRefreshStore().saveLastCleanup(timestamp),
    listPendingSources: async (limit) => await currentSourceRefreshStore().listPendingSources(limit),
    deletePendingSource: async (id) => await currentSourceRefreshStore().deletePendingSource(id)
  }
  const lazyMediaDownloadStore: MediaDownloadStore = {
    currentServerId: async (baseUrl) => await currentMediaDownloadStore().currentServerId(baseUrl),
    listCandidates: async (afterId, limit, serverId) => await currentMediaDownloadStore().listCandidates(afterId, limit, serverId)
  }
  const lazyLoadBalancerAdminStore: LoadBalancerAdminStore = {
    listLoadBalancers: async (query) => await currentLoadBalancerAdminStore().listLoadBalancers(query),
    getLoadBalancer: async (id) => await currentLoadBalancerAdminStore().getLoadBalancer(id),
    linkExists: async (link, excludeId) => await currentLoadBalancerAdminStore().linkExists(link, excludeId),
    createLoadBalancer: async (value) => await currentLoadBalancerAdminStore().createLoadBalancer(value),
    updateLoadBalancer: async (id, value) => await currentLoadBalancerAdminStore().updateLoadBalancer(id, value),
    deleteLoadBalancer: async (id) => await currentLoadBalancerAdminStore().deleteLoadBalancer(id),
    updateStatus: async (id, status, updated) => await currentLoadBalancerAdminStore().updateStatus(id, status, updated)
  }
  const lazyPluginAdminStore: PluginAdminStore = {
    listPlugins: async (query) => await currentPluginAdminStore().listPlugins(query),
    listPluginRecords: async () => await currentPluginAdminStore().listPluginRecords(),
    getPlugin: async (id) => await currentPluginAdminStore().getPlugin(id),
    findPlugin: async (name, folder) => await currentPluginAdminStore().findPlugin(name, folder),
    createPlugin: async (value) => await currentPluginAdminStore().createPlugin(value),
    updatePlugin: async (id, value) => await currentPluginAdminStore().updatePlugin(id, value),
    updateStatus: async (id, status, updated) => await currentPluginAdminStore().updateStatus(id, status, updated),
    deletePlugin: async (id) => await currentPluginAdminStore().deletePlugin(id)
  }
  const lazyAccountLifecycleStore: AccountLifecycleStore = {
    findConflict: async (username, email) => await currentAccountLifecycleStore().findConflict(username, email),
    findByIdentifier: async (identifier) => await currentAccountLifecycleStore().findByIdentifier(identifier),
    findByEmail: async (email) => await currentAccountLifecycleStore().findByEmail(email),
    createAccount: async (account) => await currentAccountLifecycleStore().createAccount(account),
    activatePending: async (email, expectedUpdated, updated) => await currentAccountLifecycleStore().activatePending(email, expectedUpdated, updated),
    resetPassword: async (email, expectedUpdated, passwordHash, updated) => await currentAccountLifecycleStore().resetPassword(email, expectedUpdated, passwordHash, updated)
  }
  const lazyDashboardStore: DashboardAdminStore = {
    videoStatus: async (ownerId) => await currentDashboardStore().videoStatus(ownerId),
    recentVideos: async (ownerId, limit) => await currentDashboardStore().recentVideos(ownerId, limit),
    popularVideos: async (range, ownerId, limit) => await currentDashboardStore().popularVideos(range, ownerId, limit),
    dailyViews: async (range, ownerId) => await currentDashboardStore().dailyViews(range, ownerId),
    popularBrowsers: async (range, ownerId, start, limit) => await currentDashboardStore().popularBrowsers(range, ownerId, start, limit),
    popularCountries: async (range, ownerId, start, limit) => await currentDashboardStore().popularCountries(range, ownerId, start, limit),
    popularAsns: async (range, ownerId, start, limit) => await currentDashboardStore().popularAsns(range, ownerId, start, limit),
    serverUsage: async () => await currentDashboardStore().serverUsage()
  }
  const lazyPrivateAdminStore: PrivateAdminStore = {
    clearVideoSources: async (id) => await currentPrivateAdminStore().clearVideoSources(id),
    clearLoadBalancerSources: async (link) => await currentPrivateAdminStore().clearLoadBalancerSources(link)
  }
  const lazySettingsMaintenanceStore: SettingsMaintenanceStore = {
    clearAllSourceCaches: async () => await currentSettingsMaintenanceStore().clearAllSourceCaches(),
    clearLoadBalancerSources: async (id) => await currentSettingsMaintenanceStore().clearLoadBalancerSources(id),
    disableBlacklistedVideos: async (prefixes) => await currentSettingsMaintenanceStore().disableBlacklistedVideos(prefixes),
    loadSetting: async (key) => await currentSettingsMaintenanceStore().loadSetting(key),
    saveSetting: async (key, value) => await currentSettingsMaintenanceStore().saveSetting(key, value)
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
    videoStore: lazyVideoStore,
    driveStore: lazyDriveStore,
    driveAccounts: new DriveAccountAdminService(lazyDriveAccountStore),
    driveAdminStore: lazyDriveAdminStore,
    statsWorkerStore: lazyStatsWorkerStore,
    viewCounterStore: lazyViewCounterStore,
    generalWorkerStore: lazyGeneralWorkerStore,
    proxyMaintenanceStore: lazyProxyMaintenanceStore,
    pluginMaintenanceStore: lazyPluginMaintenanceStore,
    sourceRefreshStore: lazySourceRefreshStore,
    mediaDownloadStore: lazyMediaDownloadStore,
    loadBalancerAdminStore: lazyLoadBalancerAdminStore,
    pluginAdminStore: lazyPluginAdminStore,
    accountLifecycleStore: lazyAccountLifecycleStore,
    dashboardStore: lazyDashboardStore,
    privateAdminStore: lazyPrivateAdminStore,
    settingsMaintenanceStore: lazySettingsMaintenanceStore
  })
}
