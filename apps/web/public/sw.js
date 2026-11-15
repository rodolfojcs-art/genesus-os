/*
 * Service worker de GENESUS OS.
 *
 * Su único trabajo es hacer la app instalable y que el armazón abra rápido.
 * NO cachea nada de /api/: ahí viajan las conversaciones, la memoria y la
 * llave de acceso. Guardar eso en el disco del teléfono sería dejar copias de
 * datos personales fuera de control, y además mostraría respuestas viejas como
 * si fueran nuevas.
 */
const CACHE = 'genesus-shell-v1';

// Armazón mínimo. Los bundles con hash se cachean solos al pedirse.
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => undefined) // que un 404 suelto no impida instalar
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Datos personales y streaming: siempre a la red, nunca a disco.
  if (url.pathname.startsWith('/api/')) return;

  // Navegación: red primero (para traer la versión nueva), caché si no hay red.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copia));
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r ?? Response.error())),
    );
    return;
  }

  // Estáticos: caché primero, y se rellena al vuelo.
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok) {
            const copia = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copia));
          }
          return res;
        }),
    ),
  );
});
