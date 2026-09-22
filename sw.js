// Cache only public app assets. Never intercept Supabase/API requests or store business data.
const CACHE = "le-chic-shell-v2";
const BASE = new URL("./", self.location.href).pathname;
self.addEventListener("install", (event) =>
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll([BASE, `${BASE}icon.svg`, `${BASE}manifest.webmanifest`]),
      ),
  ),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("le-chic-shell-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      ),
  ),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    !(
      event.request.mode === "navigate" ||
      url.pathname.startsWith(`${BASE}assets/`) ||
      [`${BASE}icon.svg`, `${BASE}manifest.webmanifest`].includes(url.pathname)
    )
  )
    return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() =>
        caches
          .match(event.request)
          .then(
            (cached) =>
              cached ||
              (event.request.mode === "navigate"
                ? caches.match(BASE)
                : Response.error()),
          ),
      ),
  );
});
