import type { AdsSettings } from './settings-admin-service.js'

export type AdsSettingsLoader = () => Promise<AdsSettings>

export type RuntimeVastConfiguration = Readonly<{
  client: AdsSettings['vast_client']
  schedule: readonly Readonly<{ tag: string; offset: string }>[]
  skipoffset: number
  skipmessage: 'Skip XX'
  creativeTimeout: 60_000
  loadVideoTimeout: 60_000
  vastLoadTimeout: 60_000
  requestTimeout: 60_000
  placement: 'interstitial'
  vpaidmode: 'insecure'
  withCredentials: false
  omidSupport: 'enabled'
  maxRedirects: 20
}>

export const DEFAULT_RUNTIME_ADS: AdsSettings = Object.freeze({
  block_adblocker: false,
  disable_vast_ads: true,
  vast_client: 'vast',
  vast_offset: Object.freeze([]),
  vast_xml: Object.freeze([]),
  vast_skip: '5',
  disable_popup_ads: true,
  popup_load_offset: '0',
  popup_ads_link: '',
  popup_ads_code: '',
  disable_banner_ads: true,
  dl_banner_top: '',
  dl_banner_bottom: '',
  sh_banner_top: '',
  sh_banner_bottom: '',
  disable_direct_ads: true,
  direct_ads_link: '',
  visitads_onplay: true,
  show_iframeads: true
})

export async function loadRuntimeAdsSettings(loader?: AdsSettingsLoader): Promise<AdsSettings> {
  if (loader === undefined) return DEFAULT_RUNTIME_ADS
  try {
    return await loader()
  } catch {
    return DEFAULT_RUNTIME_ADS
  }
}

export function runtimeVastConfiguration(ads: AdsSettings): RuntimeVastConfiguration | null {
  if (ads.disable_vast_ads) return null
  const schedule = ads.vast_xml.map((tag, index) => Object.freeze({
    tag,
    offset: legacyVastOffset(ads.vast_offset[index] ?? '')
  }))
  return Object.freeze({
    client: ads.vast_client,
    schedule: Object.freeze(schedule),
    skipoffset: Number.parseInt(ads.vast_skip, 10) || 0,
    skipmessage: 'Skip XX',
    creativeTimeout: 60_000,
    loadVideoTimeout: 60_000,
    vastLoadTimeout: 60_000,
    requestTimeout: 60_000,
    placement: 'interstitial',
    vpaidmode: 'insecure',
    withCredentials: false,
    omidSupport: 'enabled',
    maxRedirects: 20
  })
}

export function legacyVastConfiguration(ads: AdsSettings): readonly unknown[] | RuntimeVastConfiguration {
  return runtimeVastConfiguration(ads) ?? Object.freeze([])
}

function legacyVastOffset(value: string): string {
  if (/^(?:0|[1-9][0-9]*)$/.test(value)) return durationTime(Number(value))
  if (value === 'start') return 'preroll'
  if (value === 'end') return 'postroll'
  return value
}

function durationTime(seconds: number): string {
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor(seconds % 3_600 / 60)
  const remainder = seconds % 60
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':')
}
