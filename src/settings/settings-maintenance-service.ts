import { access } from 'node:fs/promises'

const CACHE_SUCCESS = 'The cache has been cleared successfully'
const CACHE_FAIL = 'The cache failed to clear'
const BLACKLIST_SUCCESS = 'The blacklisted videos have been successfully deactivated'
const BLACKLIST_FAIL = 'The blacklisted videos failed to deactivate'
const RESET_SUCCESS = 'The bypassed hosts have been successfully reset'
const RESET_FAIL = 'The bypassed hosts failed to reset'
const DEPENDENCY_SUCCESS = 'Node.js runtime dependencies are available'
const LICENSE_SUCCESS = 'The legacy license value has been successfully saved'
const LICENSE_FAIL = 'The legacy license value failed to save'
const MAX_BLACKLIST_PREFIXES = 1_000
const MAX_LICENSE_LENGTH = 4_096

export const DEFAULT_BYPASS_HOSTS = Object.freeze([
  'cloudmailru', 'cyberfile', 'dailymotion', 'dood', 'dropbox', 'dropload', 'dzen', 'facebook',
  'filemoon', 'filesfm', 'firevideoplayer', 'gofile', 'hxfile', 'krakenfiles', 'lulustream',
  'mediacm', 'mixdrop', 'mp4upload', 'mymailru', 'okru', 'pcloud', 'sendvid', 'streamtape',
  'streamhg', 'supervideo', 'tiktok', 'turboviplay', 'twitch', 'uqload', 'earnvids', 'vidmoly',
  'vidoza', 'vidtube', 'vidyard', 'vk', 'voe', 'vudeo', 'yourupload', 'youtube', 'ytdlp'
] as const)

export type SettingsActionResponse = Readonly<{
  status: 'ok' | 'fail'
  message: string
  result: unknown
}>

export interface SettingsMaintenanceStore {
  clearAllSourceCaches(): Promise<Readonly<{ temporarySourcesCleared: boolean; videoSourcesCleared: boolean }>>
  clearLoadBalancerSources(id: string): Promise<boolean>
  disableBlacklistedVideos(prefixes: readonly string[]): Promise<boolean>
  loadSetting(key: 'node_hide_ext_dialog_until'): Promise<string | null>
  saveSetting(key: 'bypass_host' | 'gdplayer_license' | 'node_hide_ext_dialog_until', value: string): Promise<boolean>
}

export interface SettingsMaintenanceFiles {
  clearAll(): Promise<boolean>
  clearSettingsTemporary(): Promise<boolean>
  clearVideoCache(): Promise<boolean>
  clearVideoFiles(): Promise<Readonly<{ imageFilesCleared: boolean; subtitleFilesCleared: boolean; cacheFilesCleared: boolean }>>
}

export interface NodeDependencyStatus {
  inspect(): Promise<Readonly<Record<string, boolean | string>>>
}

export class RuntimeNodeDependencyStatus implements NodeDependencyStatus {
  public constructor(private readonly chromeCandidates: readonly string[] = defaultChromeCandidates()) {}

  public async inspect(): Promise<Readonly<Record<string, boolean | string>>> {
    const chrome = await firstAvailable(this.chromeCandidates)
    return Object.freeze({
      ioncube: false,
      symlink: true,
      popen: true,
      pclose: true,
      exec: true,
      shell_exec: false,
      putenv: true,
      proc_open: true,
      proc_close: true,
      proc_get_status: true,
      chrome: chrome ?? false,
      node: process.version,
      php: false
    })
  }
}

export class SettingsMaintenanceService {
  private extensionDialogHiddenUntil = 0

  public constructor(
    private readonly store: SettingsMaintenanceStore,
    private readonly files: SettingsMaintenanceFiles,
    private readonly dependencies: NodeDependencyStatus = new RuntimeNodeDependencyStatus(),
    private readonly options: Readonly<{
      clearRuntimeCache: () => boolean | Promise<boolean>
      loadBlacklist: () => string | Promise<string>
      supportedHosts: ReadonlySet<string>
      now?: () => number
    }>
  ) {}

  public async action(action: string, input: Readonly<Record<string, unknown>>): Promise<SettingsActionResponse> {
    switch (action) {
      case 'clearAllCache': return await this.clearAllCache()
      case 'clearLoadBalancer': return await this.clearLoadBalancer(input)
      case 'clearSettingsCache': return await this.clearSettingsCache()
      case 'clearVideosCache': return await this.clearVideosCache()
      case 'clearVideosFiles': return await this.clearVideosFiles()
      case 'disableBlacklistedVideos': return await this.disableBlacklistedVideos()
      case 'getDependencies': return await this.getDependencies()
      case 'hideExtDialog': return await this.hideExtensionDialog()
      case 'resetHosts': return await this.resetHosts()
      case 'saveLicense': return await this.saveLicense(input)
      default: return response('fail', 'The settings action is not supported', null)
    }
  }

  public async extensionDialogHidden(): Promise<boolean> {
    const now = (this.options.now ?? Date.now)()
    if (this.extensionDialogHiddenUntil > now) return true
    const stored = Number(await this.store.loadSetting('node_hide_ext_dialog_until'))
    if (!Number.isSafeInteger(stored) || stored <= now) return false
    this.extensionDialogHiddenUntil = stored
    return true
  }

