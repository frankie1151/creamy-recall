"use strict";

/*
  Service Worker 只負責：
  1. 快取網站程式
  2. 離線時讀取快取
  3. GitHub 更新後換成新版程式

  卡片資料不會儲存在這裡。
*/

const CACHE_NAME =
  "creamy-recall-cache-v54-speech-v2";

const APP_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

/* 安裝新版 Service Worker */
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(APP_FILES);
    })
  );

  self.skipWaiting();
});

/* 啟用新版並刪除舊程式快取 */
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

/* 處理網頁和程式檔案請求 */
self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  /*
    Supabase 等外部請求不經 Service Worker。
    避免雲端同步資料被錯誤快取。
  */
  if (url.origin !== self.location.origin) return;

  /*
    優先取得 GitHub 最新檔案。
    網絡失敗時才使用本機快取。
  */
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.ok) {
          const copy = response.clone();

          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, copy);
          });
        }

        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);

        if (cached) return cached;

        /*
          如果離線時開啟網站路徑，
          回傳已快取的首頁。
        */
        if (request.mode === "navigate") {
          return (
            await caches.match("./index.html") ||
            await caches.match("./")
          );
        }

        return new Response("Offline", {
          status: 503,
          statusText: "Offline"
        });
      })
  );
});
