import { describe, expect, it } from 'vitest'
import { renderEmbedPage } from '../src/player/embed-page.js'
import { PLAYER_LOADERS, playerSettings } from '../src/settings/player-settings.js'

const defaults = Object.freeze({ embed: 'e', download: 'd', request: 'r' })
const publicOptions = Object.freeze({ autoplay: false, mute: false, repeat: false })

describe('native embed appearance', () => {
  it('renders every configured loader and the bounded caption-style contract', () => {
    for (const loader of PLAYER_LOADERS) {
      const settings = playerSettings({
        loader,
        text_loading: 'Preparing <media>',
        subtitle_color: '12abef',
        font_family: 'Trebuchet MS',
        edge_style: 'uniform',
        background_color: '102030',
        background_opacity: '65',
        window_color: '405060',
        window_opacity: '35'
      }, defaults)
      const html = renderEmbedPage(
        { host: 'direct', id: 'https://media.example.test/video.mp4' },
        publicOptions,
        undefined,
        { settings, downloadUrl: '' }
      )

      expect(html).toContain(`class="player-loader player-loader-${loader}"`)
      expect(html).toContain('data-player-loader')
      expect(html).toContain('Preparing &lt;media&gt;')
      expect(html).toContain('data-caption-color="#12abef"')
      expect(html).toContain('data-caption-font="Trebuchet MS"')
      expect(html).toContain('data-caption-edge="uniform"')
      expect(html).toContain('data-caption-background-color="#102030"')
      expect(html).toContain('data-caption-background-opacity="65"')
      expect(html).toContain('data-caption-window-color="#405060"')
      expect(html).toContain('data-caption-window-opacity="35"')
    }
  })

  it('does not leave a loading indicator on an unavailable source', () => {
    const settings = playerSettings({}, defaults)
    const html = renderEmbedPage({}, publicOptions, undefined, { settings, downloadUrl: '' })

    expect(html).toContain('The player query does not contain a source.')
    expect(html).not.toContain('data-player-loader')
  })

  it('selects only the configured local player stylesheet', () => {
    const plyr = renderEmbedPage(
      { host: 'direct', id: 'https://media.example.test/video.mp4' },
      publicOptions,
      undefined,
      { settings: playerSettings({ player: 'plyr' }, defaults), downloadUrl: '' }
    )
    expect(plyr).toContain('data-player-library="plyr"')
    expect(plyr).toContain('/assets/vendor/plyr/3.6.3/plyr-custom.min.css')
    expect(plyr).not.toContain('/assets/skin/jwplayer/')

    const jwplayer = renderEmbedPage(
      { host: 'direct', id: 'https://media.example.test/video.mp4' },
      publicOptions,
      undefined,
      { settings: playerSettings({ player: 'jwplayer', player_skin: 'hotstar' }, defaults), downloadUrl: '' }
    )
    expect(jwplayer).toContain('data-player-library="jwplayer"')
    expect(jwplayer).toContain('/assets/skin/jwplayer/hotstar.min.css')
    expect(jwplayer).not.toContain('/assets/vendor/plyr/3.6.3/plyr-custom.min.css')
    expect(jwplayer).not.toContain(' src="https://media.example.test/video.mp4"')
  })
})
