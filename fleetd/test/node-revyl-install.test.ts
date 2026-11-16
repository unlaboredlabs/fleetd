// fleetd installs Revyl's CLI by itself (node/revyl/install.ts): a node with no `revyl` fetches the release binary for
// its platform the first time a Test or a Revyl screen needs one, checks it against the pinned sha256, keeps it in its
// own folder, and carries on; a download that fails is a plain reason. A stand-in release channel serves a stand-in
// `revyl` (revyl_standin.ts): nothing reaches GitHub or Revyl.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeBoxKey } from "../src/node/identity.ts";
import { cliDir, RevylScreens, start as startRevyl } from "../src/node/revyl/index.ts";
import { assetFor, type Pin } from "../src/node/revyl/install.ts";
import { start as startRoute } from "../src/node/session_route/index.ts";
import type { NodeAction } from "../src/shared/node_link.ts";
import { seal } from "../src/shared/sealed_box.ts";
import { GOOD, standIn } from "./revyl_standin.ts";
import { testNode } from "./node_helpers.ts";

const box = new NodeBoxKey(crypto.getRandomValues(new Uint8Array(32)));
const sealedKey = () => Buffer.from(seal(Buffer.from(box.publicKey(), "base64"), new TextEncoder().encode(GOOD))).toString("base64");
const checkFrame = (): NodeAction => ({ t: "node_action", id: "a1", action: "revyl_check", revyl: sealedKey() }) as NodeAction;

const ASSET = "revyl-linux-amd64";
const VERSION = "v9.9.9";

let done: (() => void)[] = [];
afterEach(() => {
  for (const d of done.splice(0)) d();
});

/**
 * Revyl's release channel, standing in: `/download/<version>/<asset>` serves the stand-in `revyl`'s bytes, or fails
 * as `fail` says; a request waits for `held` first when set.
 */
function channel(opts: { fail?: number } = {}) {
  const s = standIn();
  const bytes = readFileSync(s.bin);
  const hits: string[] = [];
  let held: Promise<void> | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push(path);
      if (held) await held;
      if (opts.fail) return new Response("no", { status: opts.fail });
      return path === `/download/${VERSION}/${ASSET}` ? new Response(bytes) : new Response("not found", { status: 404 });
    },
  });
  const pin: Pin = { version: VERSION, sha256: { [ASSET]: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") } };
  done.push(() => void server.stop(true), s.done);
  return {
    s,
    hits,
    pin,
    releases: `http://127.0.0.1:${server.port}`,
    hold: () => {
      let release = () => {};
      held = new Promise<void>((r) => (release = r));
      return release;
    },
  };
}

/** A machine with no `revyl` anywhere: no FLEETD_REVYL_BIN, none on PATH, no ~/.revyl. */
function bare() {
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "revyl-home-"));
  done.push(() => rmSync(home, { recursive: true, force: true }));
  return { PATH: "/usr/bin:/bin", HOME: home };
}

function node(install: { releases: string; pin?: Pin; platform?: string; arch?: string; waitMs?: number }, env: Record<string, string> = bare()) {
  const t = testNode("devbox");
  const r = new RevylScreens(t.node, { boxKey: box, env, install: { platform: "linux", arch: "x64", ...install } });
  done.push(() => void r.shutdown(), t.done);
  return { t, r, dir: cliDir(t.node.home) };
}

test("a node without revyl installs Revyl's CLI into its own folder, checked, and Test passes", async () => {
  const c = channel();
  const { r, dir } = node({ releases: c.releases, pin: c.pin });
  expect(await r.check(checkFrame())).toEqual({ id: "a1", ok: true, message: "Revyl answered for the key" });
  expect(c.hits).toEqual([`/download/${VERSION}/${ASSET}`]);
  const bin = join(dir, VERSION, "revyl");
  expect(statSync(bin).mode & 0o777).toBe(0o755);
  expect(readdirSync(join(dir, VERSION))).toEqual(["revyl"]);
  expect(c.s.lines()).toEqual([expect.stringMatching(/^device history --json --limit 1 key=set /)]);
  // Installed once: the next Test runs it as it is.
  expect((await r.check(checkFrame())).ok).toBe(true);
  expect(c.hits).toHaveLength(1);
});

