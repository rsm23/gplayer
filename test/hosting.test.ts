import { describe, expect, it } from 'vitest'
import { legacyHostingData } from '../src/core/hosting-data.js'
import { Hosting } from '../src/core/hosting.js'
import { configuredOnlyHostingCases, hostingCases } from './fixtures/hosting-cases.js'

describe('Hosting legacy URL parsing', () => {
  it.each([...hostingCases, ...configuredOnlyHostingCases])('parses the complete %s URL contract', (host, url, id, download) => {
    const hosting = new Hosting(url)
    expect(hosting.getHost()).toBe(host)
    expect(hosting.getID()).toBe(id)
    expect(hosting.getDownloadLink()).toBe(download)
  })

  it('covers every configured hostname record exactly once', () => {
    const fixtureHosts = [...hostingCases, ...configuredOnlyHostingCases].map(([host]) => host).sort()
    expect(fixtureHosts).toEqual(Object.keys(legacyHostingData.hostnames).sort())
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
