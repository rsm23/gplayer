(() => {
  'use strict'

  const form = document.querySelector('#player-form')
  const generateButton = document.querySelector('#generate-button')
  const buttonLabel = generateButton?.querySelector('.button-label')
  const message = document.querySelector('#form-message')
  const outputEmpty = document.querySelector('#output-empty')
  const outputResult = document.querySelector('#output-result')
  const subtitleList = document.querySelector('#subtitle-list')
  const subtitleTemplate = document.querySelector('#subtitle-template')
  const menuButton = document.querySelector('.menu-toggle')
  const navigation = document.querySelector('#site-navigation')
  const staticGeneratorNotice = document.querySelector('#static-generator-notice')
  const isStaticPagesSite = /(?:^|\.)github\.io$/i.test(location.hostname)

  if (isStaticPagesSite) {
    document.documentElement.classList.add('is-static-pages-site')
    if (staticGeneratorNotice instanceof HTMLElement) staticGeneratorNotice.hidden = false
    if (buttonLabel instanceof HTMLElement) buttonLabel.textContent = 'View product demo'
  }

  const copyrightYear = document.querySelector('#copyright-year')
  if (copyrightYear instanceof HTMLElement) copyrightYear.textContent = String(new Date().getFullYear())

  menuButton?.addEventListener('click', () => {
    const isOpen = navigation.classList.toggle('is-open')
    menuButton.setAttribute('aria-expanded', String(isOpen))
  })

  navigation?.addEventListener('click', (event) => {
    if (!(event.target instanceof HTMLAnchorElement)) return
    navigation.classList.remove('is-open')
    menuButton?.setAttribute('aria-expanded', 'false')
  })

  configurePublicUtilities()

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => {
      const manifestLink = document.querySelector('link[rel="manifest"]')
      const publicBase = manifestLink instanceof HTMLLinkElement ? manifestLink.href : document.baseURI
      navigator.serviceWorker.register(new URL('sw.js', publicBase)).catch(() => {
        // Offline support is optional; a failed registration must not break the player generator.
      })
    })
  }

  document.querySelector('#add-subtitle')?.addEventListener('click', () => addSubtitleRow())

  subtitleList?.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('.remove-subtitle') : null
    button?.closest('.subtitle-item')?.remove()
  })

  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const input = document.querySelector(`#${button.dataset.copy}`)
      if (!(input instanceof HTMLInputElement) || input.value.length === 0) return
      try {
        await navigator.clipboard.writeText(input.value)
      } catch {
        input.select()
        document.execCommand('copy')
      }
      const previous = button.textContent
      button.textContent = 'Copied'
      window.setTimeout(() => { button.textContent = previous }, 1400)
    })
  })

  form?.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!(form instanceof HTMLFormElement)) return

    if (isStaticPagesSite) {
      document.querySelector('#product-demo')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }

    clearMessage()
    const mainInput = form.elements.namedItem('id')
    if (!(mainInput instanceof HTMLInputElement) || !mainInput.checkValidity()) {
      mainInput?.setAttribute('aria-invalid', 'true')
      showMessage('Enter a valid main video URL.')
      mainInput?.focus()
      return
    }
    mainInput.removeAttribute('aria-invalid')

    const payload = new FormData(form)
    payload.set('action', 'createPlayer')
    for (const field of ['sub-url[]', 'lang-url[]', 'sub-file[]', 'lang-file[]']) payload.delete(field)
    const rows = [...form.querySelectorAll('.subtitle-item')].slice(0, 10)
    rows.forEach((row, index) => {
      const labelInput = row.querySelector('[data-subtitle-label]')
      const urlInput = row.querySelector('[data-subtitle-url]')
      const fileInput = row.querySelector('[data-subtitle-file]')
      const label = labelInput instanceof HTMLInputElement && labelInput.value.trim() !== ''
        ? labelInput.value.trim()
        : `Subtitle ${index + 1}`
      if (urlInput instanceof HTMLInputElement && urlInput.value.trim() !== '') {
        payload.append('sub-url[]', urlInput.value.trim())
        payload.append('lang-url[]', label)
      }
      if (fileInput instanceof HTMLInputElement && fileInput.files?.[0] !== undefined) {
        payload.append('sub-file[]', fileInput.files[0], fileInput.files[0].name)
        payload.append('lang-file[]', label)
      }
    })

    setLoading(true)
    try {
      const response = await fetch(new URL('ajax/public/', document.baseURI), {
        method: 'POST',
        headers: { accept: 'application/json' },
        body: payload
      })
      if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
      const body = await response.json()
      if (body.status !== 'ok' || body.result === null) {
        throw new Error(body.message || 'The player could not be generated.')
      }

      showResult(body.result)
      showMessage('Player links generated.', true)
    } catch (error) {
      showMessage(error instanceof Error ? error.message : 'The player could not be generated.')
    } finally {
      setLoading(false)
    }
  })

  function addSubtitleRow() {
    if (!(subtitleTemplate instanceof HTMLTemplateElement) || !(subtitleList instanceof HTMLElement)) return
    const rowNumber = subtitleList.querySelectorAll('.subtitle-item').length + 1
    if (rowNumber > 10) {
      showMessage('You can add up to 10 subtitle tracks.')
      return
    }
    const row = subtitleTemplate.content.cloneNode(true)
    const controls = [
      ['[data-subtitle-label]', `subtitle-${rowNumber}-label`],
      ['[data-subtitle-url]', `subtitle-${rowNumber}-url`],
      ['[data-subtitle-file]', `subtitle-${rowNumber}-file`]
    ]
    controls.forEach(([selector, id]) => {
      const control = row.querySelector(selector)
      const label = control?.closest('.field')?.querySelector('label')
      if (control instanceof HTMLInputElement) control.id = id
      if (label instanceof HTMLLabelElement) label.htmlFor = id
    })
    subtitleList.append(row)
    subtitleList.lastElementChild?.querySelector('input')?.focus()
  }

  function showResult(result) {
    setValue('embed-url', result.embed_url)
    setValue('embed-code', result.embed_code)
    setValue('download-url', result.download_url)
    setValue('request-url', result.request_url)

    const preview = document.querySelector('#player-preview')
    if (preview instanceof HTMLIFrameElement) preview.src = result.embed_url
    const openPlayer = document.querySelector('#open-player')
    if (openPlayer instanceof HTMLAnchorElement) openPlayer.href = result.embed_url

    outputEmpty.hidden = true
    outputResult.hidden = false
    document.querySelector('#output')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function setValue(id, value) {
    const input = document.querySelector(`#${id}`)
    if (input instanceof HTMLInputElement) input.value = String(value || '')
  }

  function setLoading(isLoading) {
    if (generateButton instanceof HTMLButtonElement) generateButton.disabled = isLoading
    if (buttonLabel instanceof HTMLElement) buttonLabel.textContent = isLoading ? 'Generating player…' : 'Generate player'
  }

  function showMessage(text, success = false) {
    if (!(message instanceof HTMLElement)) return
    message.textContent = text
    message.classList.toggle('success', success)
  }

  function clearMessage() {
    if (!(message instanceof HTMLElement)) return
    message.textContent = ''
    message.classList.remove('success')
  }

  function configurePublicUtilities() {
    const gotoTop = document.querySelector('#gotoTop')
    if (!(gotoTop instanceof HTMLButtonElement)) return
    let scrollFrame = 0
    const updateGotoTop = () => {
      scrollFrame = 0
      gotoTop.hidden = globalThis.scrollY <= 200
    }
    globalThis.addEventListener('scroll', () => {
      if (scrollFrame !== 0) return
      scrollFrame = globalThis.requestAnimationFrame(updateGotoTop)
    }, { passive: true })
    gotoTop.addEventListener('click', () => {
      const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
      globalThis.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' })
    })
    updateGotoTop()
  }
})()
