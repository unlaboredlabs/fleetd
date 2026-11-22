// A hosted box's whole life against the provider's stand-in server (stand_ins.ts with a Runner): the node's Boxes
// (src/node/sandbox/remote/boxes.ts) builds the template, creates the box with labels and no secret, starts the
// bootstrap with the box's own secret, hands it this fleetd, and opens the guest's link through the provider's port;
// then commands, files in and out, and the box's delete, and the reaper of boxes no session holds. The bootstrap and
// the guest run here as the provider would run them in the box.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boatStandIn, KEY, localRunner, type StandIn, type Step } from "./stand_ins.ts";
import { provider, type ProviderId } from "../../src/sandbox/providers/index.ts";
import { Boxes, DOWN_MS, hostable, MACHINE_LABEL, PROBE_AGAIN_MS, SESSION_LABEL } from "../../src/node/sandbox/remote/boxes.ts";
import { BOX_DIR, type Source } from "../../src/node/sandbox/remote/bootstrap.ts";
import { FLEETD_PATH } from "../../src/sandbox/providers/recipe.ts";
import { type Box } from "../../src/node/sandbox/box.ts";
import { LeadRelay } from "../../src/node/lead/index.ts";
import { Masker } from "../../src/node/mask.ts";
import { type HostedStep, stepWords, watchSteps } from "../../src/node/place/hosted_steps.ts";
import { troubleLine, troubleOf } from "../../src/shared/sandbox.ts";

