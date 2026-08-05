import { playerSettings, type PlayerSettings, type PlayerSettingsDefaults } from './player-settings.js'

export type PlayerSettingsLoader = () => Promise<PlayerSettings>

export async function loadRuntimePlayerSettings(
  loader: PlayerSettingsLoader | undefined,
  defaultSlugs: PlayerSettingsDefaults
): Promise<PlayerSettings> {
  if (loader !== undefined) {
    try {
      return await loader()
    } catch {
      // Public playback stays available with strict built-in defaults when settings storage is unavailable.
    }
  }
  return playerSettings({}, defaultSlugs)
}
