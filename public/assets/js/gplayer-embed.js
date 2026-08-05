(() => {
  'use strict'

  const body = document.body
  const video = document.querySelector('#media-player')
  let fallbackStarted = false
  let cacheRefreshAttempted = false
  const cacheToken = body.dataset.playerCacheToken || ''
  const cacheRetryKey = `gplayer:cache-refresh:${window.location.pathname}:${window.location.search.slice(0, 512)}`
  const cacheRetryHash = '#gplayer-cache-refresh'

  const cacheRefreshWasAttempted = () => {
    try {
      return window.sessionStorage.getItem(cacheRetryKey) === '1'
    } catch {
      return cacheRefreshAttempted || window.location.hash === cacheRetryHash
    }
  }

  const markCacheRefreshAttempted = () => {
    cacheRefreshAttempted = true
    try {
      window.sessionStorage.setItem(cacheRetryKey, '1')
    } catch {
      // Sandboxed embeds and privacy modes may deny access to session storage.
      window.location.hash = cacheRetryHash
    }
  }

  const clearCacheRefreshAttempt = () => {
    cacheRefreshAttempted = false
    try {
      window.sessionStorage.removeItem(cacheRetryKey)
    } catch {
      // The fragment fallback below remains available when storage is blocked.
    }
    if (window.location.hash === cacheRetryHash) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
    }
  }

  const fallbackUrl = (() => {
    const value = body.dataset.playerFallbackUrl || ''
    if (!value) return ''
    try {
      const url = new URL(value, window.location.href)
      return url.origin === window.location.origin && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        ? url.toString()
        : ''
    } catch {
      return ''
    }
  })()

  const switchToFallback = () => {
    if (fallbackStarted || !fallbackUrl) return false
    fallbackStarted = true
    window.location.replace(fallbackUrl)
    return true
  }

  const recoverFromPlaybackFailure = () => {
    if (fallbackStarted) return true
    if (!cacheToken || cacheRefreshWasAttempted()) return switchToFallback()
    fallbackStarted = true
    markCacheRefreshAttempted()
    const payload = new URLSearchParams({ action: 'clearVideoCache', data: cacheToken })
    void window.fetch('/ajax/public/', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: payload.toString()
    }).finally(() => window.location.reload())
    return true
  }

  if (video instanceof HTMLVideoElement) {
    video.addEventListener('error', recoverFromPlaybackFailure)
    video.addEventListener('canplay', clearCacheRefreshAttempt, { once: true })
  }

  const enforceEmbedOnly = () => {
    if (body.dataset.embedOnly !== 'true' || window.self !== window.top) return true
    document.title = 'Player unavailable'
    const stage = document.createElement('main')
    stage.className = 'player-stage'
    const notice = document.createElement('div')
    notice.className = 'player-notice player-error'
    const label = document.createElement('span')
    label.textContent = 'GDPlayer'
    const heading = document.createElement('h1')
    heading.textContent = 'Player unavailable'
    const message = document.createElement('p')
    message.textContent = 'This player is available only when embedded in a page.'
    notice.append(label, heading, message)
    stage.append(notice)
    body.replaceChildren(stage)
    return false
  }

  if (!enforceEmbedOnly()) return

  const readVastConfiguration = () => {
    const element = document.querySelector('[data-vast-config]')
    if (!(element instanceof HTMLScriptElement)) return null
    try {
      const parsed = JSON.parse(element.textContent || '')
      if (parsed === null || typeof parsed !== 'object' || !['vast', 'googima'].includes(parsed.client)) return null
      if (!Array.isArray(parsed.schedule) || parsed.schedule.length > 20) return null
      const schedule = parsed.schedule.flatMap((item) => {
        if (item === null || typeof item !== 'object' || typeof item.tag !== 'string' || typeof item.offset !== 'string') return []
        try {
          const tag = new URL(item.tag)
          if (!['http:', 'https:'].includes(tag.protocol) || tag.username || tag.password || item.offset.length > 32) return []
          return [{ tag: tag.toString(), offset: item.offset }]
        } catch {
          return []
        }
      })
      if (schedule.length !== parsed.schedule.length) return null
      const boundedInteger = (value, fallbackValue, maximum) => Number.isInteger(value) && value >= 0 && value <= maximum ? value : fallbackValue
      return {
        client: parsed.client,
        schedule,
        skipoffset: boundedInteger(parsed.skipoffset, 0, 86_400),
        skipmessage: 'Skip XX',
        creativeTimeout: boundedInteger(parsed.creativeTimeout, 60_000, 60_000),
        loadVideoTimeout: boundedInteger(parsed.loadVideoTimeout, 60_000, 60_000),
        vastLoadTimeout: boundedInteger(parsed.vastLoadTimeout, 60_000, 60_000),
        requestTimeout: boundedInteger(parsed.requestTimeout, 60_000, 60_000),
        placement: 'interstitial',
        vpaidmode: 'insecure',
        withCredentials: false,
        omidSupport: 'enabled',
        maxRedirects: boundedInteger(parsed.maxRedirects, 20, 20)
      }
    } catch {
      return null
    }
  }

  const readP2pConfiguration = () => {
    const element = document.querySelector('[data-p2p-config]')
    if (!(element instanceof HTMLScriptElement)) return null
    try {
      const parsed = JSON.parse(element.textContent || '')
      if (parsed === null || typeof parsed !== 'object' || !/^[a-f0-9]{64}$/.test(parsed.swarmId || '')) return null
      if (!Array.isArray(parsed.trackers) || parsed.trackers.length === 0 || parsed.trackers.length > 100) return null
      const trackers = parsed.trackers.flatMap((value) => {
        if (typeof value !== 'string' || value.length > 2_048) return []
        try {
          const url = new URL(value)
          return ['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password ? [url.toString()] : []
        } catch {
          return []
        }
      })
      if (trackers.length !== parsed.trackers.length || new Set(trackers).size !== trackers.length) return null
      return { swarmId: parsed.swarmId, trackers }
    } catch {
      return null
    }
  }

  const readPlaybackSources = () => {
    const element = document.querySelector('[data-playback-sources]')
    if (!(element instanceof HTMLScriptElement)) return []
    try {
      const parsed = JSON.parse(element.textContent || '')
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 100) return []
      const sources = parsed.flatMap((source, index) => {
        if (source === null || typeof source !== 'object' || typeof source.file !== 'string') return []
        if (!['hls', 'dash', 'mp4'].includes(source.type)) return []
        try {
          const url = new URL(source.file, window.location.href)
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return []
          return [{
            file: url.toString(),
            type: source.type,
            label: typeof source.label === 'string' && source.label.trim() ? source.label.trim().slice(0, 100) : `Source ${index + 1}`,
            default: source.default === true || index === 0
          }]
        } catch {
          return []
        }
      })
      return sources.length === parsed.length ? sources : []
    } catch {
      return []
    }
  }

  const readFilmstrip = () => {
    const element = document.querySelector('[data-filmstrip-config]')
    if (!(element instanceof HTMLScriptElement)) return ''
    try {
      const parsed = JSON.parse(element.textContent || '')
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.file !== 'string') return ''
      const url = new URL(parsed.file, window.location.href)
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : ''
    } catch {
      return ''
    }
  }

  const mp4QualityConfiguration = (media) => {
    const sources = readPlaybackSources()
    if (sources.length < 2 || sources.some((source) => source.type !== 'mp4')) return null
    const choices = sources.flatMap((source) => {
      const match = source.label.match(/(?:^|\D)(\d{3,4})(?:p|\D|$)/i)
      const quality = Number.parseInt(match?.[1] || '', 10)
      return Number.isInteger(quality) && quality > 0 ? [{ ...source, quality }] : []
    })
    if (choices.length !== sources.length || new Set(choices.map((choice) => choice.quality)).size !== choices.length) return null
    const options = choices.map((choice) => choice.quality).sort((left, right) => left - right)
    const selected = selectedDefaultQuality(options) || options.at(-1)
    const initial = choices.find((choice) => choice.quality === selected)
    if (initial !== undefined && media.src !== initial.file) media.src = initial.file
    const onChange = (value) => {
      const quality = Number(value)
      const choice = choices.find((candidate) => candidate.quality === quality)
      if (choice === undefined || media.src === choice.file || media.currentSrc === choice.file) return
      const position = Number.isFinite(media.currentTime) ? media.currentTime : 0
      const resume = !media.paused
      media.src = choice.file
      media.load()
      media.addEventListener('loadedmetadata', () => {
        if (position > 0 && Number.isFinite(media.duration)) media.currentTime = Math.min(position, Math.max(0, media.duration - 0.25))
        if (resume) void media.play().catch(() => {})
      }, { once: true })
    }
    return { default: selected, options, forced: true, onChange }
  }

  const hlsRuntimeConfiguration = (p2p) => ({
    abrEwmaFastLive: 7,
    abrEwmaFastVoD: 7,
    abrEwmaSlowLive: 9,
    abrEwmaSlowVoD: 9,
    abrMaxWithRealBitrate: true,
    appendErrorMaxRetry: 10,
    debug: false,
    defaultAudioCodec: 'mp4a.40.2',
    enableWorker: true,
    fpsDroppedMonitoringPeriod: 2_500,
    fpsDroppedMonitoringThreshold: 0.1,
    fragLoadPolicy: retryLoadPolicy(),
    highBufferWatchdogPeriod: 4,
    liveDurationInfinity: true,
    lowLatencyMode: false,
    manifestLoadPolicy: retryLoadPolicy(),
    maxBufferHole: 0.2,
    maxBufferLength: 10,
    maxBufferSize: 600_000,
    maxFragLookUpTolerance: 0.5,
    maxLiveSyncPlaybackRate: 1,
    maxMaxBufferLength: 20,
    nudgeOffset: 0.1,
    nudgeMaxRetry: 10,
    playlistLoadPolicy: retryLoadPolicy(),
    progressive: false,
    ...(p2p === null ? {} : {
      p2p: {
        core: {
          swarmId: p2p.swarmId,
          announceTrackers: p2p.trackers,
          highDemandTimeWindow: 30,
          simultaneousHttpDownloads: 5,
          p2pNotReceivingBytesTimeoutMs: 10_000,
          p2pInactiveLoaderDestroyTimeoutMs: 15_000,
          httpNotReceivingBytesTimeoutMs: 8_000,
          httpErrorRetries: 5,
          p2pErrorRetries: 5
        }
      }
    }),
    testBandwidth: false
  })

  function retryLoadPolicy () {
    return {
      default: {
        maxTimeToFirstByteMs: 60_000,
        maxLoadTimeMs: 120_000,
        timeoutRetry: { maxNumRetry: 10, retryDelayMs: 1_000, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: 10, retryDelayMs: 1_000, maxRetryDelayMs: 0 }
      }
    }
  }

  const shakaRuntimeConfiguration = () => ({
    abr: { enabled: true, defaultBandwidthEstimate: 500_000 },
    manifest: { dash: { autoCorrectDrift: true, ignoreEmptyAdaptationSet: true } },
    streaming: { bufferBehind: 15, bufferingGoal: 10, rebufferingGoal: 5 }
  })

  const languagePreference = (name) => [body.dataset[name] || '', body.dataset[`${name}Key`] || '']
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)

  const languageMatches = (track, name) => {
    const preferences = languagePreference(name)
    if (preferences.length === 0) return false
    const values = [track.language, track.lang, track.name, track.label]
      .filter((value) => typeof value === 'string' && value.trim() !== '')
      .map((value) => value.trim().toLowerCase())
    return preferences.some((preference) => values.some((value) => value === preference || (value.length > 3 && preference.length > 3 && (value.includes(preference) || preference.includes(value)))))
  }

  const languageLabel = (track, index) => {
    for (const value of [track.label, track.originalTextId]) {
      if (typeof value === 'string' && value.trim() !== '' && value !== 'Shaka Player TextTrack') return value.trim()
    }
    if (typeof track.language === 'string' && track.language.trim() !== '') {
      try {
        return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(track.language) || track.language.toUpperCase()
      } catch {
        return track.language.toUpperCase()
      }
    }
    return `Subtitle ${index + 1}`
  }

  const qualityBucket = (height) => {
    for (const threshold of [4_000, 2_000, 1_400, 1_200, 1_100, 1_000, 900, 800, 700, 600, 500, 400, 300, 200]) {
      if (height >= threshold) return threshold
    }
    return 100
  }

  const selectedDefaultQuality = (heights) => {
    const requested = Number.parseInt(body.dataset.defaultResolution || '', 10)
    if (!Number.isInteger(requested)) return 0
    return heights.find((height) => qualityBucket(height) === requested) || 0
  }

  const supportedHlsLevels = (hls) => hls.levels.flatMap((level, index) => {
    const height = Number(level.height)
    if (!Number.isInteger(height) || height <= 0) return []
    const codecs = typeof level.codecs === 'string' && level.codecs !== ''
      ? level.codecs
      : typeof level.attrs?.CODECS === 'string' ? level.attrs.CODECS : ''
    if (codecs !== '' && typeof window.MediaSource?.isTypeSupported === 'function' && !window.MediaSource.isTypeSupported(`video/mp4; codecs="${codecs}"`)) return []
    return [{ index, height }]
  })

  const uniqueQualities = (tracks) => [...new Set(tracks.map((track) => Number(track.height)).filter((height) => Number.isInteger(height) && height > 0))].sort((left, right) => left - right)

  const waitForHlsManifest = (hls) => new Promise((resolve, reject) => {
    const events = window.Hls.Events
    const clear = () => {
      window.clearTimeout(timeout)
      hls.off?.(events.MANIFEST_PARSED, parsed)
      hls.off?.(events.ERROR, failed)
    }
    const parsed = () => {
      clear()
      resolve()
    }
    const failed = (_event, data) => {
      if (!data?.fatal) return
      clear()
      reject(new Error('HLS manifest failed to load'))
    }
    const timeout = window.setTimeout(() => {
      clear()
      reject(new Error('HLS manifest timed out'))
    }, 60_000)
    hls.on(events.MANIFEST_PARSED, parsed)
    hls.on(events.ERROR, failed)
  })

  const initializePlyrTransport = async (media) => {
    const source = media.dataset.source || ''
    const kind = media.dataset.sourceKind || 'video'
    const p2p = readP2pConfiguration()
    if (!source || (kind !== 'hls' && kind !== 'dash')) return null

    if (kind === 'hls') {
      if (typeof window.Hls === 'function' && window.Hls.isSupported()) {
        let HlsRuntime = window.Hls
        let p2pActive = false
        if (p2p !== null) {
          try {
            const module = await import('/assets/vendor/p2p-media-loader-hlsjs/2.2.1/p2p-media-loader-hlsjs.es.min.js')
            if (typeof module.HlsJsP2PEngine?.injectMixin === 'function') {
              HlsRuntime = module.HlsJsP2PEngine.injectMixin(window.Hls)
              p2pActive = true
            }
          } catch {
            p2pActive = false
          }
        }
        const hls = new HlsRuntime(hlsRuntimeConfiguration(p2pActive ? p2p : null))
        const manifest = waitForHlsManifest(hls)
        hls.on(window.Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(source))
        hls.attachMedia(media)
        window.gplayerMediaTransport = hls
        body.dataset.mediaTransport = 'hls.js'
        if (p2pActive) body.dataset.p2pTransport = 'hls'
        window.addEventListener('pagehide', () => hls.destroy(), { once: true })
        await manifest.catch((error) => {
          recoverFromPlaybackFailure()
          throw error
        })
        const levels = supportedHlsLevels(hls)
        const qualities = uniqueQualities(levels)
        let selectedQuality = selectedDefaultQuality(qualities)
        const selectQuality = (value) => {
          const quality = Number(value)
          const level = levels.find((candidate) => candidate.height === quality)
          selectedQuality = level === undefined ? 0 : quality
          hls.currentLevel = level?.index ?? -1
          body.dataset.playerQuality = selectedQuality === 0 ? 'auto' : String(selectedQuality)
        }
        selectQuality(selectedQuality)
        const audioTracks = hls.audioTracks.map((track, index) => ({
          id: index,
          label: track.name || track.lang || `Audio ${index + 1}`,
          language: track.lang || '',
          active: index === hls.audioTrack
        }))
        const preferredAudio = audioTracks.find((track) => languageMatches(track, 'defaultAudio'))
        if (preferredAudio !== undefined) hls.audioTrack = preferredAudio.id
        const preferredSubtitle = hls.subtitleTracks
          .map((track, index) => ({ ...track, id: index }))
          .find((track) => languageMatches(track, 'defaultSubtitle'))
        if (preferredSubtitle !== undefined) {
          hls.subtitleTrack = preferredSubtitle.id
          hls.subtitleDisplay = true
        }
        return {
          engine: hls,
          quality: qualities.length > 1 ? { default: selectedQuality, options: [0, ...qualities], forced: true, onChange: selectQuality } : null,
          audio: audioTracks.length > 1
            ? {
                tracks: audioTracks.map((track) => ({ ...track, active: track.id === hls.audioTrack })),
                select: (id) => { hls.audioTrack = Number(id) }
              }
            : null
        }
      }
      if (media.canPlayType('application/vnd.apple.mpegurl')) {
        media.src = source
        body.dataset.mediaTransport = 'native-hls'
      }
      return null
    }

    if (window.shaka?.Player?.isBrowserSupported?.()) {
      window.shaka.polyfill?.installAll?.()
      const shakaPlayer = new window.shaka.Player()
      await shakaPlayer.attach(media)
      shakaPlayer.configure(shakaRuntimeConfiguration())
      let p2pEngine = null
      if (p2p !== null && typeof window.p2pml?.shaka?.Engine === 'function') {
        try {
          p2pEngine = new window.p2pml.shaka.Engine({
            segments: { swarmId: p2p.swarmId },
            loader: {
              trackerAnnounce: p2p.trackers,
              httpUseRanges: true,
              httpDownloadProbabilitySkipIfNoPeers: true
            }
          })
          p2pEngine.initShakaPlayer(shakaPlayer)
          body.dataset.p2pTransport = 'dash'
        } catch {
          p2pEngine = null
        }
      }
      await shakaPlayer.load(source).catch((error) => {
        recoverFromPlaybackFailure()
        throw error
      })
      const shakaCaptions = shakaPlayer.getTextTracks().map((track, index) => {
        const kind = track.kind === 'caption' ? 'captions' : 'subtitles'
        const nativeTrack = media.addTextTrack(kind, languageLabel(track, index), track.language || '')
        nativeTrack.mode = 'hidden'
        return { nativeTrack, track }
      })
      const variants = shakaPlayer.getVariantTracks()
      let activeVariant = variants.find((track) => track.active) || variants[0]
      const preferredAudio = variants.find((track) => languageMatches(track, 'defaultAudio'))
      if (preferredAudio !== undefined && preferredAudio.audioId !== activeVariant?.audioId) {
        if (typeof shakaPlayer.selectAudioLanguage === 'function' && preferredAudio.language) {
          shakaPlayer.selectAudioLanguage(preferredAudio.language)
        } else {
          shakaPlayer.selectVariantTrack(preferredAudio, true)
        }
        activeVariant = preferredAudio
      }
      let selectedAudioId = activeVariant?.audioId
      const qualities = uniqueQualities(variants)
      let selectedQuality = selectedDefaultQuality(qualities)
      const selectQuality = (value) => {
        const quality = Number(value)
        if (!Number.isInteger(quality) || quality <= 0) {
          selectedQuality = 0
          shakaPlayer.configure({ abr: { enabled: true } })
          body.dataset.playerQuality = 'auto'
          return
        }
        const variant = variants.find((track) => track.height === quality && track.audioId === selectedAudioId) || variants.find((track) => track.height === quality)
        if (variant === undefined) return
        selectedQuality = quality
        selectedAudioId = variant.audioId
        shakaPlayer.configure({ abr: { enabled: false } })
        shakaPlayer.selectVariantTrack(variant, true)
        body.dataset.playerQuality = String(quality)
      }
      selectQuality(selectedQuality)
      const audioTracks = []
      for (const variant of variants) {
        if (audioTracks.some((track) => track.id === variant.audioId)) continue
        audioTracks.push({
          id: variant.audioId,
          label: variant.label || variant.language || `Audio ${audioTracks.length + 1}`,
          language: variant.language || '',
          active: variant.audioId === selectedAudioId
        })
      }
      window.gplayerMediaTransport = shakaPlayer
      window.gplayerP2pEngine = p2pEngine
      body.dataset.mediaTransport = 'shaka'
      window.addEventListener('pagehide', () => {
        void p2pEngine?.destroy?.()
        void shakaPlayer.destroy()
      }, { once: true })
      return {
        engine: shakaPlayer,
        quality: qualities.length > 1 ? { default: selectedQuality, options: [0, ...qualities], forced: true, onChange: selectQuality } : null,
        captions: shakaCaptions.length === 0
          ? null
          : {
              tracks: shakaCaptions,
              select: (track) => {
                shakaPlayer.selectTextTrack(track)
                shakaPlayer.setTextTrackVisibility(true)
              },
              disable: () => shakaPlayer.setTextTrackVisibility(false)
            },
        audio: audioTracks.length > 1
          ? {
              tracks: audioTracks,
              select: (id) => {
                const variant = variants.find((track) => String(track.audioId) === String(id) && (selectedQuality === 0 || track.height === selectedQuality)) || variants.find((track) => String(track.audioId) === String(id))
                if (variant === undefined) return
                selectedAudioId = variant.audioId
                selectedQuality = Number(variant.height) || 0
                shakaPlayer.configure({ abr: { enabled: false } })
                shakaPlayer.selectVariantTrack(variant, true)
                body.dataset.playerQuality = selectedQuality === 0 ? 'auto' : String(selectedQuality)
              }
            }
          : null
      }
    }
    return null
  }

  const loadRuntimeScript = (source, key) => new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-player-runtime="${key}"]`)) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.src = source
    script.dataset.playerRuntime = key
    const timeout = window.setTimeout(() => {
      script.remove()
      reject(new Error('Player runtime timed out'))
    }, 10_000)
    script.addEventListener('load', () => {
      window.clearTimeout(timeout)
      resolve()
    }, { once: true })
    script.addEventListener('error', () => {
      window.clearTimeout(timeout)
      script.remove()
      reject(new Error('Player runtime failed to load'))
    }, { once: true })
    document.head.append(script)
  })

  const nativeController = (media, engine = 'native', instance = null) => ({
    engine,
    instance,
    media,
    play: async () => { await media.play().catch(() => {}) },
    pause: () => media.pause(),
    paused: () => media.paused,
    position: () => media.currentTime,
    duration: () => media.duration,
    seek: (seconds) => { media.currentTime = seconds },
    onReady: (listener) => {
      if (media.readyState >= HTMLMediaElement.HAVE_METADATA) {
        window.queueMicrotask(listener)
        return
      }
      media.addEventListener('loadedmetadata', listener, { once: true })
    },
    onTime: (listener) => media.addEventListener('timeupdate', () => listener(media.currentTime, media.duration)),
    onEnded: (listener) => media.addEventListener('ended', listener),
    onPlay: (listener, once = false) => media.addEventListener('play', listener, { once }),
    bindLoading: (show, hide) => {
      for (const event of ['loadstart', 'waiting', 'stalled', 'seeking']) media.addEventListener(event, show)
      for (const event of ['loadeddata', 'canplay', 'playing', 'seeked', 'error']) media.addEventListener(event, hide)
      if (media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) hide()
    }
  })

  const jwController = (instance) => {
    const once = (event, listener) => {
      const wrapped = (payload) => {
        instance.off(event, wrapped)
        listener(payload)
      }
      instance.on(event, wrapped)
    }
    return {
      engine: 'jwplayer',
      instance,
      media: null,
      play: async () => { instance.play() },
      pause: () => instance.pause(),
      paused: () => instance.getState() !== 'playing',
      position: () => Number(instance.getPosition()),
      duration: () => Number(instance.getDuration()),
      seek: (seconds) => instance.seek(seconds),
      onReady: (listener) => {
        const duration = Number(instance.getDuration())
        if (Number.isFinite(duration) && duration > 0) {
          window.queueMicrotask(listener)
          return
        }
        once('ready', listener)
      },
      onTime: (listener) => instance.on('time', (event) => listener(Number(event.position), Number(event.duration))),
      onEnded: (listener) => instance.on('complete', listener),
      onPlay: (listener, runOnce = false) => runOnce ? once('play', listener) : instance.on('play', listener),
      bindLoading: (show, hide) => {
        instance.on('buffer', show)
        instance.on('ready', hide)
        instance.on('firstFrame', hide)
        instance.on('play', hide)
        instance.on('error', hide)
        instance.on('setupError', hide)
      }
    }
  }

  const installAdaptiveAudioMenu = (instance, audio) => {
    if (audio === null || audio.tracks.length < 2) return
    const container = instance.elements?.container
    if (!(container instanceof HTMLElement)) return
    const menu = container.querySelector('.plyr__menu__container')
    const home = menu?.querySelector('[id$="-home"]')
    const homeMenu = home?.querySelector('[role="menu"]')
    if (!(menu instanceof HTMLElement) || !(home instanceof HTMLElement) || !(homeMenu instanceof HTMLElement) || menu.querySelector('[data-gplayer-audio-menu]')) return

    const active = () => audio.tracks.find((track) => track.active) || audio.tracks[0]
    const identifier = `${menu.id || 'plyr-settings'}-gplayer-audio`
    const forward = document.createElement('button')
    forward.type = 'button'
    forward.className = 'plyr__control plyr__control--forward'
    forward.dataset.plyr = 'settings'
    forward.dataset.gplayerAudioMenu = ''
    forward.setAttribute('role', 'menuitem')
    forward.setAttribute('aria-haspopup', 'true')
    forward.setAttribute('aria-controls', identifier)
    const forwardLabel = document.createElement('span')
    forwardLabel.textContent = 'Audio'
    const forwardValue = document.createElement('span')
    forwardValue.className = 'plyr__menu__value'
    forwardValue.textContent = active()?.label || 'Default'
    forwardLabel.append(forwardValue)
    forward.append(forwardLabel)
    homeMenu.prepend(forward)

    const panel = document.createElement('div')
    panel.id = identifier
    panel.hidden = true
    panel.dataset.gplayerAudioPanel = ''
    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'plyr__control plyr__control--back'
    const backVisible = document.createElement('span')
    backVisible.setAttribute('aria-hidden', 'true')
    backVisible.textContent = 'Audio'
    const backLabel = document.createElement('span')
    backLabel.className = 'plyr__sr-only'
    backLabel.textContent = 'Go back to the previous menu'
    back.append(backVisible, backLabel)
    const choices = document.createElement('div')
    choices.setAttribute('role', 'menu')
    for (const track of audio.tracks) {
      const choice = document.createElement('button')
      choice.type = 'button'
      choice.className = 'plyr__control'
      choice.dataset.plyr = 'audio'
      choice.value = String(track.id)
      choice.setAttribute('role', 'menuitemradio')
      choice.setAttribute('aria-checked', String(track.active))
      choice.textContent = track.language && !track.label.toLowerCase().includes(track.language.toLowerCase())
        ? `${track.label} (${track.language.toUpperCase()})`
        : track.label
      choice.addEventListener('click', () => {
        for (const candidate of audio.tracks) candidate.active = String(candidate.id) === choice.value
        for (const button of choices.querySelectorAll('[role="menuitemradio"]')) button.setAttribute('aria-checked', String(button === choice))
        audio.select(choice.value)
        forwardValue.textContent = track.label
        panel.hidden = true
        home.hidden = false
        forward.focus()
      })
      choices.append(choice)
    }
    panel.append(back, choices)
    home.after(panel)
    forward.addEventListener('click', () => {
      home.hidden = true
      panel.hidden = false
      choices.querySelector('[aria-checked="true"]')?.focus()
    })
    back.addEventListener('click', () => {
      panel.hidden = true
      home.hidden = false
      forward.focus()
    })
  }

  const installAdaptiveQualityMenu = (instance, quality) => {
    const container = instance.elements?.container
    if (!(container instanceof HTMLElement)) return
    const buttons = [...container.querySelectorAll('button[data-plyr="quality"]')]
    const automatic = buttons.find((button) => button.value === '0')
    const label = automatic?.querySelector('span')
    if (label instanceof HTMLElement) label.textContent = 'Auto'
    if (quality === null) return
    for (const button of buttons) {
      if (button.dataset.gplayerQualityBound === 'true') continue
      button.dataset.gplayerQualityBound = 'true'
      button.addEventListener('click', () => quality.onChange(button.value))
    }
  }

  const installAdaptiveCaptions = (instance, media, captions) => {
    const selectCurrent = () => {
      if (captions === null) return
      const index = Number(instance.currentTrack)
      const selected = Number.isInteger(index) && index >= 0 ? media.textTracks[index] : null
      const shakaTrack = captions.tracks.find((candidate) => candidate.nativeTrack === selected)
      if (shakaTrack === undefined) captions.disable()
      else captions.select(shakaTrack.track)
    }
    const applyPreferred = () => {
      const tracks = Array.from(media.textTracks)
      const preferred = tracks.findIndex((track) => languageMatches(track, 'defaultSubtitle'))
      const fallback = tracks.findIndex((track) => track.label !== 'Shaka Player TextTrack')
      const index = preferred >= 0 ? preferred : fallback
      if (index < 0) return
      instance.currentTrack = index
      instance.toggleCaptions?.(true)
      window.queueMicrotask(selectCurrent)
    }
    if (captions !== null && !instance.gplayerAdaptiveCaptionsInstalled) {
      instance.gplayerAdaptiveCaptionsInstalled = true
      instance.on('captionsenabled', selectCurrent)
      instance.on('languagechange', selectCurrent)
      instance.on('captionsdisabled', captions.disable)
    }
    if (!instance.gplayerDefaultCaptionBound) {
      instance.gplayerDefaultCaptionBound = true
      instance.on('loadedmetadata', applyPreferred)
      media.addEventListener('loadedmetadata', () => window.setTimeout(applyPreferred, 0))
      media.addEventListener('loadeddata', () => window.setTimeout(applyPreferred, 0))
      media.addEventListener('canplay', () => window.setTimeout(applyPreferred, 0))
      media.textTracks.addEventListener?.('addtrack', () => window.setTimeout(applyPreferred, 0))
      window.setTimeout(applyPreferred, 250)
      window.setTimeout(applyPreferred, 1_000)
    }
    applyPreferred()
  }

  const labelPlayerSettings = (instance) => {
    const container = instance.elements?.container
    if (!(container instanceof HTMLElement)) return
    const settings = container.querySelector('.plyr__controls button[data-plyr="settings"]')
    if (!(settings instanceof HTMLButtonElement)) return
    settings.setAttribute('aria-label', 'Settings')
    settings.removeAttribute('aria-controls')
    const currentTime = container.querySelector('.plyr__time--current[aria-label]')
    if (currentTime instanceof HTMLElement) {
      currentTime.title = currentTime.getAttribute('aria-label') || 'Current time'
      currentTime.removeAttribute('aria-label')
    }
  }

  const initializeSelectedPlayer = async () => {
    if (!(video instanceof HTMLVideoElement)) return null
    const fallback = nativeController(video)
    body.dataset.activePlayer = 'native'
    const vastConfig = readVastConfiguration()
    if (body.dataset.playerLibrary === 'plyr') {
      try {
        const mediaTransport = await initializePlyrTransport(video)
        const mp4Quality = mediaTransport === null ? mp4QualityConfiguration(video) : null
        await loadRuntimeScript('/assets/vendor/plyr/3.6.3/plyr-custom.polyfilled.min.js', 'plyr')
        if (typeof window.Plyr !== 'function') return fallback
        const speedEnabled = body.dataset.playbackRate === 'true'
        const settings = ['captions']
        if ((mediaTransport?.quality !== null && mediaTransport?.quality !== undefined) || mp4Quality !== null) settings.push('quality')
        if (speedEnabled) settings.push('speed')
        const instance = new window.Plyr(video, {
          controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen'],
          settings,
          captions: { active: true, update: true },
          ...(readFilmstrip() === '' ? {} : { previewThumbnails: { enabled: true, src: readFilmstrip() } }),
          ...((mediaTransport?.quality === null || mediaTransport?.quality === undefined) && mp4Quality === null
            ? {}
            : { quality: mediaTransport?.quality || mp4Quality }),
          ...(vastConfig?.schedule.length ? { ads: { enabled: true, tagUrl: vastConfig.schedule[0].tag } } : {}),
          speed: { selected: 1, options: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] },
          storage: { enabled: false, key: 'plyr' },
          tooltips: { controls: true, seek: true }
        })
        instance.mediaTransport = mediaTransport?.engine || null
        instance.resumePlayback = () => instance.play()
        const installAdaptiveMenus = () => {
          labelPlayerSettings(instance)
          installAdaptiveQualityMenu(instance, mediaTransport?.quality || mp4Quality)
          installAdaptiveAudioMenu(instance, mediaTransport?.audio || null)
        }
        const installAdaptiveRuntime = () => {
          installAdaptiveMenus()
          installAdaptiveCaptions(instance, video, mediaTransport?.captions || null)
        }
        instance.on('ready', installAdaptiveRuntime)
        window.queueMicrotask(installAdaptiveMenus)
        window.setTimeout(installAdaptiveRuntime, 0)
        window.gdPlyr = instance
        body.dataset.activePlayer = 'plyr'
        return nativeController(video, 'plyr', instance)
      } catch {
        body.dataset.activePlayer = 'native'
        return fallback
      }
    }
    if (body.dataset.playerLibrary !== 'jwplayer') return fallback
    try {
      window.jwpBaseUrl = '/assets/vendor/jwplayer'
      await loadRuntimeScript('/assets/vendor/jwplayer/jwplayer.js', 'jwplayer')
      if (typeof window.jwplayer !== 'function') return fallback
      window.jwplayer.key = 'ITWMv7t88JGzI0xPwW8I0+LveiXX9SWbfdmt0ArUSyc='
      const skins = new Set(['dropload', 'hotstar', 'iqiyi', 'lulustream', 'netflix'])
      const skin = skins.has(body.dataset.playerSkin || '') ? body.dataset.playerSkin : ''
      if (skin) await loadRuntimeScript(`/assets/skin/jwplayer/${skin}.js`, `jwplayer-skin-${skin}`)
      const source = video.dataset.source || ''
      if (!source) return fallback
      const sourceKind = video.dataset.sourceKind || 'video'
      const resolvedSources = readPlaybackSources()
      const tracks = Array.from(video.querySelectorAll('track')).map((track) => ({
        file: track.src,
        label: track.label,
        kind: 'captions',
        default: track.default
      }))
      const filmstrip = readFilmstrip()
      if (filmstrip !== '') tracks.push({ file: filmstrip, label: 'Thumbnails', kind: 'thumbnails', default: false })
      const captionOpacity = (name, fallbackValue) => {
        const value = Number.parseInt(body.dataset[name] || '', 10)
        return Number.isInteger(value) && value >= 0 && value <= 100 ? value : fallbackValue
      }
      const instance = window.jwplayer('media-player').setup({
        width: '100%',
        height: '100%',
        controls: true,
        sources: resolvedSources.length > 0
          ? resolvedSources
          : [{ file: source, type: sourceKind === 'hls' ? 'hls' : sourceKind === 'dash' ? 'dash' : 'mp4', label: 'Default', default: true }],
        tracks,
        title: document.querySelector('[data-player-title]')?.textContent || document.title,
        image: video.poster,
        autostart: video.autoplay,
        mute: video.muted,
        repeat: video.loop,
        preload: video.preload,
        stretching: video.className.replace('player-stretch-', '') || 'uniform',
        displaytitle: false,
        playbackRateControls: body.dataset.playbackRate === 'true',
        playbackRates: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
        captions: {
          color: body.dataset.captionColor,
          backgroundOpacity: captionOpacity('captionBackgroundOpacity', 75),
          backgroundColor: body.dataset.captionBackgroundColor,
          fontFamily: body.dataset.captionFont,
          edgeStyle: body.dataset.captionEdge,
          windowOpacity: captionOpacity('captionWindowOpacity', 0),
          windowColor: body.dataset.captionWindowColor
        },
        ...(vastConfig !== null ? { advertising: vastConfig } : {}),
        ...(skin ? { skin: { name: skin } } : {}),
        abouttext: 'GPlayer',
        aboutlink: 'https://github.com/rsm23/gplayer',
        generateSEOMetadata: false
      })
      instance.destroy = () => instance.remove()
      instance.resumePlayback = () => instance.play()
      window.jwp = instance
      instance.on('error', recoverFromPlaybackFailure)
      instance.on('setupError', recoverFromPlaybackFailure)
      body.dataset.activePlayer = 'jwplayer'
      return jwController(instance)
    } catch {
      body.dataset.activePlayer = 'native'
      if (!video.hasAttribute('src') && video.dataset.sourceKind === 'video' && video.dataset.source) video.src = video.dataset.source
      return fallback
    }
  }

  const initializeDeferredSources = (controller) => {
    if (controller?.engine !== 'jwplayer' && video instanceof HTMLVideoElement && video.dataset.sourceKind === 'video' && !video.hasAttribute('src')) {
      const source = video.dataset.source
      if (source) video.src = source
    }
    const provider = document.querySelector('[data-provider-frame]')
    if (provider instanceof HTMLIFrameElement && !provider.hasAttribute('src')) {
      const source = provider.dataset.deferredSource
      if (source) provider.src = source
    }
  }

  const initializePlayerAppearance = () => {
    if (/^#[a-f0-9]{6}$/i.test(body.dataset.playerColor || '')) {
      document.documentElement.style.setProperty('--brand', body.dataset.playerColor)
    }
    if (/^#[a-f0-9]{6}$/i.test(body.dataset.playerColor2 || '')) {
      document.documentElement.style.setProperty('--brand-secondary', body.dataset.playerColor2)
    }
    const captionColor = body.dataset.captionColor || ''
    if (/^#[a-f0-9]{6}$/i.test(captionColor)) {
      document.documentElement.style.setProperty('--caption-color', captionColor)
    }
    const captionFonts = new Set(['Arial', 'Courier', 'Georgia', 'Impact', 'Lucida Console', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'])
    const captionFont = body.dataset.captionFont || ''
    if (captionFonts.has(captionFont)) {
      document.documentElement.style.setProperty('--caption-font', `"${captionFont}"`)
    }
    const rgbaCaptionColor = (color, opacity) => {
      if (!/^#[a-f0-9]{6}$/i.test(color || '')) return ''
      const alpha = Number.parseInt(opacity || '', 10)
      if (!Number.isInteger(alpha) || alpha < 0 || alpha > 100) return ''
      return `rgba(${Number.parseInt(color.slice(1, 3), 16)}, ${Number.parseInt(color.slice(3, 5), 16)}, ${Number.parseInt(color.slice(5, 7), 16)}, ${alpha / 100})`
    }
    const captionBackground = rgbaCaptionColor(body.dataset.captionBackgroundColor, body.dataset.captionBackgroundOpacity)
    if (captionBackground) document.documentElement.style.setProperty('--caption-background', captionBackground)
    const captionWindow = rgbaCaptionColor(body.dataset.captionWindowColor, body.dataset.captionWindowOpacity)
    if (captionWindow) document.documentElement.style.setProperty('--caption-window', captionWindow)
    const captionEdges = {
      none: 'none',
      raised: '-1px -1px 0 #000, 1px 1px 0 rgba(255, 255, 255, 0.45)',
      depressed: '1px 1px 0 #000, -1px -1px 0 rgba(255, 255, 255, 0.35)',
      uniform: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000',
      dropShadow: '2px 2px 3px #000'
    }
    const captionEdge = captionEdges[body.dataset.captionEdge]
    if (captionEdge) document.documentElement.style.setProperty('--caption-edge', captionEdge)
    document.querySelectorAll('[data-player-logo]').forEach((logo) => {
      const margin = Number.parseInt(logo.dataset.logoMargin || body.dataset.logoMargin || '0', 10)
      const container = logo.closest('.player-logo, .player-small-logo')
      if (container instanceof HTMLElement && Number.isInteger(margin) && margin >= 0 && margin <= 1_000) {
        container.style.setProperty('--logo-margin', `${margin}px`)
      }
    })
  }

  const initializeLoader = (controller) => {
    const loader = document.querySelector('[data-player-loader]')
    if (!(loader instanceof HTMLElement)) return
    const hide = () => { loader.hidden = true }
    const show = () => { loader.hidden = false }
    if (controller !== null) {
      controller.bindLoading(show, hide)
      return
    }
    const provider = document.querySelector('[data-provider-frame]')
    if (provider instanceof HTMLIFrameElement) {
      provider.addEventListener('load', hide, { once: true })
      provider.addEventListener('error', hide, { once: true })
      return
    }
    hide()
  }

  const initializeFakePlay = (controller) => {
    const fakePlay = document.querySelector('[data-player-fake-play]')
    if (controller === null) return
    fakePlay?.addEventListener('click', () => {
      controller.play()
      fakePlay.remove()
    })
    controller.onPlay(() => fakePlay?.remove(), true)
  }

  document.querySelector('[data-player-share]')?.addEventListener('click', async () => {
    try {
      if (typeof navigator.share === 'function') await navigator.share({ title: document.title, url: window.location.href })
      else if (navigator.clipboard) await navigator.clipboard.writeText(window.location.href)
    } catch {
      // Cancellation and unavailable clipboard permissions leave the player unchanged.
    }
  })

  const initializeVisibilityPause = (controller) => {
    if (body.dataset.pauseOnLeft !== 'true' || controller === null) return
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && !controller.paused()) controller.pause()
    })
  }

  const initializeContinueWatching = (controller) => {
    if (body.dataset.continueWatching !== 'true' || controller === null) return
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
    controller.onReady(() => {
      let saved = 0
      try { saved = Number.parseFloat(window.localStorage.getItem(storageKey) || '0') } catch {}
      const duration = controller.duration()
      if (!Number.isFinite(saved) || saved < 5 || !Number.isFinite(duration) || saved >= duration - 5) return
      controller.pause()
      promptText.textContent = promptText.textContent.replace('hh:mm:ss', formatTime(saved))
      prompt.hidden = false
      yes?.addEventListener('click', () => {
        controller.seek(saved)
        hidePrompt()
        controller.play()
      }, { once: true })
      no?.addEventListener('click', () => {
        forget()
        controller.seek(0)
        hidePrompt()
      }, { once: true })
    })
    controller.onTime((position) => {
      const second = Math.floor(position)
      if (second === lastStoredSecond || second < 1) return
      lastStoredSecond = second
      try { window.localStorage.setItem(storageKey, String(second)) } catch {}
    })
    controller.onEnded(forget)
  }

  const initializeViewCounter = (controller) => {
    if (controller === null) return
    const token = body.dataset.viewCounterToken || ''
    const runtime = Number.parseInt(body.dataset.viewCounterRuntime || '', 10)
    if (!token || !Number.isInteger(runtime) || runtime < 0 || runtime > 86_400) return
    let counted = false
    const count = () => {
      if (counted) return
      counted = true
      const payload = new URLSearchParams({ action: 'statCounter', data: token })
      window.fetch('/ajax/public/', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: payload.toString(),
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive: true
      }).catch(() => {})
    }
    if (runtime === 0) controller.onPlay(count, true)
    controller.onTime((position) => {
      if (Number.isFinite(position) && position >= runtime) count()
    })
  }

  const formatTime = (seconds) => {
    const value = Math.max(0, Math.floor(seconds))
    const hours = Math.floor(value / 3_600)
    const minutes = Math.floor((value % 3_600) / 60)
    const remainder = value % 60
    return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':')
  }

  const showFallback = (media, message) => {
    if (!(media instanceof HTMLVideoElement)) return
    const fallback = document.createElement('p')
    fallback.className = 'player-fallback'
    fallback.textContent = message
    media.insertAdjacentElement('afterend', fallback)
  }

  const initializeStreamingPlayback = (controller) => {
    const media = controller?.media
    if (!(media instanceof HTMLVideoElement) || controller.engine === 'jwplayer') return
    const source = media.dataset.source
    const kind = media.dataset.sourceKind
    if (!source || (kind !== 'hls' && kind !== 'dash')) return

    if (kind === 'dash') {
      if (typeof window.shaka !== 'object' || typeof window.shaka.Player !== 'function') {
        showFallback(media, 'MPEG-DASH playback is not supported in this browser.')
        return
      }
      window.shaka.polyfill.installAll()
      if (!window.shaka.Player.isBrowserSupported()) {
        showFallback(media, 'MPEG-DASH playback is not supported in this browser.')
        return
      }
      const player = new window.shaka.Player()
      player.attach(media)
        .then(() => player.load(source))
        .catch(() => {
          if (!recoverFromPlaybackFailure()) showFallback(media, 'The MPEG-DASH stream could not be loaded.')
        })
      return
    }

    if (media.canPlayType('application/vnd.apple.mpegurl')) {
      media.src = source
      return
    }

    if (typeof window.Hls === 'function' && window.Hls.isSupported()) {
      const hls = new window.Hls({ enableWorker: true })
      hls.on(window.Hls.Events.ERROR, (_event, data) => {
        if (data?.fatal) recoverFromPlaybackFailure()
      })
      hls.loadSource(source)
      hls.attachMedia(media)
      return
    }

    showFallback(media, 'HLS playback is not supported in this browser.')
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

  const providerGate = document.querySelector('[data-provider-ad-gate]')
  providerGate?.addEventListener('click', () => {
    visitPlayAds()
    providerGate.remove()
  }, { once: true })

  const initializeAdblockDetection = (controller) => {
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
      controller?.pause()
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

  const boot = async () => {
    initializePlayerAppearance()
    const controller = await initializeSelectedPlayer()
    initializeLoader(controller)
    initializeDeferredSources(controller)
    initializeStreamingPlayback(controller)
    initializeFakePlay(controller)
    initializeVisibilityPause(controller)
    initializeContinueWatching(controller)
    initializeViewCounter(controller)
    initializeAdblockDetection(controller)
    controller?.onPlay(visitPlayAds, true)
    if (body.dataset.popupFrameUrl && Number.parseInt(body.dataset.popupDelaySeconds || '0', 10) === 0) {
      mountPopupFrame()
    }
  }

  boot()
})()
