// Service worker: only here so phones offer "Install app" / "Add to Home Screen".
// It doesn't cache anything - the game needs the live server anyway.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // let the browser load everything normally
});
