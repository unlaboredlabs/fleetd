// A bot's computer image in a hosted provider (src/node/place/hosted.ts buildSnapshot), against boat's stand-in server,
// its boxes running here: the build box runs setup, is saved as a snapshot named for the bot and its key, and goes; a
// session placed in boat starts from the snapshot without running setup; a new image removes the old snapshot; one whose
// snapshot is gone starts from the template and runs the setup it skipped. A provider that saved no snapshots would give
// its bots no image: a clean start plus setup.
import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boatStandIn, KEY, localRunner, type StandIn } from "./stand_ins.ts";
import { provider, type ProviderId } from "../../src/sandbox/providers/index.ts";
import { Boxes, setBoxes } from "../../src/node/sandbox/remote/boxes.ts";
import { BOX_DIR } from "../../src/node/sandbox/remote/bootstrap.ts";
import { hostedBackend, hostedPlace, snapshotName } from "../../src/node/place/hosted.ts";
import { Images, sessionImage } from "../../src/node/place/image.ts";
import { LeadRelay } from "../../src/node/lead/index.ts";
import { Masker } from "../../src/node/mask.ts";
import * as setup from "../../src/node/worktree/setup.ts";

const MAIN = join(import.meta.dir, "../../src/main.ts");
const tmp = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-hosted-image-"));
let server: StandIn | undefined;
let cleanup = async () => {};
afterEach(async () => {
  server?.stop();
  await cleanup();
});
afterAll(() => {
  setBoxes(undefined);
  rmSync(tmp, { recursive: true, force: true });
});

const FLEETD = new TextEncoder().encode(`#!/bin/sh\nexec ${process.execPath} ${MAIN} "$@"\n`);
const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

