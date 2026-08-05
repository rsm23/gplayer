import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const app = await buildApp(config)

const close = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, 'shutting down')
  await app.close()
  process.exit(0)
}

process.once('SIGINT', () => void close('SIGINT'))
process.once('SIGTERM', () => void close('SIGTERM'))

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
