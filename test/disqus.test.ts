import { describe, expect, it } from 'vitest'
import { disqusConfig, disqusCsp, renderDisqus } from '../src/player/disqus.js'

describe('bounded Disqus homepage integration', () => {
  it('normalizes a DNS-safe shortname and preserves the configured canonical page URL', () => {
    const config = disqusConfig(
      { disqus_shortname: ' Community-42 ' },
      new URL('https://player.example/base/')
    )

    expect(config).toEqual({
      shortname: 'community-42',
      pageUrl: 'https://player.example/base/',
      pageIdentifier: 'https://player.example/base/'
    })
    expect(renderDisqus(config)).toContain('data-disqus-shortname="community-42"')
    expect(renderDisqus(config)).toContain('src="/assets/js/gplayer-disqus.js"')
    expect(renderDisqus(config)).not.toContain('community-42.disqus.com/embed.js')
    expect(disqusCsp(config).scripts).toContain('https://community-42.disqus.com')
  })

  it('rejects executable, dotted, oversized, and malformed shortnames', () => {
    for (const shortname of [
      'comments.example.com',
      'bad"><script>alert(1)</script>',
      '-leading',
      'trailing-',
      'a'.repeat(64)
    ]) {
      const config = disqusConfig({ disqus_shortname: shortname }, new URL('https://player.example/'))
      expect(config).toBeNull()
      expect(renderDisqus(config)).toBe('')
      expect(disqusCsp(config)).toEqual({ scripts: [], connections: [], images: [], frames: [] })
    }
  })
})
