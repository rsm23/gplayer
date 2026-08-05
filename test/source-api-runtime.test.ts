import { describe, expect, it } from 'vitest'
import { googleHlsHostsForRequest } from '../src/http/source-api-runtime.js'

describe('source API Google media modes', () => {
  it('enables only the configured playback hosts', () => {
    expect([...googleHlsHostsForRequest({ gdrive_hls: true, gphotos_hls: false }, false)]).toEqual(['gdrive'])
    expect([...googleHlsHostsForRequest({ gdrive_hls: false, gphotos_hls: true }, false)]).toEqual(['googlephotos'])
    expect([...googleHlsHostsForRequest({ gdrive_hls: true, gphotos_hls: true }, false)]).toEqual(['gdrive', 'googlephotos'])
  })

  it('forces MP4-compatible extraction for downloads', () => {
    expect([...googleHlsHostsForRequest({ gdrive_hls: true, gphotos_hls: true }, true)]).toEqual([])
  })
})
