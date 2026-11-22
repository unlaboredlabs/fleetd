// The web app's service worker: a page opened again starts from this browser when the network is slow or gone. Only the
// app's own files, which name no one and hold nothing of an account:
// - /assets/*: named by their content, so a cached copy is right forever: from the cache, else the network (kept).
// - the app's page (a navigation to / or /index.html, the app routing by its hash): index.html from the network when it
//   answers within NETWORK_FIRST_MS, so a deploy's new build is what opens; else (a slow link, offline) the kept one,
//   when every file it names is kept too. Either way the network's answer is kept, with its files, for the next load.
// Everything else goes past it untouched: any other path (the sign-in's way back, /signin/callback, and every route of
// the cloud's), the session and sign-in (/web/…), the teams' sockets, calls, reports and files (/t/…), any other origin,
// anything but a GET, and a page asked for with `fresh` (main.tsx, after a chunk of an older build failed to load).
// Signing out leaves nothing of the account here.
// A new build's index names new files; the old ones go once nothing kept names them. To retire this worker, ship a
// sw.js that unregisters itself (self.registration.unregister()): browsers check it on every load.
"use strict";

const SHELL = "fleetd-shell-v1";
const ASSETS = "fleetd-assets-v1";
const INDEX = "/index.html";
/**
 * How long a page waits for the network's index.html before it opens the kept one: a fast link gets the current build
 * (5 KB, a round trip or two); a slow or dead one opens from here, and the network's answer is kept for next time.
 */
const NETWORK_FIRST_MS = 1500;
/** The paths that are the app's page; any other navigation is the cloud's (its sign-in's way back among them). */
const PAGES = new Set(["/", INDEX]);
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The /assets/ files an index.html names. */
const namedIn = (html) => [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);

/** What a request is to this worker: "asset", "page", or null (left to the network). */
const kindOf = (request, origin) => {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  if (url.origin !== origin) return null;
  if (url.pathname.startsWith("/assets/")) return "asset";
  if (request.mode !== "navigate" || !PAGES.has(url.pathname) || url.searchParams.has("fresh")) return null;
  return "page";
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
const refresh = async (caches, fetch, answer) => {
  const fresh = answer ?? (await fetch(INDEX, { cache: "no-store" }));
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

/** The kept index when every file it names is kept too, else null. */
const keptWhole = async (caches) => {
  const kept = await (await caches.open(SHELL)).match(INDEX);
  if (!kept) return null;
  const assets = await caches.open(ASSETS);
  return (await Promise.all(namedIn(await kept.clone().text()).map((p) => assets.match(p)))).every(Boolean) ? kept : null;
};

/**
 * The app's page: the network's index when it answers within `waitMs`, else the kept one (a slow link, offline); the
 * network's answer, whenever it comes, kept with its files for the next load.
 */
const page = async (caches, fetch, request, waitUntil, waitMs = NETWORK_FIRST_MS) => {
  // Two copies of one answer: one for the page, one to keep.
  const network = fetch(INDEX, { cache: "no-store" }).then(
    (r) => (r.ok ? { page: r, keep: r.clone() } : null),
    () => null,
  );
  waitUntil(network.then((copies) => (copies === null ? undefined : refresh(caches, fetch, copies.keep))).catch(() => undefined));
  const kept = await keptWhole(caches);
  if (kept === null) return (await network)?.page ?? fetch(request);
  const answered = await Promise.race([network, later(waitMs).then(() => null)]);
  return answered?.page ?? kept;
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
