// Ports the core of crates/fleetd/src/update/tests.rs: the checked download from a local fake release (never the real
// release server), the swap, and the watcher with fake ports.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finish, type Plan, type Ports, readVerdict, run } from "../src/update/finish.ts";
import {
  assetOf,
  channelOf,
  cliAsset,
  Failure,
  FLAVOUR,
  helperPath,
  HttpFeed,
  keptHelper,
  parseChannel,
  parseFlavour,
  parseSums,
  releaseApi,
  restore,
  sha256Hex,
  swap,
  updateHelper,
  verifiedTo,
} from "../src/update/index.ts";
import { servicesIn } from "../src/update/service.ts";
import { versionLabel, versionShown } from "../src/update/version.ts";
import { tempHome } from "./helpers.ts";

const build = new TextEncoder().encode("#!/bin/sh\necho new build\n".repeat(2000));
let cutOnce = true;
let downloads = 0;

/** A release server written by hand over TCP, so a body can be cut off for real (Bun.serve would fix its length). */
function answer(path: string, range: string | undefined): { head: string; body: Uint8Array; cut?: number } {
  const text = (status: string, body: string, type = "text/plain") => ({ head: `HTTP/1.1 ${status}\r\ncontent-type: ${type}\r\n`, body: new TextEncoder().encode(body) });
  if (path === "/rel/SHA256SUMS") return text("200 OK", `${sha256Hex(build)}  fleetd-linux-x64\n${"0".repeat(64)} *fleetd-bad\n`);
  if (path === "/rel/fleetd-bad") return text("200 OK", "not it");
  if (path === "/down/release.json") return text("503 Service Unavailable", "boom");
  if (path === "/rel/fleetd-linux-x64") {
    downloads++;
    const from = range ? Number(/bytes=(\d+)-/.exec(range)?.[1]) : 0;
    const rest = build.slice(from);
    if (cutOnce && from === 0) {
      // Part of the build, then the connection ends: the download asks again from the byte it stopped at.
      cutOnce = false;
      return { head: "HTTP/1.1 200 OK\r\n", body: rest, cut: 20000 };
    }
    if (from > 0) return { head: `HTTP/1.1 206 Partial Content\r\ncontent-range: bytes ${from}-${build.length - 1}/${build.length}\r\n`, body: rest };
    return { head: "HTTP/1.1 200 OK\r\n", body: rest };
  }
  return text("404 Not Found", "no");
}

const release = Bun.listen<{ buf: string }>({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open(s) {
      s.data = { buf: "" };
    },
    data(s, chunk) {
      s.data.buf += new TextDecoder().decode(chunk);
      const end = s.data.buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const [line, ...headers] = s.data.buf.slice(0, end).split("\r\n");
      const path = line!.split(" ")[1]!;
      const range = headers.find((h) => h.toLowerCase().startsWith("range:"))?.slice(6).trim();
      const a = answer(path, range);
      s.write(`${a.head}content-length: ${a.body.length}\r\nconnection: close\r\n\r\n`);
      s.write(a.cut !== undefined ? a.body.slice(0, a.cut) : a.body);
      s.end();
    },
  },
});
const base = `http://127.0.0.1:${release.port}`;
const home = tempHome();
afterAll(() => {
  release.stop(true);
  home.done();
});

test("a build lands only when it matches its SHA256SUMS line, resuming a cut-off download", async () => {
  const feed = new HttpFeed(`${base}/rel`);
  const path = join(home.dir, "fleetd.next");
  await verifiedTo(feed, "fleetd-linux-x64", path);
  expect(Buffer.compare(readFileSync(path), Buffer.from(build))).toBe(0);
  expect(downloads).toBe(2);
  const bad = join(home.dir, "bad");
  const failed = await verifiedTo(feed, "fleetd-bad", bad).catch((e) => e as Failure);
  expect(failed).toBeInstanceOf(Failure);
  expect((failed as Failure).stage).toBe("checksum");
  expect((failed as Failure).message).toStartWith("`fleetd-bad`: checksum mismatch (expected `0000");
  expect(existsSync(bad) || existsSync(join(home.dir, ".bad.new"))).toBe(false);
  const missing = await verifiedTo(feed, "fleetd-darwin-arm64", bad).catch((e) => e as Failure);
  expect((missing as Failure).message).toBe("`fleetd-darwin-arm64` is not in the release");
  const down = await new HttpFeed(`${base}/down`).get("release.json").catch((e) => (e as Error).message);
  expect(down).toBe(`GET \`${base}/down/release.json\`: 503 Service Unavailable`);
});

