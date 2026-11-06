/* ============================================================
   八班游乐场 · 照片缓存 Service Worker
   ------------------------------------------------------------
   只缓存 Supabase Storage 里 b8-photos 桶的公开图片：
   · 图片路径带时间戳 / 随机串，内容不会变，可以 cache-first；
   · 浏览器第二次看同一张图不再走 Supabase CDN，直接本地命中；
   · 不碰 API / RPC / HTML，不会把登录态或成绩缓存住。
   ============================================================ */
'use strict';

var CACHE = 'b8-photos-v1';
var MAX_ITEMS = 150;
var PHOTO_PATH = '/storage/v1/object/public/b8-photos/';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function trim(cache) {
  return cache.keys().then(function (keys) {
    if (keys.length <= MAX_ITEMS) return;
    return Promise.all(keys.slice(0, keys.length - MAX_ITEMS).map(function (req) {
      return cache.delete(req);
    }));
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.hostname.indexOf('.supabase.co') < 0) return;
  if (url.pathname.indexOf(PHOTO_PATH) < 0) return;

  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          // <img> 的 no-cors 请求拿到的是 opaque response（status 0，ok=false）
          if (res && (res.ok || res.type === 'opaque')) {
            cache.put(req, res.clone()).then(function () { trim(cache); }).catch(function () {});
          }
          return res;
        });
      });
    })
  );
});
