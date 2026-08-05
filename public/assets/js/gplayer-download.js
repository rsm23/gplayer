(() => {
  'use strict'

  for (const link of document.querySelectorAll('[data-download-target]')) {
    if (!(link instanceof HTMLAnchorElement)) continue
    let target
    try {
      target = new URL(link.dataset.downloadTarget || '', window.location.href)
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) continue
    } catch {
      continue
    }
    link.addEventListener('click', () => {
      window.open(target.toString(), '_blank', 'noopener,noreferrer')
    })
  }
})()