test("channels, sums, release APIs and version labels read as the Rust ones", () => {
  expect([parseChannel("nightly"), parseChannel("latest"), channelOf("0.0.0-edge.202610261056+1b563d7", true), channelOf("1.2.0", true), channelOf("1.2.0", false)]).toEqual([
    "edge",
    "stable",
    "edge",
    "stable",
    "edge",
  ]);
  expect(parseSums("ABC  a\ndef *b\n")).toEqual(new Map([["a", "abc"], ["b", "def"]]));
  expect(releaseApi("https://github.com/unlaboredlabs/fleetd/releases/download/edge")).toBe("https://api.github.com/repos/unlaboredlabs/fleetd/releases/tags/edge");
  expect(releaseApi("https://github.com/unlaboredlabs/fleetd/releases/latest/download")).toBe("https://api.github.com/repos/unlaboredlabs/fleetd/releases/latest");
  expect(releaseApi("http://127.0.0.1:1/rel")).toBeUndefined();
  expect(versionLabel("0.0.0-edge.202610261056+1b563d7")).toBe("Edge · Oct 26, 10:56 UTC · 1b563d7");
  expect(versionShown("1.2.0")).toBe("1.2.0");
  expect(versionShown("0.0.0-nightly.202601051300")).toBe("Edge · Jan 5, 13:00 UTC (0.0.0-nightly.202601051300)");
});

test("each flavour has its own asset, and the Rust session host beside a Bun build moves with it", async () => {
  expect(FLAVOUR).toBe("bun");
  expect(cliAsset()).toBe(assetOf("bun"));
  expect(assetOf("bun")).toBe(assetOf("rust").replace("fleetd-", "fleetd-bun-"));
  expect(parseFlavour("rust")).toBe("rust");
  expect(() => parseFlavour("ts")).toThrow('unknown flavour "ts": use rust or bun');
  const rust = new TextEncoder().encode("the rust build");
  const s = new Map([[assetOf("rust"), sha256Hex(rust)]]);
  const asked: string[] = [];
  const feed = {
    get: async (name: string) => {
      asked.push(name);
      return rust;
    },
  };
  const dir = join(home.dir, "flavour");
  mkdirSync(dir);
  const exe = join(dir, "fleetd");
  // No session host beside it (one on PATH, say): nothing to move.
  await updateHelper(feed, s, exe);
  expect(existsSync(helperPath(exe))).toBe(false);
  writeFileSync(helperPath(exe), "the previous rust build");
  await updateHelper(feed, s, exe);
  expect(readFileSync(helperPath(exe), "utf8")).toBe("the rust build");
  // Already the release's: not downloaded again.
  await updateHelper(feed, s, exe);
  expect(asked).toEqual([assetOf("rust")]);
});

test("the swap keeps the previous binary, and a restore puts it back", () => {
  const exe = join(home.dir, "fleetd");
  writeFileSync(exe, "old");
  const next = join(home.dir, "next");
  writeFileSync(next, "new");
  const prev = join(home.dir, "update", "fleetd.prev");
  swap(exe, next, new TextEncoder().encode("old"), prev);
  expect([readFileSync(exe, "utf8"), readFileSync(prev, "utf8")]).toEqual(["new", "old"]);
  restore(exe, prev);
  expect(readFileSync(exe, "utf8")).toBe("old");
  const units = join(home.dir, "units");
  require("node:fs").mkdirSync(units);
  writeFileSync(join(units, "fleetd-node.service"), `ExecStart=${exe} node run`);
  writeFileSync(join(units, "fleetd-hub.service"), `ExecStart=${exe} hub start`);
  writeFileSync(join(units, "fleetd-hub-lab.service"), "ExecStart=/other/fleetd hub start");
  expect(servicesIn(units, exe)).toEqual([
    { name: "fleetd-hub.service", unit: "hub" },
    { name: "fleetd-node.service", unit: "node" },
  ]);
});

