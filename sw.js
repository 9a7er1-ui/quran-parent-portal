const CACHE='quran-pwa-dev-20261003-syncfix1';

self.addEventListener('install', e => self.skipWaiting());

self.addEventListener('activate', e => e.waitUntil((async()=>{
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const r = e.request;
  const u = new URL(r.url);

  // مهم: لا نعترض أي طلب خارج نطاق الموقع، وخصوصًا طلبات Supabase.
  // تركها للمتصفح مباشرة يمنع تخزين ردود قاعدة البيانات القديمة في Cache Storage.
  if (u.origin !== self.location.origin) return;
  if (r.method !== 'GET') return;

  // ملفات التطبيق الأساسية: الشبكة أولًا، والكاش فقط عند تعذر الشبكة.
  if (u.pathname.endsWith('.html') || u.pathname.endsWith('.js') || u.pathname.endsWith('/')) {
    e.respondWith(
      fetch(r, { cache: 'no-store' }).catch(() => caches.match(r))
    );
    return;
  }

  // الأصول المحلية الثابتة فقط (صور/أيقونات/manifest...): الكاش أولًا.
  e.respondWith(
    caches.match(r).then(cached => cached || fetch(r).then(res => {
      if (res && res.ok) {
        const cp = res.clone();
        caches.open(CACHE).then(cache => cache.put(r, cp));
      }
      return res;
    }))
  );
});
