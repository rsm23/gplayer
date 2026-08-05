import { describe, expect, it } from 'vitest'
import {
  analyticsConfig,
  analyticsCspSources,
  hasAnalytics,
  histatsOnly,
  renderAnalyticsHead,
  renderAnalyticsNoScript
} from '../src/player/analytics.js'

describe('bounded analytics runtime', () => {
  it('normalizes supported identifiers and renders inert configuration plus no-script fallbacks', () => {
    const config = analyticsConfig({
      google_analytics_id: ' g-abc1234 ',
      google_tag_manager: ' gtm-test123 ',
      histats_id: '3590204'
    })

    expect(config).toEqual({
      googleAnalyticsId: 'G-ABC1234',
      googleTagManagerId: 'GTM-TEST123',
      histatsId: '3590204'
    })
    expect(renderAnalyticsHead(config)).toContain('data-google-analytics-id="G-ABC1234"')
    expect(renderAnalyticsHead(config)).toContain('src="/assets/js/gplayer-analytics.js"')
    expect(renderAnalyticsHead(config)).not.toContain('gtag(')
    expect(renderAnalyticsNoScript(config)).toContain('ns.html?id=GTM-TEST123')
    expect(renderAnalyticsNoScript(config)).toContain('0.gif?3590204&amp;101')
  })

  it('rejects malformed or executable values without emitting markup or CSP allowances', () => {
    const config = analyticsConfig({
      google_analytics_id: 'G-ABC123</meta><script>alert(1)</script>',
      google_tag_manager: 'https://attacker.example/script.js',
      histats_id: '1&redirect=https://attacker.example'
    })

    expect(hasAnalytics(config)).toBe(false)
    expect(renderAnalyticsHead(config)).toBe('')
    expect(renderAnalyticsNoScript(config)).toBe('')
    expect(analyticsCspSources(config)).toEqual({ scripts: [], connections: [], images: [], frames: [] })
  })

  it('keeps the legacy download-error behavior limited to Histats', () => {
    const config = histatsOnly(analyticsConfig({
      google_analytics_id: 'UA-123456-7',
      google_tag_manager: 'GTM-ABC123',
      histats_id: '123456'
    }))

    expect(config).toEqual({ googleAnalyticsId: '', googleTagManagerId: '', histatsId: '123456' })
    expect(renderAnalyticsNoScript(config)).not.toContain('googletagmanager.com')
    expect(renderAnalyticsNoScript(config)).toContain('0.gif?123456&amp;101')
  })
})
