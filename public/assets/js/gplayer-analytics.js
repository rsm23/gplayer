(() => {
  'use strict'

  const element = document.querySelector('meta[name="gplayer-analytics"]')
  if (!(element instanceof HTMLMetaElement)) return

  const googleAnalyticsId = /^(?:G-[A-Z0-9]{5,32}|UA-[0-9]{4,10}-[0-9]{1,4})$/.test(element.dataset.googleAnalyticsId || '')
    ? element.dataset.googleAnalyticsId
    : ''
  const googleTagManagerId = /^GTM-[A-Z0-9]{4,32}$/.test(element.dataset.googleTagManagerId || '')
    ? element.dataset.googleTagManagerId
    : ''
  const histatsId = /^[0-9]{1,20}$/.test(element.dataset.histatsId || '')
    ? element.dataset.histatsId
    : ''

  const loadScript = (url, marker) => {
    if (document.querySelector(`script[data-analytics-loader="${marker}"]`)) return
    const script = document.createElement('script')
    script.async = true
    script.src = url
    script.dataset.analyticsLoader = marker
    document.head.append(script)
  }

  if (googleAnalyticsId) {
    globalThis.dataLayer = Array.isArray(globalThis.dataLayer) ? globalThis.dataLayer : []
    globalThis.gtag = typeof globalThis.gtag === 'function'
      ? globalThis.gtag
      : function () { globalThis.dataLayer.push(arguments) }
    globalThis.gtag('js', new Date())
    globalThis.gtag('config', googleAnalyticsId)
    loadScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(googleAnalyticsId)}`, 'google-analytics')
  }

  if (googleTagManagerId) {
    globalThis.dataLayer = Array.isArray(globalThis.dataLayer) ? globalThis.dataLayer : []
    globalThis.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' })
    loadScript(`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(googleTagManagerId)}`, 'google-tag-manager')
  }

  if (histatsId) {
    globalThis._Hasync = Array.isArray(globalThis._Hasync) ? globalThis._Hasync : []
    globalThis._Hasync.push(['Histats.start', `1,${histatsId},4,0,0,0,00010000`])
    globalThis._Hasync.push(['Histats.fasi', '1'])
    globalThis._Hasync.push(['Histats.track_hits', ''])
    loadScript('https://s10.histats.com/js15_as.js', 'histats')
  }
})()
