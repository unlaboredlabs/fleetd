/// <reference lib="webworker" />
// The service worker: shows each Web Push and opens the inbox when the notification is tapped. No offline cache;
// the inbox is live data from the hub.

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  // The hub sends one line with no secrets in it, e.g. "2 asks need you: prod deploy (+1 more)".
  const body = (event.data?.text() ?? "").split("\n")[0]?.trim() || "Something needs you.";
  event.waitUntil(self.registration.showNotification("fleetd", { body, tag: "fleetd", icon: "/icon-192.png" }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows[0];
      if (open !== undefined) {
        await open.focus();
        open.postMessage({ t: "inbox" });
        return;
      }
      await self.clients.openWindow("/");
    })(),
  );
});
