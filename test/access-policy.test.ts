import { describe, expect, it } from 'vitest'
import { AccessPolicy, getHostOrigin, isIpInRange } from '../src/security/access-policy.js'

describe('AccessPolicy GDPlayer compatibility', () => {
  it('matches the shipped blocked user-agent pattern case-insensitively', () => {
    const policy = new AccessPolicy()
    expect(policy.isBrowserBlacklisted('VLC/3.0.21 LibVLC')).toBe(true)
    expect(policy.isBrowserBlacklisted('Mozilla/5.0 Safari/605.1.15')).toBe(false)
  })

  it('normalizes domain blacklist settings', () => {
    const policy = new AccessPolicy({
      domainBlacklist: 'https://www.blocked.example\r\nhttp://other.example'
    })
    expect(policy.isDomainBlacklisted('https://blocked.example/watch/1')).toBe(true)
    expect(policy.isDomainBlacklisted('https://allowed.example/watch/1')).toBe(false)
  })

  it('allows all domains when no custom whitelist exists', () => {
    expect(new AccessPolicy().isDomainWhitelisted('https://unknown.example/video')).toBe(true)
  })

  it('adds the legacy link-shortener allowlist when a custom whitelist exists', () => {
    const policy = new AccessPolicy({ domainWhitelist: 'player.example' })
    expect(policy.isDomainWhitelisted('https://player.example/embed')).toBe(true)
    expect(policy.isDomainWhitelisted('https://bit.ly/abc')).toBe(true)
    expect(policy.isDomainWhitelisted('https://unknown.example/video')).toBe(false)
  })

  it('checks full normalized referers', () => {
    const policy = new AccessPolicy({ refererBlacklist: 'https://www.bad.example/path/' })
    expect(policy.isRefererBlacklisted('http://bad.example/path')).toBe(true)
    expect(policy.isRefererBlacklisted('http://bad.example/other')).toBe(false)
  })

  it('matches title blacklist words in both legacy directions', () => {
    const policy = new AccessPolicy({ titleBlacklist: 'forbidden phrase\nblocked' })
    expect(policy.isTitleBlacklisted('A forbidden phrase appears')).toBe(true)
    expect(policy.isTitleBlacklisted('forbidden')).toBe(true)
    expect(policy.isTitleBlacklisted('ordinary title')).toBe(false)
  })

  it('checks country codes and configured VPN ranges', () => {
    const policy = new AccessPolicy({
      bannedCountries: ['FR', 'DE'],
      blockVpn: true,
      vpnPrefixes: ['203.0.113.0/24', '2001:db8::/32', '198.51.100.']
    })
    expect(policy.isCountryBlacklisted('fr')).toBe(true)
    expect(policy.isProxyVpnBlacklisted('203.0.113.42')).toBe(true)
    expect(policy.isProxyVpnBlacklisted('2001:db8:1::1')).toBe(true)
    expect(policy.isProxyVpnBlacklisted('198.51.100.9')).toBe(true)
    expect(policy.isProxyVpnBlacklisted('192.0.2.1')).toBe(false)
  })
})

describe('access policy helpers', () => {
  it('extracts host and non-default port', () => {
    expect(getHostOrigin('https://Example.test:8443/path')).toBe('example.test:8443')
    expect(getHostOrigin('https://Example.test/path', true)).toBe('https://example.test')
  })

  it.each([
    ['192.168.1.42', '192.168.1.0/24', true],
    ['192.168.2.42', '192.168.1.0/24', false],
    ['2001:db8:abcd::1', '2001:db8::/32', true],
    ['2001:db9::1', '2001:db8::/32', false],
    ['::ffff:192.0.2.128', '::ffff:192.0.2.0/120', true],
    ['not-an-ip', '192.168.1.0/24', false]
  ])('checks %s in %s', (ip, range, expected) => {
    expect(isIpInRange(ip, range)).toBe(expected)
  })
})
