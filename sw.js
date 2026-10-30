const BUILD = "2026-10-30.a34bb033e0d6";
const CACHE = "att-teacher-" + BUILD;
const PRECACHE = [
  "/.nojekyll",
  "/README.md",
  "/icons/apple-touch-icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/index.html",
  "/manifest.webmanifest",
  "/shared/base.css",
  "/shared/core.js",
  "/teacher.css",
  "/teacher.js",
  "/vendor/fonts/ibm-plex-sans-arabic-400.woff2",
  "/vendor/fonts/ibm-plex-sans-arabic-500.woff2",
  "/vendor/fonts/ibm-plex-sans-arabic-600.woff2",
  "/vendor/fonts/ibm-plex-sans-arabic-700.woff2",
  "/vendor/xlsx.full.min.js",
  "/vendor/zxing.min.js"
];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE))); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
self.addEventListener("message", e => { if (e.data === "SKIP_WAITING") self.skipWaiting(); });
