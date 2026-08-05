import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createCountryCodeLookup } from '../src/security/geoip-country.js'
import { accessPolicyFromMisc, filterSourcesByResolution } from '../src/settings/misc-runtime.js'
import { miscHostOptions, miscSettings, parseMiscSettingsSubmission, runtimeProxySettings } from '../src/settings/misc-settings.js'

const supportedHosts = new Set(['direct', 'youtube', 'gdrive'])

describe('misc settings contract', () => {
  it('loads all legacy values defensively without exposing stored proxy credentials', () => {
    const values = miscSettings({
      bypass_host: '["gdrive","removed-host"]',
      disable_host: '["youtube"]',
      disable_resolution: '["700","Original","bogus"]',
      disable_proxy: 'true',
      free_proxy: 'true',
      proxy_list: '203.0.113.5:1080,user:secret,socks5\n198.51.100.8:443,https',
      domain_whitelisted: 'https://www.Allowed.Example\ninvalid path/value',
      domain_blacklisted: 'blocked.example',
      link_blacklisted: 'https://www.bad.example/watch/',
      word_blacklisted: 'Forbidden Phrase',
      banned_countries: '["FR","XX"]',
      block_vpn: 'true',
      block_vpn_list: '203.0.113.0/24\ninvalid range'
    }, supportedHosts)

    expect(values).toEqual({
      bypass_host: ['gdrive'],
      disable_host: ['youtube'],
      disable_resolution: ['700', 'Original'],
      disable_proxy: true,
      free_proxy: true,
      proxy_list_configured: true,
      proxy_count: 2,
      domain_whitelisted: 'allowed.example',
      domain_blacklisted: 'blocked.example',
      link_blacklisted: 'bad.example/watch',
      word_blacklisted: 'forbidden phrase',
      banned_countries: ['FR'],
      block_vpn: true,
      block_vpn_list: '203.0.113.0/24'
    })
    expect(JSON.stringify(values)).not.toContain('secret')
  })

  it('loads normalized proxy credentials only through the server runtime contract', () => {
    const raw = {
      disable_proxy: 'false',
      proxy_list: [
        '203.0.113.5:1080,user:secret,socks5',
        '203.0.113.5:1080,user:secret,socks5',
        '198.51.100.8:443,https',
        'invalid'
      ].join('\n')
    }
    const runtime = runtimeProxySettings(raw)

    expect(runtime).toEqual({
      disabled: false,
      proxies: [
        {
          format: '203.0.113.5:1080,user:secret,socks5',
          hostname: '203.0.113.5',
          port: 1080,
          type: 'socks5',
          username: 'user',
          password: 'secret'
        },
        {
          format: '198.51.100.8:443,https',
          hostname: '198.51.100.8',
          port: 443,
          type: 'https',
          username: '',
          password: ''
        }
      ]
    })
    expect(JSON.stringify(miscSettings(raw, supportedHosts))).not.toContain('secret')
    expect(runtimeProxySettings({ ...raw, disable_proxy: 'true' }).disabled).toBe(true)
  })

  it('validates and serializes all thirteen supplied setting keys', () => {
    const parsed = parseMiscSettingsSubmission({
      'bypass_host[]': ['', 'gdrive'],
      'disable_host[]': ['', 'youtube'],
      'disable_resolution[]': ['', '700', 'Original'],
      disable_proxy: ['false', 'true'],
      free_proxy: 'false',
      proxy_list: '203.0.113.5:1080,USER:password,socks5\n[2001:db8::1]:8080,https',
      domain_whitelisted: 'https://www.Allowed.Example\n192.0.2.10\n2001:db8::1',
      domain_blacklisted: 'blocked.example',
      link_blacklisted: 'https://www.bad.example/watch/',
      word_blacklisted: 'Forbidden Phrase\nBlocked',
      'banned_countries[]': ['', 'DE', 'FR'],
      block_vpn: 'true',
      block_vpn_list: '203.0.113.0/24\n198.51.100.\n2001:db8::/32',
      attacker_key: 'ignored'
    }, {}, supportedHosts)

    expect(parsed.status).toBe('ok')
    if (parsed.status !== 'ok') throw new Error(parsed.message)
    expect(Object.fromEntries(parsed.entries.map(({ key, value }) => [key, value]))).toEqual({
      disable_proxy: 'true',
      free_proxy: 'false',
      block_vpn: 'true',
      bypass_host: '["gdrive"]',
      disable_host: '["youtube"]',
      disable_resolution: '["700","Original"]',
      banned_countries: '["DE","FR"]',
      domain_whitelisted: 'allowed.example\n192.0.2.10\n[2001:db8::1]',
      domain_blacklisted: 'blocked.example',
      link_blacklisted: 'bad.example/watch',
      word_blacklisted: 'forbidden phrase\nblocked',
      block_vpn_list: '203.0.113.0/24\n198.51.100.\n2001:db8::/32',
      proxy_list: '203.0.113.5:1080,USER:password,socks5\n[2001:db8::1]:8080,https'
    })
    expect(parsed.entries.some(({ key }) => key === 'attacker_key')).toBe(false)
  })

  it('preserves a blank write-only proxy field and requires an explicit unambiguous clear', () => {
    const raw = { proxy_list: '203.0.113.5:1080,user:secret,socks5' }
    const preserved = parseMiscSettingsSubmission({ disable_proxy: 'false', proxy_list: '', clear_proxy_list: 'false' }, raw, supportedHosts)
    expect(preserved.status).toBe('ok')
    if (preserved.status === 'ok') expect(preserved.entries).not.toContainEqual(expect.objectContaining({ key: 'proxy_list' }))

    const cleared = parseMiscSettingsSubmission({ proxy_list: '', clear_proxy_list: 'true' }, raw, supportedHosts)
    expect(cleared).toEqual({ status: 'ok', entries: [{ key: 'proxy_list', value: '' }] })
    expect(parseMiscSettingsSubmission({ proxy_list: '203.0.113.5:8080', clear_proxy_list: 'true' }, raw, supportedHosts)).toEqual({
      status: 'invalid',
      message: 'Choose either a replacement proxy list or clear the stored list'
    })
  })

  it('rejects unsupported selections and malformed security inputs atomically', () => {
    expect(parseMiscSettingsSubmission({ 'disable_host[]': ['not-supported'] }, {}, supportedHosts)).toEqual({ status: 'invalid', message: 'The disable host selection is invalid' })
    expect(parseMiscSettingsSubmission({ domain_whitelisted: 'allowed.example/path' }, {}, supportedHosts)).toEqual({ status: 'invalid', message: 'Allowed embed domains/IPs contain an invalid or excessive entry' })
    expect(parseMiscSettingsSubmission({ block_vpn_list: '999.1.' }, {}, supportedHosts)).toEqual({ status: 'invalid', message: 'Proxy/VPN prefixes contain an invalid or excessive entry' })
    expect(parseMiscSettingsSubmission({ proxy_list: 'proxy.example:8080' }, {}, supportedHosts)).toEqual({ status: 'invalid', message: 'The proxy list contains an invalid endpoint or more than 500 entries' })
  })

  it('labels only the active extractor set using bundled legacy names', () => {
    expect(miscHostOptions(supportedHosts)).toEqual([
      { value: 'direct', label: 'Direct URL' },
      { value: 'gdrive', label: 'Google Drive' },
      { value: 'youtube', label: 'Youtube' }
    ])
  })
})

