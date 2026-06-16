// ReelAgent · Service Worker Moduso
// Strategia: cache-first SOLO per il guscio statico (HTML, font, icone).
// Tutto ciò che è dinamico (Supabase, Anthropic, Netlify Functions) passa
// SEMPRE dalla rete e non viene mai messo in cache.

const CACHE = 'titano-v2';

// Il guscio minimo dell'app. Aggiungi qui altri asset statici locali se presenti.
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Domini che NON devono MAI essere serviti dalla cache:
// dati live, autenticazione, generazione script, trend.
const NETWORK_ONLY = [
  'supabase.co',
  'supabase.in',
  'api.anthropic.com',
  '/.netlify/functions/'
];

// ---- install: precarica il guscio ----
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// ---- activate: pulisce le cache vecchie ----
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ---- fetch ----
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo richieste GET vengono considerate per la cache.
  if (req.method !== 'GET') return;

  const url = req.url;

  // 1) Chiamate dinamiche (auth, API, functions): SEMPRE rete, mai cache.
  if (NETWORK_ONLY.some((frag) => url.includes(frag))) {
    return; // lascia gestire al browser: va direttamente in rete
  }

  // 2) Navigazione (apertura pagina): network-first, fallback al guscio offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // 3) Asset statici (font, icone, css/js locali): cache-first, poi rete.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // Mette in cache solo risposte valide dello stesso tipo statico.
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
