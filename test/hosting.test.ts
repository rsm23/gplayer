import { describe, expect, it } from 'vitest'
import { Hosting } from '../src/core/hosting.js'
import { hostingCases } from './fixtures/hosting-cases.js'

describe('Hosting legacy URL parsing', () => {
  it.each(hostingCases)('detects the %s adapter', (host, url) => {
    expect(new Hosting(url).getHost()).toBe(host)
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
    ['https://example.org/videos/watch/peer-id', 'peertube', 'videos/watch/peer-id'],
    ['https://archive.org/download/archive-id/movie.mp4', 'direct', 'https://archive.org/download/archive-id/movie.mp4']
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
})
