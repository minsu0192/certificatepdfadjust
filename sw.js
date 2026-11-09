// Service worker: makes the tools installable and usable offline.
// Same-origin files: network first (always fresh when online), cached copy when offline.
// Versioned CDN libraries: cache first (their URLs never change content).
const VERSION = 'v1';
const SHELL = `shell-${VERSION}`, CDN = `cdn-${VERSION}`;
const PRECACHE = [
  '/', '/portal.css', '/portal.js', '/tool-theme.css', '/tool-ocr.js', '/pwa.js', '/manifest.webmanifest', '/icons/icon-192.png',
  '/support/', '/support/app.js',
  '/tools/pdf-workbench/', '/tools/pdf-workbench/app.js', '/tools/pdf-workbench/editor.js', '/tools/pdf-workbench/style.css',
  '/tools/pdf-workbench/image-converter.js', '/tools/pdf-workbench/ocr-tab.js', '/tools/pdf-workbench/ttf-subset.js', '/tools/pdf-workbench/unlock-worker.js',
  '/tools/pdf-workbench/vendor/fontkit/fontkit.umd.min.js', '/tools/pdf-workbench/vendor/fonts/Pretendard-Regular.ttf',
  ...['celine-credit-note', 'dhl-invoice', 'dhl-pdf-extractor', 'fedex-dhl-extractor', 'import-certificate'].flatMap(t => [`/tools/${t}/`, `/tools/${t}/app.js`, `/tools/${t}/style.css`])
];
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'unpkg.com', 'cdn.jsdelivr.net', 'cdn.sheetjs.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.all(PRECACHE.map(url => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (![SHELL, CDN].includes(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) event.respondWith(networkFirst(req));
  else if (CDN_HOSTS.includes(url.hostname)) event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' && await cache.match('/'));
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CDN);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}
