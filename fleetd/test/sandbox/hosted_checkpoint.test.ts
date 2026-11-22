// A hosted box hands its work back after every turn (src/node/place/hosted.ts `checkpoint`), against boat.dev's stand-in
// server with its box running here. Unlike hosted_place.test.ts's box, this one keeps its own copy of the worktree,
// the repo and HOME (under a root of its own, as a real box has them on its own disk), so a box that dies really
// loses what only it held:
// - a box that dies mid-task: the commit and transcript of its last finished turn are on the machine, what came after
//   is lost, and the session hears that its sandbox stopped and since when its work was lost;
// - a keep-alive that fails: it is reported, and the session ends with its work brought back before the box's time
//   runs out;
// - the key disconnected with a box live: the session ends with its work brought back, then the key goes;
// - work that doesn't come back after a turn is said to the lead once; a box whose work doesn't come back as it ends
//   is kept, tried again, and deleted once its work is here, or given up (the lead told) after its time or as a new
//   box starts for the session (which first tries to bring its work back).
import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boatStandIn, KEY, localRunner, type StandIn } from "./stand_ins.ts";
import { provider } from "../../src/sandbox/providers/index.ts";
import { Boxes, LIFETIME_MS, setBoxes } from "../../src/node/sandbox/remote/boxes.ts";
import { BOX_DIR } from "../../src/node/sandbox/remote/bootstrap.ts";
import { BOX_CLAUDE, boxEnd, boxWork, type BoxWork, checkpoint, hasBox, hostedBox, hostedPlace, hostedProbe, KEEP_ALIVE, KEPT, keptBoxes, readRecord, retryKept, settleKept, teardown } from "../../src/node/place/hosted.ts";
import { configDir, sessionFile } from "../../src/node/runner/claude.ts";
import { Sandboxes } from "../../src/node/sandbox/hosted.ts";
import { causeMessage } from "../../src/node/sessions/state.ts";
import { LeadRelay } from "../../src/node/lead/index.ts";
import { Masker } from "../../src/node/mask.ts";
import type { Box } from "../../src/node/sandbox/box.ts";
import type { RunnerEvent } from "../../src/node/runner/host.ts";

const MAIN = join(import.meta.dir, "../../src/main.ts");
const tmp = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-hosted-checkpoint-"));
const keepAliveBefore = { ...KEEP_ALIVE };
const keptBefore = { ...KEPT };
// Every world a test started goes after it, not only its last: a test that starts a second one left the first's guest
// running, and its stand-in.
const servers: StandIn[] = [];
const cleanups: (() => Promise<void>)[] = [];
/** The last world's boxes, which a test ends itself. */
let cleanup = async () => {};
afterEach(async () => {
  Object.assign(KEEP_ALIVE, keepAliveBefore);
  Object.assign(KEPT, keptBefore);
  delete boxWork.said;
  for (const s of servers.splice(0)) s.stop();
  for (const c of cleanups.splice(0)) await c();
});
afterAll(() => {
  setBoxes(undefined);
  delete hostedProbe.probe;
  rmSync(tmp, { recursive: true, force: true });
});

const FLEETD = new TextEncoder().encode(`#!/bin/sh\nexec ${process.execPath} ${MAIN} "$@"\n`);
const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@devbox.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@devbox.test" };

