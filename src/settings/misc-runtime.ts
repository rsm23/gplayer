import type { MediaSource } from '../core/source-resolver.js'
import { AccessPolicy } from '../security/access-policy.js'
import { miscSettings, type MiscSettings } from './misc-settings.js'

export type MiscSettingsLoader = () => Promise<MiscSettings>

export async function loadRuntimeMiscSettings(
  loader: MiscSettingsLoader | undefined,
  supportedHosts: ReadonlySet<string>
): Promise<MiscSettings> {
  if (loader !== undefined) {
    try {
      return await loader()
    } catch {
      // Public playback stays available with restrictive parsing and inert defaults if storage is unavailable.
    }
  }
  return miscSettings({}, supportedHosts)
}

export function accessPolicyFromMisc(settings: MiscSettings): AccessPolicy {
  return new AccessPolicy({
    bannedCountries: settings.banned_countries,
    domainBlacklist: settings.domain_blacklisted,
    domainWhitelist: settings.domain_whitelisted,
    refererBlacklist: settings.link_blacklisted,
    titleBlacklist: settings.word_blacklisted,
    blockVpn: settings.block_vpn,
    vpnPrefixes: settings.block_vpn_list
  })
}

export function accessPolicyRejects(
  policy: AccessPolicy,
  input: Readonly<{ clientIp: string; countryCode: string; referer: string; userAgent: string }>
): boolean {
  return policy.isBrowserBlacklisted(input.userAgent) ||
    policy.isCountryBlacklisted(input.countryCode) ||
    policy.isProxyVpnBlacklisted(input.clientIp) ||
    policy.isDomainBlacklisted(input.referer) ||
    !policy.isDomainWhitelisted(input.referer) ||
    policy.isRefererBlacklisted(input.referer)
}

export function filterSourcesByResolution(
  sources: readonly MediaSource[],
  disabledResolutions: readonly string[]
): readonly MediaSource[] {
  if (sources.length <= 1 || disabledResolutions.length === 0) return sources
  const disabled = new Set(disabledResolutions)
  const result = sources.flatMap((source) => {
    const rawLabel = typeof source.label === 'string' ? source.label.replace(/p+$/i, '') : ''
    const label = /^\d+$/.test(rawLabel) ? resolutionThreshold(Number(rawLabel)) : rawLabel
    if (disabled.has(String(label))) return []
    const type = typeof source.type === 'string' && ['hls', 'mpd', 'video/mp4'].includes(source.type)
      ? source.type
      : 'video/mp4'
    return [{ ...source, type }]
  })
  return result.length === 0 ? sources : Object.freeze(result)
}

function resolutionThreshold(label: number): number {
  for (const threshold of [4_000, 2_000, 1_400, 1_200, 1_100, 1_000, 900, 800, 700, 600, 500, 400, 300, 200, 100]) {
    if (label >= threshold) return threshold
  }
  return label
}
