// The app's own files kept on the phone: it opens from this copy at once, with no server at all; when the address
// answers (the install link is open), the copy is refreshed in the background for the next start. A closed link
// answers with an error page (Cloudflare 530), never trusted over the copy. The exchanges' data is never cached.
const CACHE = "hd-phone-v10";
const FILES = ["./", "index.html", "hd.js", "manifest.json", "icon-180.png", "icon-512.png",
  "https://unpkg.com/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js"];
// the files always fresh from the server, past the browser's own cache (GitHub Pages lets it keep them 10 min)
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE)
  .then((c) => c.addAll(FILES.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE)
  .map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  const mine = u.origin === location.origin || u.hostname === "unpkg.com";
  if (!mine || e.request.method !== "GET") return;                 // the exchanges: straight to the network
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const kept = await c.match(e.request, { ignoreSearch: true }) || (u.origin === location.origin && u.pathname.endsWith("/")
      ? await c.match("index.html") : undefined);
    const fresh = fetch(e.request, { cache: "no-store" }).then((r) => { if (r && r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
    if (kept) { e.waitUntil(fresh); return kept; }                   // the copy first; the refresh for next time
    const r = await fresh;
    return r && r.ok ? r : (r || Response.error());
  }));
});
