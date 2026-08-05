import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

const METHODS = 'GET, POST, HEAD, OPTIONS'
const NO_CACHE = 'no-cache, no-store, no-transform, must-revalidate'

export function registerBootstrapCompatibility(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    applyLegacyCorsHeaders(reply)
    if (request.method !== 'OPTIONS') return
    return reply
      .header('cache-control', NO_CACHE)
      .code(204)
      .send()
  })
}

export function sendLegacyHeadFallback(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  reply.header('cache-control', NO_CACHE)
  if (request.url.includes('mpd/')) reply.header('content-type', 'application/dash+xml')
  return reply.code(200).send()
}

function applyLegacyCorsHeaders(reply: FastifyReply): void {
  reply
    .header('access-control-allow-methods', METHODS)
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-headers', '*')
    .header('access-control-expose-headers', '*')
}
