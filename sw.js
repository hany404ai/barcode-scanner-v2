/* ==========================================================================
   sw.js — Service Worker لتطبيق المعلم (حضور الطلاب)
   --------------------------------------------------------------------------
   لماذا في جذر المشروع وليس في teacher/؟
   نطاق الـ Service Worker يُحدَّد بمكان ملفه، ولا يعترض أي طلب خارج نطاقه.
   تطبيق المعلم يستخدم ../shared/core.js و ../shared/base.css و ../vendor/*،
   وهي خارج نطاق teacher/؛ لذا يجب أن يكون الملف في الجذر ليعمل أوفلاين فعليًا.
   لا يخزّن هذا العامل أي ملف من center/، ويمرّر طلبات المركز إلى الشبكة كما هي.

   السلوك:
   install  : تخزين مسبق لكل ملفات المعلم في كاش باسم att-teacher-<BUILD>.
              فشل أي ملف يُفشل التثبيت (لا كاش ناقص).
   activate : حذف الكاشات القديمة ثم السيطرة على الصفحات المفتوحة.
   fetch    : GET من نفس الأصل وداخل مسارات المعلم فقط.
              التنقل ← index.html المخزّن. الملفات ← الكاش أولًا ثم الشبكة مع
              تحديث الكاش في الخلفية. أي أصل آخر لا يُعترض ولا يُخزَّن.
   message  : SKIP_WAITING عند ضغط «تحديث الآن» في الواجهة.
   ========================================================================== */
"use strict";

var BUILD = "2026-10-30.1";
var CACHE_PREFIX = "att-teacher-";
var CACHE = CACHE_PREFIX + BUILD;

/* كل المسارات نسبية إلى مكان هذا الملف (جذر الموقع) لتعمل أيضًا تحت مسار فرعي. */
var PRECACHE = [
  "teacher/index.html",
  "teacher/teacher.js",
  "teacher/teacher.css",
  "teacher/manifest.webmanifest",
  "teacher/icons/icon-192.png",
  "teacher/icons/icon-512.png",
  "teacher/icons/maskable-512.png",
  "teacher/icons/apple-touch-icon-180.png",
  "shared/base.css",
  "shared/core.js",
  "vendor/zxing.min.js",
  "vendor/xlsx.full.min.js",
  "vendor/fonts/ibm-plex-sans-arabic-400.woff2",
  "vendor/fonts/ibm-plex-sans-arabic-500.woff2",
  "vendor/fonts/ibm-plex-sans-arabic-600.woff2",
  "vendor/fonts/ibm-plex-sans-arabic-700.woff2"
];

function abs(p) {
  return new URL(p, self.location.href).href;
}

var INDEX = abs("teacher/index.html");
var INDEX_PATH = new URL(INDEX).pathname;
var OWNED_PATHS = ["teacher/", "shared/", "vendor/"].map(function (d) {
  return new URL(d, self.location.href).pathname;
});

/** هل يخص هذا الطلب تطبيق المعلم؟ (المسارات وليس الأصل فقط) */
function isOwned(url) {
  if (url.origin !== self.location.origin) return false;
  for (var i = 0; i < OWNED_PATHS.length; i++) {
    if (url.pathname.indexOf(OWNED_PATHS[i]) === 0) return true;
  }
  return false;
}

/** مفتاح الكاش بلا استعلام (?v=) حتى لا تتكرر النسخ نفسها. */
function keyFor(req) {
  var u = new URL(req.url);
  u.search = "";
  u.hash = "";
  return u.href;
}

/** يجلب من الشبكة ويحدّث الكاش بصمت (لا يفشل الطلب إن فشل التحديث). */
function fetchAndCache(req) {
  return fetch(req).then(function (res) {
    if (res && res.ok && res.status === 200) {
      var copy = res.clone();
      caches.open(CACHE).then(function (cache) {
        return cache.put(keyFor(req), copy);
      }).catch(function () { });
    }
    return res;
  });
}

/** الكاش أولًا، ثم الشبكة مع تحديث الكاش. */
function cacheFirst(req) {
  return caches.match(req, { ignoreSearch: true }).then(function (hit) {
    if (hit) {
      fetchAndCache(req).catch(function () { });
      return hit;
    }
    return fetchAndCache(req);
  });
}

/** التنقل دائمًا إلى صفحة التطبيق المخزّنة، حتى لو تغيّر مسار البدء أو الاستعلام. */
function navigate(req) {
  return caches.match(INDEX).then(function (hit) {
    if (hit) return hit;
    return fetch(req).catch(function () {
      return caches.match(INDEX);
    });
  });
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // cache:"reload" يتجاوز كاش HTTP حتى لا تُخزَّن نسخة قديمة.
      var reqs = PRECACHE.map(function (p) {
        return new Request(abs(p), { cache: "reload" });
      });
      return cache.addAll(reqs);
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name.indexOf(CACHE_PREFIX) === 0 && name !== CACHE) return caches.delete(name);
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (!req || req.method !== "GET") return;
  var url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (!isOwned(url)) return; // المركز وأي أصل خارجي: شبكة كما هي، بلا تخزين.

  if (req.mode === "navigate") {
    event.respondWith(navigate(req));
    return;
  }
  event.respondWith(cacheFirst(req));
});

self.addEventListener("message", function (event) {
  var data = event.data || {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (data.type === "GET_VERSION" && event.source) {
    event.source.postMessage({ type: "ATT_SW_VERSION", build: BUILD });
  }
});

/* للتشخيص والاختبارات الآلية فقط (لا تُستخدم في منطق التطبيق). */
self.ATT_SW_INFO = {
  build: BUILD,
  cache: CACHE,
  precache: PRECACHE.slice(),
  index: INDEX,
  indexPath: INDEX_PATH
};
