(() => {
  const setupCustomHeaders = () => {
    const editor = document.querySelector('.custom-header-editor')
    const list = editor?.querySelector('[data-custom-header-list]')
    const template = document.querySelector('template[data-custom-header-template]')
    const addButton = editor?.querySelector('[data-add-custom-header]')
    if (!(editor instanceof HTMLFormElement) || !(list instanceof HTMLElement) || !(template instanceof HTMLTemplateElement) || !(addButton instanceof HTMLButtonElement)) return

    const maximum = Number(editor.dataset.maxRules ?? '50')
    const rows = () => [...list.querySelectorAll('[data-custom-header-row]')]
    const reindex = () => {
      rows().forEach((row, index) => {
        const keywords = row.querySelector('[data-custom-header-keywords]')
        const values = row.querySelector('[data-custom-header-values]')
        const keywordsLabel = row.querySelector('[data-custom-header-keywords-label]')
        const valuesLabel = row.querySelector('[data-custom-header-values-label]')
        const title = row.querySelector('[data-custom-header-title]')
        if (keywords instanceof HTMLTextAreaElement) {
          keywords.id = `custom-header-keywords-${index}`
          keywords.name = `items[${index}][keywords]`
        }
        if (values instanceof HTMLTextAreaElement) {
          values.id = `custom-header-values-${index}`
          values.name = `items[${index}][headers]`
        }
        if (keywordsLabel instanceof HTMLLabelElement) keywordsLabel.htmlFor = `custom-header-keywords-${index}`
        if (valuesLabel instanceof HTMLLabelElement) valuesLabel.htmlFor = `custom-header-values-${index}`
        if (title instanceof HTMLElement) title.textContent = `Header rule ${index + 1}`
      })
      addButton.disabled = rows().length >= maximum
    }

    list.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const remove = target.closest('[data-remove-custom-header]')
      if (!(remove instanceof HTMLButtonElement)) return
      remove.closest('[data-custom-header-row]')?.remove()
      reindex()
    })

    addButton.addEventListener('click', () => {
      if (rows().length >= maximum) return
      list.append(template.content.cloneNode(true))
      reindex()
      rows().at(-1)?.querySelector('textarea')?.focus()
    })

    reindex()
  }

  const setupVastSchedule = () => {
    const editor = document.querySelector('.ads-settings-editor')
    const list = editor?.querySelector('[data-vast-list]')
    const template = document.querySelector('template[data-vast-template]')
    const addButton = editor?.querySelector('[data-add-vast]')
    if (!(editor instanceof HTMLFormElement) || !(list instanceof HTMLElement) || !(template instanceof HTMLTemplateElement) || !(addButton instanceof HTMLButtonElement)) return

    const maximum = Number(editor.dataset.maxVast ?? '20')
    const rows = () => [...list.querySelectorAll('[data-vast-row]')]
    const reindex = () => {
      rows().forEach((row, index) => {
        const offset = row.querySelector('[data-vast-offset]')
        const url = row.querySelector('[data-vast-url]')
        const offsetLabel = row.querySelector('[data-vast-offset-label]')
        const urlLabel = row.querySelector('[data-vast-url-label]')
        if (offset instanceof HTMLInputElement) offset.id = `vast-offset-${index}`
        if (url instanceof HTMLInputElement) url.id = `vast-url-${index}`
        if (offsetLabel instanceof HTMLLabelElement) offsetLabel.htmlFor = `vast-offset-${index}`
        if (urlLabel instanceof HTMLLabelElement) urlLabel.htmlFor = `vast-url-${index}`
      })
      addButton.disabled = rows().length >= maximum
    }

    list.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const remove = target.closest('[data-remove-vast]')
      if (!(remove instanceof HTMLButtonElement)) return
      remove.closest('[data-vast-row]')?.remove()
      reindex()
    })

    addButton.addEventListener('click', () => {
      if (rows().length >= maximum) return
      list.append(template.content.cloneNode(true))
      reindex()
      rows().at(-1)?.querySelector('input')?.focus()
    })

    reindex()
  }

  const revealActiveSettingsTab = () => {
    const navigation = document.querySelector('.settings-subnav')
    const active = navigation?.querySelector('[aria-current="page"]')
    if (!(navigation instanceof HTMLElement) || !(active instanceof HTMLElement)) return
    const activeRight = active.offsetLeft + active.offsetWidth
    const visibleRight = navigation.scrollLeft + navigation.clientWidth
    if (activeRight > visibleRight) navigation.scrollLeft = Math.max(0, activeRight - navigation.clientWidth + 4)
    else if (active.offsetLeft < navigation.scrollLeft) navigation.scrollLeft = Math.max(0, active.offsetLeft - 4)
  }

  const setupPlayerSettings = () => {
    const editor = document.querySelector('[data-player-settings]')
    if (!(editor instanceof HTMLFormElement)) return
    const colors = [...editor.querySelectorAll('.settings-color-field input[type="color"]')]
    const refreshColorLabel = (input) => {
      const label = input.closest('.settings-color-field')?.querySelector('code')
      if (label instanceof HTMLElement) label.textContent = input.value.toLowerCase()
    }
    colors.forEach((input) => {
      if (!(input instanceof HTMLInputElement)) return
      input.addEventListener('input', () => refreshColorLabel(input))
      refreshColorLabel(input)
    })

    const skin = editor.querySelector('#player_skin')
    const primary = editor.querySelector('#player_color')
    const secondary = editor.querySelector('#player_color2')
    if (!(skin instanceof HTMLSelectElement) || !(primary instanceof HTMLInputElement) || !(secondary instanceof HTMLInputElement)) return
    const palettes = {
      dropload: ['#3db6d4', '#00d0a2'],
      netflix: ['#e50914', '#e50914'],
      hotstar: ['#095ae5', '#062794'],
      iqiyi: ['#00c234', '#23d41e'],
      lulustream: ['#4a62e1', '#51e0c0']
    }
    skin.addEventListener('change', () => {
      const palette = palettes[skin.value]
      if (palette === undefined) return
      primary.value = palette[0]
      secondary.value = palette[1]
      refreshColorLabel(primary)
      refreshColorLabel(secondary)
    })
  }

  const setupHostingSettings = () => {
    const editor = document.querySelector('[data-hosting-settings]')
    const search = editor?.querySelector('[data-hosting-search]')
    const list = editor?.querySelector('[data-hosting-list]')
    const empty = editor?.querySelector('[data-hosting-empty]')
    if (!(editor instanceof HTMLFormElement) || !(search instanceof HTMLInputElement) || !(list instanceof HTMLElement) || !(empty instanceof HTMLElement)) return

    const cards = [...list.querySelectorAll('[data-hosting-provider]')]
    const filter = () => {
      const query = search.value.trim().toLocaleLowerCase('en-US')
      let visible = 0
      cards.forEach((card) => {
        if (!(card instanceof HTMLDetailsElement)) return
        const match = query === '' || (card.dataset.hostingSearch ?? '').includes(query)
        card.hidden = !match
        if (match) visible += 1
      })
      empty.hidden = visible !== 0
    }

    search.addEventListener('input', filter)
    editor.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const reset = target.closest('[data-reset-hosting-name]')
      if (!(reset instanceof HTMLButtonElement)) return
      const field = document.getElementById(reset.dataset.target ?? '')
      if (!(field instanceof HTMLInputElement)) return
      field.value = reset.dataset.value ?? ''
      field.focus()
    })
    filter()
  }

  const setupVideoEditor = () => {
    const editor = document.querySelector('[data-video-editor]')
    const list = editor?.querySelector('[data-video-alternative-list]')
    const template = editor?.querySelector('template[data-video-alternative-template]')
    const addButton = editor?.querySelector('[data-add-video-alternative]')
    if (!(editor instanceof HTMLFormElement) || !(list instanceof HTMLElement) || !(template instanceof HTMLTemplateElement) || !(addButton instanceof HTMLButtonElement)) return

    const maximum = Number(editor.dataset.maxAlternatives ?? '20')
    const rows = () => [...list.querySelectorAll('[data-video-alt-row]')]
    const reindex = () => {
      rows().forEach((row, index) => {
        const input = row.querySelector('[data-video-alt-input]')
        const label = row.querySelector('[data-video-alt-label]')
        const remove = row.querySelector('[data-remove-video-alternative]')
        if (input instanceof HTMLInputElement) input.id = `alt-link-${index}`
        if (label instanceof HTMLLabelElement) {
          label.htmlFor = `alt-link-${index}`
          label.textContent = `Alternative URL ${index + 1}`
        }
        if (remove instanceof HTMLButtonElement) remove.setAttribute('aria-label', `Remove alternative URL ${index + 1}`)
      })
      addButton.disabled = rows().length >= maximum
    }

    list.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const remove = target.closest('[data-remove-video-alternative]')
      if (!(remove instanceof HTMLButtonElement)) return
      remove.closest('[data-video-alt-row]')?.remove()
      reindex()
    })
    addButton.addEventListener('click', () => {
      if (rows().length >= maximum) return
      list.append(template.content.cloneNode(true))
      reindex()
      rows().at(-1)?.querySelector('input')?.focus()
    })
    reindex()
  }

  const setupVideoChecker = () => {
    const form = document.querySelector('[data-video-checker]')
    const progressShell = form?.querySelector('[data-video-checker-progress]')
    const progress = progressShell?.querySelector('progress')
    const output = progressShell?.querySelector('output')
    const submit = form?.querySelector('button[type="submit"]')
    const csrf = form?.querySelector('input[name="csrf"]')
    if (!(form instanceof HTMLFormElement) || !(progressShell instanceof HTMLElement) || !(progress instanceof HTMLProgressElement) || !(output instanceof HTMLOutputElement) || !(submit instanceof HTMLButtonElement) || !(csrf instanceof HTMLInputElement)) return

    const statusFor = (id) => document.querySelector(`[data-video-status="${CSS.escape(id)}"]`)
    const setStatus = (element, status, label) => {
      if (!(element instanceof HTMLElement)) return
      element.classList.remove('video-state-0', 'video-state-1', 'video-state-2')
      element.classList.add(`video-state-${status}`)
      element.textContent = label
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const maximum = Number(form.dataset.maxVideos ?? '100')
      const selected = [...document.querySelectorAll('[data-video-selection]:checked')]
        .filter((item) => item instanceof HTMLInputElement)
      progressShell.hidden = false
      if (selected.length === 0) {
        output.textContent = 'Select at least one video to check.'
        return
      }
      if (!Number.isSafeInteger(maximum) || maximum < 1 || selected.length > maximum) {
        output.textContent = `Select no more than ${Number.isSafeInteger(maximum) && maximum > 0 ? maximum : 100} videos at once.`
        return
      }
      if (!window.confirm(`Check ${selected.length} selected video${selected.length === 1 ? '' : 's'} now?`)) return

      const original = new Map()
      let good = 0
      let broken = 0
      let failed = 0
      progress.max = selected.length
      progress.value = 0
      submit.disabled = true
      selected.forEach((item) => { item.disabled = true })

      for (const [index, selection] of selected.entries()) {
        const id = selection.value
        const state = statusFor(id)
        if (state instanceof HTMLElement) {
          original.set(id, { className: state.className, text: state.textContent ?? '' })
          state.setAttribute('aria-busy', 'true')
          setStatus(state, 2, 'Checking')
        }
        output.textContent = `Checking ${index + 1} of ${selected.length}…`

        try {
          const response = await fetch(form.action, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: new URLSearchParams({ csrf: csrf.value, id })
          })
          const payload = await response.json()
          const videoStatus = payload?.result?.videoStatus
          if (!response.ok || payload?.status !== 'ok' || (videoStatus !== 0 && videoStatus !== 1)) throw new Error(payload?.message || 'The video availability check failed')
          setStatus(state, videoStatus, videoStatus === 0 ? 'Good' : 'Broken')
          state?.setAttribute('title', payload.message ?? '')
          if (videoStatus === 0) good += 1
          else broken += 1
        } catch (error) {
          failed += 1
          const previous = original.get(id)
          if (state instanceof HTMLElement && previous !== undefined) {
            state.className = previous.className
            state.textContent = previous.text
            state.setAttribute('title', error instanceof Error ? error.message : 'The video availability check failed')
          }
        } finally {
          state?.removeAttribute('aria-busy')
          progress.value = index + 1
        }
      }

      selected.forEach((item) => { item.disabled = false })
      submit.disabled = false
      output.textContent = `${good} Good · ${broken} Broken${failed > 0 ? ` · ${failed} not updated` : ''}`
    })
  }

  const setupVideoBulk = () => {
    const form = document.querySelector('[data-video-bulk]')
    const linksInput = form?.querySelector('textarea[name="links"]')
    const useTitle = form?.querySelector('input[name="useTitle"]')
    const csrf = form?.querySelector('input[name="csrf"]')
    const submit = form?.querySelector('button[type="submit"]')
    const progressShell = form?.querySelector('[data-video-bulk-progress]')
    const progress = progressShell?.querySelector('progress')
    const output = progressShell?.querySelector('output')
    const results = document.querySelector('[data-video-bulk-results]')
    const rows = results?.querySelector('[data-video-bulk-rows]')
    if (!(form instanceof HTMLFormElement) || !(linksInput instanceof HTMLTextAreaElement) || !(useTitle instanceof HTMLInputElement) || !(csrf instanceof HTMLInputElement) || !(submit instanceof HTMLButtonElement) || !(progressShell instanceof HTMLElement) || !(progress instanceof HTMLProgressElement) || !(output instanceof HTMLOutputElement) || !(results instanceof HTMLElement) || !(rows instanceof HTMLTableSectionElement)) return

    const appendTextCell = (row, value) => {
      const cell = document.createElement('td')
      cell.textContent = value
      row.append(cell)
      return cell
    }
    const safeUrl = (value) => {
      try {
        const url = new URL(String(value ?? ''), window.location.href)
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
      } catch {
        return ''
      }
    }
    const appendFailure = (input, message) => {
      const row = document.createElement('tr')
      row.className = 'video-bulk-error'
      const title = appendTextCell(row, 'Not saved')
      const detail = document.createElement('span')
      detail.textContent = `${input} · ${message}`
      title.append(detail)
      appendTextCell(row, '—')
      appendTextCell(row, '—')
      appendTextCell(row, '—')
      const status = appendTextCell(row, '')
      const state = document.createElement('span')
      state.className = 'video-state video-state-1'
      state.textContent = 'Failed'
      status.append(state)
      appendTextCell(row, '—')
      rows.append(row)
    }
    const appendResult = (record) => {
      const row = document.createElement('tr')
      const title = appendTextCell(row, String(record?.title || 'Untitled video'))
      const slug = document.createElement('span')
      slug.textContent = String(record?.slug || '')
      title.append(slug)

      const source = document.createElement('td')
      source.className = 'video-bulk-source'
      const sourceUrl = safeUrl(record?.link)
      if (sourceUrl !== '') {
        const link = document.createElement('a')
        link.href = sourceUrl
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.textContent = String(record?.host || 'source')
        source.append(link)
      } else source.textContent = String(record?.host || '—')
      const sourceId = document.createElement('span')
      sourceId.textContent = String(record?.host_id || '')
      source.append(sourceId)
      row.append(source)

      appendTextCell(row, record?.has_sub === true ? 'Available' : '—')
      const created = Number(record?.created)
      appendTextCell(row, Number.isFinite(created) && created > 0 ? new Date(created * 1000).toLocaleString() : '—')
      const statusCell = appendTextCell(row, '')
      const status = Number(record?.status) === 0 ? 0 : 1
      const state = document.createElement('span')
      state.className = `video-state video-state-${status}`
      state.textContent = status === 0 ? 'Good' : 'Broken'
      statusCell.append(state)

      const actionsCell = document.createElement('td')
      const actions = document.createElement('div')
      actions.className = 'video-row-actions'
      const embedUrl = safeUrl(record?.actions?.embed)
      if (embedUrl !== '') {
        const embed = document.createElement('a')
        embed.href = embedUrl
        embed.target = '_blank'
        embed.rel = 'noopener noreferrer'
        embed.textContent = 'Embed'
        actions.append(embed)
      }
      const editBase = safeUrl(form.dataset.editUrl)
      if (editBase !== '' && String(record?.id || '') !== '') {
        const edit = document.createElement('a')
        const editUrl = new URL(editBase)
        editUrl.searchParams.set('id', String(record.id))
        edit.href = editUrl.href
        edit.textContent = 'Edit'
        actions.append(edit)
      }
      const deleteUrl = safeUrl(form.dataset.deleteUrl)
      if (deleteUrl !== '' && String(record?.id || '') !== '') {
        const deleteForm = document.createElement('form')
        deleteForm.action = deleteUrl
        deleteForm.method = 'post'
        for (const [name, value] of [['csrf', form.dataset.mutationCsrf || ''], ['id', String(record.id)]]) {
          const input = document.createElement('input')
          input.type = 'hidden'
          input.name = name
          input.value = value
          deleteForm.append(input)
        }
        const button = document.createElement('button')
        button.type = 'submit'
        button.className = 'session-revoke'
        button.textContent = 'Delete'
        deleteForm.append(button)
        deleteForm.addEventListener('submit', (event) => {
          if (!window.confirm(`Delete ${String(record?.title || 'this video')}?`)) event.preventDefault()
        })
        actions.append(deleteForm)
      }
      actionsCell.append(actions)
      row.append(actionsCell)
      rows.append(row)
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (!form.reportValidity()) return
      const sourceLines = linksInput.value.trim()
      if (sourceLines === '') {
        progressShell.hidden = false
        output.textContent = 'Insert the video links first.'
        return
      }
      const links = sourceLines.split('\n').map((value) => value.trim())
      const maximum = Number(form.dataset.maxVideos ?? '1000')
      progressShell.hidden = false
      if (!Number.isSafeInteger(maximum) || maximum < 1 || links.length > maximum) {
        output.textContent = `Paste no more than ${Number.isSafeInteger(maximum) && maximum > 0 ? maximum : 1000} video URLs at once.`
        return
      }
      if (!window.confirm(`Resolve and save ${links.length} video URL${links.length === 1 ? '' : 's'}?`)) return

      rows.replaceChildren()
      results.hidden = false
      progress.max = links.length
      progress.value = 0
      submit.disabled = true
      linksInput.disabled = true
      useTitle.disabled = true
      let good = 0
      let broken = 0
      let failed = 0

      for (const [offset, data] of links.entries()) {
        output.textContent = `Resolving ${offset + 1} of ${links.length}…`
        try {
          const response = await fetch(form.action, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: new URLSearchParams({ csrf: csrf.value, data, total: String(links.length), offset: String(offset), useTitle: String(useTitle.checked) })
          })
          const payload = await response.json()
          if (!response.ok || payload?.status !== 'ok' || typeof payload?.result?.data !== 'object') {
            failed += 1
            appendFailure(data, String(payload?.message || 'The new video failed to save'))
          } else {
            appendResult(payload.result.data)
            if (Number(payload.result.data.status) === 0) good += 1
            else broken += 1
          }
        } catch (error) {
          failed += 1
          appendFailure(data, error instanceof Error ? error.message : 'The new video failed to save')
        } finally {
          progress.value = offset + 1
        }
      }

      submit.disabled = false
      linksInput.disabled = false
      useTitle.disabled = false
      linksInput.value = ''
      output.textContent = `${good} Good · ${broken} Broken${failed > 0 ? ` · ${failed} not saved` : ''}`
    })
  }

  const setupAccountAvailability = () => {
    const form = document.querySelector('form[data-account-availability]')
    if (!(form instanceof HTMLFormElement)) return
    const lookups = [
      { input: form.querySelector('#user'), action: 'checkUsername', key: 'username' },
      { input: form.querySelector('#email'), action: 'checkEmail', key: 'email' }
    ]
    lookups.forEach((lookup) => {
      if (!(lookup.input instanceof HTMLInputElement)) return
      let controller
      lookup.input.addEventListener('input', () => {
        controller?.abort()
        controller = undefined
        if (lookup.input.dataset.availabilityError === 'true') {
          lookup.input.setCustomValidity('')
          delete lookup.input.dataset.availabilityError
        }
      })
      lookup.input.addEventListener('change', async () => {
        controller?.abort()
        const nextController = new AbortController()
        controller = nextController
        const value = lookup.input.value.trim()
        if (value === '' || !lookup.input.validity.valid) return
        try {
          const response = await window.fetch('/ajax/public/', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: new URLSearchParams({ action: lookup.action, [lookup.key]: value }),
            signal: nextController.signal
          })
          const payload = await response.json()
          if (controller !== nextController) return
          const message = response.ok && payload?.status === 'fail' && typeof payload.message === 'string'
            ? payload.message
            : ''
          lookup.input.setCustomValidity(message)
          if (message === '') delete lookup.input.dataset.availabilityError
          else lookup.input.dataset.availabilityError = 'true'
        } catch (error) {
          if (error?.name !== 'AbortError') {
            lookup.input.setCustomValidity('Account availability could not be checked. Try again.')
            lookup.input.dataset.availabilityError = 'true'
          }
        }
      })
    })
  }

  setupCustomHeaders()
  setupVastSchedule()
  setupPlayerSettings()
  setupHostingSettings()
  setupVideoEditor()
  setupVideoBulk()
  setupVideoChecker()
  setupAccountAvailability()
  revealActiveSettingsTab()
})()
