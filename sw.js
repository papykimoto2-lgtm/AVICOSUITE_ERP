const CACHE='avinest-v12-2';
const CDN=['https://cdnjs.cloudflare.com','https://cdn.jsdelivr.net'];
self.addEventListener('install',e=>{self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c=>{
    try{return c.add(self.registration.scope);}catch{return Promise.resolve();}
  }));});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const u=e.request.url;
  if(CDN.some(d=>u.startsWith(d))){
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(nr=>{
      const c=nr.clone();caches.open(CACHE).then(ca=>ca.put(e.request,c));return nr;
    }).catch(()=>new Response('',{status:503}))));
    return;
  }
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).then(r=>{
      const c=r.clone();caches.open(CACHE).then(ca=>ca.put(e.request,c));return r;
    }).catch(()=>caches.match(e.request).then(r=>r||caches.match(self.registration.scope))));
    return;
  }
  e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));
});