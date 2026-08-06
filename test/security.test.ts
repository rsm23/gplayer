import { describe, expect, it } from 'vitest'
import {
  decryptLegacyData,
  decodeLegacyBase64Url,
  encodeLegacyBase64Url,
  Security
} from '../src/security/security.js'
import {
  legacyDataCases,
  responseCases,
  securityCases,
  securitySalt
} from './fixtures/security-cases.js'

describe('security token compatibility', () => {
  const security = new Security(securitySalt)

  it.each(securityCases)('decrypts protected-runtime fixture: $plainText', (fixture) => {
    expect(security.decryptStrict(fixture.encrypted)).toBe(fixture.plainText)
    expect(security.decryptURLStrict(fixture.urlToken)).toBe(fixture.plainText)
  })

  it.each(responseCases)('decrypts encryptResponse fixture: $plainText', (fixture) => {
    expect(security.decryptResponseStrict(fixture.encrypted, fixture.password)).toBe(
      fixture.plainText
    )
  })

  it('round-trips current tokens and URL tokens', () => {
    const plainText = 'source=direct&id=https%3A%2F%2Fcdn.example.test%2Fvideo.m3u8'
    const encrypted = security.encrypt(plainText)
    const urlToken = security.encryptURL(plainText)

    expect(security.decryptStrict(encrypted)).toBe(plainText)
    expect(security.decryptURLStrict(urlToken)).toBe(plainText)
  })

  it('authenticates tokens before decrypting them', () => {
    const envelope = Buffer.from(security.encrypt('hello'), 'base64')
    envelope[20] = (envelope[20] ?? 0) ^ 1
    const tampered = envelope.toString('base64')

    expect(security.decryptStrict(tampered)).toBeNull()
    expect(security.decrypt(tampered)).toBe(tampered)
  })

  it('rejects malformed values in strict mode while preserving the legacy fallback', () => {
    expect(security.decryptStrict('not-a-token')).toBeNull()
    expect(security.decrypt('not-a-token')).toBe('not-a-token')
    expect(security.decryptURLStrict('not-a-token')).toBeNull()
  })

  it('reuses the legacy encryption cache for identical plaintext', () => {
    expect(security.encrypt('cached')).toBe(security.encrypt('cached'))
  })

  it('creates and validates API salt tokens', () => {
    const token = security.encryptApiSalt()
    expect(security.validateApiSalt(token)).toBe(true)
    expect(security.validateApiSalt('kntlMmkLuCoeg')).toBe(false)
  })

  it('uses the legacy -_, URL alphabet', () => {
    const value = '\u00fb\u00ff\u00fe?'
    const encoded = encodeLegacyBase64Url(value)
    expect(encoded).not.toMatch(/[+/=]/)
    expect(decodeLegacyBase64Url(encoded)).toBe(value)
  })
})

describe('legacy SecurityHelper data compatibility', () => {
  it.each(legacyDataCases)('decrypts AES-128 fixture: $plainText', (fixture) => {
    expect(decryptLegacyData(fixture.encrypted, securitySalt)).toBe(fixture.plainText)
  })

  it('returns an empty string for malformed values', () => {
    expect(decryptLegacyData('not-a-token', securitySalt)).toBe('')
    expect(decryptLegacyData(null, securitySalt)).toBe('')
  })
})