const MAIN = join(import.meta.dir, "../../src/main.ts");
const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-hosted-"));
const running: StandIn[] = [];
const opened: Box[] = [];
afterEach(() => {
  for (const b of opened.splice(0)) b.close();
  for (const s of running.splice(0)) s.stop();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** "fleetd" as the box gets it: a script that runs this checkout's fleetd under this Bun. */
const FLEETD = new TextEncoder().encode(`#!/bin/sh\nexec ${process.execPath} ${MAIN} "$@"\n`);
const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

let made = 0;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A stand-in for `id` whose boxes run here, each with a port and a box dir of its own. `o.step`: how a template
 * build's commands end; `o.before`: what the account holds before the keys come (`name`: this recipe's template). */
async function world(id: ProviderId, o: { step?: Step; before?: (s: StandIn, name: string) => void; source?: () => Source; baked?: string; released?: (url: string) => Promise<boolean>; now?: () => number } = {}) {
  const dir = join(root, `w${++made}`);
  mkdirSync(dir, { recursive: true });
  const local = localRunner(join(dir, "boxes"), BOX_DIR);
  cleanups.push(local.cleanup);
  // Where the box's template holds fleetd, here.
  if (o.baked) {
    const rewrite = local.runner.rewrite;
    local.runner.rewrite = (box, text) => rewrite(box, text).replaceAll(FLEETD_PATH, o.baked!);
  }
  const s = boatStandIn(local.runner, o.step);
  running.push(s);
  local.track(s);
  const api = `${s.url}/api/v1`;
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const boxes = new Boxes(home, "devbox", { open: (b) => b }, {
    provider: (p, auth) => provider(p, auth, { urls: { api, sandbox: (box, port) => `${s.url}/box/${box}/${port}` }, pollMs: 5 }),
    source: o.source ?? (() => ({ sha256: sha(FLEETD), bytes: async () => FLEETD })),
    ...(o.released ? { released: o.released } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
  o.before?.(s, boxes.templateName());
  boxes.setKeys({ [id]: Buffer.from(JSON.stringify({ provider: id, key: KEY })).toString("base64") });
  boxes.wire({ lead: { relay: new LeadRelay(), identify: () => ({ kind: "none" }) as never, maskFor: () => new Masker([]) } });
  return { s, boxes, home };
}

for (const id of ["boat"] as const) {
  describe(id, () => {
    test("a box comes up from the built template with fleetd handed to it, runs commands, takes files and goes", async () => {
      const { s, boxes } = await world(id);
      const record = await boxes.create(id, "sess-1", [], []);
      // Built once, kept for the next box.
      expect(await boxes.template(id)).toBe(await boxes.template(id));
      const b = s.boxes.get(record.boxId);
      const labels = b.labels ?? b.metadata;
      expect(labels).toMatchObject({ [MACHINE_LABEL]: "devbox", [SESSION_LABEL]: "sess-1", fleetd: "1" });
      // The create holds no secret: the box's own secret went only to its start.
      expect(JSON.stringify(b.req)).not.toContain(record.secret);
      const box = await boxes.open(record, "sess-1");
      opened.push(box);
      const ran = await box.run({ argv: ["sh", "-c", "echo hello from $0"], cwd: "/", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutSec: 20 });
      expect(ran).toMatchObject({ exitCode: 0, timedOut: false });
      expect(ran.outputTail).toContain("hello from sh");
      // A file larger than one control message goes in pieces, both ways.
      const big = new Uint8Array(1_500_000).map((_, i) => i % 251);
      const at = join(root, `file-${id}.bin`);
      await box.write(at, big);
      expect(Buffer.compare(Buffer.from(await box.read(at, 2_000_000)), Buffer.from(big))).toBe(0);
      await expect(box.read(at, 1000)).rejects.toThrow("larger than 1000 bytes");
      await boxes.extend(record);
      await boxes.destroy(record);
      expect(s.boxes.has(record.boxId)).toBe(false);
    }, 60_000);
  });
}

test("boat: a machine whose home was wiped finds the template at fleetd's computers by its name and builds none", async () => {
  const { s, boxes, home } = await world("boat");
  const name = await boxes.template("boat");
  const builds = () => s.calls.filter((c) => c.method === "POST" && String(c.body?.name ?? "").startsWith("fleetd build")).length;
  expect(builds()).toBe(1);
  // The host was rebuilt: the runner's home, and its note of the template, are gone.
  rmSync(join(home, "sandbox"), { recursive: true, force: true });
  const again = new Boxes(home, "devbox", { open: (b) => b }, {
    provider: (p, auth) => provider(p, auth, { urls: { api: `${s.url}/api/v1`, sandbox: (box, port) => `${s.url}/box/${box}/${port}` }, pollMs: 5 }),
    source: () => ({ sha256: sha(FLEETD), bytes: async () => FLEETD }),
  });
  again.setKeys({ boat: Buffer.from(JSON.stringify({ provider: "boat", key: KEY })).toString("base64") });
  expect(await again.template("boat")).toBe(name);
  expect(builds()).toBe(1);
  // And it keeps the note again: no second lookup.
  const lookups = () => s.calls.filter((c) => c.method === "GET" && c.path === `/api/v1/saved-snapshots/${name}`).length;
  const seen = lookups();
  expect(await again.template("boat")).toBe(name);
  expect(lookups()).toBe(seen);
  // One the account doesn't have ready is built: a deleted one.
  rmSync(join(home, "sandbox"), { recursive: true, force: true });
  await provider("boat", { key: KEY }, { urls: { api: `${s.url}/api/v1` } }).forget!(name);
  const third = new Boxes(home, "devbox", { open: (b) => b }, {
    provider: (p, auth) => provider(p, auth, { urls: { api: `${s.url}/api/v1`, sandbox: (box, port) => `${s.url}/box/${box}/${port}` }, pollMs: 5 }),
    source: () => ({ sha256: sha(FLEETD), bytes: async () => FLEETD }),
  });
  third.setKeys({ boat: Buffer.from(JSON.stringify({ provider: "boat", key: KEY })).toString("base64") });
  expect(await third.template("boat")).toBe(name);
  expect(builds()).toBe(2);
}, 60_000);

test("boat: a bot's picked size is the box's own, exactly, and one boat doesn't give is refused before any box", async () => {
  const { s, boxes } = await world("boat");
  const size = { cpu: 4, memGb: 8 };
  const record = await boxes.create("boat", "sess-big", [], [], size);
  // The session's box, not boat's build box (named "fleetd build …").
  const made = s.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/sandboxes" && !String(c.body?.name ?? "").startsWith("fleetd build"));
  expect(made).toHaveLength(1);
  // boat sizes at create: the one template, the box of type "default" (4 vCPU / 8 GB).
  expect(made[0]!.body.type).toBe("default");
  expect(await boxes.template("boat", size)).toBe(await boxes.template("boat"));
  await boxes.destroy(record);
  const before = s.calls.length;
  const odd = await boxes.create("boat", "sess-odd", [], [], { cpu: 3, memGb: 6 }).catch((e) => e);
  expect(odd.message).toContain("come in no 3 vCPU / 6 GB");
  expect(s.calls.length).toBe(before);
}, 60_000);

/** The template builds' boxes the stand-in was asked to make, and its saves. */
const buildBoxes = (s: StandIn) => s.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/sandboxes" && String(c.body?.name ?? "").startsWith("fleetd build"));
const saves = (s: StandIn) => s.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/saved-snapshots");
/** Resolves once `ok()` holds, failing after `ms`. */
async function until(ok: () => boolean, ms = 10_000) {
  for (const end = Date.now() + ms; !ok(); await Bun.sleep(10)) if (Date.now() > end) throw new Error("it never happened");
}
/** A saved snapshot as another machine (or an older release) left it in the account. */
const seed = (s: StandIn, name: string, at: string, status: "ready" | "saving" | "failed" = "ready") => s.saved!.set(name, { asked: status === "ready" ? 2 : 0, at, ...(status === "failed" ? { failed: true } : {}) });

test("the template is built ahead when the keys come, so a box's start waits on no build (W756 W1)", async () => {
  const { s, boxes } = await world("boat");
  // Nothing asked for a box yet: the keys alone started the build.
  await until(() => saves(s).length === 1);
  const steps: HostedStep[] = [];
  const unwatch = watchSteps("sess-ahead", (step) => steps.push(step));
  const record = await boxes.create("boat", "sess-ahead", [], []);
  unwatch();
  expect(s.boxes.get(record.boxId).req.from).toBe(boxes.templateName());
  expect(buildBoxes(s)).toHaveLength(1);
  expect(saves(s)).toHaveLength(1);
  // The keys again (the next link): nothing built again.
  boxes.setKeys({ boat: Buffer.from(JSON.stringify({ provider: "boat", key: KEY })).toString("base64") });
  // The keys' build ahead is asked for once the probe answers, before a template() after it: a build it started is the
  // run ahead() then answers, and is waited for whole.
  await boxes.template("boat");
  await boxes.ahead("boat")?.done;
  expect(buildBoxes(s)).toHaveLength(1);
  await boxes.destroy(record);
}, 60_000);

test("a template saved before builds proved it is never one to start from, however new (W756)", async () => {
  const fail = () => ({ exitCode: 100, stderr: "E: broken" });
  // fleetd-94251c014f62's kind: newer, ready, and without the Claude Code a start runs.
  const { s, boxes } = await world("boat", { step: fail, before: (s) => {
    seed(s, "fleetd-94251c014f62", "2026-11-20T21:26:01Z");
    seed(s, "fleetd-taaaaaaaaaaaa", "2026-11-18T09:00:00Z");
  } });
  await boxes.ahead("boat")?.done.catch(() => {});
  const record = await boxes.create("boat", "sess-proven", [], []);
  expect(s.boxes.get(record.boxId).req.from).toBe("fleetd-taaaaaaaaaaaa");
  await boxes.destroy(record);
  // With only such a template, the first start waits on a build, saying so, rather than start where it can't run.
  const { boxes: only } = await world("boat", { step: fail, before: (s) => seed(s, "fleetd-94251c014f62", "2026-11-20T21:26:01Z") });
  await only.ahead("boat")?.done.catch(() => {});
  const steps: HostedStep[] = [];
  const unwatch = watchSteps("sess-unproven", (step) => steps.push(step));
  await expect(only.create("boat", "sess-unproven", [], [])).rejects.toThrow("the sandbox template at fleetd's computers didn't build");
  unwatch();
  expect(steps).toEqual(["template"]);
}, 60_000);

test("a template this recipe's build fails on: boxes start from the newest ready older one, said so, never saved over (W756 W1)", async () => {
  // boat's base image breaks every step of the build, as its PPA did on 2026-11-20.
  const { s, boxes } = await world("boat", {
    step: () => ({ exitCode: 100, stderr: "E: Repository changed its 'Label' value" }),
    before: (s) => {
      seed(s, "fleetd-taaaaaaaaaaaa", "2026-11-18T09:00:00Z");
      seed(s, "fleetd-tbbbbbbbbbbbb", "2026-11-10T09:00:00Z");
      // A bot's computer image, and a template whose save failed, are never a template to start from.
      seed(s, "fleetd-p1-0123456789ab", "2026-11-19T09:00:00Z");
      seed(s, "fleetd-tcccccccccccc", "2026-11-19T10:00:00Z", "failed");
    },
  });
  // The build ahead the keys started fails.
  await boxes.ahead("boat")?.done.catch(() => {});
  const steps: HostedStep[] = [];
  const unwatch = watchSteps("sess-older", (step) => steps.push(step));
  const record = await boxes.create("boat", "sess-older", [], []);
  unwatch();
  expect(s.boxes.get(record.boxId).req.from).toBe("fleetd-taaaaaaaaaaaa");
  expect(steps.map((st) => stepWords(st, "boat"))).toEqual(["Starting its computer (a newer computer image didn't build; using the one from Nov 18)"]);
  // The start built nothing, and nothing was set aside: the provider takes the next box.
  expect(buildBoxes(s)).toHaveLength(1);
  expect(boxes.usable()).toEqual(["boat"]);
  // Nothing was saved: not the failed build, and never over the older templates.
  expect(saves(s)).toHaveLength(0);
  // The next link tries the build again, in the background.
  boxes.setKeys({ boat: Buffer.from(JSON.stringify({ provider: "boat", key: KEY })).toString("base64") });
  await until(() => buildBoxes(s).length === 2);
  await boxes.destroy(record);
}, 60_000);

test("while this recipe's template is still being built, a box starts from the last good one and says so", async () => {
  // The build's steps never end here: it is still under way when the box starts.
  const { s, boxes } = await world("boat", { step: () => ({ exitCode: 0, running: true }), before: (s) => seed(s, "fleetd-taaaaaaaaaaaa", "2026-11-18T09:00:00Z") });
  await until(() => buildBoxes(s).length === 1);
  const steps: HostedStep[] = [];
  const unwatch = watchSteps("sess-mid", (step) => steps.push(step));
  const record = await boxes.create("boat", "sess-mid", [], []);
  unwatch();
  expect(s.boxes.get(record.boxId).req.from).toBe("fleetd-taaaaaaaaaaaa");
  expect(steps.map((st) => stepWords(st, "boat"))).toEqual(["Starting its computer (a newer computer image is still being made; using the one from Nov 18)"]);
  await boxes.destroy(record);
}, 60_000);

test("a template another machine is still saving under this name is waited for, never built or saved over", async () => {
  const { s, boxes } = await world("boat", { before: (s, name) => seed(s, name, "2026-11-20T09:00:00Z", "saving") });
  expect(await boxes.template("boat")).toBe(boxes.templateName());
  expect(buildBoxes(s)).toHaveLength(0);
  expect(saves(s)).toHaveLength(0);
}, 60_000);

test("only a team with no template at all waits on a build, with the first-time words", async () => {
  const { boxes } = await world("boat", { step: () => ({ exitCode: 1, stderr: "broken" }) });
  await boxes.ahead("boat")?.done.catch(() => {});
  const steps: HostedStep[] = [];
  const unwatch = watchSteps("sess-first", (step) => steps.push(step));
  await expect(boxes.create("boat", "sess-first", [], [])).rejects.toThrow("the sandbox template at fleetd's computers didn't build");
  unwatch();
  expect(steps).toEqual(["template"]);
}, 60_000);

test("a template's build box carries the machine's label: the reaper leaves it while it builds, and takes one a dead build left (W12)", async () => {
  let reaped: Promise<number> | undefined;
  let boxesRef: Boxes | undefined;
  const { s, boxes } = await world("boat", {
    // While a step of the build runs, the reaper sweeps.
    step: () => {
      reaped ??= boxesRef?.reap(() => new Set());
      return { exitCode: 0 };
    },
  });
  boxesRef = boxes;
  await boxes.template("boat").catch(() => {});
  // The build ahead started before boxesRef was set: build once more so a sweep runs mid-build.
  if (!reaped) {
    s.saved!.clear();
    rmSync(join(boxes.home, "sandbox", "template-boat.json"), { force: true });
    boxes.setKeys({ boat: Buffer.from(JSON.stringify({ provider: "boat", key: KEY })).toString("base64") });
    await boxes.ahead("boat")?.done;
  }
  expect(await reaped).toBe(0);
  for (const b of buildBoxes(s)) expect(b.body.labels).toMatchObject({ [MACHINE_LABEL]: "devbox", fleetd: "1" });
  // A build box its machine's runner left when it died (no build of it runs here now) goes at the next sweep.
  const orphan = await boxes.client("boat").create({ template: "t", key: "k-orphan", labels: { [MACHINE_LABEL]: "devbox", "fleetd-build": "fleetd-000000000000" }, lifetimeMs: 60_000 });
  expect(await boxes.reap(() => new Set())).toBe(1);
  expect(s.boxes.has(orphan.id)).toBe(false);
}, 60_000);

/** A release build's source: its URL (nothing answers there, so a fetch fails and the node sends the bytes) and SHA. */
const release = (): Source => ({ sha256: sha(FLEETD), url: "https://127.0.0.1:9/fleetd-linux-x64", bytes: async () => FLEETD });
/** A box's bootstrap log, in the stand-in's dir of that box. */
const bootLog = (home: string, boxId: string) => readFileSync(join(home, "..", "boxes", boxId, "boot.log"), "utf8");

test("a template built for this release holds its fleetd, and a box from it starts that one, fetching nothing (W755 fix 5)", async () => {
  const baked = join(root, `baked-${++made}`);
  writeFileSync(baked, FLEETD, { mode: 0o755 });
  const { s, boxes, home } = await world("boat", { source: release, baked, released: async () => true });
  const name = await boxes.template("boat");
  // Saved under the recipe's name and the release's fleetd; a bot's computer image keys on the recipe's alone.
  expect(name).toBe(`${boxes.templateName()}-f${sha(FLEETD).slice(0, 12)}`);
  expect(boxes.templateName()).toMatch(/^fleetd-t[0-9a-f]{12}$/);
  // The build fetched and checked that very build into the template.
  const steps = s.calls.filter((c) => c.method === "POST" && /\/commands$/.test(c.path)).map((c) => String(c.body.command));
  expect(steps.some((c) => c.includes("https://127.0.0.1:9/fleetd-linux-x64") && c.includes(`${sha(FLEETD)}  ${FLEETD_PATH}`))).toBe(true);
  const record = await boxes.create("boat", "sess-baked", [], []);
  expect(bootLog(home, record.boxId)).toContain("the template's fleetd is the node's");
  expect(bootLog(home, record.boxId)).not.toContain("fetching fleetd");
  expect(lstatSync(join(home, "..", "boxes", record.boxId, "fleetd")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(home, "..", "boxes", record.boxId, "fleetd"))).toBe(baked);
  await boxes.destroy(record);
}, 60_000);

test("a fleetd that isn't a published release (a build of one's own) bakes nothing: the plain template, and the box takes it at its start", async () => {
  const asked: string[] = [];
  // Its URL answers 404, as a build of one's own's does.
  const { s, boxes, home } = await world("boat", { source: release, released: async (url) => (asked.push(url), false) });
  expect(await boxes.template("boat")).toBe(boxes.templateName());
  expect(asked).toEqual(["https://127.0.0.1:9/fleetd-linux-x64"]);
  // Its recipe fetched no fleetd: a build that would fail on a 404.
  const steps = s.calls.filter((c) => c.method === "POST" && /\/commands$/.test(c.path)).map((c) => String(c.body.command));
  expect(steps.some((c) => c.includes("127.0.0.1:9"))).toBe(false);
  const record = await boxes.create("boat", "sess-own", [], []);
  expect(bootLog(home, record.boxId)).toContain("starting the guest");
  await boxes.destroy(record);
  // Asked once per process.
  await boxes.template("boat");
  expect(asked).toHaveLength(1);
}, 60_000);

test("a template holding another fleetd build: the box takes the node's as before", async () => {
  const baked = join(root, `baked-${++made}`);
  writeFileSync(baked, new TextEncoder().encode("#!/bin/sh\nexit 3\n"), { mode: 0o755 });
  const { boxes, home } = await world("boat", { source: release, baked, released: async () => true });
  const record = await boxes.create("boat", "sess-other", [], []);
  const log = bootLog(home, record.boxId);
  expect(log).toContain("the template's fleetd is another build");
  // Its fetch failed here (nothing at the URL), so the node sent the bytes; the guest came up on them.
  expect(log).toContain("starting the guest");
  await boxes.destroy(record);
}, 60_000);

test("a new template's build deletes the account's older templates past the newest two, never a bot's image", async () => {
  const { s, boxes } = await world("boat", {
    before: (s) => {
      seed(s, "fleetd-taaaaaaaaaaaa", "2026-11-18T09:00:00Z");
      seed(s, "fleetd-tbbbbbbbbbbbb-f0123456789ab", "2026-11-17T09:00:00Z");
      seed(s, "fleetd-tcccccccccccc", "2026-11-10T09:00:00Z");
      seed(s, "fleetd-p1-0123456789ab", "2026-11-01T09:00:00Z");
      seed(s, "fleetd-tdddddddddddd", "2026-11-09T09:00:00Z", "saving");
    },
  });
  await boxes.template("boat");
  await until(() => !s.saved!.has("fleetd-tcccccccccccc"));
  expect([...s.saved!.keys()].sort()).toEqual([boxes.templateName(), "fleetd-taaaaaaaaaaaa", "fleetd-tdddddddddddd", "fleetd-p1-0123456789ab"].sort());
}, 60_000);

test("a new template's build deletes every template named as before builds proved them, and nothing else (W756)", async () => {
  const logged: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    const { s, boxes } = await world("boat", {
      before: (s) => {
        // From before the rename: never started from, all of them deleted, the newest too, a failed one too.
        seed(s, "fleetd-94251c014f62", "2026-11-19T09:00:00Z");
        seed(s, "fleetd-0123456789ab", "2026-11-12T09:00:00Z");
        seed(s, "fleetd-abcdef012345", "2026-11-11T09:00:00Z", "failed");
        // Proven ones, kept as today: the newest two.
        seed(s, "fleetd-taaaaaaaaaaaa", "2026-11-18T09:00:00Z");
        seed(s, "fleetd-tcccccccccccc", "2026-11-10T09:00:00Z");
        // A bot's computer image, and a person's own templates whose names only look alike.
        seed(s, "fleetd-p1-0123456789ab", "2026-11-01T09:00:00Z");
        seed(s, "fleetd-0123456789ab-mine", "2026-11-01T09:00:00Z");
        seed(s, "fleetd-mybox", "2026-11-01T09:00:00Z");
        seed(s, "fleetd-0123456789abc", "2026-11-01T09:00:00Z");
      },
    });
    await boxes.template("boat");
    // Each delete is logged once boat answered it, after the stand-in dropped the template: the log lines, not the
    // stand-in's state, say the prune is done.
    const deleted = (n: string) => logged.filter((l) => l.includes("INFO an old hosted sandbox template is deleted") && l.includes(`"name":"${n}"`));
    const unproven = ["fleetd-94251c014f62", "fleetd-0123456789ab", "fleetd-abcdef012345"];
    await until(() => [...unproven, "fleetd-tcccccccccccc"].every((n) => deleted(n).length > 0));
    expect([...s.saved!.keys()].sort()).toEqual([boxes.templateName(), "fleetd-taaaaaaaaaaaa", "fleetd-p1-0123456789ab", "fleetd-0123456789ab-mine", "fleetd-mybox", "fleetd-0123456789abc"].sort());
    for (const n of unproven) expect(deleted(n)).toHaveLength(1);
  } finally {
    console.log = log;
  }
}, 60_000);

test("a template a box of this node is being created from is never pruned", async () => {
  const { s, boxes } = await world("boat");
  const name = await boxes.template("boat");
  // The account loses this recipe's template, so the next machine builds and prunes; two old ones are there.
  await boxes.client("boat").forget!(name);
  seed(s, "fleetd-0123456789ab", "2026-11-12T09:00:00Z");
  seed(s, "fleetd-0123456789cd", "2026-11-12T09:00:00Z");
  let open = () => {};
  const gate = new Promise<void>((r) => (open = r));
  const again = new Boxes(join(root, `again-${++made}`), "devbox", { open: (b) => b }, {
    provider: (p, auth) => {
      const c = provider(p, auth, { urls: { api: `${s.url}/api/v1`, sandbox: (box, port) => `${s.url}/box/${box}/${port}` }, pollMs: 5 });
      return { ...c, create: async (o) => (await gate, c.create(o)) };
    },
    source: () => ({ sha256: sha(FLEETD), bytes: async () => FLEETD }),
  });
  again.setKeys({ boat: Buffer.from(JSON.stringify({ provider: "boat", key: KEY })).toString("base64") });
  again.wire({ lead: { relay: new LeadRelay(), identify: () => ({ kind: "none" }) as never, maskFor: () => new Masker([]) } });
  const making = again.create("boat", "sess-old", [], [], undefined, { template: "fleetd-0123456789ab" });
  await until(() => !s.saved!.has("fleetd-0123456789cd"));
  expect(s.saved!.has("fleetd-0123456789ab")).toBe(true);
  open();
  const record = await making;
  expect(s.boxes.get(record.boxId).req.from).toBe("fleetd-0123456789ab");
  await again.destroy(record);
}, 60_000);

test("a release asset's HEAD that missed is asked again PROBE_AGAIN_MS later, not at every start; one found stays (W756)", async () => {
  const baked = join(root, `baked-${++made}`);
  writeFileSync(baked, FLEETD, { mode: 0o755 });
  let now = Date.parse("2026-11-20T10:00:00Z");
  let published = false;
  const asked: number[] = [];
  const { s, boxes } = await world("boat", { source: release, baked, now: () => now, released: async () => (asked.push(now), published) });
  // Not published yet: the plain template.
  expect(await boxes.template("boat")).toBe(boxes.templateName());
  expect(asked).toHaveLength(1);
  // Starts before the wait ask nothing.
  now += PROBE_AGAIN_MS - 1;
  published = true;
  expect(await boxes.template("boat")).toBe(boxes.templateName());
  expect(asked).toHaveLength(1);
  // After it, asked again: found, this release's template is built ahead while boxes start from the plain one.
  now += 1;
  const steps: HostedStep[] = [];
  expect(await boxes.template("boat", undefined, (step) => steps.push(step))).toBe(boxes.templateName());
  expect(asked).toHaveLength(2);
  expect(steps).toEqual([{ older: expect.any(String), building: true }]);
  const own = `${boxes.templateName()}-f${sha(FLEETD).slice(0, 12)}`;
  // The node's own build is what ends: boat answering the save ready comes a round trip (the build box's delete) before.
  await boxes.ahead("boat")?.done;
  expect(saves(s)).toHaveLength(2);
  expect(await boxes.template("boat")).toBe(own);
  // Found stays found: never asked again.
  now += 10 * PROBE_AGAIN_MS;
  expect(await boxes.template("boat")).toBe(own);
  expect(asked).toHaveLength(2);
}, 60_000);

test("a box whose noted template was deleted looks again and starts, never set aside for it", async () => {
  const { s, boxes } = await world("boat");
  const name = await boxes.template("boat");
  // Another machine of the team pruned it; this one's note still names it.
  await boxes.client("boat").forget!(name);
  seed(s, "fleetd-taaaaaaaaaaaa", "2026-11-18T09:00:00Z");
  const record = await boxes.create("boat", "sess-gone", [], []);
  expect(s.boxes.get(record.boxId).req.from).toBe("fleetd-taaaaaaaaaaaa");
  expect(boxes.usable()).toEqual(["boat"]);
  await boxes.destroy(record);
}, 60_000);

test("fleetd's computers' start rate sets it aside for a minute, in its own words, not the plan's limit (W8)", () => {
  const boxes = new Boxes(join(root, "rate"), "devbox", { open: (b) => b }, {});
  boxes.setKeys({ boat: Buffer.from(JSON.stringify({ provider: "boat", key: KEY })).toString("base64") });
  const now = Date.parse("2026-11-20T19:20:00Z");
  boxes.setAside("boat", "the limit of fleetd's computers on sandbox starts is reached for now (12 per minute).", now, "rate");
  expect(boxes.usable(now + 30_000)).toEqual([]);
  expect(boxes.usable(now + 61_000)).toEqual(["boat"]);
  const t = boxes.trouble(now)[0]!;
  expect(troubleLine(troubleOf("boat", t))).toBe("fleetd's computers are at their start rate: trying again in a minute");
  // A plan's limit is still set aside for DOWN_MS, with its fix.
  boxes.setAside("boat", "at once", now, "limit");
  expect(boxes.usable(now + 61_000)).toEqual([]);
  expect(boxes.usable(now + DOWN_MS + 1)).toEqual(["boat"]);
  expect(troubleLine(troubleOf("boat", boxes.trouble(now)[0]!))).toContain("plan's limit");
});

test("a box whose guest doesn't take the secret is never reached; the bootstrap refuses fleetd with a wrong checksum", async () => {
  const { boxes } = await world("boat");
  const bad = new Boxes(join(root, "bad"), "devbox", { open: (b) => b }, {
    provider: (p, auth) => boxes.client(p),
    source: () => ({ sha256: "0".repeat(64), bytes: async () => FLEETD }),
  });
  bad.setKeys({ boat: Buffer.from(JSON.stringify({ provider: "boat", key: KEY })).toString("base64") });
  await expect(bad.create("boat", "sess-2", [], [])).rejects.toThrow("SHA-256");
}, 60_000);

test("the reaper deletes this machine's boxes no session holds, and no one else's", async () => {
  const { s, boxes } = await world("boat");
  // The template built ahead at the keys, its build box gone.
  await boxes.template("boat");
  const client = boxes.client("boat");
  await client.create({ template: "t", key: "k-mine", labels: { [MACHINE_LABEL]: "devbox", [SESSION_LABEL]: "gone" }, lifetimeMs: 60_000 });
  const kept = await client.create({ template: "t", key: "k-kept", labels: { [MACHINE_LABEL]: "devbox", [SESSION_LABEL]: "live" }, lifetimeMs: 60_000 });
  const other = await client.create({ template: "t", key: "k-other", labels: { [MACHINE_LABEL]: "laptop", [SESSION_LABEL]: "x" }, lifetimeMs: 60_000 });
  expect(await boxes.reap(() => new Set([kept.id]))).toBe(1);
  expect([...s.boxes.keys()].sort()).toEqual([kept.id, other.id].sort());
});

test("only an x86_64 node makes hosted boxes: an arm64 one says so", () => {
  expect(hostable("x64")).toBe(true);
  expect(hostable("arm64")).toBe(false);
});

test("keys: a provider not sent again is forgotten, on disk too; a key that doesn't open is ignored", async () => {
  const home = join(root, "keys");
  const b = new Boxes(home, "devbox", { open: (x) => (x[0] === 0x7b ? x : null) });
  b.setKeys({ boat: Buffer.from("junk").toString("base64") });
  expect(b.connected()).toEqual([]);
  b.setKeys({ boat: Buffer.from(JSON.stringify({ provider: "boat", key: "k1" })).toString("base64") });
  expect(b.connected()).toEqual(["boat"]);
  expect(existsSync(join(home, "sandbox", "keys", "boat"))).toBe(true);
  // A node that starts again reads them back.
  expect(new Boxes(home, "devbox", { open: (x) => x }).connected()).toEqual(["boat"]);
  // A provider that failed to make a box is offered no more for a while, then again.
  b.setAside("boat", "boat's limit for this team is reached", 1_000);
  expect(b.usable(1_000 + 60_000)).toEqual([]);
  expect(b.usable(1_000 + DOWN_MS)).toEqual(["boat"]);
  b.setKeys({});
  expect(b.connected()).toEqual([]);
  expect(existsSync(join(home, "sandbox", "keys", "boat"))).toBe(false);
});
