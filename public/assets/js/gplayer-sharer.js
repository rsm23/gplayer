(() => {
  'use strict'

  const form = document.querySelector('#frmBypassLimit')
  const submit = document.querySelector('#sharer-submit')
  const output = document.querySelector('#txtGDriveDL')
  const status = document.querySelector('#sharer-status')
  if (!(form instanceof HTMLFormElement) || !(submit instanceof HTMLButtonElement) || !(output instanceof HTMLInputElement) || !(status instanceof HTMLElement)) return

  output.addEventListener('focus', () => output.select())
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    submit.disabled = true
    submit.setAttribute('aria-busy', 'true')
    status.dataset.state = 'pending'
    status.textContent = 'Creating a Drive copy…'
    output.value = ''
    output.dataset.id = ''
    try {
      const data = new FormData(form)
      const body = new URLSearchParams()
      for (const [key, value] of data.entries()) if (typeof value === 'string') body.append(key, value)
      // The hidden legacy field is named `action`, which shadows form.action
      // through HTMLFormElement's named-property lookup. Read the attribute.
      const endpoint = new URL(form.getAttribute('action') || '/ajax/public/', document.baseURI)
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { accept: 'application/json' },
        body,
        credentials: 'same-origin'
      })
      const payload = await response.json()
      const link = payload && payload.status === 'ok' && payload.result && typeof payload.result.link === 'string' ? payload.result.link : ''
      if (link === '') throw new Error(payload && typeof payload.message === 'string' ? payload.message : 'Cannot bypass the file, try later')
      output.value = link
      output.dataset.id = typeof payload.result.id === 'string' ? payload.result.id : ''
      status.dataset.state = 'success'
      status.textContent = typeof payload.message === 'string' && payload.message !== '' ? payload.message : 'The file has been successfully bypassed'
      output.focus()
    } catch (error) {
      status.dataset.state = 'error'
      status.textContent = error instanceof Error ? error.message : 'Cannot bypass the file, try later'
    } finally {
      submit.disabled = false
      submit.removeAttribute('aria-busy')
      if (globalThis.grecaptcha && typeof globalThis.grecaptcha.reset === 'function') globalThis.grecaptcha.reset()
    }
  })
})()
