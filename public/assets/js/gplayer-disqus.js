(() => {
  'use strict'

  const element = document.querySelector('[data-disqus-config]')
  if (!(element instanceof HTMLElement)) return
  const shortname = (element.dataset.disqusShortname || '').toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(shortname)) return

  const safePageUrl = (value) => {
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
    } catch {
      return ''
    }
  }
  const pageUrl = safePageUrl(element.dataset.disqusPageUrl || '')
  const pageIdentifier = safePageUrl(element.dataset.disqusPageIdentifier || '')
  if (!pageUrl || !pageIdentifier) return

  globalThis.disqus_config = function () {
    this.page.url = pageUrl
    this.page.identifier = pageIdentifier
  }

  if (document.querySelector('script[data-disqus-loader]')) return
  const script = document.createElement('script')
  script.async = true
  script.src = `https://${shortname}.disqus.com/embed.js`
  script.dataset.disqusLoader = String(Date.now())
  document.head.append(script)
})()