function sh(cwd: string, cmd: string): string {
  const r = Bun.spawnSync(["sh", "-c", cmd], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

async function world(id: ProviderId, makingMs?: number, snapshots = true) {
  const base = mkdtempSync(join(tmp, "t-"));
  const home = join(base, "node");
  const HOME = join(base, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  const repo = join(base, "repo");
  sh(base, `git init -q -b main ${repo} && cd ${repo} && echo v1 > bun.lock && git add -A && git commit -qm one`);
  const local = localRunner(join(base, "boxes"), BOX_DIR);
  cleanup = local.cleanup;
  const s = boatStandIn(local.runner);
  server = s;
  local.track(s);
  const api = `${s.url}/api/v1`;
  const boxes = new Boxes(home, "devbox", { open: (b) => b }, {
    provider: (p, auth) => {
      const c = provider(p, auth, { urls: { api, sandbox: (box, port) => `${s.url}/box/${box}/${port}` }, pollMs: 5 });
      return snapshots ? c : { ...c, snapshot: undefined, forget: undefined };
    },
    source: () => ({ sha256: sha(FLEETD), bytes: async () => FLEETD }),
    ...(makingMs !== undefined ? { makingMs } : {}),
  });
  boxes.setKeys({ [id]: Buffer.from(JSON.stringify({ provider: id, key: KEY })).toString("base64") });
  boxes.wire({ lead: { relay: new LeadRelay(), identify: () => ({ kind: "none" }) as never, maskFor: () => new Masker([]) } });
  setBoxes(boxes);
  const images = new Images({ home, backend: () => hostedBackend(home, id, HOME), root: () => repo, vars: () => ({ env: {}, secrets: [] }) });
  const env = { HOME, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, FLEETD_NODE_SOCK: join(home, "node.sock"), TMPDIR: join(home, "tmp", "s1") };
  return { s, home, repo, HOME, images, env, base, boxes };
}

/** A stand-in box runs here, at this machine's paths, and its guest outlives its box: the next box's node.sock is free
 * only once the last one's is gone. */
const nextBox = (home: string) => rmSync(join(home, "node.sock"), { force: true });

const creates = (s: StandIn) => s.calls.filter((c) => c.method === "POST" && /\/sandboxes$/.test(c.path)).map((c) => c.body);

test("boat: setup builds a snapshot, a session placed there starts from it without setup, and a new one replaces it", async () => {
  const w = await world("boat");
  const log = join(w.base, "ran.log");
  const plan: setup.Plan = { commands: [`echo built >> '${log}'`], inputs: ["bun.lock"] };
  expect(w.images.status("p1", plan)).toMatchObject({ state: "building", where: "boat" });
  await w.images.idle();
  const ready = w.images.status("p1", plan);
  expect(ready).toMatchObject({ state: "ready", where: "boat" });
  expect(ready.bytes).toBeUndefined();
  expect(readFileSync(log, "utf8")).toBe("built\n");
  // The build's box was made savable (no `snapshots: false`), saved under the bot's name, and deleted.
  const build = creates(w.s).at(-1);
  expect(build.snapshots).toBeUndefined();
  // (The template's own build saves one too.)
  const saves = w.s.calls.filter((c) => c.method === "POST" && c.path.endsWith("/saved-snapshots") && String(c.body.name).startsWith("fleetd-p1-"));
  expect(saves).toHaveLength(1);
  const name = saves[0]!.body.name as string;
  expect(name).toMatch(/^fleetd-p1-[0-9a-f]{12}$/);
  expect(w.s.boxes.size).toBe(0);

  // A session's worktree with the same lockfile: its box starts from the snapshot, and its setup doesn't run.
  const cwd = join(w.home, "worktrees", "T1");
  sh(w.repo, `git worktree add -q -b fleetd/T1 ${cwd}`);
  nextBox(w.home);
  const image = w.images.use("p1", plan, cwd, "s1", "boat");
  expect(image).toMatchObject({ where: "boat", ref: name });
  const dir = join(w.home, "hosts", "s1");
  const place = hostedPlace("boat", "s1", dir);
  const outcome = await setup.run(place, plan, cwd, w.env, [], () => {}, () => {}, undefined, image);
  expect(outcome.kind).toBe("image");
  const ran = await place.run({ cwd, argv: ["sh", "-c", "echo ok"], timeoutSec: 30, env: w.env, scrub: [] });
  expect(ran.exitCode).toBe(0);
  expect(creates(w.s).at(-1).from).toBe(name);
  expect(creates(w.s).at(-1).snapshots).toBe(false);
  expect(readFileSync(log, "utf8")).toBe("built\n");
  await place.end(dir);
  expect(sessionImage(w.home, "s1")).toBeUndefined();

  // New commands: a new snapshot, and the old one is deleted from the account.
  nextBox(w.home);
  const more: setup.Plan = { ...plan, commands: [...plan.commands!, "echo more"] };
  w.images.status("p1", more);
  await w.images.idle();
  expect(w.images.status("p1", more).state).toBe("ready");
  expect(w.s.calls.some((c) => c.method === "DELETE" && c.path.endsWith(`/saved-snapshots/${name}`))).toBe(true);
}, 60_000);

test("boat: a session whose snapshot went starts from the template and runs the setup it skipped", async () => {
  const w = await world("boat");
  const log = join(w.base, "ran.log");
  const plan: setup.Plan = { commands: [`echo ran >> '${log}'`], inputs: ["bun.lock"] };
  w.images.status("p1", plan);
  await w.images.idle();
  const cwd = join(w.home, "worktrees", "T2");
  sh(w.repo, `git worktree add -q -b fleetd/T2 ${cwd}`);
  nextBox(w.home);
  const image = w.images.use("p1", plan, cwd, "s2", "boat")!;
  expect(image).toBeDefined();
  // The provider no longer has it: its create from the snapshot is refused once.
  w.s.fail({ path: /\/sandboxes$/, status: 404, body: { ok: false, code: "snapshot_not_found", message: "no such snapshot" }, times: 1 });
  const dir = join(w.home, "hosts", "s2");
  const place = hostedPlace("boat", "s2", dir);
  expect((await setup.run(place, plan, cwd, w.env, [], () => {}, () => {}, undefined, image)).kind).toBe("image");
  const ran = await place.run({ cwd, argv: ["sh", "-c", "echo ok"], timeoutSec: 30, env: w.env, scrub: [] });
  expect(ran.exitCode).toBe(0);
  expect(creates(w.s).at(-1).from).not.toBe(image.ref);
  // Built once, run again in the session's box.
  expect(readFileSync(log, "utf8")).toBe("ran\nran\n");
  expect(sessionImage(w.home, "s2")).toBeUndefined();
  await place.end(dir);
}, 60_000);

test("boat: the sweep of boxes no session holds leaves a build's box alone until the build ends", async () => {
  // A new box is left alone for 0 ms here (60 s on a node), so a build longer than that meets the sweep.
  const w = await world("boat", 0);
  const go = join(w.base, "go");
  const waiting = join(w.base, "waiting");
  const plan: setup.Plan = { commands: [`touch '${waiting}'; until [ -e '${go}' ]; do sleep 0.05; done; echo built`], inputs: ["bun.lock"] };
  w.images.status("p1", plan);
  const until = Date.now() + 20_000;
  while (!existsSync(waiting) && Date.now() < until) await Bun.sleep(20);
  expect(existsSync(waiting)).toBe(true);
  await Bun.sleep(50);
  // The sweep, as the reaper runs it every 10 minutes: the build's box is no session's.
  expect(await w.boxes.reap(() => new Set())).toBe(0);
  expect(w.s.boxes.size).toBe(1);
  writeFileSync(go, "");
  await w.images.idle();
  expect(w.images.status("p1", plan).state).toBe("ready");
  // Once it ended, it is gone and nothing holds the sweep back.
  expect(w.s.boxes.size).toBe(0);
}, 60_000);

test("a provider that saves no snapshots gives its bots no image: they start clean and run setup", async () => {
  const w = await world("boat", undefined, false);
  expect(hostedBackend(w.home, "boat", w.HOME)).toBeUndefined();
  expect(w.images.status("p1", { commands: ["echo"] })).toEqual({ state: "none" });
  expect(w.images.use("p1", { commands: ["echo"] }, w.repo, "s3", "boat")).toBeUndefined();
  expect(existsSync(join(w.home, "vm", "images"))).toBe(false);
  expect(snapshotName("P_1", "a".repeat(64))).toBe("fleetd-p-1-aaaaaaaaaaaa");
});
