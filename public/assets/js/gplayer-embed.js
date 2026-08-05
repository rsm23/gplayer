(() => {
  'use strict'

  const body = document.body
  const video = document.querySelector('#media-player')

  const initializePlayerAppearance = () => {
    if (/^#[a-f0-9]{6}$/i.test(body.dataset.playerColor || '')) {
      document.documentElement.style.setProperty('--brand', body.dataset.playerColor)
    }
    if (/^#[a-f0-9]{6}$/i.test(body.dataset.playerColor2 || '')) {
      document.documentElement.style.setProperty('--brand-secondary', body.dataset.playerColor2)
    }
    document.querySelectorAll('[data-player-logo]').forEach((logo) => {
      const margin = Number.parseInt(logo.dataset.logoMargin || body.dataset.logoMargin || '0', 10)
      const container = logo.closest('.player-logo, .player-small-logo')
      if (container instanceof HTMLElement && Number.isInteger(margin) && margin >= 0 && margin <= 1_000) {
        container.style.setProperty('--logo-margin', `${margin}px`)
      }
    })
  }

  const fakePlay = document.querySelector('[data-player-fake-play]')
  fakePlay?.addEventListener('click', () => {
    if (!(video instanceof HTMLVideoElement)) return
    video.play().catch(() => {})
    fakePlay.remove()
  })
  if (video instanceof HTMLVideoElement) video.addEventListener('play', () => fakePlay?.remove(), { once: true })

  document.querySelector('[data-player-share]')?.addEventListener('click', async () => {
    try {
      if (typeof navigator.share === 'function') await navigator.share({ title: document.title, url: window.location.href })
      else if (navigator.clipboard) await navigator.clipboard.writeText(window.location.href)
    } catch {
      // Cancellation and unavailable clipboard permissions leave the player unchanged.
    }
  })

  const initializeVisibilityPause = () => {
    if (body.dataset.pauseOnLeft !== 'true' || !(video instanceof HTMLVideoElement)) return
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && !video.paused) video.pause()
    })
  }

  const initializeContinueWatching = () => {
    if (body.dataset.continueWatching !== 'true' || !(video instanceof HTMLVideoElement)) return
    const prompt = document.querySelector('[data-player-resume]')
    const promptText = document.querySelector('[data-player-resume-text]')
    const yes = document.querySelector('[data-player-resume-yes]')
    const no = document.querySelector('[data-player-resume-no]')
    if (!(prompt instanceof HTMLElement) || !(promptText instanceof HTMLElement)) return
    const storageKey = `gplayer:position:${window.location.pathname}:${window.location.search.slice(0, 512)}`
    let lastStoredSecond = -1
    const hidePrompt = () => { prompt.hidden = true }
    const forget = () => {
      try { window.localStorage.removeItem(storageKey) } catch {}
    }
    video.addEventListener('loadedmetadata', () => {
      let saved = 0
      try { saved = Number.parseFloat(window.localStorage.getItem(storageKey) || '0') } catch {}
      if (!Number.isFinite(saved) || saved < 5 || !Number.isFinite(video.duration) || saved >= video.duration - 5) return
      video.pause()
      promptText.textContent = promptText.textContent.replace('hh:mm:ss', formatTime(saved))
      prompt.hidden = false
      yes?.addEventListener('click', () => {
        video.currentTime = saved
        hidePrompt()
        video.play().catch(() => {})
      }, { once: true })
      no?.addEventListener('click', () => {
        forget()
        video.currentTime = 0
        hidePrompt()
      }, { once: true })
    }, { once: true })
    video.addEventListener('timeupdate', () => {
      const second = Math.floor(video.currentTime)
      if (second === lastStoredSecond || second < 1) return
      lastStoredSecond = second
      try { window.localStorage.setItem(storageKey, String(second)) } catch {}
    })
    video.addEventListener('ended', forget)
  }

  const formatTime = (seconds) => {
    const value = Math.max(0, Math.floor(seconds))
    const hours = Math.floor(value / 3_600)
    const minutes = Math.floor((value % 3_600) / 60)
    const remainder = value % 60
    return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':')
  }

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

  initializePlayerAppearance()
  initializeStreamingPlayback()
  initializeVisibilityPause()
  initializeContinueWatching()
  initializeAdblockDetection()
  if (body.dataset.popupFrameUrl && Number.parseInt(body.dataset.popupDelaySeconds || '0', 10) === 0) {
    mountPopupFrame()
  }
})()
