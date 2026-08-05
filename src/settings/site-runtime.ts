import { DEFAULT_SITE_SETTINGS, type SiteSettings } from './settings-admin-service.js'

export type SiteSettingsLoader = () => Promise<SiteSettings>

export async function loadRuntimeSiteSettings(loader?: SiteSettingsLoader): Promise<SiteSettings> {
  if (loader === undefined) return DEFAULT_SITE_SETTINGS
  try {
    return await loader()
  } catch {
    return DEFAULT_SITE_SETTINGS
  }
}