describe('misc runtime', () => {
  it('reproduces legacy source-resolution bucketing and sole-source fallback', () => {
    const sources = [
      { file: 'https://cdn.example/1080.mp4', label: '1080p', type: 'mp4' },
      { file: 'https://cdn.example/720.mp4', label: '720p', type: 'video/mp4' },
      { file: 'https://cdn.example/480.mp4', label: '480p', type: 'video/mp4' }
    ]
    expect(filterSourcesByResolution(sources, ['1000', '700'])).toEqual([
      { file: 'https://cdn.example/480.mp4', label: '480p', type: 'video/mp4' }
    ])
    expect(filterSourcesByResolution([sources[0]!], ['1000'])).toEqual([sources[0]])
    expect(filterSourcesByResolution(sources.slice(0, 2), ['1000', '700'])).toEqual(sources.slice(0, 2))
  })

  it('maps normalized misc values into the existing access-policy contract', () => {
    const settings = miscSettings({
      domain_whitelisted: 'allowed.example',
      domain_blacklisted: 'blocked.example',
      word_blacklisted: 'forbidden',
      banned_countries: '["FR"]',
      block_vpn: 'true',
      block_vpn_list: '203.0.113.0/24'
    }, supportedHosts)
    const policy = accessPolicyFromMisc(settings)
    expect(policy.isDomainWhitelisted('https://allowed.example/embed')).toBe(true)
    expect(policy.isDomainBlacklisted('https://blocked.example/embed')).toBe(true)
    expect(policy.isTitleBlacklisted('A forbidden title')).toBe(true)
    expect(policy.isCountryBlacklisted('FR')).toBe(true)
    expect(policy.isProxyVpnBlacklisted('203.0.113.9')).toBe(true)
  })

  it('reads country codes from the bundled MaxMind database', async () => {
    const directory = path.dirname(fileURLToPath(import.meta.url))
    const lookup = createCountryCodeLookup(path.resolve(directory, '../resources/data/geoip/GeoLite2-Country.mmdb'))
    await expect(lookup('8.8.8.8')).resolves.toBe('US')
    await expect(lookup('not-an-ip')).resolves.toBe('')
  })
})
