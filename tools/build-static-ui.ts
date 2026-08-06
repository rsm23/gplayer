import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { SHADCN_STATIC_STYLESHEET, withShadcnUi } from '../src/ui/shadcn-html.js'

const staticPages = ['public/index.html', 'public/offline.html'] as const

for (const relativePath of staticPages) {
  const absolutePath = resolve(relativePath)
  const source = await readFile(absolutePath, 'utf8')
  const output = withShadcnUi(source, SHADCN_STATIC_STYLESHEET)
  if (output !== source) await writeFile(absolutePath, output)
}
