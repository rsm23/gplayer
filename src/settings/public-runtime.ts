import type { RuntimePublicSettings } from './settings-admin-service.js'

export type PublicSettingsLoader = () => Promise<RuntimePublicSettings>

export const DEFAULT_RUNTIME_PUBLIC: RuntimePublicSettings = Object.freeze({
  enable_request_url: true,
  enable_json_subtitles: true,
  enable_download_page: true,
  show_sub_download: true,
  show_watch_button: true
})

export async function loadRuntimePublicSettings(loader?: PublicSettingsLoader): Promise<RuntimePublicSettings> {
  if (loader === undefined) return DEFAULT_RUNTIME_PUBLIC
  try {
    return await loader()
  } catch {
    return DEFAULT_RUNTIME_PUBLIC
  }
}
