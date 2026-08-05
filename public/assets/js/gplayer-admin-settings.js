(() => {
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
    const fragment = template.content.cloneNode(true)
    list.append(fragment)
    reindex()
    rows().at(-1)?.querySelector('textarea')?.focus()
  })

  reindex()
})()
