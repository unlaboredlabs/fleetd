// Projects' kept browser profiles, the warm pool and the browser's install (crates/fleetd/src/node/browser/chrome.rs's
// tests, tests/kept.rs and mod.rs's install): a lead stays signed in between sessions and no other agent is, one
// browser at a time runs on a profile, forgetting it signs the lead out, and a machine without Chrome installs it.
import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installCommand, installTmp, Kept, keptDir, type KeptLease, Pool, readyKept } from "../src/node/browser/chrome.ts";
import { Broker, screenHooks } from "../src/node/browser/index.ts";
import { chrome, driver, rig, THREAD } from "./browser_rig.ts";
import { tempHome } from "./helpers.ts";
import { testNode } from "./node_helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

test("a project's profile is its own, one browser at a time, keeps only sign-ins, and a wipe waits for its browser", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  expect(keptDir(home.dir, "ada")).toBe(join(home.dir, "browser/kept/ada"));
  mkdirSync(join(home.dir, "browser/navis/old"), { recursive: true });
  expect(keptDir(home.dir, "old")).toBe(join(home.dir, "browser/navis/old"));
  for (const name of ["", "..", "../ada", "a/b", ".hidden"]) expect(keptDir(home.dir, name)).toBeUndefined();
  const kept = new Kept(home.dir);
  const ada = kept.take("ada");
  expect(() => kept.take("ada")).toThrow("This project's browser is open in another session");
  const bee = kept.take("bee");
  expect(ada.dir).not.toBe(bee.dir);
  // What a killed browser left: its lock, a cache, history, a saved password; and its cookies.
  const def = join(ada.dir, "Default");
  mkdirSync(join(def, "Cache/Cache_Data"), { recursive: true });
  writeFileSync(join(def, "Cache/Cache_Data/x"), "a page");
  for (const file of ["History", "Login Data", "Cookies"]) writeFileSync(join(def, file), "x");
  writeFileSync(join(def, "Preferences"), JSON.stringify({ intl: { accept_languages: "de" }, profile: { name: "x" } }));
  symlinkSync("devbox-123", join(ada.dir, "SingletonLock"));
  readyKept(ada.dir);
  expect(existsSync(join(def, "Cookies"))).toBe(true);
  for (const gone of ["Cache", "History", "Login Data"]) expect(existsSync(join(def, gone))).toBe(false);
  expect(() => lstatSync(join(ada.dir, "SingletonLock"))).toThrow();
  const prefs = JSON.parse(readFileSync(join(def, "Preferences"), "utf8"));
  expect(prefs.credentials_enable_service).toBe(false);
  expect(prefs.profile).toEqual({ name: "x", password_manager_enabled: false });
  expect(prefs.autofill.profile_enabled).toBe(false);
  expect(prefs.intl.accept_languages).toBe("de");
  // A wipe waits for the browser on it to let go.
  let wiped = false;
  const wiping = kept.wipe("ada").then(() => (wiped = true));
  await Bun.sleep(30);
  expect(wiped).toBe(false);
  ada.release();
  await wiping;
  expect(existsSync(ada.dir)).toBe(false);
  bee.release();
  expect(kept.locks()).toBe(0);
  await kept.wipe("bee");
  expect(() => kept.take("ada").release()).not.toThrow();
});

/** A stand-in browser for the pool. */
const fakeBrowser = (n: number) => ({ n, closed: false, alive: () => true, close: async () => {}, cdp: undefined as never });

test("the pool keeps one warm, launches without the sandbox where the host refuses it, and lets go of a lease that failed", async () => {
  const launched: { sandboxed: boolean; kept?: string }[] = [];
  let n = 0;
  const pool = new Pool(async (sandboxed, kept) => {
    launched.push({ sandboxed, ...(kept ? { kept } : {}) });
    if (sandboxed) throw new Error("No usable sandbox!");
    if (kept === "/nope") throw new Error("no such profile");
    return fakeBrowser(++n);
  }, 1);
  const first = await pool.take();
  expect(first.n).toBe(1);
  expect(pool.unsandboxed()).toBe(true);
  for (let i = 0; i < 50 && pool.warm() < 1; i++) await Bun.sleep(5);
  expect(pool.warm()).toBe(1);
  // The warm one goes next, with no launch, and the pool refills behind it.
  const before = launched.length;
  expect((await pool.take()).n).toBe(2);
  expect(launched.length).toBe(before + 1);
  for (let i = 0; i < 50 && pool.warm() < 1; i++) await Bun.sleep(5);
  expect(pool.warm()).toBe(1);
  // Once refused, never sandboxed again.
  expect(launched.filter((l) => l.sandboxed).length).toBe(1);
  let released = 0;
  const lease: KeptLease = { dir: "/nope", release: () => void (released += 1) };
  await expect(pool.takeKept(lease)).rejects.toThrow("no such profile");
  expect(released).toBe(1);
  await pool.drain();
  expect(pool.warm()).toBe(0);
  // node.json requiring the sandbox: never without it.
  const strict = new Pool(async (sandboxed) => (sandboxed ? Promise.reject(new Error("No usable sandbox!")) : fakeBrowser(0)), 0, true);
  await expect(strict.take()).rejects.toThrow("No usable sandbox!");
});

