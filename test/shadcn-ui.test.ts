import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { renderAdminLoginPage } from '../src/player/admin-page.js'
import { renderDownloadError } from '../src/player/download-page.js'
import { renderEmbedError } from '../src/player/embed-page.js'
import { publicErrors, renderPublicError } from '../src/player/public-page.js'
import { SHADCN_STYLESHEET, withShadcnUi } from '../src/ui/shadcn-html.js'

describe('application-wide shadcn UI', () => {
  it('uses the project-owned Base Nova registry configuration', () => {
    const config = JSON.parse(readFileSync(new URL('../components.json', import.meta.url), 'utf8')) as {
      style: string
      rsc: boolean
      tailwind: { css: string }
      aliases: { ui: string; utils: string }
    }
    expect(config).toMatchObject({
      style: 'base-nova',
      rsc: false,
      tailwind: { css: 'src/styles/globals.css' },
      aliases: { ui: '@/components/ui', utils: '@/lib/utils' }
    })
  })

  it('composes native server forms from shadcn fields and controls', () => {
    const source = `<!doctype html><html><head><title>UI</title></head><body><!-- contract-marker --><form class="settings-form" enctype="multipart/form-data"><div class="field"><label for="name">Name</label><input id="name" name="name" inputmode="url" autocomplete="url" required><p class="field-hint">Required</p></div><div class="field"><label for="notes">Notes</label><textarea id="notes" name="notes">Hello</textarea></div><div class="field"><label for="role">Role</label><select id="role" name="role"><option value="user" selected>User</option></select></div><label><input type="checkbox" name="enabled" checked> Enabled</label><button type="submit">Save</button></form><table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>One</td></tr></tbody></table></body></html>`
    const output = withShadcnUi(source)

    for (const slot of ['form', 'field-group', 'field', 'field-label', 'field-description', 'input', 'textarea', 'native-select-wrapper', 'native-select', 'checkbox', 'button', 'table', 'table-header', 'table-body', 'table-row', 'table-head', 'table-cell']) {
      expect(output).toContain(`data-slot="${slot}"`)
    }
    expect(output).toContain('data-ui="shadcn"')
    expect(output).toContain(`href="${SHADCN_STYLESHEET}"`)
    expect(output).toContain('enctype="multipart/form-data"')
    expect(output).toContain('inputmode="url"')
    expect(output).toContain('autocomplete="url"')
    expect(output).toContain('<option value="user" selected>User</option>')
    expect(output).toContain('<!-- contract-marker -->')
    expect(withShadcnUi(output)).toBe(output)
  })

  it('covers authentication, public, player, and download document shells', () => {
    const documents = [
      renderAdminLoginPage('/administrator'),
      renderPublicError(publicErrors[404]),
      renderEmbedError('Unavailable'),
      renderDownloadError('Unavailable')
    ]
    for (const document of documents) {
      expect(document).toContain('data-ui="shadcn"')
      expect(document).toContain(`href="${SHADCN_STYLESHEET}"`)
    }
    expect(documents[0]).toContain('data-slot="field-group"')
    expect(documents[0]).toContain('data-slot="card"')
    expect(documents[0]).toContain('data-slot="input"')
    expect(documents[0]).toContain('data-slot="checkbox"')
    expect(documents[0]).toContain('data-slot="button"')
    expect(documents[1]).toContain('data-slot="button"')
  })

  it('keeps the generated Pages landing and offline fallback on the same system', () => {
    for (const relativePath of ['../public/index.html', '../public/offline.html']) {
      const html = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
      expect(html).toContain('data-ui="shadcn"')
      expect(html).toContain(`href="${SHADCN_STYLESHEET}"`)
      expect(withShadcnUi(html)).toBe(html)
    }
    const landing = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
    expect(landing).toContain('data-slot="field-group"')
    expect(landing).toContain('data-slot="button"')
    expect(landing).toContain('data-slot="input"')
    expect(landing).toContain('<!-- runtime-public-navigation -->')
  })
})
