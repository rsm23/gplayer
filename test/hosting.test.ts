import { describe, expect, it } from 'vitest'
import liveHostSupport from '../docs/live-host-support.json' with { type: 'json' }
import hostLabels from '../resources/data/json/host-list.json' with { type: 'json' }
import supportedHostExamples from '../resources/data/json/supported-hosts.json' with { type: 'json' }
import { legacyHostingData } from '../src/core/hosting-data.js'
import { Hosting } from '../src/core/hosting.js'
import { ExtractorFactory } from '../src/hosting/extractor-factory.js'
import { configuredOnlyHostingCases, hostingCases, liveCatalogHostingCases } from './fixtures/hosting-cases.js'

describe('Hosting legacy URL parsing', () => {
  it.each([...hostingCases, ...liveCatalogHostingCases, ...configuredOnlyHostingCases])('parses the complete %s URL contract', (host, url, id, download) => {
    const hosting = new Hosting(url)
    expect(hosting.getHost()).toBe(host)
    expect(hosting.getID()).toBe(id)
    expect(hosting.getDownloadLink()).toBe(download)
  })

  it('covers every configured hostname record exactly once', () => {
    const fixtureHosts = [...hostingCases, ...liveCatalogHostingCases, ...configuredOnlyHostingCases].map(([host]) => host).sort()
    expect(fixtureHosts).toEqual(Object.keys(legacyHostingData.hostnames).sort())
  })

  it('registers every currently enabled public-catalog host while retaining archive adapters', () => {
    const enabledHosts = [...liveHostSupport.enabledHosts]
    const registeredHosts = new ExtractorFactory().supportedHosts()
    const bundledEnabledHosts = Object.keys(hostLabels).filter((host) => ((supportedHostExamples as Record<string, readonly string[]>)[host]?.length ?? 0) > 0)
    expect(new Set(enabledHosts).size).toBe(liveHostSupport.enabledHostCount)
    expect(enabledHosts).toHaveLength(liveHostSupport.enabledHostCount)
    expect(enabledHosts).toEqual(bundledEnabledHosts)
    expect(registeredHosts).toHaveLength(liveHostSupport.registeredAdapterCount)
    expect(enabledHosts.every((host) => registeredHosts.includes(host))).toBe(true)
    expect(registeredHosts.filter((host) => !enabledHosts.includes(host))).toEqual([...liveHostSupport.archiveOnlyExtras].sort())
    expect(registeredHosts).toEqual([...hostingCases, ...liveCatalogHostingCases].map(([host]) => host).sort())
  })

  it.each([
    ['https://savefiles.com/savefiles-id', 'savefiles', 'savefiles-id'],
    ['https://dropload.pro/dropload-id', 'dropload', 'dropload-id'],
    ['https://streama2z.com/streama2z-id/video.mkv', 'streama2z', 'streama2z-id'],
    ['https://streamhg.com/streamhg-id', 'streamhg', 'streamhg-id'],
    ['https://streamhg.com/f/streamhg-id', 'streamhg', 'streamhg-id'],
    ['https://vidtube.cam/vidtube-id.html', 'vidtube', 'vidtube-id'],
    ['https://www.twitch.tv/videos/123456', 'twitch', 'videos/123456']
  ])('parses current public example shape %s', (url, host, id) => {
    const hosting = new Hosting(url)
    expect(hosting.getHost()).toBe(host)
    expect(hosting.getID()).toBe(id)
  })

  it.each([
    ['https://drive.google.com/file/d/drive-file-id/view', 'gdrive', 'drive-file-id'],
    ['https://www.youtube.com/watch?v=video-id', 'youtube', 'video-id'],
    ['https://youtu.be/short-id', 'youtube', 'short-id'],
    ['https://ok.ru/video/123456', 'okru', '123456'],
    ['https://streamtape.com/e/stream-id', 'streamtape', 'stream-id'],
    ['https://photos.app.goo.gl/photo-share-id', 'googlephotos', 'photo-share-id'],
    ['https://www.dropbox.com/s/share-id/movie.mp4?dl=0', 'dropbox', 'https://www.dropbox.com/s/share-id/movie.mp4?dl=0'],
    ['https://e.pcloud.link/publink/show?code=share-id', 'pcloud', 'https://e.pcloud.link/publink/show?code=share-id'],
    ['https://soundcloud.com/artist/track-id', 'soundcloud', 'https://soundcloud.com/artist/track-id'],
    ['https://example.org/videos/watch/peer-id', 'peertube', 'https://example.org/videos/watch/peer-id'],
    ['https://archive.org/download/archive-id/movie.mp4', 'direct', 'https://archive.org/download/archive-id/movie.mp4'],
    ['https://rumble.cloud/video/movie.mp4', 'direct', 'https://rumble.cloud/video/movie.mp4'],
    ['https://cloud.mail.ru/weblink/view/media-id', 'direct', 'https://cloud.mail.ru/weblink/view/media-id'],
    ['https://cdn.dzen.ru/video/media-id/master.m3u8', 'dzen', 'https://cdn.dzen.ru/video/media-id/master.m3u8'],
    ['https://photos.google.com/share/album-id?key=share-key', 'googlephotos', 'share/album-id?key=share-key'],
    ['https://geo.dailymotion.com/player.html?video=query-id', 'dailymotion', 'query-id']
  ])('parses %s', (url, host, id) => {
    const hosting = new Hosting(url)
    expect(hosting.getHost()).toBe(host)
    expect(hosting.getID()).toBe(id)
  })

  it('constructs the canonical download URL for a parsed host', () => {
    expect(new Hosting('https://ok.ru/video/123456').getDownloadLink()).toBe('https://ok.ru/video/123456')
  })

  it('keeps direct media URLs unchanged', () => {
    const url = 'https://cdn.example.test/media/file.mp4?token=abc'
    expect(new Hosting(url).getDownloadLink()).toBe(url)
  })

  it.each([
    ['https://notyoutube.example/video', 'direct'],
    ['https://youtube.example/video?id=video-id', 'youtube'],
    ['https://www.embedtv.net/embed/video-id', 'embedtv2'],
    ['https://embedtv-3.icu/video-id', 'embedtv']
  ])('does not confuse hostname substrings for provider labels in %s', (url, host) => {
    expect(new Hosting(url).getHost()).toBe(host)
  })

  it('matches the legacy last-write rule for duplicate custom hostname aliases', () => {
    const data = {
      hostnames: { alpha: ['video.private.example'], omega: ['video.private.example'] },
      downloadUrls: {}
    }
    expect(new Hosting('https://video.private.example/watch/id', data).getHost()).toBe('omega')
  })
})
