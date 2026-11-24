const CACHE_NAME = "retro-web-shell-v1";
const CORE_CACHE_NAME = "retro-web-emulator-v1";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./i18n.js",
  "./local-store.js",
  "./styles.css",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith("retro-web-") &&
                key !== CACHE_NAME &&
                key !== CORE_CACHE_NAME,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/")) return;

  const immutable =
    url.pathname.includes("/vendor/emulatorjs/data/") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".jpg") ||
    url.pathname.endsWith(".webp");
  if (immutable) {
    event.respondWith(
      caches.open(CORE_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        const headers = new Headers();
        const etag = cached?.headers.get("etag");
        if (etag) headers.set("if-none-match", etag);
        const network = fetch(request, { headers });
        if (!cached) {
          const response = await network;
          if (response.ok) cache.put(request, response.clone());
          return response;
        }
        event.waitUntil(
          network.then(async (response) => {
            if (response.status === 304) return;
            if (response.ok) await cache.put(request, response);
          }),
        );
        return cached;
      }),
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, response.clone()));
        }
        return response;
      })
      .catch(() => caches.match(request)),
  );
});
