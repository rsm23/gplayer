(() => {
  'use strict'

  const body = document.body
  const video = document.querySelector('#media-player')

  const showFallback = (message) => {
    if (!(video instanceof HTMLVideoElement)) return
    const fallback = document.createElement('p')
    fallback.className = 'player-fallback'
    fallback.textContent = message
    video.insertAdjacentElement('afterend', fallback)
  }

  const initializeStreamingPlayback = () => {
    if (!(video instanceof HTMLVideoElement)) return
    const source = video.dataset.source
    const kind = video.dataset.sourceKind
    if (!source || (kind !== 'hls' && kind !== 'dash')) return

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
  }

  const mountPopupFrame = () => {
    const url = body.dataset.popupFrameUrl
    if (!url || document.querySelector('[data-popup-ad-frame]')) return
    const frame = document.createElement('iframe')
    frame.className = 'popup-ad-frame'
    frame.dataset.popupAdFrame = ''
    frame.src = url
    frame.title = 'Advertisement'
    frame.referrerPolicy = 'no-referrer'
    frame.setAttribute('sandbox', 'allow-forms allow-popups allow-popups-to-escape-sandbox allow-scripts')
    document.body.append(frame)
  }

  let delayedPopupScheduled = false
  const scheduleDelayedPopup = () => {
    if (delayedPopupScheduled || !body.dataset.popupFrameUrl) return
    const delay = Number.parseInt(body.dataset.popupDelaySeconds || '0', 10)
    if (!Number.isFinite(delay) || delay <= 0) return
    delayedPopupScheduled = true
    // The supplied player increments a one-second counter and injects after it exceeds the offset.
    window.setTimeout(mountPopupFrame, (delay + 1) * 1_000)
  }

  const showDirectAdFrame = (url) => {
    const panel = document.querySelector('[data-direct-ad-panel]')
    const frame = document.querySelector('[data-direct-ad-frame]')
    if (!(panel instanceof HTMLElement) || !(frame instanceof HTMLIFrameElement)) return
    frame.src = url
    panel.hidden = false
  }

  const visitDirectAd = () => {
    const url = body.dataset.directAdUrl
    if (body.dataset.directAdOnPlay !== 'true' || !url || url === '#') return
    let opened
    try {
      opened = window.open(url, '_blank')
      if (opened) opened.opener = null
    } catch {
      opened = null
    }
    if (body.dataset.directAdIframe === 'true') {
      window.setTimeout(() => {
        if (opened === null || opened === undefined) showDirectAdFrame(url)
      }, 3_000)
    }
  }

  let playAdsVisited = false
  const visitPlayAds = () => {
    if (playAdsVisited) return
    playAdsVisited = true
    visitDirectAd()
    scheduleDelayedPopup()
  }

  const closeButton = document.querySelector('[data-direct-ad-close]')
  closeButton?.addEventListener('click', () => {
    const panel = document.querySelector('[data-direct-ad-panel]')
    const frame = document.querySelector('[data-direct-ad-frame]')
    if (frame instanceof HTMLIFrameElement) frame.removeAttribute('src')
    if (panel instanceof HTMLElement) panel.hidden = true
  })

  if (video instanceof HTMLVideoElement) video.addEventListener('play', visitPlayAds, { once: true })
  const providerGate = document.querySelector('[data-provider-ad-gate]')
  providerGate?.addEventListener('click', () => {
    visitPlayAds()
    providerGate.remove()
  }, { once: true })

  const initializeAdblockDetection = () => {
    if (body.dataset.blockAdblocker !== 'true') return
    const bait = document.createElement('img')
    bait.id = 'advertisement'
    bait.className = 'ad-banner ad-container sponsored'
    bait.alt = ''
    bait.tabIndex = -1
    bait.hidden = true
    let finished = false
    const showBlocked = () => {
      if (finished) return
      finished = true
      body.classList.add('is-adblocked')
      if (video instanceof HTMLVideoElement) video.pause()
      const notice = document.querySelector('[data-adblock-notice]')
      if (notice instanceof HTMLElement) notice.hidden = false
    }
    bait.addEventListener('load', () => {
      finished = true
      bait.remove()
    }, { once: true })
    bait.addEventListener('error', showBlocked, { once: true })
    bait.src = `/ads/advertisement.png?${Date.now()}`
    document.body.append(bait)
    window.setTimeout(showBlocked, 3_000)
  }

  initializeStreamingPlayback()
  initializeAdblockDetection()
  if (body.dataset.popupFrameUrl && Number.parseInt(body.dataset.popupDelaySeconds || '0', 10) === 0) {
    mountPopupFrame()
  }
})()
