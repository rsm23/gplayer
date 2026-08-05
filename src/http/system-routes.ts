import type { FastifyInstance, FastifyReply } from 'fastify'
import { freemem, loadavg, totalmem } from 'node:os'
import type { AppConfig } from '../config.js'
import {
  publicErrors,
  renderChangelogPage,
  renderDmcaPage,
  renderPrivacyPage,
  renderPublicError,
  renderTermsPage
} from '../player/public-page.js'
import { Security } from '../security/security.js'

const publicPageCsp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; object-src 'none'"

function memoryUsagePercent(): number {
  const total = totalmem()
  const free = freemem()
  return total > 0 ? Math.round(((total - free) / total) * 10_000) / 100 : 0
}

async function activeConnections(app: FastifyInstance): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    app.server.getConnections((error, count) => {
      if (error) reject(error)
      else resolve(count)
    })
  })
}

export async function registerSystemRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  const security = new Security(config.secureSalt)

  app.get('/ping', async (_request, reply) => {
    reply.header('cache-control', 'no-cache')
    return { running: true, pid: process.pid }
  })

  app.get('/health-check', async (_request, reply) => {
    reply.header('cache-control', 'no-cache')
    return {
      connections: await activeConnections(app),
      cpu_load_1m: process.platform === 'win32' ? 0 : loadavg()[0] ?? 0,
      mem_used_pct: memoryUsagePercent(),
      timestamp: Math.floor(Date.now() / 1_000)
    }
  })

  const sitemap = async (_request: unknown, reply: FastifyReply) => {
    const baseUrl = config.baseUrl.toString().replace(/\/$/, '')
    const paths = ['', '/sharer/', '/changelog/', '/terms/', '/privacy/']
    const priorities = ['1.00', '0.80', '0.80', '0.80', '0.80']
    const urls = paths.map((path, index) => `  <url>\n    <loc>${baseUrl}${path}</loc>\n    <priority>${priorities[index]}</priority>\n  </url>`).join('\n')
    reply.type('application/xml; charset=UTF-8')
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`
  }
  app.get('/sitemap', sitemap)
  app.get('/sitemap.xml', sitemap)

  const pages = [
    { paths: ['/changelog', '/changelog/'], render: renderChangelogPage },
    { paths: ['/terms', '/terms/'], render: renderTermsPage },
    { paths: ['/privacy', '/privacy/'], render: renderPrivacyPage },
    { paths: ['/dmca', '/dmca/'], render: renderDmcaPage }
  ] as const

  for (const page of pages) {
    for (const path of page.paths) {
      app.get(path, async (_request, reply) => {
        applyPublicPageHeaders(reply)
        reply.header('cache-control', 'public, max-age=300').type('text/html; charset=utf-8')
        return page.render()
      })
    }
  }

  for (const error of Object.values(publicErrors)) {
    for (const path of [`/${error.status}`, `/${error.status}/`]) {
      app.get(path, async (_request, reply) => {
        applyPublicPageHeaders(reply, true)
        reply.code(error.status).type('text/html; charset=utf-8')
        return renderPublicError(error)
      })
    }
  }

  app.get('/redirect/*', async (request, reply) => {
    const target = parseLegacyRedirect(request.url, security)
    if (target === null) {
      applyPublicPageHeaders(reply, true)
      reply.code(400).type('text/html; charset=utf-8')
      return renderPublicError(publicErrors[400])
    }
    return reply.redirect(target.href)
  })

  app.get('/embed.php', async (request, reply) => {
    const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''
    return reply.redirect(`/e/${query}`)
  })

  app.get('/embed2.php', async (request, reply) => {
    const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''
    return reply.redirect(`/r/${query}`)
  })
}

export function applyPublicPageHeaders(reply: FastifyReply, noStore = false): void {
  reply
    .header('content-security-policy', publicPageCsp)
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'strict-origin-when-cross-origin')
    .header('x-frame-options', 'SAMEORIGIN')
  if (noStore) {
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex, nofollow')
  }
}

function parseLegacyRedirect(requestUrl: string, security: Security): URL | null {
  const pathAndQuery = requestUrl.slice('/redirect/'.length)
  const queryIndex = pathAndQuery.indexOf('?')
  const rawPath = queryIndex < 0 ? pathAndQuery : pathAndQuery.slice(0, queryIndex)
  const rawQuery = queryIndex < 0 ? '' : pathAndQuery.slice(queryIndex)
  const segments = rawPath.split('/')

  // 4.8.3 used a leading routing segment before the encrypted origin. Accept
  // both that shape and the older one-token shape for existing generated links.
  const tokenIndexes = segments.length > 1 ? [1, 0] : [0]
  for (const tokenIndex of tokenIndexes) {
    const token = segments[tokenIndex]
    if (token === undefined || token.length === 0) continue
    const origin = security.decryptURLStrict(token)
    if (origin === null || !isSafeRedirectOrigin(origin)) continue

    const suffix = segments.slice(tokenIndex + 1).join('/')
    try {
      const target = new URL(origin + suffix + rawQuery)
      if (target.protocol !== 'http:' && target.protocol !== 'https:') continue
      if (target.username || target.password) continue
      return target
    } catch {
      continue
    }
  }
  return null
}

function isSafeRedirectOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}
