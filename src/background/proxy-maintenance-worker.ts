import type { ProxyDefinition } from '../settings/misc-settings.js'
import { parseProxyDefinition } from '../settings/misc-settings.js'

const MAX_PROXIES = 500
const GDRIVE_CHECK_URL = new URL('https://docs.google.com/u/4/get_video_info?docid=1225BQ0G3QbioqbP7H5q5u8EqklWDKnDC')

export type ProxyMaintenanceConfiguration = Readonly<{
  disabled: boolean
  useConfiguredOnly: boolean
  proxies: readonly string[]
}>

export interface ProxyMaintenanceStore {
  loadProxyConfiguration(): Promise<ProxyMaintenanceConfiguration>
  saveProxyList(proxies: readonly string[]): Promise<void>
}

export interface FreeProxySource {
  list(timeoutMilliseconds: number): Promise<readonly string[]>
}

export interface ProxyProbe {
  fetchText(proxy: ProxyDefinition, target: URL, timeoutMilliseconds: number): Promise<string>
}

export type ProxyMaintenanceResult = Readonly<{
  disabled: boolean
  discovered: number
  checked: number
  valid: number
}>

export class ProxyMaintenanceWorker {
  private readonly timeout: number
  private readonly concurrency: number

  public constructor(
    private readonly store: ProxyMaintenanceStore,
    private readonly source: FreeProxySource,
    private readonly probe: ProxyProbe,
    options: Readonly<{ timeout?: number; concurrency?: number }> = {}
  ) {
    this.timeout = Math.max(100, Math.min(60_000, Math.trunc(options.timeout ?? 10_000)))
    this.concurrency = Math.max(1, Math.min(50, Math.trunc(options.concurrency ?? 25)))
  }

  public async runOnce(): Promise<ProxyMaintenanceResult> {
    const configuration = await this.store.loadProxyConfiguration()
    if (configuration.disabled) return Object.freeze({ disabled: true, discovered: 0, checked: 0, valid: 0 })

    let candidates = normalizedProxies(configuration.proxies)
    let discovered = 0
    if (!configuration.useConfiguredOnly && candidates.length <= 1) {
      const before = new Set(candidates.map((proxy) => proxy.format))
      const scraped = normalizedProxies(await this.source.list(this.timeout).catch(() => []))
      candidates = uniqueProxies([...candidates, ...scraped])
      discovered = candidates.filter((proxy) => !before.has(proxy.format)).length
      if (candidates.length > 1) await this.store.saveProxyList(candidates.map((proxy) => proxy.format))
    }
    if (candidates.length === 0) return Object.freeze({ disabled: false, discovered, checked: 0, valid: 0 })

    const valid: ProxyDefinition[] = []
    let cursor = 0
    const consume = async (): Promise<void> => {
      while (cursor < candidates.length) {
        const proxy = candidates[cursor]
        cursor += 1
        if (proxy === undefined) continue
        const response = await this.probe.fetchText(proxy, GDRIVE_CHECK_URL, this.timeout).catch(() => '')
        if (response !== '' && !response.toLowerCase().includes('recaptcha')) valid.push(proxy)
      }
    }
    await Promise.all(Array.from({ length: Math.min(candidates.length, this.concurrency) }, consume))
    const ordered = candidates.filter((candidate) => valid.some((proxy) => proxy.format === candidate.format))
    await this.store.saveProxyList(ordered.map((proxy) => proxy.format))
    return Object.freeze({ disabled: false, discovered, checked: candidates.length, valid: ordered.length })
  }
}

function normalizedProxies(values: readonly string[]): ProxyDefinition[] {
  return uniqueProxies(values.slice(0, MAX_PROXIES).flatMap((value) => {
    const parsed = parseProxyDefinition(String(value).trim())
    return parsed === null ? [] : [parsed]
  }))
}

function uniqueProxies(values: readonly ProxyDefinition[]): ProxyDefinition[] {
  const result: ProxyDefinition[] = []
  const seen = new Set<string>()
  for (const proxy of values) {
    if (seen.has(proxy.format)) continue
    seen.add(proxy.format)
    result.push(proxy)
    if (result.length >= MAX_PROXIES) break
  }
  return result
}
