import { createCipheriv } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildPlayerQuery,
  normalizeLegacyHost,
  parsePlayerQuery,
  playerMediaCandidates
} from '../src/core/player-query.js'
import { Security } from '../src/security/security.js'
import { securitySalt } from './fixtures/security-cases.js'

const security = new Security(securitySalt, {
  randomBytes: (size) => Buffer.alloc(size, 7)
})

describe('player query contract', () => {
  it('parses the authenticated URL token emitted by the 4.8.3 generator', () => {
    const query = buildPlayerQuery({
      host: 'streamwish',
      id: 'video id',
      ahost: 'vidhide',
      aid: 'alternative',
      poster: 'https://img.example/poster.jpg',
      sub: ['https://sub.example/en.vtt', 'https://sub.example/fr.vtt'],
      lang: ['English', 'French'],
      source: 'remote',
      uid: '42'
    })
    const token = security.encryptURL(query)
    const parsed = parsePlayerQuery(`${token}&autoplay=1&mute=yes`, security, {
      secureSalt: securitySalt,
      allowPublicQuery: true
    })

    expect(parsed.encoding).toBe('security-url')
    expect(parsed.media).toEqual({
      host: 'streamhg',
      id: 'video id',
      ahost: 'earnvids',
      aid: 'alternative',
      poster: 'https://img.example/poster.jpg',
      sub: ['https://sub.example/en.vtt', 'https://sub.example/fr.vtt'],
      lang: ['English', 'French'],
      source: 'remote',
      uid: '42'
    })
    expect(parsed.publicOptions).toEqual({ autoplay: true, mute: true, repeat: false })
    expect(parsed.errors).toEqual([])
  })

  it('authenticates before parsing and does not fall back to injected plaintext values', () => {
    const token = security.encryptURL('host=direct&id=https%3A%2F%2Fcdn.example%2Fa.mp4')
    const tampered = `${token.slice(0, -1)}A`
    const parsed = parsePlayerQuery(`${tampered}&host=direct&id=https://attacker.example/x.mp4`, security, {
      secureSalt: securitySalt
    })

    expect(parsed.encoding).toBe('none')
    expect(parsed.media).toBeNull()
    expect(parsed.errors).toContain('Query token is malformed or failed authentication')
  })

  it('accepts plaintext media only for the explicit request/embed2 route', () => {
    const raw = 'host=filelions&id=abc&sub%5B%5D=a.vtt&sub%5B%5D=b.vtt&lang%5B%5D=en&lang%5B%5D=fr'
    const denied = parsePlayerQuery(raw, security, { secureSalt: securitySalt })
    const allowed = parsePlayerQuery(raw, security, {
      secureSalt: securitySalt,
      allowPlaintextMedia: true
    })

    expect(denied.media).toBeNull()
    expect(allowed.encoding).toBe('plaintext')
    expect(allowed.media).toEqual({
      host: 'earnvids',
      id: 'abc',
      sub: ['a.vtt', 'b.vtt'],
      lang: ['en', 'fr']
    })
  })

  it('reads pre-4.8 AES-128 links when their payload is a media query', () => {
    const oldToken = createLegacyToken('host=vidhide&id=legacy&source=remote')
    const parsed = parsePlayerQuery(oldToken, security, { secureSalt: securitySalt })

    expect(parsed.encoding).toBe('legacy-aes')
    expect(parsed.media).toEqual({ host: 'earnvids', id: 'legacy', source: 'remote' })
  })

  it('keeps configured player controls unless public queries are enabled', () => {
    const token = security.encryptURL('source=db&id=15')
    const denied = parsePlayerQuery(`${token}&autoplay=0&mute=1&repeat=1`, security, {
      secureSalt: securitySalt,
      publicDefaults: { autoplay: true, mute: false, repeat: false }
    })
    const allowed = parsePlayerQuery(`${token}&autoplay=off&mute=on&repeat=true`, security, {
      secureSalt: securitySalt,
      allowPublicQuery: true,
      publicDefaults: { autoplay: true, mute: false, repeat: false }
    })

    expect(denied.publicOptions).toEqual({ autoplay: true, mute: false, repeat: false })
    expect(allowed.publicOptions).toEqual({ autoplay: false, mute: true, repeat: true })
  })

  it('reproduces buildQueryNoIndex encoding and repeated arrays', () => {
    expect(buildPlayerQuery({
      host: 'direct',
      id: 'https%3A%2F%2Fcdn.example%2Fa%20b.mp4',
      sub: ['one file.vtt', 'deux.vtt'],
      lang: ['English', 'Français']
    })).toBe(
      'host=direct&id=https%3A%2F%2Fcdn.example%2Fa+b.mp4&sub[]=one+file.vtt&sub[]=deux.vtt&lang[]=English&lang[]=Fran%C3%A7ais'
    )
  })

  it('orders and deduplicates primary, legacy alternative, and persisted playback candidates', () => {
    expect(playerMediaCandidates({
      host: 'streamhg',
      id: 'primary',
      ahost: 'direct',
      aid: 'https://cdn.example/backup.mp4',
      alternatives: [
        { host: 'direct', id: 'https://cdn.example/backup.mp4' },
        { host: 'vimeo', id: 'last' },
        { host: '', id: 'ignored' }
      ]
    })).toEqual([
      { host: 'streamhg', id: 'primary' },
      { host: 'direct', id: 'https://cdn.example/backup.mp4' },
      { host: 'vimeo', id: 'last' }
    ])
  })

  it.each([
    ['filelions', 'earnvids'],
    ['vidhide', 'earnvids'],
    ['streamwish', 'streamhg'],
    ['YouTube', 'youtube']
  ])('normalizes legacy host alias %s', (input, expected) => {
    expect(normalizeLegacyHost(input)).toBe(expected)
  })

  it('rejects oversized query strings before attempting compatibility parsing', () => {
    const parsed = parsePlayerQuery(`x${'a'.repeat(33_000)}`, security, {
      secureSalt: securitySalt,
      allowPlaintextMedia: true
    })

    expect(parsed.media).toBeNull()
    expect(parsed.errors[0]).toMatch(/exceeds/)
  })
})

function createLegacyToken(plainText: string): string {
  const iv = Buffer.from('1234567890abcdef', 'utf8')
  const decodedSalt = Buffer.from(securitySalt.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  const keySource = decodedSalt.length > 0 ? decodedSalt : Buffer.from(securitySalt, 'utf8')
  const key = Buffer.alloc(16)
  keySource.copy(key, 0, 0, 16)
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]).toString('base64')
  return Buffer.from(`${encrypted}::${iv.toString('utf8')}`, 'utf8').toString('base64')
}
