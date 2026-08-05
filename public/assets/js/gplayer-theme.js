(() => {
  'use strict'

  const cookieName = 'theme'
  const stored = document.cookie.match(/(?:^|;\s*)theme=(dark|light)(?:;|$)/)?.[1]
  const preferred = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === true ? 'dark' : 'light'
  const initial = stored === 'dark' || stored === 'light' ? stored : preferred

  applyTheme(initial)

  const ready = () => {
    updateControls(initial)
    document.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-theme-choice]') : null
      if (!(button instanceof HTMLButtonElement)) return
      const choice = button.dataset.themeChoice
      if (choice !== 'dark' && choice !== 'light') return
      applyTheme(choice)
      updateControls(choice)
      button.closest('details')?.removeAttribute('open')
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true })
  else ready()

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    const secure = location.protocol === 'https:' ? '; Secure' : ''
    document.cookie = `${cookieName}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
  }

  function updateControls(theme) {
    document.querySelectorAll('[data-theme-label]').forEach((label) => {
      label.textContent = theme === 'dark' ? 'Dark' : 'Light'
    })
    document.querySelectorAll('[data-theme-choice]').forEach((button) => {
      const active = button instanceof HTMLElement && button.dataset.themeChoice === theme
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', String(active))
    })
  }
})()
