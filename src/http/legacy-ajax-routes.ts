import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

type LegacyAjaxHandler = (request: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>

export function registerLegacyAjaxAliases(
  app: FastifyInstance,
  aliases: readonly string[],
  handler: LegacyAjaxHandler,
  methods: readonly ('GET' | 'POST')[] = ['GET', 'POST']
): void {
  const routes = new Set<string>()
  for (const alias of aliases) {
    const route = alias.endsWith('/') ? alias.slice(0, -1) : alias
    routes.add(route)
    routes.add(`${route}/`)
  }
  for (const url of routes) app.route({ method: [...methods], url, handler })
}
