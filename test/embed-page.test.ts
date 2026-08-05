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
        window_opacity: '35',
        default_resolution: '700',
        default_audio: 'French',
        default_subtitle: 'Spanish'
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
      expect(html).toContain('data-default-resolution="700"')
      expect(html).toContain('data-default-audio="French"')
      expect(html).toContain('data-default-audio-key="fr"')
      expect(html).toContain('data-default-subtitle="Spanish"')
      expect(html).toContain('data-default-subtitle-key="es"')
    }
  })

  it('does not leave a loading indicator on an unavailable source', () => {
    const settings = playerSettings({}, defaults)
    const html = renderEmbedPage({}, publicOptions, undefined, { settings, downloadUrl: '' })

    expect(html).toContain('The player query does not contain a source.')
    expect(html).not.toContain('data-player-loader')
  })

  it('publishes only the signed token and bounded playback threshold needed by the view counter', () => {
    const settings = playerSettings({}, defaults)
    const html = renderEmbedPage(
      { host: 'direct', id: 'https://media.example.test/video.mp4' },
      publicOptions,
      undefined,
      { settings, downloadUrl: '', viewCounter: { token: 'signed_token-123', runtime: 17 } }
    )

    expect(html).toContain('data-view-counter-token="signed_token-123"')
    expect(html).toContain('data-view-counter-runtime="17"')
    expect(html).not.toContain('https://media.example.test/video.mp4" data-view-counter')
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

  it('publishes P2P transport only for configured Plyr HLS and DASH media', () => {
    const settings = playerSettings({
      player: 'plyr',
      p2p: 'true',
      torrent_tracker: 'wss://tracker.example/socket\nws://tracker2.example/announce'
    }, defaults)
    const options = { settings, downloadUrl: '', p2pSwarmId: 'a'.repeat(64) }
    const hls = renderEmbedPage(
      { host: 'direct', id: 'https://media.example.test/live.m3u8' },
      publicOptions,
      undefined,
      options
    )
    const serialized = hls.match(/<script type="application\/json" data-p2p-config>([\s\S]*?)<\/script>/)?.[1]
    expect(JSON.parse(serialized ?? '')).toEqual({
      swarmId: 'a'.repeat(64),
      trackers: ['wss://tracker.example/socket', 'ws://tracker2.example/announce']
    })
    expect(hls).toContain('<script type="importmap">')
    expect(hls).toContain('/assets/vendor/hls.js/1.6.4/hls.min.js')
    expect(hls).not.toContain(' src="https://media.example.test/live.m3u8"')

    const dash = renderEmbedPage(
      { host: 'direct', id: 'https://media.example.test/manifest.mpd' },
      publicOptions,
      undefined,
      options
    )
    expect(dash).toContain('/assets/vendor/shaka-player/2.5.23/shaka-player.compiled.js')
    expect(dash).toContain('/assets/vendor/p2p-media-loader-core/0.6.2/p2p-media-loader-core.min.js')
    expect(dash).toContain('/assets/vendor/p2p-media-loader-shaka/0.6.2/p2p-media-loader-shaka.min.js')
    expect(dash).not.toContain(' src="https://media.example.test/manifest.mpd"')

    const jw = renderEmbedPage(
      { host: 'direct', id: 'https://media.example.test/live.m3u8' },
      publicOptions,
      undefined,
      { settings: playerSettings({ player: 'jwplayer', p2p: 'true' }, defaults), downloadUrl: '', p2pSwarmId: 'a'.repeat(64) }
    )
    expect(jw).not.toContain('data-p2p-config')
    expect(jw).not.toContain('p2p-media-loader')
  })
})