test("a Revyl screen on a node without revyl installs it, then starts", async () => {
  const c = channel();
  const t = testNode("devbox");
  done.push(t.done);
  t.link.answer = async (op) => (op === "session_route" ? { runner: "devbox", here: true, revyl: { platform: "android", sealed: sealedKey(), why: "Revyl only" } } : {});
  startRoute(t.node);
  const r = startRevyl(t.node, { boxKey: box, env: bare(), install: { releases: c.releases, pin: c.pin, platform: "linux", arch: "x64" } });
  done.push(() => void r.shutdown());
  const started = (await t.local.call("session_start", { kind: "android", purpose: "check the checkout" }, "t1")) as Record<string, unknown>;
  expect(started).toMatchObject({ op: "session_start", kind: "android", source: "revyl" });
  expect(c.hits).toHaveLength(1);
  expect(c.s.lines()[0]).toMatch(/^device start --platform android /);
});

test("two callers at once: one download, and both wait for it", async () => {
  const c = channel();
  const { r } = node({ releases: c.releases, pin: c.pin });
  const release = c.hold();
  const both = Promise.all([r.check(checkFrame()), r.check(checkFrame())]);
  while (c.hits.length === 0) await Bun.sleep(5);
  release();
  expect((await both).map((a) => a.ok)).toEqual([true, true]);
  expect(c.hits).toHaveLength(1);
  expect(c.s.lines()).toHaveLength(2);
});

test("a revyl already on the machine is used as it is: nothing downloaded", async () => {
  const c = channel();
  const env = bare();
  const { r, dir } = node({ releases: c.releases, pin: c.pin }, { ...env, PATH: `${join(c.s.bin, "..")}:${env.PATH}` });
  expect((await r.check(checkFrame())).ok).toBe(true);
  expect(c.hits).toEqual([]);
  expect(existsSync(dir)).toBe(false);
});

test("a download that fails is a plain reason: no_cli for Test, a refusal for a screen, nothing half-installed", async () => {
  const gone = channel({ fail: 404 });
  const { r, dir } = node({ releases: gone.releases, pin: gone.pin });
  expect(await r.check(checkFrame())).toEqual({ id: "a1", ok: false, reason: "no_cli", message: `127.0.0.1:${new URL(gone.releases).port} answered 404 for Revyl's CLI ${VERSION} (${ASSET})` });
  expect(readdirSync(join(dir, VERSION))).toEqual([]);

  const offline = node({ releases: "http://127.0.0.1:9", pin: gone.pin, waitMs: 5000 });
  const cut = await offline.r.check(checkFrame());
  expect(cut).toMatchObject({ ok: false, reason: "no_cli", message: expect.stringMatching(/^couldn't download Revyl's CLI from 127\.0\.0\.1:9: ./) });

  const c = channel();
  const tampered = node({ releases: c.releases, pin: { version: VERSION, sha256: { [ASSET]: "0".repeat(64) } } });
  expect(await tampered.r.check(checkFrame())).toMatchObject({ ok: false, reason: "no_cli", message: `the download of Revyl's CLI ${VERSION} didn't match the checksum Revyl published for it` });
  expect(readdirSync(join(tampered.dir, VERSION))).toEqual([]);

  const windows = node({ releases: c.releases, pin: c.pin, platform: "win32" });
  expect(await windows.r.check(checkFrame())).toMatchObject({ ok: false, reason: "no_cli", message: "Revyl's CLI has no build for win32/x64 (only macOS and Linux, on x64 or arm64)" });
  expect(c.s.lines()).toEqual([]);

  // A screen refused the same way: the agent hears why, and does without.
  const thread = "t1";
  await expect(r.start(thread, { id: "s1", cwd: "/", call: { op: "session_start", kind: "android" } } as never, { platform: "android", sealed: sealedKey(), why: "Revyl only" })).rejects.toThrow(
    `Revyl's CLI couldn't be installed on this machine (127.0.0.1:${new URL(gone.releases).port} answered 404`,
  );
});

test("Revyl's binary names: macOS and Linux on x64 or arm64", () => {
  expect(assetFor("linux", "x64")).toBe("revyl-linux-amd64");
  expect(assetFor("darwin", "arm64")).toBe("revyl-darwin-arm64");
  expect(assetFor("linux", "arm64")).toBe("revyl-linux-arm64");
  expect(assetFor("win32", "x64")).toBeUndefined();
  expect(assetFor("linux", "ia32")).toBeUndefined();
});
