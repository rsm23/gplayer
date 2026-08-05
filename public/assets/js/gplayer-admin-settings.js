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
    if (activeRight > visibleRight) navigation.scrollLeft = activeRight - navigation.clientWidth + 4
    else if (active.offsetLeft < navigation.scrollLeft) navigation.scrollLeft = Math.max(0, active.offsetLeft - 4)
  }

  setupCustomHeaders()
  setupVastSchedule()
  revealActiveSettingsTab()
})()
