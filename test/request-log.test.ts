import { describe, expect, it } from 'vitest'
import { redactSensitiveRequestUrl } from '../src/http/request-log.js'

describe('request URL redaction', () => {
  it('redacts the legacy plugin synchronization secret', () => {
    expect(redactSensitiveRequestUrl('/administrator/plugins/sync/?id=7&secure=deployment-salt&action=ping')).toBe('/administrator/plugins/sync/?id=7&secure=%5Bredacted%5D&action=ping')
  })

  it('retains ordinary query values and fragments no secret value', () => {
    expect(redactSensitiveRequestUrl('/videos/list/?q=sample&draw=2')).toBe('/videos/list/?q=sample&draw=2')
    expect(redactSensitiveRequestUrl('/api?token=private&secure=also-private')).not.toContain('private')
  })
})
