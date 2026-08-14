/* Service worker: the app shell, and nothing else.
 *
 * The point is an installed app that opens instantly and doesn't show the
 * browser's offline page when the train goes into a tunnel. It is deliberately
 * not an offline mode: every /api/ request goes to the network, every time.
 * Caching a score would be the worst bug this site could have — a stale one
 * looks exactly like a real one.
 *
 * Two rules:
 *   - hashed build assets are immutable, so they're served from the cache and
 *     never revalidated;
 *   - navigations go to the network first and fall back to the cached shell,
 *     so a deploy is picked up on the next load rather than pinned forever.
 */

const CACHE = "portal-shell-v1";
const SHELL = "/index.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/** Cache-first, for things whose URL changes when their content does. */
async function fromCache(request) {
  const hit = await caches.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

/** Network-first, holding the last good shell for when the network isn't there. */
async function shellFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(SHELL, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(SHELL);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Third-party requests (fonts, ESPN images, analytics) are the browser's
  // business, not ours.
  if (url.origin !== self.location.origin) return;
  // Data is never cached. See the note at the top.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(shellFirst(request));
    return;
  }

  // Vite fingerprints everything under /assets, so a hit there can't be stale.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(fromCache(request));
  }
});
