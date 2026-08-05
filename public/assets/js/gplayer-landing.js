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

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(new URL('sw.js', document.baseURI)).catch(() => {
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

    const subtitles = [...form.querySelectorAll('[data-subtitle-url]')]
      .filter((input) => input instanceof HTMLInputElement && input.value.trim().length > 0)
      .map((input) => input.value.trim())
    const labels = [...form.querySelectorAll('[data-subtitle-label]')]
      .filter((input) => input instanceof HTMLInputElement)
      .map((input, index) => input.value.trim() || `Subtitle ${index + 1}`)

    const payload = {
      action: 'createPlayer',
      id: mainInput.value.trim(),
      aid: valueOf(form, 'aid'),
      poster: valueOf(form, 'poster'),
      'sub[]': subtitles,
      'lang[]': labels.slice(0, subtitles.length)
    }

    setLoading(true)
    try {
      const response = await fetch(new URL('ajax/public/', document.baseURI), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload)
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
    const row = subtitleTemplate.content.cloneNode(true)
    subtitleList.append(row)
    subtitleList.lastElementChild?.querySelector('input')?.focus()
  }

  function valueOf(formElement, name) {
    const input = formElement.elements.namedItem(name)
    return input instanceof HTMLInputElement ? input.value.trim() : ''
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
})()
