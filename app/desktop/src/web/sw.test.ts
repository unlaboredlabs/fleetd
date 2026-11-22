// The web app's service worker (public/sw.js), run in a sandbox with a fake Cache API and network: what it serves, what
// it leaves alone, and what it keeps.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

interface Sw {
  kindOf: (r: Request, origin: string) => string | null;
  page: (c: FakeCaches, f: typeof fetch, r: Request, w: (p: Promise<unknown>) => void) => Promise<Response>;
  asset: (c: FakeCaches, f: typeof fetch, r: Request) => Promise<Response>;
  refresh: (c: FakeCaches, f: typeof fetch) => Promise<void>;
}
const ORIGIN = "https://app.fleetd.dev";
const load = (): Sw => {
  const box: { fleetdSw?: Sw } = {};
  const context = vm.createContext({ globalThis: box, URL, Request, Response, Set, Promise, setTimeout });
  (context as { globalThis: unknown }).globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(import.meta.dirname, "public/sw.js"), "utf8"), context);
  return (context as unknown as { fleetdSw: Sw }).fleetdSw;
};
const sw = load();

class FakeCache {
  readonly kept = new Map<string, Response>();
  key(r: Request | string) {
    return new URL(typeof r === "string" ? r : r.url, ORIGIN).pathname;
  }
  match(r: Request | string) {
    return Promise.resolve(this.kept.get(this.key(r))?.clone());
  }
  put(r: Request | string, res: Response) {
    this.kept.set(this.key(r), res);
    return Promise.resolve();
  }
  delete(r: Request) {
    return Promise.resolve(this.kept.delete(this.key(r)));
  }
  keys() {
    return Promise.resolve([...this.kept.keys()].map((k) => new Request(`${ORIGIN}${k}`)));
  }
}
class FakeCaches {
  readonly all = new Map<string, FakeCache>();
  open(name: string) {
    const cache = this.all.get(name) ?? new FakeCache();
    this.all.set(name, cache);
    return Promise.resolve(cache);
  }
}
const index = (...files: string[]) => `<html><head>${files.map((f) => `<link rel="modulepreload" href="/assets/${f}">`).join("")}</head></html>`;
/** A network serving `files` (path → body); counts what it was asked for. */
const network = (files: Record<string, string>) => {
  const asked: string[] = [];
  const f = ((input: Request | string) => {
    const p = new URL(typeof input === "string" ? input : input.url, ORIGIN).pathname;
    asked.push(p);
    const body = files[p === "/" ? "/index.html" : p];
    return Promise.resolve(body === undefined ? new Response("", { status: 404 }) : new Response(body));
  }) as typeof fetch;
  return { f, asked };
};
// A navigation (Node can't build a Request in "navigate" mode): what the worker reads of one.
const nav = (p: string) => ({ method: "GET", url: `${ORIGIN}${p}`, mode: "navigate" }) as unknown as Request;

describe("the web app's service worker", () => {
  it("keeps only the app's own files: never the session, a team's socket or calls, another origin or a write", () => {
    expect(sw.kindOf(new Request(`${ORIGIN}/assets/main-abc.js`), ORIGIN)).toBe("asset");
    expect(sw.kindOf(nav("/"), ORIGIN)).toBe("page");
    expect(sw.kindOf(nav("/some/route"), ORIGIN)).toBe("page");
    expect(sw.kindOf(nav("/web/sign-in"), ORIGIN)).toBeNull();
    expect(sw.kindOf(new Request(`${ORIGIN}/web/session`), ORIGIN)).toBeNull();
    expect(sw.kindOf(nav("/t/team/web/frames"), ORIGIN)).toBeNull();
    expect(sw.kindOf(new Request(`${ORIGIN}/t/team/app`), ORIGIN)).toBeNull();
    expect(sw.kindOf(new Request("https://other.invalid/assets/x.js"), ORIGIN)).toBeNull();
    expect(sw.kindOf(new Request(`${ORIGIN}/assets/x.js`, { method: "POST", body: "x" }), ORIGIN)).toBeNull();
  });

  it("serves a page from the network the first time, keeping the index and its files for the next", async () => {
    const caches = new FakeCaches();
    const net = network({ "/index.html": index("main-1.js"), "/assets/main-1.js": "one" });
    const waits: Array<Promise<unknown>> = [];
    const first = await sw.page(caches, net.f, nav("/"), (p) => waits.push(p));
    expect(await first.text()).toBe(index("main-1.js"));
    await Promise.all(waits);
    // Next time: no network before the page; the refresh behind it waits (not while the page loads on a slow link).
    net.asked.length = 0;
    const second = await sw.page(caches, net.f, nav("/"), () => undefined);
    expect(await second.text()).toBe(index("main-1.js"));
    expect(net.asked).toEqual([]);
    expect(await (await sw.asset(caches, net.f, new Request(`${ORIGIN}/assets/main-1.js`))).text()).toBe("one");
  });

  it("serves the network's page when the kept index names a file not kept", async () => {
    const caches = new FakeCaches();
    await (await caches.open("fleetd-shell-v1")).put("/index.html", new Response(index("gone-1.js")));
    const net = network({ "/index.html": index("main-2.js"), "/assets/main-2.js": "two" });
    const res = await sw.page(caches, net.f, nav("/"), () => undefined);
    expect(await res.text()).toBe(index("main-2.js"));
  });

  it("keeps a new build's index once all its files are in, and drops the files no kept index names", async () => {
    const caches = new FakeCaches();
    const assets = await caches.open("fleetd-assets-v1");
    await (await caches.open("fleetd-shell-v1")).put("/index.html", new Response(index("main-1.js")));
    await assets.put("/assets/main-1.js", new Response("one"));
    await assets.put("/assets/older-0.js", new Response("zero"));
    await sw.refresh(caches, network({ "/index.html": index("main-2.js"), "/assets/main-2.js": "two" }).f);
    expect(await (await (await caches.open("fleetd-shell-v1")).match("/index.html"))?.text()).toBe(index("main-2.js"));
    expect([...assets.kept.keys()].sort()).toEqual(["/assets/main-1.js", "/assets/main-2.js"]);
  });

  it("never keeps a failed answer", async () => {
    const caches = new FakeCaches();
    const res = await sw.asset(caches, network({}).f, new Request(`${ORIGIN}/assets/missing.js`));
    expect(res.status).toBe(404);
    expect((await caches.open("fleetd-assets-v1")).kept.size).toBe(0);
  });
});
