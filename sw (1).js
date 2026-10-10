// ============================================================
// sw.js — تشغيل التطبيق دون إنترنت
// • الشبكة أولًا: عند وجود الإنترنت تُجلب أحدث نسخة من الملفات دائمًا وتُحفظ نسخة منها.
// • عند انقطاع الإنترنت: تُعرض آخر نسخة محفوظة، فيفتح التطبيق ويرصد كالمعتاد.
// • لا يُخزَّن أي اتصال بقاعدة البيانات (Supabase) ولا أي بيانات طلاب؛ البيانات تبقى في التخزين المحلي كما هي.
// ============================================================
const CACHE = 'quran-app-offline-v3';
const CORE = ['./', './index.html', './parent-sync.js', './manifest.json', './manifest.webmanifest', './icon-192.png', './icon-512.png', './student.html'];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // كل ملف على حدة؛ غياب ملف اختياري (مثل أيقونة) لا يُفشل التثبيت
    await Promise.all(CORE.map(async url => {
      try { const res = await fetch(url, { cache: 'reload' }); if (res && res.ok) await cache.put(url, res); } catch (_) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

function cacheKeyFor(request) {
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate' && (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html'))) return './index.html';
    url.search = ''; // parent-sync.js?v=... يُحفظ باسم واحد
    return url.href;
  }
  return request.url;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const cdn = CDN_HOSTS.includes(url.hostname);
  if (!sameOrigin && !cdn) return; // Supabase وQR وغيرها: مباشرة دون أي تخزين
  const key = cacheKeyFor(req);
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) { try { await cache.put(key, res.clone()); } catch (_) {} }
      return res;
    } catch (err) {
      const hit = (await cache.match(key)) || (await cache.match(req, { ignoreSearch: true })) ||
        (req.mode === 'navigate' ? await cache.match('./index.html') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
