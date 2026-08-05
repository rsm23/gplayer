import { generalSettings, type GeneralSettings } from './settings-admin-service.js'

export type GeneralSettingsLoader = () => Promise<GeneralSettings>

export async function loadRuntimeGeneralSettings(
  loader: GeneralSettingsLoader | undefined,
  defaultBaseUrl: URL
): Promise<GeneralSettings> {
  if (loader !== undefined) {
    try {
      return await loader()
    } catch {
      // Public playback and view capture retain bounded defaults if settings storage is unavailable.
    }
  }
  return generalSettings({}, defaultBaseUrl)
}

export function visitCounterLimit(settings: GeneralSettings): number {
  return boundedInteger(settings.visit_counter, 1, 1_000_000, 1)
}

export function visitCounterRuntime(settings: GeneralSettings): number {
  return boundedInteger(settings.visit_counter_runtime, 0, 86_400, 10)
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}
