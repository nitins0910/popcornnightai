/* =========================================================
   POPCORNNIGHT — Service Worker
   Caches the app shell for offline/installable use, and
   opportunistically caches poster/backdrop images so recently
   viewed movies still show art when offline.
   ========================================================= */

const SHELL_CACHE = "popcornnight-shell-v1";
const IMAGE_CACHE = "popcornnight-images-v1";

const SHELL_FILES = ["./", "./index.html", "./style.css", "./script.js"];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
    );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== SHELL_CACHE && key !== IMAGE_CACHE)
                    .map((key) => caches.delete(key))
            )
        ).then(() =>
            // Tell every open tab a new version has taken over, so the page
            // can auto-reload and actually pick up the new code/assets
            // instead of silently running stale JS until the user manually
            // refreshes.
            self.clients.matchAll({ type: "window" }).then((clients) => {
                clients.forEach((client) => client.postMessage({ type: "SW_UPDATED" }));
            })
        )
    );
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // TMDB poster/backdrop images: cache-first, so previously seen art keeps
    // working offline (e.g. from the Recently Viewed rail or Wishlist).
    if (url.hostname.includes("image.tmdb.org")) {
        event.respondWith(
            caches.open(IMAGE_CACHE).then((cache) =>
                cache.match(event.request).then(
                    (cached) =>
                        cached ||
                        fetch(event.request)
                            .then((res) => {
                                cache.put(event.request, res.clone());
                                return res;
                            })
                            .catch(() => cached)
                )
            )
        );
        return;
    }

    // App shell files: network-first with cache fallback, so users always
    // get the latest deploy when online, but the app still opens offline.
    if (event.request.method === "GET" && url.origin === self.location.origin) {
        event.respondWith(
            fetch(event.request)
                .then((res) => {
                    const resClone = res.clone();
                    caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, resClone));
                    return res;
                })
                .catch(() => caches.match(event.request))
        );
    }
});