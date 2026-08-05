import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

type LegacyFrontendHandler = (request: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>
type LegacyFrontendMethod = 'GET' | 'POST'

/**
 * The legacy front controller selected a frontend view from the first URI
 * segment after removing everything from its first dot onward. The remaining
 * path only belonged to the selected view, so `/view`, `/view.php`, and
 * `/view.php/anything` all dispatched to the same controller.
 */
export function registerLegacyFrontendAliases(
  app: FastifyInstance,
  aliases: readonly string[],
  handler: LegacyFrontendHandler,
  options: Readonly<{
    methods?: readonly LegacyFrontendMethod[]
    nested?: boolean
    dotted?: boolean
  }> = {}
): void {
  const methods = options.methods ?? ['GET']
  const nested = options.nested ?? true
  const dotted = options.dotted ?? true
  const routes = new Set<string>()

  for (const alias of aliases) {
    const route = normalizeAlias(alias)
    routes.add(route)
    routes.add(`${route}/`)
    if (nested) routes.add(`${route}/*`)
    if (dotted) {
      routes.add(`${route}.:legacyExtension`)
      routes.add(`${route}.:legacyExtension/`)
      if (nested) routes.add(`${route}.:legacyExtension/*`)
    }
  }

  for (const url of routes) app.route({ method: [...methods], url, handler })
}

function normalizeAlias(alias: string): string {
  const value = alias.trim().replace(/^\/+|\/+$/g, '')
  if (value === '' || value.includes('/') || value.includes(':') || value.includes('*')) {
    throw new Error(`Invalid legacy frontend alias: ${alias}`)
  }
  return `/${value}`
}
