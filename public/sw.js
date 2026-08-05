const CACHE_NAME = 'gplayer-node-public-v7'
const scopedUrl = (path) => new URL(path, self.registration.scope).toString()
const OFFLINE_URL = scopedUrl('offline.html')
const PRECACHE = [
  '',
  'offline.html',
  'manifest.json',
  'assets/css/gplayer-landing.css',
  'assets/css/gplayer-public.css',
  'assets/js/gplayer-landing.js',
  'assets/img/logo/rr.ico',
  'assets/img/film.png',
  'assets/img/maskable_icon.png',
  'assets/img/product/gplayer-generator.png',
  'assets/img/product/gplayer-admin.png'
].map(scopedUrl)

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((name) => /^(?:gdplayer|gplayer)-/.test(name) && name !== CACHE_NAME).map((name) => caches.delete(name))
    ))
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)))
    return
  }

  if (!['style', 'script', 'image', 'manifest', 'font'].includes(request.destination)) return
  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
      if (!response.ok || response.type !== 'basic') return response
      const copy = response.clone()
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
      return response
    }))
  )
})
