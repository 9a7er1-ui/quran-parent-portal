const CACHE='quran-pwa-dev-20260930-rosterorder1';
self.addEventListener('install',e=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil((async()=>{
 const keys=await caches.keys();
 await Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)));
 await self.clients.claim();
})()));
self.addEventListener('fetch',e=>{
 const r=e.request,u=new URL(r.url);
 if(r.method!=='GET')return;
 if(u.origin===location.origin && (u.pathname.endsWith('.html')||u.pathname.endsWith('.js')||u.pathname.endsWith('/'))){
   e.respondWith(fetch(r,{cache:'no-store'}).catch(()=>caches.match(r)));
   return;
 }
 e.respondWith(caches.match(r).then(c=>c||fetch(r).then(res=>{
   const cp=res.clone();caches.open(CACHE).then(x=>x.put(r,cp));return res;
 })));
});