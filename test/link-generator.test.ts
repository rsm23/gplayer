import { describe, expect, it } from 'vitest'
import { parsePlayerQuery } from '../src/core/player-query.js'
import { PlayerLinkGenerator } from '../src/player/link-generator.js'
import { Security } from '../src/security/security.js'
import { securitySalt } from './fixtures/security-cases.js'

describe('player link generator', () => {
  const security = new Security(securitySalt, { randomBytes: (size) => Buffer.alloc(size, 9) })
  const generator = new PlayerLinkGenerator(security, {
    baseUrl: new URL('https://player.example/base/'),
    embedSlug: 'e',
    downloadSlug: 'd',
    requestSlug: 'r'
  })

  it('emits the embed, download, request, and iframe contract', () => {
    const result = generator.generate({
      id: 'https://streamwish.to/e/main-id',
      aid: 'https://vidhide.com/v/alt-id',
      poster: 'https://img.example/poster.jpg',
      sub: ['https://sub.example/en.vtt'],
      lang: ['English'],
      uid: '86Rf07'
    })

    expect(result.query).toEqual({
      host: 'streamhg',
      id: 'main-id',
      ahost: 'earnvids',
      aid: 'alt-id',
      poster: 'https://img.example/poster.jpg',
      sub: ['https://sub.example/en.vtt'],
      lang: ['English'],
      uid: '86Rf07'
    })
    expect(result.embedUrl).toBe(`https://player.example/base/e/?${result.token}`)
    expect(result.downloadUrl).toBe(`https://player.example/base/d/?${result.token}`)
    expect(result.requestUrl).toContain('https://player.example/base/r/?host=streamhg&id=main-id')
    expect(result.embedCode).toContain(`src="${result.embedUrl}"`)

    const parsed = parsePlayerQuery(result.token, security, { secureSalt: securitySalt })
    expect(parsed.media).toEqual(result.query)
  })

  it('rejects non-http URLs and URLs containing credentials', () => {
    expect(() => generator.generate({ id: 'file:///tmp/video.mp4' })).toThrow(/HTTP/)
    expect(() => generator.generate({ id: 'https://user:pass@example.com/video.mp4' })).toThrow(/credentials/)
  })

  it('accepts only bounded default-alphabet Sqids user identifiers', () => {
    expect(generator.generate({ id: 'https://cdn.example/video.mp4', uid: 'Jg' }).query.uid).toBe('Jg')
    expect(generator.generate({ id: 'https://cdn.example/video.mp4', uid: '42-' }).query.uid).toBeUndefined()
  })

  it('applies an administrator-provided iframe template without executing it', () => {
    const custom = new PlayerLinkGenerator(security, {
      baseUrl: new URL('https://player.example/'),
      embedSlug: 'watch',
      downloadSlug: 'fetch',
      requestSlug: 'request-player',
      iframeCode: '<iframe title="{title}" data-player="custom" src="{embed_url}"></iframe>'
    })
    const result = custom.generate({ id: 'https://cdn.example/video.mp4' })
    expect(result.embedCode).toBe(`<iframe title="" data-player="custom" src="${result.embedUrl}"></iframe>`)
  })
})
