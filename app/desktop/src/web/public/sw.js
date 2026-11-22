// The web app's service worker: a page opened again starts from this browser, not the network. Only the app's own
// files, which name no one and hold nothing of an account:
// - /assets/*: named by their content, so a cached copy is right forever: from the cache, else the network (kept).
// - a page (a navigation to any path but /web/… and /t/…): index.html from the cache when every file it names is
//   cached too, and asked for again behind it, so the next load has a new build's; the network when not.
// Everything else goes past it untouched: the session and sign-in (/web/…), the teams' sockets, calls, reports and
// files (/t/…), any other origin, anything but a GET. Signing out leaves nothing of the account here.
// A new build's index names new files; the old ones go once nothing kept names them. To retire this worker, ship a
// sw.js that unregisters itself (self.registration.unregister()): browsers check it on every load.
"use strict";

const SHELL = "fleetd-shell-v1";
const ASSETS = "fleetd-assets-v1";
const INDEX = "/index.html";
/** A page served from here asks for index.html again this long after: on a slow link, not while the page loads. */
const REFRESH_AFTER_MS = 8000;
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The /assets/ files an index.html names. */
const namedIn = (html) => [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);

/** What a request is to this worker: "asset", "page", or null (left to the network). */
const kindOf = (request, origin) => {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  if (url.origin !== origin) return null;
  if (url.pathname.startsWith("/assets/")) return "asset";
  if (url.pathname.startsWith("/web/") || url.pathname.startsWith("/t/")) return null;
  return request.mode === "navigate" ? "page" : null;
};

const asset = async (caches, fetch, request) => {
  const cache = await caches.open(ASSETS);
  const kept = await cache.match(request);
  if (kept) return kept;
  const fresh = await fetch(request);
  if (fresh.ok) await cache.put(request, fresh.clone());
  return fresh;
};

/**
 * Asks for index.html again and keeps it, with every file it names. A new build's index drops the files neither it nor
 * the one before names (a chunk loaded later, a screen or the parser, is asked for again the first time it's needed).
 */
const refresh = async (caches, fetch) => {
  const fresh = await fetch(INDEX, { cache: "no-store" });
  if (!fresh.ok) return;
  const html = await fresh.clone().text();
  const shell = await caches.open(SHELL);
  const was = await shell.match(INDEX);
  const old = was ? await was.text() : "";
  if (old === html) return;
  const assets = await caches.open(ASSETS);
  // The new build's first load, before its index is kept: the index is served only when all of it is there.
  for (const path of namedIn(html)) if (!(await assets.match(path))) await asset(caches, fetch, path);
  await shell.put(INDEX, fresh);
  if (old === "") return;
  const keep = new Set([...namedIn(html), ...namedIn(old)]);
  for (const request of await assets.keys()) if (!keep.has(new URL(request.url).pathname)) await assets.delete(request);
};

/** A page: the kept index when its files are all kept, refreshed behind it; else the network's, kept for next time. */
const page = async (caches, fetch, request, waitUntil) => {
  const shell = await caches.open(SHELL);
  const kept = await shell.match(INDEX);
  if (kept) {
    const html = await kept.clone().text();
    const assets = await caches.open(ASSETS);
    const whole = (await Promise.all(namedIn(html).map((p) => assets.match(p)))).every(Boolean);
    if (whole) {
      waitUntil(later(REFRESH_AFTER_MS).then(() => refresh(caches, fetch)).catch(() => undefined));
      return kept;
    }
  }
  const fresh = await fetch(request);
  if (fresh.ok) waitUntil(refresh(caches, fetch).catch(() => undefined));
  return fresh;
};

const handle = (event, scope) => {
  const kind = kindOf(event.request, scope.location.origin);
  if (kind === "asset") event.respondWith(asset(scope.caches, scope.fetch.bind(scope), event.request));
  else if (kind === "page") event.respondWith(page(scope.caches, scope.fetch.bind(scope), event.request, (p) => event.waitUntil(p)));
};

if (typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope) {
  // The page that registered it has just loaded: its index and files come from the HTTP cache, so the next load is
  // served from here already.
  self.addEventListener("install", (event) => {
    void self.skipWaiting();
    event.waitUntil(refresh(self.caches, self.fetch.bind(self)).catch(() => undefined));
  });
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener("fetch", (event) => handle(event, self));
} else {
  // Tests load this file to read its parts.
  globalThis.fleetdSw = { kindOf, asset, page, refresh, namedIn, SHELL, ASSETS, INDEX };
}
