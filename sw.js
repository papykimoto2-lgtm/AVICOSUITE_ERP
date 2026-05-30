// ============================================================
//  SANIX AviNest Pro — Service Worker PWA
//  Cache offline · Stratégie : Cache-first pour assets
//  Network-first pour API Supabase
// ============================================================

const APP_NAME    = 'sanix-avinest-pro';
const VERSION     = 'v1.0.0';
const CACHE_NAME  = `${APP_NAME}-${VERSION}`;
const API_CACHE   = `${APP_NAME}-api-${VERSION}`;

// Fichiers à mettre en cache au premier chargement
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js',
];

// Domaines Supabase → toujours réseau (données live)
const SUPABASE_HOSTS = [
  'supabase.co',
  'supabase.com',
];

// ── Installation : précache des assets statiques ───────────
self.addEventListener('install', event => {
  console.log(`[SW ${VERSION}] Installation...`);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log(`[SW] Mise en cache des assets statiques`);
        return cache.addAll(PRECACHE_ASSETS.map(url => {
          return new Request(url, { mode: 'no-cors' });
        })).catch(err => {
          console.warn('[SW] Précache partiel (normal) :', err.message);
        });
      })
      .then(() => self.skipWaiting())
  );
});

// ── Activation : nettoyer les anciens caches ────────────────
self.addEventListener('activate', event => {
  console.log(`[SW ${VERSION}] Activation...`);
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key.startsWith(APP_NAME) && key !== CACHE_NAME && key !== API_CACHE)
          .map(key => {
            console.log(`[SW] Suppression ancien cache : ${key}`);
            return caches.delete(key);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ── Fetch : stratégie selon le type de requête ─────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Requêtes Supabase (API) → Network first, fallback cache
  if (SUPABASE_HOSTS.some(h => url.hostname.includes(h))) {
    event.respondWith(networkFirstWithCache(event.request, API_CACHE));
    return;
  }

  // 2. CDN (Font Awesome, Chart.js) → Cache first, network fallback
  if (url.hostname.includes('cdnjs.cloudflare.com')) {
    event.respondWith(cacheFirstWithNetwork(event.request));
    return;
  }

  // 3. Navigation (pages HTML) → Network first, offline fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(navigationHandler(event.request));
    return;
  }

  // 4. Autres (images, fonts, etc.) → Stale-while-revalidate
  event.respondWith(staleWhileRevalidate(event.request));
});

// ── Stratégies de cache ─────────────────────────────────────

async function networkFirstWithCache(request, cacheName) {
  try {
    const networkResponse = await fetch(request.clone());
    if (networkResponse.ok || networkResponse.status === 0) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cached = await caches.match(request);
    if (cached) {
      console.log('[SW] Hors ligne — données Supabase depuis cache');
      return cached;
    }
    return new Response(
      JSON.stringify({ error: 'Hors ligne — données non disponibles en cache', offline: true }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function cacheFirstWithNetwork(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request.clone());
    if (response.ok || response.status === 0) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Ressource non disponible hors ligne', { status: 503 });
  }
}

async function navigationHandler(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Hors ligne : servir la page depuis le cache
    const cached = await caches.match(request) || await caches.match('/') || await caches.match('/index.html');
    if (cached) {
      console.log('[SW] Navigation hors ligne — page depuis cache');
      return cached;
    }
    return offlinePage();
  }
}

async function staleWhileRevalidate(request) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkPromise = fetch(request.clone()).then(response => {
    if (response.ok || response.status === 0) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || await networkPromise || new Response('Non disponible', { status: 503 });
}

function offlinePage() {
  const html = `<!DOCTYPE html><html lang="fr"><head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>SANIX AviNest Pro — Hors ligne</title>
    <style>
      body{margin:0;background:#1a4731;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;color:#fff;text-align:center;padding:20px}
      .card{background:rgba(255,255,255,.1);border-radius:16px;padding:32px;max-width:360px}
      h1{font-size:48px;margin:0 0 8px}
      h2{font-size:20px;font-weight:600;margin:0 0 12px}
      p{font-size:14px;opacity:.8;line-height:1.6;margin:0 0 20px}
      button{background:#52b788;color:#fff;border:none;border-radius:8px;padding:12px 24px;font-size:14px;cursor:pointer;font-weight:600}
      .dot{display:inline-block;width:8px;height:8px;background:#f4a261;border-radius:50%;margin-right:6px}
    </style>
  </head><body>
    <div class="card">
      <div style="font-size:60px;margin-bottom:16px">🐔</div>
      <h2>SANIX AviNest Pro</h2>
      <p><span class="dot"></span>Connexion internet non disponible.<br>Vos données locales restent accessibles.</p>
      <p style="font-size:12px;opacity:.6">Les données saisies hors ligne seront synchronisées dès le retour du réseau.</p>
      <button onclick="location.reload()">Réessayer la connexion</button>
    </div>
  </body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// ── Messages depuis l'app (ex: force refresh) ──────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'CLEAR_CACHE') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
    console.log('[SW] Tous les caches effacés');
  }
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: VERSION, cache: CACHE_NAME });
  }
});

// ── Notification push (future intégration) ─────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json().catch(() => ({ title: 'AviNest', body: event.data.text() }));
  event.waitUntil(
    data.then(payload =>
      self.registration.showNotification(payload.title || 'SANIX AviNest Pro', {
        body:    payload.body || '',
        icon:    '/icons/icon-192.png',
        badge:   '/icons/icon-96.png',
        tag:     payload.tag || 'avinest-notif',
        data:    payload.data || {},
        actions: payload.actions || [],
        vibrate: [200, 100, 200],
      })
    )
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
