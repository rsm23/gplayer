import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('normalizes the legacy server configuration', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      HOST: '0.0.0.0',
      PORT: '8080',
      BASE_URL: 'https://player.example.test/base/',
      ADMIN_DIR: 'control-panel',
      SECURE_SALT: '1234567890123456'
    })

    expect(config.port).toBe(8080)
    expect(config.baseUrl.toString()).toBe('https://player.example.test/base/')
    expect(config.adminDirectory).toBe('control-panel')
    expect(config.trustProxy).toBe(false)
  })

  it('refuses the development salt in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/SECURE_SALT/)
  })

  it('accepts only explicit trusted proxy addresses or ranges', () => {
    expect(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '127.0.0.1,10.0.0.0/8' }).trustProxy).toEqual(['127.0.0.1', '10.0.0.0/8'])
    expect(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true' }).trustProxy).toBe(true)
    expect(() => loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'proxy.example' })).toThrow(/TRUST_PROXY/)
  })
})