test("the browser's install downloads to its own temp dir on disk, and a failed install answers one start, then runs again", async () => {
  const { cmd, env } = installCommand("/home/ada/.fleetd/node/browser/ms-playwright", installTmp("/home/ada/.fleetd/node"));
  expect(cmd).toEqual(["npx", "--yes", "playwright@1.64.1", "install", "chromium-headless-shell", "ffmpeg"]);
  for (const key of ["TMPDIR", "TMP", "TEMP"]) expect(env[key]).toBe("/home/ada/.fleetd/node/browser/install-tmp");
  const t = testNode();
  const steps: string[] = [];
  let chromeFails = true;
  const broker = new Broker(t.node, undefined, {
    installer: {
      agentBrowser: async () => void steps.push("agent-browser"),
      chrome: async () => {
        steps.push("chrome");
        if (chromeFails) throw new Error("npx: offline");
      },
    },
  });
  cleanups.push(async () => {
    await broker.shutdown();
    t.done();
  });
  await expect(broker.open("t1", "look")).rejects.toThrow("This machine has no browser for sessions: npx: offline.");
  expect(steps).toEqual(["agent-browser", "chrome"]);
  // The next start installs again; an install that leaves no browser says so.
  chromeFails = false;
  await expect(broker.open("t1", "look")).rejects.toThrow("This machine has no browser for sessions: the install left no browser.");
  expect(steps).toEqual(["agent-browser", "chrome", "agent-browser", "chrome"]);
  // As the node starts: an install in the background, whose failure the next start is owed.
  chromeFails = true;
  broker.prepare();
  await Bun.sleep(20);
  await expect(broker.open("t1", "look")).rejects.toThrow("npx: offline");
});

/** A site that signs a browser in: /login sets a lasting cookie, / says whether it has one. */
function site() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const signedIn = (req.headers.get("cookie") ?? "").includes("session=ada");
      const title = new URL(req.url).pathname === "/login" ? "Signed in" : signedIn ? "Welcome back" : "Signed out";
      const headers: Record<string, string> = { "content-type": "text/html" };
      if (new URL(req.url).pathname === "/login") headers["set-cookie"] = "session=ada; Max-Age=86400; Path=/";
      return new Response(`<html><head><title>${title}</title></head><body></body></html>`, { headers });
    },
  });
  cleanups.push(() => void server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

/** Opens a session for `thread`, visits `url`, and says the page's title. */
async function visit(r: Awaited<ReturnType<typeof rig>>, thread: string, url: string, title?: string): Promise<string> {
  const started = await r.call("session_start", { purpose: "a visit" }, thread);
  if (started.error) throw new Error(started.error.message);
  const d = await driver(String(started.result!.cdp));
  const page = await d.page();
  await d.ok("Page.navigate", { url }, page);
  let seen = "";
  for (const end = Date.now() + 10_000; Date.now() < end; await Bun.sleep(30)) {
    seen = String((await d.evaluate(page, "document.title").catch(() => "")) ?? "");
    if (title ? seen === title : seen !== "" && seen !== url.replace(/^https?:\/\//, "")) break;
  }
  d.close();
  return seen;
}

test.skipIf(!chrome)("a lead stays signed in between sessions, no other agent is, and forgetting its sign-ins signs it out", async () => {
  const r = await rig();
  cleanups.push(r.done);
  const url = site();
  const hooks = screenHooks(r.node, (thread) => !!r.broker.live(thread));
  hooks.launched(THREAD, "assistant", "proj-1");
  expect(r.broker.staysHere(THREAD)).toBe(true);
  expect(await visit(r, THREAD, `${url}/login`, "Signed in")).toBe("Signed in");
  await r.call("session_end");
  expect(existsSync(join(r.home, "browser/kept/proj-1/Default"))).toBe(true);
  expect(await visit(r, THREAD, url, "Welcome back")).toBe("Welcome back");
  // One browser at a time on it: the lead's second session is refused, a person's screen opens signed out.
  const second = await r.call("session_start", { purpose: "again" }, "t-lead-2");
  expect(second.error).toBeUndefined();
  await r.call("session_end", {}, "t-lead-2");
  hooks.launched("t-lead-2", "assistant", "proj-1");
  expect((await r.call("session_start", { purpose: "again" }, "t-lead-2")).error?.message).toBe(
    "This project's browser is open in another session: it keeps the project's sign-ins, and one browser at a time runs on them.",
  );
  r.broker.personScreen("person-key", "proj-1");
  expect(await visit(r, "person-key", url, "Signed out")).toBe("Signed out");
  await r.call("session_end", {}, "person-key");
  // Another agent's browser is fresh.
  expect(await visit(r, "t-worker", url, "Signed out")).toBe("Signed out");
  await r.call("session_end", {}, "t-worker");
  // A lead with repos keeps its sign-ins where the hub places it here, but isn't held here.
  hooks.launched("t-lead-repos", "lead", "proj-2");
  expect(r.broker.staysHere("t-lead-repos")).toBe(false);
  expect(r.broker.isNavi("t-lead-repos")).toBe(true);

  // Forgetting: the lead's browser ends, then the profile goes.
  await hooks.forgetSignins("proj-1");
  expect(r.broker.live(THREAD)).toBeUndefined();
  expect(existsSync(join(r.home, "browser/kept/proj-1"))).toBe(false);
  expect(await visit(r, THREAD, url, "Signed out")).toBe("Signed out");
  // The lead's claude exited: its browser ends, and it is no project's lead any more.
  r.node.area("launch").ended(THREAD);
  for (let i = 0; i < 100 && r.broker.live(THREAD); i++) await Bun.sleep(20);
  expect(r.broker.live(THREAD)).toBeUndefined();
  expect(r.broker.isNavi(THREAD)).toBe(false);
});
