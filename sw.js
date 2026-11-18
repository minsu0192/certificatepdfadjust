// Service worker: makes the tools installable and usable offline.
// Same-origin files: network first (always fresh when online), cached copy when offline.
// Versioned CDN libraries: cache first (their URLs never change content).
const VERSION = 'v5';
const SHELL = `shell-${VERSION}`, CDN = `cdn-${VERSION}`;
const PRECACHE = [
  '/', '/portal.css', '/portal.js', '/tool-theme.css', '/tool-ocr.js', '/invoice-amounts.js', '/pwa.js', '/manifest.webmanifest', '/icons/icon-192.png',
  '/vendor/pdf.min.js', '/vendor/pdf.worker.min.js', '/vendor/jszip.min.js', '/vendor/pdf-lib.min.js',
  '/tools/ai-table/', '/tools/ai-table/style.css', '/tools/ai-table/app.js', '/tools/ai-table/pdf.js', '/tools/ai-table/pdf-layout.js', '/tools/ai-table/vendor/xlsx.min.js', '/tools/ai-table/vendor/docx.js',
  '/support/', '/support/app.js',
  '/tools/pdf-workbench/', '/tools/pdf-workbench/app.js', '/tools/pdf-workbench/editor.js', '/tools/pdf-workbench/style.css',
  '/tools/pdf-workbench/image-converter.js', '/tools/pdf-workbench/ocr-tab.js', '/tools/pdf-workbench/ttf-subset.js', '/tools/pdf-workbench/unlock-worker.js',
  '/tools/pdf-workbench/vendor/fontkit/fontkit.umd.min.js', '/tools/pdf-workbench/vendor/fonts/Pretendard-Regular.ttf',
  '/tools/pdf-workbench/vendor/qpdf/qpdf.js', '/tools/pdf-workbench/vendor/qpdf/qpdf.wasm',
  ...['celine-credit-note', 'dhl-invoice', 'dhl-pdf-extractor', 'fedex-dhl-extractor', 'import-certificate'].flatMap(t => [`/tools/${t}/`, `/tools/${t}/app.js`, `/tools/${t}/style.css`])
];
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'unpkg.com', 'cdn.jsdelivr.net', 'cdn.sheetjs.com', 'fonts.gstatic.com'];
const CORE_LIBRARIES = [
  'https://cdn.jsdelivr.net/npm/postal-mime@3.0.0/+esm'
];
async function prepareExternal(cache, url) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error('Library unavailable');
    await cache.put(url, response);
  } finally { clearTimeout(timer); }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    const cdn = await caches.open(CDN);
    await Promise.allSettled([
      ...PRECACHE.map(url => cache.add(new Request(url, { cache: 'reload' }))),
      ...CORE_LIBRARIES.map(url => prepareExternal(cdn, url))
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('message', event => {
  if (event.data !== 'CACHE_STATUS' || !event.ports[0]) return;
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL), cdn = await caches.open(CDN);
    const local = await Promise.all(PRECACHE.map(url => shell.match(url)));
    const libs = await Promise.all(CORE_LIBRARIES.map(url => cdn.match(url)));
    event.ports[0].postMessage({ ready: [...local, ...libs].every(Boolean) });
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
  const hit = await cache.match(req, { ignoreSearch: true });
  const controller = new AbortController();
  const timer = hit ? setTimeout(() => controller.abort(), 4000) : null;
  try {
    const res = await fetch(req, { signal: controller.signal });
    if (res.ok) await cache.put(req, res.clone()).catch(() => {});
    return !res.ok && hit ? hit : res;
  } catch (e) {
    const fallback = hit || (req.mode === 'navigate' && await cache.match('/'));
    if (fallback) return fallback;
    throw e;
  } finally { clearTimeout(timer); }
}

async function cacheFirst(req) {
  const cache = await caches.open(CDN);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}