function sh(cwd: string, cmd: string): string {
  const r = Bun.spawnSync(["sh", "-c", cmd], { cwd, env: { ...process.env, ...GIT_ENV } });
  if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The box `b` with `prefixes` of this machine's paths at `root` + the same path: what the node asks of it goes there,
 * and what it answers names them as the node does. */
function ownDisk(b: Box, root: string, prefixes: string[]): Box {
  const there = new RegExp(`(${prefixes.map(esc).join("|")})(?![A-Za-z0-9_-])`, "g");
  const back = new RegExp(`${esc(root)}(${prefixes.map(esc).join("|")})(?![A-Za-z0-9_-])`, "g");
  const to = (s: string) => s.replace(there, `${root}$1`);
  const from = (s: string) => s.replace(back, "$1");
  const env = (e: Record<string, string | undefined> = {}) => Object.fromEntries(Object.entries(e).flatMap(([k, v]) => (v === undefined ? [] : [[k, to(v)]]))) as Record<string, string>;
  return new Proxy(b, {
    get(t, k) {
      if (k === "run")
        return async (r: Parameters<Box["run"]>[0]) => {
          const out = await t.run({ ...r, argv: r.argv.map(to), cwd: to(r.cwd), env: env(r.env) });
          return { ...out, outputTail: from(out.outputTail) };
        };
      if (k === "write") return (path: string, bytes: Uint8Array, mode?: number) => t.write(to(path), bytes, mode);
      if (k === "read") return (path: string, max: number, at?: number) => t.read(to(path), max, at);
      if (k === "start") return (l: Parameters<Box["start"]>[0]) => t.start({ ...l, cwd: to(l.cwd), env: env(l.env) });
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

/** Lines of the machine's transcript. */
const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : []);

async function until<T>(what: string, f: () => T | undefined | false | Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** A node, a repo and a worktree, and a session `id` started in a box of the stand-in's with a disk of its own, whose
 * claude finishes its first turn as it starts: a commit, and a line of its transcript. */
async function started(id: string, before: (s: StandIn) => void = () => {}) {
  const base = mkdtempSync(join(tmp, "t-"));
  const home = join(base, "node");
  const HOME = join(base, "home");
  const root = join(base, "box-disk");
  mkdirSync(home, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  const repo = join(base, "repo");
  sh(base, `git init -q -b main ${repo} && cd ${repo} && echo a > a.txt && git add -A && git commit -qm one`);
  const cwd = join(home, "worktrees", "T1");
  sh(repo, `git worktree add -q -b fleetd/T1 ${cwd}`);
  const env = { HOME, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, FLEETD_NODE_SOCK: join(home, "node.sock"), TMPDIR: join(home, "tmp", id), ...GIT_ENV };
  // The transcript the session resumes from, here and in the box, long enough that a turn brings back only what it added.
  const transcript = sessionFile(configDir(env), cwd, id)!;
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, `${JSON.stringify({ turn: "zero", pad: "x".repeat(6000) })}\n`);
  const claude = join(base, "claude");
  writeFileSync(
    claude,
    `#!/bin/sh
echo one > one.txt && git add one.txt && git commit -qm 'turn one'
printf '%s\\n' '{"turn":"one"}' >> ${q(root + transcript)}
echo '{"type":"system","subtype":"init","claude_code_version":"2.1.302","model":"m1","cwd":"/fake"}'
exec cat > /dev/null
`,
  );
  chmodSync(claude, 0o755);
  BOX_CLAUDE.path = claude;
  hostedProbe.probe = async () => {};
  const local = localRunner(join(base, "boxes"), BOX_DIR);
  const s = boatStandIn(local.runner);
  servers.push(s);
  local.track(s);
  cleanups.push(local.cleanup);
  cleanup = local.cleanup;
  const boxes = new Boxes(home, "devbox", { open: (b) => b }, {
    provider: (p, auth) => provider(p, auth, { urls: { api: `${s.url}/api/v1`, sandbox: (box, port) => `${s.url}/box/${box}/${port}` }, pollMs: 5 }),
    source: () => ({ sha256: sha(FLEETD), bytes: async () => FLEETD }),
  });
  boxes.setKeys({ boat: Buffer.from(JSON.stringify({ provider: "boat", key: KEY })).toString("base64") });
  boxes.wire({ lead: { relay: new LeadRelay(), identify: () => ({ kind: "none" }) as never, maskFor: () => new Masker([]) } });
  const open = boxes.open.bind(boxes);
  boxes.open = async (r, session) => ownDisk(await open(r, session), root, [repo, cwd, HOME]);
  setBoxes(boxes);
  before(s);
  const dir = join(home, "hosts", id);
  const link = await hostedPlace("boat", id, dir).start({ fleetd: [], dir, sessionId: id, program: "claude", args: [], cwd, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "tok-123" } });
  // Its first turn is done once claude says it started.
  const first = await Promise.race([link.next(), Bun.sleep(15_000).then(() => "timed out")]);
  expect(JSON.stringify(first as RunnerEvent)).toContain("m1");
  return { s, boxes, home, cwd, root, dir, env, transcript, link };
}

const log = (cwd: string) => sh(cwd, "git log --format=%s");

test("a box that dies mid-task leaves the commit and transcript of its last finished turn on the machine, and says its sandbox stopped and since when", async () => {
  const { s, cwd, root, dir, env, transcript } = await started("s-lost");
  // The box has its own disk: its first turn's commit is there, not here.
  expect(log(root + cwd)).toBe("turn one\none");
  // The turn ended: the session hands the box's work back, as the node does at each turn's end.
  await checkpoint("s-lost");
  expect(log(cwd)).toBe("turn one\none");
  expect(readFileSync(join(cwd, "one.txt"), "utf8")).toBe("one\n");
  expect(lines(transcript).map((l) => JSON.parse(l).turn)).toEqual(["zero", "one"]);
  const since = readRecord(dir)!.since!;
  expect(since).toMatch(/^\d{4}-\d\d-\d\dT/);

  // Its next turn: a commit and some uncommitted work, and its transcript goes on. Then the box dies mid-turn.
  const box = hostedBox("s-lost")!;
  const turn = await box.run({ argv: ["sh", "-c", `echo two > two.txt && git add two.txt && git commit -qm 'turn two' && echo wip > wip.txt && printf '%s\\n' '{"turn":"two"}' >> ${q(transcript)}`], cwd, env, timeoutSec: 30 });
  expect(turn.exitCode).toBe(0);
  await cleanup();
  // Its guest is gone for good (here without waiting out the redials).
  box.close();
  await teardown("s-lost", dir);

  // On the machine: the last finished turn's work and transcript, and nothing of the turn under way.
  expect(log(cwd)).toBe("turn one\none");
  expect(existsSync(join(cwd, "two.txt"))).toBe(false);
  expect(existsSync(join(cwd, "wip.txt"))).toBe(false);
  expect(lines(transcript).map((l) => JSON.parse(l).turn)).toEqual(["zero", "one"]);
  // The box is deleted, and the session hears what happened in plain words, once.
  expect(s.boxes.size).toBe(0);
  expect(hasBox("s-lost")).toBe(false);
  const why = boxEnd("s-lost")!;
  expect(why).toBe(`its sandbox stopped (boat.dev), so its work since ${since.slice(11, 16)} UTC was lost; it goes on from its work as of then`);
  expect(boxEnd("s-lost")).toBeUndefined();
  // That is the run's failure, as the task's recovery line reads it.
  expect(causeMessage({ kind: "exited", exit: { code: null, signal: null, stderr_tail: why, why } })).toBe(why);
}, 90_000);

test("a keep-alive that fails is reported, and the session ends with its work brought back before the box's time runs out", async () => {
  const reports: { provider: string; error?: string }[] = [];
  // boat.dev refuses the key when the box's life is extended, a few seconds after it started (its first turn done by
  // then); and the box has less left than a session's end needs.
  const { boxes, s, cwd, root, dir } = await started("s-kept", (s) => {
    s.fail({ path: /^PATCH \/api\/v1\/sandboxes\//, status: 401, body: { code: 401, message: "authorization header is missing or invalid" }, times: 100 });
    Object.assign(KEEP_ALIVE, { everyMs: 3000, retryMs: 50, endBeforeMs: LIFETIME_MS });
  });
  (boxes as unknown as { keptAlive(p: string, e?: unknown): void }).keptAlive = (p, e) => reports.push({ provider: p, ...(e ? { error: (e as Error).message } : {}) });
  expect(log(root + cwd)).toBe("turn one\none");
  expect(hasBox("s-kept")).toBe(true);
  await until("the session to end", () => !hasBox("s-kept") && s.boxes.size === 0);
  await teardown("s-kept", dir);
  expect(reports[0]).toMatchObject({ provider: "boat" });
  expect(reports[0]!.error).toContain("refused the key");
  // Its work came back, and it hears why in plain words.
  expect(log(cwd)).toBe("turn one\none");
  expect(boxEnd("s-kept")).toBe("its sandbox at boat.dev couldn't be kept running (boat.dev refused the team's key), so it was ended with its work saved before its time ran out");
}, 90_000);

test("disconnecting the key with a box live ends its session with its work brought back, then drops the key", async () => {
  const { s, boxes, cwd, root, dir, env } = await started("s-key");
  const sandboxes = new Sandboxes({ open: (b) => b }, undefined, boxes);
  const box = hostedBox("s-key")!;
  expect((await box.run({ argv: ["sh", "-c", "echo late > late.txt"], cwd, env, timeoutSec: 30 })).exitCode).toBe(0);
  expect(existsSync(join(root + cwd, "late.txt"))).toBe(true);
  // The hub sends the limits with no boat.dev key: the node answers at once and keeps the key until its box is gone.
  expect(sandboxes.setLimits({ id: "a1", action: "sandbox_limits", limits: [], keys: {} } as never)).toMatchObject({ ok: true });
  expect(boxes.connected()).toEqual(["boat"]);
  await until("the key to go", () => boxes.connected().length === 0);
  await teardown("s-key", dir);
  expect(s.boxes.size).toBe(0);
  expect(log(cwd)).toBe("turn one\none");
  expect(readFileSync(join(cwd, "late.txt"), "utf8")).toBe("late\n");
  expect(boxEnd("s-key")).toBe("the team's boat.dev key was disconnected, so its sandbox was ended with its work saved");
}, 90_000);

/** Something else holds the machine's index of `cwd`: git can't set its worktree, so a bring-back fails. */
function lockIndex(cwd: string): () => void {
  const lock = join(sh(cwd, "git rev-parse --absolute-git-dir"), "index.lock");
  writeFileSync(lock, "");
  return () => rmSync(lock, { force: true });
}

test("work that doesn't come back is said once; a box whose work didn't come back as it ended is kept, and deleted once its work is here", async () => {
  const said: BoxWork[] = [];
  boxWork.said = (e) => void said.push(e);
  const { s, home, cwd, root, dir, env } = await started("s-back");
  const unlock = lockIndex(cwd);
  await checkpoint("s-back");
  const box = hostedBox("s-back")!;
  expect((await box.run({ argv: ["sh", "-c", "echo two > two.txt && git add two.txt && git commit -qm 'turn two'"], cwd, env, timeoutSec: 30 })).exitCode).toBe(0);
  await checkpoint("s-back");
  // Two turns whose work didn't come back: the lead hears it once.
  expect(said.map((e) => e.state)).toEqual(["not_back"]);
  expect(said[0]!.text).toStartWith("its sandbox's work since ");
  expect(said[0]!.text).toContain("didn't come back to the machine after its turn");
  expect(log(cwd)).toBe("one");

  // The session ends with its work still not back: its box is kept, not deleted with the only copy of that work.
  await teardown("s-back", dir);
  expect(s.boxes.size).toBe(1);
  expect(readRecord(dir)).toBeUndefined();
  expect(said.map((e) => e.state)).toEqual(["not_back", "kept"]);
  expect(said[1]!.text).toContain("so the sandbox is kept and fleetd tries again every 10 minutes until");
  expect(said[1]!.untilMs).toBeGreaterThan(Date.now());
  // The node's sweep of leftover boxes leaves it alone.
  expect(keptBoxes(home).size).toBe(1);
  // Tried again at the node's sweep while git still can't: kept.
  await retryKept(home);
  expect(s.boxes.size).toBe(1);
  expect(said.length).toBe(2);
  // Once it can, the work is here and only then the box goes.
  unlock();
  await retryKept(home);
  expect(log(cwd)).toBe("turn two\nturn one\none");
  expect(log(root + cwd)).toBe("turn two\nturn one\none");
  expect(s.boxes.size).toBe(0);
  expect(keptBoxes(home).size).toBe(0);
  expect(said.length).toBe(2);
}, 90_000);

test("a kept box is given up after its time, or as a new box for the session starts, and the lead is told", async () => {
  const said: BoxWork[] = [];
  boxWork.said = (e) => void said.push(e);
  const { s, home, cwd, dir, env } = await started("s-gone");
  const unlock = lockIndex(cwd);
  KEPT.forMs = 0;
  await teardown("s-gone", dir);
  expect(s.boxes.size).toBe(1);
  await retryKept(home);
  expect(s.boxes.size).toBe(0);
  expect(keptBoxes(home).size).toBe(0);
  expect(said.map((e) => e.state)).toEqual(["kept", "given_up"]);
  expect(said[1]!.text).toContain("never came back to the machine");
  expect(said[1]!.text).toContain("so fleetd gave it up and deleted the sandbox");

  // Kept again, then a new box for the session is starting (`ensure` settles first): the kept one's work comes back
  // before the new box starts from the machine's worktree, or, where it still can't, the kept box is given up.
  KEPT.forMs = 60 * 60_000;
  const { home: home2, cwd: cwd2, dir: dir2, s: s2, env: env2 } = await started("s-new");
  const box2 = hostedBox("s-new")!;
  expect((await box2.run({ argv: ["sh", "-c", "echo late > late.txt"], cwd: cwd2, env: env2, timeoutSec: 30 })).exitCode).toBe(0);
  const unlock2 = lockIndex(cwd2);
  await teardown("s-new", dir2);
  expect(said.at(-1)!.state).toBe("kept");
  await settleKept(home2, "s-new");
  expect(said.at(-1)!.state).toBe("given_up");
  expect(said.at(-1)!.text).toContain("a new sandbox started from the machine's work");
  expect(keptBoxes(home2).size).toBe(0);
  expect(s2.boxes.size).toBe(0);
  unlock2();
  unlock();
}, 120_000);

test("a new box settles a kept box only after an old node's record is torn down, so old work never lands later", async () => {
  const said: BoxWork[] = [];
  boxWork.said = (e) => void said.push(e);
  const { s, home, cwd, dir, env } = await started("s-order");
  const unlock = lockIndex(cwd);
  // A node before this one left the box's record and no live box: the record's teardown keeps it (its work won't come
  // back), and only then is the session's kept box settled, before its new box starts.
  const record = readRecord(dir)!;
  await teardown("s-order", dir);
  rmSync(join(home, "sandbox", "kept", "s-order.json"));
  writeFileSync(join(dir, "place.json"), JSON.stringify(record));
  const ran = await hostedPlace("boat", "s-order", dir).run({ cwd, argv: ["true"], timeoutSec: 30, env, scrub: [] });
  // (The new box can't take the worktree while git is locked: what matters is what happened to the old one first.)
  expect(ran.exitCode).toBeNull();
  expect(keptBoxes(home).size).toBe(0);
  expect([...s.boxes.keys()]).not.toContain(record.boxId);
  expect(said.filter((e) => e.state === "given_up").at(-1)!.text).toContain("a new sandbox started from the machine's work");
  unlock();
}, 120_000);

test("a settle waits for the kept box's retry under way, then makes its own last try", async () => {
  const said: BoxWork[] = [];
  boxWork.said = (e) => void said.push(e);
  const { s, home, cwd, dir } = await started("s-race");
  const unlock = lockIndex(cwd);
  await teardown("s-race", dir);
  expect(keptBoxes(home).size).toBe(1);
  // The node's sweep tries it again, and a new box's start settles it, at once.
  await Promise.all([retryKept(home), settleKept(home, "s-race")]);
  expect(keptBoxes(home).size).toBe(0);
  expect(s.boxes.size).toBe(0);
  expect(said.map((e) => e.state)).toEqual(["kept", "given_up"]);
  unlock();
}, 120_000);
