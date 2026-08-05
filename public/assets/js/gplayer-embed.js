(() => {
  'use strict'

  const video = document.querySelector('#media-player')
  if (!(video instanceof HTMLVideoElement)) return

  const source = video.dataset.source
  const kind = video.dataset.sourceKind
  if (!source || (kind !== 'hls' && kind !== 'dash')) return

  const showFallback = (message) => {
    video.insertAdjacentHTML('afterend', `<p class="player-fallback">${message}</p>`)
  }

  if (kind === 'dash') {
    if (typeof window.shaka !== 'object' || typeof window.shaka.Player !== 'function') {
      showFallback('MPEG-DASH playback is not supported in this browser.')
      return
    }
    window.shaka.polyfill.installAll()
    if (!window.shaka.Player.isBrowserSupported()) {
      showFallback('MPEG-DASH playback is not supported in this browser.')
      return
    }
    const player = new window.shaka.Player()
    player.attach(video)
      .then(() => player.load(source))
      .catch(() => showFallback('The MPEG-DASH stream could not be loaded.'))
    return
  }

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = source
    return
  }

  if (typeof window.Hls === 'function' && window.Hls.isSupported()) {
    const hls = new window.Hls({ enableWorker: true })
    hls.loadSource(source)
    hls.attachMedia(video)
    return
  }

  showFallback('HLS playback is not supported in this browser.')
})()
