/* Court & Barbell: the service worker of the installable build (build.py --standalone fills in VERSION and
   SHELL_FILES). It lets the app open with no network:
   - The app shell (the page, the manifest and the icons) is cached when the worker installs.
   - Opening the app asks the network first, so a new version arrives on the next launch; with no network (or no
     answer within 4 seconds) the cached page opens instead, and a late answer still refreshes the cache.
   - SortableJS (cdnjs) and Google Fonts are cached the first time they load and served from the cache after
     that. If one was never cached and the network fails, the page goes on without it: system fonts, and the
     plan's menus instead of drag and drop.
   Every build has a new VERSION (a hash of the files), so a new build installs a new worker, which takes over at
   once and deletes the caches of older builds. Caches are named cb-* so other apps on the same origin keep
   theirs. */
const VERSION = "a91fabd0ae40";
const SHELL = "cb-shell-" + VERSION;
const RUNTIME = "cb-runtime-v1";
const SHELL_FILES = ["./index.html", "./manifest.webmanifest", "./apple-touch-icon.png", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./favicon.ico", "./icon.svg"];
const INDEX = new URL("./index.html", self.location.href).href;
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
const NAV_WAIT = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    /* cache: "reload" skips the HTTP cache, so the shell is this build's files. */
    await cache.addAll(SHELL_FILES.map((u) => new Request(u, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith("cb-") && n !== SHELL && n !== RUNTIME).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (req.mode === "navigate") { event.respondWith(openPage(event)); return; }
  if (CDN.test(req.url)) { event.respondWith(fromCdn(req)); return; }
  if (new URL(req.url).origin === self.location.origin) event.respondWith(fromShell(req));
});

/* The page: network first (checked with the server, past the 10-minute HTTP cache, so a new build shows on the
   next launch), the cached copy when the network fails or is slow. */
async function openPage(event) {
  const cache = await caches.open(SHELL);
  const network = fetch(new Request(event.request.url, { cache: "no-cache", credentials: "same-origin" })).then(async (res) => {
    if (!res.ok || res.type !== "basic" || res.redirected) return null;
    await cache.put(INDEX, res.clone());
    return res;
  });
  event.waitUntil(network.then(() => {}, () => {}));
  const res = await Promise.race([network.catch(() => null), new Promise((resolve) => setTimeout(() => resolve(null), NAV_WAIT))]);
  if (res) return res;
  const cached = await cache.match(INDEX);
  /* Nothing cached yet (or not a plain page): the browser's own request, redirects and errors as usual. */
  return cached || fetch(event.request);
}

/* The shell's own files: the cache, then the network. */
async function fromShell(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  return hit || fetch(req);
}

/* SortableJS and the fonts: the cache first; a copy from the network is kept for next time. */
async function fromCdn(req) {
  const cache = await caches.open(RUNTIME);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) await cache.put(req, res.clone());
    return res;
  } catch (e) {
    return offline(req.url);
  }
}
function offline(url) {
  if (/^https:\/\/fonts\.googleapis\.com\//.test(url)) return new Response("/* fonts unavailable: system fonts */\n", { headers: { "Content-Type": "text/css" } });
  if (/\.js(\?|$)/.test(url)) return new Response("/* unavailable offline */\n", { headers: { "Content-Type": "application/javascript" } });
  return Response.error();
}

/* The page sends what it loaded before this worker was in charge (the fonts, SortableJS) to be cached too. */
self.addEventListener("message", (event) => {
  const d = event.data || {};
  if (d.type !== "cache" || !Array.isArray(d.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(RUNTIME);
    for (const u of d.urls.slice(0, 40)) {
      if (typeof u !== "string" || !CDN.test(u)) continue;
      try {
        if (await cache.match(u, { ignoreVary: true })) continue;
        let res = null;
        try { res = await fetch(u, { mode: "cors", credentials: "omit" }); } catch (e) { res = null; }
        /* A font is always asked for with CORS, so only a CORS copy of one can be used. */
        if ((!res || !res.ok) && !/^https:\/\/fonts\.gstatic\.com\//.test(u)) res = await fetch(u, { mode: "no-cors" });
        if (res && (res.ok || res.type === "opaque")) await cache.put(u, res);
      } catch (e) { /* next time */ }
    }
  })());
});