test("an update keeps the session host it replaces, and a rollback puts it back with the binary", async () => {
  const dir = join(home.dir, "rollback");
  mkdirSync(dir);
  const p = plan(dir);
  writeFileSync(helperPath(p.exe), "old rust build");
  const rust = new TextEncoder().encode("new rust build");
  const s = new Map([[assetOf("rust"), sha256Hex(rust)]]);
  const feed = { get: async () => rust };
  // The update moves the session host to the new release, keeping the one it ran beside the previous binary.
  writeFileSync(keptHelper(p.prev), "kept by an earlier update");
  await updateHelper(feed, s, p.exe, p.prev);
  expect([readFileSync(helperPath(p.exe), "utf8"), readFileSync(keptHelper(p.prev), "utf8")]).toEqual(["new rust build", "old rust build"]);
  // The new build doesn't come up: the watcher puts both back.
  expect((await finish(p, fakePorts("1.0.0").ports)).state).toBe("rolled_back");
  expect([readFileSync(p.exe, "utf8"), readFileSync(helperPath(p.exe), "utf8")]).toEqual(["old", "old rust build"]);
  // A session host already the release's isn't replaced, and nothing stale is left to put back.
  writeFileSync(helperPath(p.exe), "new rust build");
  await updateHelper(feed, s, p.exe, p.prev);
  expect(existsSync(keptHelper(p.prev))).toBe(false);
  writeFileSync(p.exe, "new");
  restore(p.exe, p.prev);
  expect([readFileSync(p.exe, "utf8"), readFileSync(helperPath(p.exe), "utf8")]).toEqual(["old", "new rust build"]);
});

/** A service manager and a clock that move on as the watcher looks. */
function fakePorts(upOn: string | undefined, refuse = false) {
  let now = 0;
  const restarts: string[] = [];
  const ports: Ports = {
    restart(s) {
      if (refuse) throw new Error(`restarting ${s.name} exited with exit status: 1`);
      restarts.push(s.name);
    },
    healthy: async (_h, version) => version === upOn,
    sleep: async (ms) => {
      now += ms;
    },
    nowMs: () => now,
  };
  return { ports, restarts };
}

function plan(dir: string): Plan {
  const exe = join(dir, "fleetd");
  const prev = join(dir, "fleetd.prev");
  writeFileSync(exe, "new");
  writeFileSync(prev, "old");
  return {
    exe,
    prev,
    service: { name: "fleetd-hub.service", unit: "hub" },
    from: "1.0.0",
    to: "1.1.0",
    health: { kind: "hub", url: "http://127.0.0.1:1" },
    waitSecs: 90,
    verdict: join(dir, "verdict.json"),
  };
}

test("the watcher keeps a build that comes up, puts back one that doesn't, and one the manager refused", async () => {
  const p = plan(home.dir);
  expect(await finish(p, fakePorts("1.1.0").ports)).toEqual({ state: "done", stage: null, message: "runs 1.1.0" });
  const back = fakePorts("1.0.0");
  expect(await finish(p, back.ports)).toEqual({
    state: "rolled_back",
    stage: "health",
    message: "1.1.0 didn't come up healthy within 90 s, so 1.0.0 was put back and runs again",
  });
  expect(back.restarts.length).toBe(2);
  expect(readFileSync(p.exe, "utf8")).toBe("old");
  writeFileSync(p.exe, "new");
  expect(await finish(p, fakePorts(undefined, true).ports)).toEqual({
    state: "failed",
    stage: "restart",
    message: "restarting fleetd-hub.service exited with exit status: 1, so it never restarted onto 1.1.0 and still runs 1.0.0; its previous binary was put back",
  });
  // `fleetd update-finish <plan>`: its verdict lands where the hub reads it.
  const planPath = join(home.dir, "plan.json");
  writeFileSync(planPath, JSON.stringify(p));
  const write = process.stdout.write;
  process.stdout.write = () => true;
  const code = await run(planPath, fakePorts("1.1.0").ports);
  process.stdout.write = write;
  expect(code).toBe(0);
  expect(readVerdict(p.verdict)).toEqual({ state: "done", stage: null, message: "runs 1.1.0" });
  const err = process.stderr.write;
  process.stderr.write = () => true;
  expect(await run(join(home.dir, "nothing.json"))).toBe(2);
  process.stderr.write = err;
});

test("the kept binary reads as it was when the process started, after a new one is renamed over its path", async () => {
  const { Kept } = await import("../src/update/running.ts");
  const { replaceFile } = await import("../src/update/index.ts");
  const dir = join(home.dir, "kept");
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, "fleetd");
  writeFileSync(exe, "old build");
  const kept = Kept.open(exe);
  try {
    replaceFile(exe, "the new build");
    expect(new TextDecoder().decode(kept.bytes())).toBe("old build");
    expect(readFileSync(exe, "utf8")).toBe("the new build");
  } finally {
    kept.close();
  }
});