  private async clearAllCache(): Promise<SettingsActionResponse> {
    try {
      const [sources, files, runtime] = await Promise.all([
        this.store.clearAllSourceCaches(),
        this.files.clearAll(),
        this.options.clearRuntimeCache()
      ])
      return response('ok', CACHE_SUCCESS, {
        kill_background_process: true,
        clear_tmp_video_sources: sources.temporarySourcesCleared,
        clear_video_sources: sources.videoSourcesCleared,
        clear_cache_files: files,
        clear_cache_driver: runtime
      })
    } catch {
      return response('fail', CACHE_FAIL, null)
    }
  }

  private async clearLoadBalancer(input: Readonly<Record<string, unknown>>): Promise<SettingsActionResponse> {
    const id = scalar(input.id).trim()
    if (id === '' || id.length > 128) return response('fail', CACHE_FAIL, null)
    try {
      return response('ok', CACHE_SUCCESS, {
        kill_background_process: true,
        clear_video_sources: await this.store.clearLoadBalancerSources(id)
      })
    } catch {
      return response('fail', CACHE_FAIL, null)
    }
  }

  private async clearSettingsCache(): Promise<SettingsActionResponse> {
    try {
      const [runtime, temporary] = await Promise.all([
        this.options.clearRuntimeCache(),
        this.files.clearSettingsTemporary()
      ])
      return response('ok', CACHE_SUCCESS, { clear_settings: runtime, clear_tmp_files: temporary })
    } catch {
      return response('fail', CACHE_FAIL, null)
    }
  }

  private async clearVideosCache(): Promise<SettingsActionResponse> {
    try {
      const [sources, files, runtime] = await Promise.all([
        this.store.clearAllSourceCaches(),
        this.files.clearVideoCache(),
        this.options.clearRuntimeCache()
      ])
      return response('ok', CACHE_SUCCESS, {
        kill_background_process: true,
        clear_tmp_video_sources: sources.temporarySourcesCleared,
        clear_video_sources: sources.videoSourcesCleared,
        clear_video_player: runtime,
        clear_cache_files: files
      })
    } catch {
      return response('fail', CACHE_FAIL, null)
    }
  }

  private async clearVideosFiles(): Promise<SettingsActionResponse> {
    try {
      const files = await this.files.clearVideoFiles()
      return response('ok', CACHE_SUCCESS, {
        kill_background_process: true,
        clear_images_files: files.imageFilesCleared,
        clear_subtitles_files: files.subtitleFilesCleared,
        clear_cache_files: files.cacheFilesCleared
      })
    } catch {
      return response('fail', CACHE_FAIL, null)
    }
  }

  private async disableBlacklistedVideos(): Promise<SettingsActionResponse> {
    try {
      const prefixes = blacklistPrefixes(await this.options.loadBlacklist())
      if (prefixes.length === 0) return response('ok', BLACKLIST_SUCCESS, null)
      const updated = await this.store.disableBlacklistedVideos(prefixes)
      return response(updated ? 'ok' : 'fail', updated ? BLACKLIST_SUCCESS : BLACKLIST_FAIL, null)
    } catch {
      return response('fail', BLACKLIST_FAIL, null)
    }
  }

  private async getDependencies(): Promise<SettingsActionResponse> {
    try {
      return response('ok', DEPENDENCY_SUCCESS, await this.dependencies.inspect())
    } catch {
      return response('fail', 'The Node.js runtime dependency check failed', null)
    }
  }

  private async hideExtensionDialog(): Promise<SettingsActionResponse> {
    const expiresAt = (this.options.now ?? Date.now)() + 30 * 24 * 60 * 60 * 1_000
    try {
      const saved = await this.store.saveSetting('node_hide_ext_dialog_until', String(expiresAt))
      if (!saved) return response('fail', 'The dependency dialog preference failed to save', null)
      this.extensionDialogHiddenUntil = expiresAt
      return response('ok', DEPENDENCY_SUCCESS, null)
    } catch {
      return response('fail', 'The dependency dialog preference failed to save', null)
    }
  }

  private async resetHosts(): Promise<SettingsActionResponse> {
    const hosts = DEFAULT_BYPASS_HOSTS.filter((host) => this.options.supportedHosts.has(host))
    try {
      const saved = await this.store.saveSetting('bypass_host', JSON.stringify(hosts))
      return response(saved ? 'ok' : 'fail', saved ? RESET_SUCCESS : RESET_FAIL, hosts)
    } catch {
      return response('fail', RESET_FAIL, null)
    }
  }

  private async saveLicense(input: Readonly<Record<string, unknown>>): Promise<SettingsActionResponse> {
    const value = scalar(input.gdplayer_license).trim()
    if (value === '' || value.length > MAX_LICENSE_LENGTH) return response('fail', LICENSE_FAIL, null)
    try {
      const saved = await this.store.saveSetting('gdplayer_license', value)
      return response(saved ? 'ok' : 'fail', saved ? LICENSE_SUCCESS : LICENSE_FAIL, null)
    } catch {
      return response('fail', LICENSE_FAIL, null)
    }
  }
}

function response(status: 'ok' | 'fail', message: string, result: unknown): SettingsActionResponse {
  return Object.freeze({ status, message, result })
}

function scalar(value: unknown): string {
  if (Array.isArray(value)) return scalar(value.at(-1))
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function blacklistPrefixes(value: string): readonly string[] {
  return Object.freeze([...new Set(value.replaceAll('\r\n', '\n').split('\n').map((row) => row.trim().toLowerCase()).filter(Boolean))].slice(0, MAX_BLACKLIST_PREFIXES))
}

function defaultChromeCandidates(): readonly string[] {
  const configured = process.env.CHROME_PATH?.trim()
  return Object.freeze([
    ...(configured === undefined || configured === '' ? [] : [configured]),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ])
}

async function firstAvailable(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {}
  }
  return null
}
