const shell = "carrot-shell-v8";
const home = new URL("./", self.registration.scope).href;
const assets = ["./app.js?v=8", "./storage.js?v=8", "./history.js?v=8", "./style.css?v=8", "./config.js",
  "./manifest.webmanifest", "./icon-180.png", "./icon-192.png", "./icon-512.png"]
  .map((path) => new URL(path, home).href);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(shell);
    // An incomplete download should leave the previous offline app available.
    await cache.addAll([home, ...assets].map((url) => new Request(url, { cache: "reload" })));
    const page = await cache.match(home);
    if (!page || !(await page.text()).includes("./app.js?v=8")) {
      throw new Error("The new app page is not available yet");
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("carrot-shell-") && key !== shell) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (request.mode === "navigate" && new URL(request.url).origin === self.location.origin &&
      [new URL(home).pathname, new URL("index.html", home).pathname].includes(new URL(request.url).pathname)) {
    // Serve one consistent shell. The browser checks for an updated worker on navigation.
    event.respondWith(caches.open(shell).then(async (cache) => (await cache.match(home)) ?? fetch(request)));
  } else if (assets.includes(request.url)) {
    event.respondWith(caches.open(shell).then(async (cache) => (await cache.match(request)) ?? fetch(request)));
  }
});
