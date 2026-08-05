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

  setupCustomHeaders()
  setupVastSchedule()
  setupPlayerSettings()
  setupHostingSettings()
  revealActiveSettingsTab()
})()
