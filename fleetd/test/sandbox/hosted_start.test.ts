// A hosted session's start through the node's sessions (src/node/sessions/index.ts) against boat.dev's stand-in, its
// box running here as the provider would run it, with no real claude: the run's progress line follows the start
// (the computer at boat.dev, its template's first build, the repo going in), and a box that came up but where the
// session couldn't start (Claude's endpoint out of its reach) is the `sandbox` class: a lead tries once more after a
// while, a task leaves that to its recovery, and the run's failure is the plain sentence, with no path, no curl output
// and no "could not start <claude>" wrapper (scenario B of the hosted sandboxes sweep).
import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boatStandIn, KEY, localRunner, type StandIn } from "./stand_ins.ts";
import { provider } from "../../src/sandbox/providers/index.ts";
import { Boxes, setBoxes } from "../../src/node/sandbox/remote/boxes.ts";
import { BOX_DIR } from "../../src/node/sandbox/remote/bootstrap.ts";
import { BOX_CLAUDE, hostedProbe } from "../../src/node/place/hosted.ts";
import { LeadRelay } from "../../src/node/lead/index.ts";
import { Masker } from "../../src/node/mask.ts";
import { HOSTED_RETRY, SessionService } from "../../src/node/sessions/index.ts";
import type { NodeFrame } from "../../src/node/wire.ts";

setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../src/main.ts");
const tmp = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-hosted-start-"));
const FLEETD = new TextEncoder().encode(`#!/bin/sh\nexec ${process.execPath} ${MAIN} "$@"\n`);
const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
/** Says it started, then runs until its stdin closes. */
const CLAUDE = `#!/bin/sh
echo '{"type":"system","subtype":"init","claude_code_version":"2.1.302","model":"m1","cwd":"/fake"}'
exec cat > /dev/null
`;
/** The hub's Claude account's endpoint: on a private network, which a box reaches only on the team's tailnet. */
const ENDPOINT = "http://10.0.0.5:8317";

const retryBefore = HOSTED_RETRY.ms;
let cleanup = async () => {};
afterEach(async () => {
  await cleanup();
  cleanup = async () => {};
});
afterAll(() => {
  HOSTED_RETRY.ms = retryBefore;
  delete hostedProbe.probe;
  setBoxes(undefined);
  rmSync(tmp, { recursive: true, force: true });
});

function sh(cwd: string, cmd: string): string {
  const r = Bun.spawnSync(["sh", "-c", cmd], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@devbox.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@devbox.test" } });
  if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const until = async <T>(what: string, fn: () => T | undefined, ms = 45_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const got = fn();
    if (got !== undefined && got !== false) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};

/** A node of its own with boat.dev's stand-in for its boxes, a repo, and the box's Claude check `probe`. */
async function node(probe: (url: string) => Promise<void>) {
  const base = mkdtempSync(join(tmp, "t-"));
  const home = join(base, "node");
  const HOME = join(base, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  const claude = join(base, "claude");
  writeFileSync(claude, CLAUDE);
  chmodSync(claude, 0o755);
  BOX_CLAUDE.path = claude;
  hostedProbe.probe = async (_box, url) => {
    try {
      await probe(url);
    } catch (error) {
      // A stand-in box shares this machine's paths: the socket its start made here goes with it, as a real box's would.
      rmSync(join(home, "node.sock"), { force: true });
      throw error;
    }
  };
  const repo = join(base, "repo");
  sh(base, `git init -q -b main ${repo} && cd ${repo} && echo a > a.txt && git add -A && git commit -qm one`);
  const local = localRunner(join(base, "boxes"), BOX_DIR);
  const s: StandIn = boatStandIn(local.runner);
  local.track(s);
  const boxes = new Boxes(home, "devbox", { open: (b) => b }, {
    provider: (p, auth) => provider(p, auth, { urls: { api: `${s.url}/api/v1`, sandbox: (box, port) => `${s.url}/box/${box}/${port}` }, pollMs: 5 }),
    source: () => ({ sha256: sha(FLEETD), bytes: async () => FLEETD }),
  });
  boxes.setKeys({ boat: Buffer.from(JSON.stringify({ provider: "boat", key: KEY })).toString("base64") });
  boxes.wire({ lead: { relay: new LeadRelay(), identify: () => ({ kind: "none" }) as never, maskFor: () => new Masker([]) } });
  setBoxes(boxes);
  const service = await SessionService.start({
    home,
    claudeEnv: join(base, "claude.env"),
    // On a Claude account (the machine's own login never goes to a box), whose endpoint the box must reach.
    baseEnv: { HOME, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, BUN_BIN: process.execPath, ANTHROPIC_AUTH_TOKEN: "tok-x", ANTHROPIC_BASE_URL: ENDPOINT },
    claudeBin: "/bin/true",
    // A stand-in box shares this machine's paths, and links the fleetd a box was given at this one's path: one of the
    // test's own, never a file of the repo's.
    fleetd: [join(base, "fleetd")],
    retryScheduleMs: [50, 50, 50],
    idleReapMs: 60_000,
  });
  const frames: NodeFrame[] = [];
  service.attach((f) => frames.push(f));
  cleanup = async () => {
    await service.stopAll();
    s.stop();
    await local.cleanup();
  };
  let n = 0;
  const go = async (op: string, args: Record<string, unknown>) => {
    const reply = await service.handle({ id: `h${++n}`, call: { op, ...args } as never });
    if (!("ok" in reply.result)) throw new Error(`${op}: ${JSON.stringify(reply.result)}`);
  };
  await go("project_upsert", { projectId: "p1", title: "demo", workspaceRoot: repo });
  type Item = { type?: string; id?: string; status?: string; kind?: { type?: string; text?: string } };
  /** Every word the run's progress line said, in order (the follow's snapshot, then each change), and how it ended. */
  const progress = (runId: string) => {
    const said: string[] = [];
    let ended: string | undefined;
    for (const f of frames) {
      if (f.t !== "thread_event") continue;
      const ev = (f as { event?: Item & { items?: Item[] } }).event;
      for (const e of ev?.type === "snapshot" ? (ev.items ?? []).map((i) => ({ ...i, type: "item" })) : [ev]) {
        if (e?.type !== "item" || e.id !== `starting-${runId}` || e.kind?.type !== "starting") continue;
        if (said.at(-1) !== e.kind.text) said.push(e.kind.text!);
        if (e.status !== "running") ended = e.status;
      }
    }
    return { said, ended };
  };
  const launch = async (session: string, runId: string, role: "lead" | "worker") => {
    await go("launch", { sessionId: session, projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "hello", runId, role, place: "boat" });
    await go("follow", { sessionId: session });
  };
  const failed = (session: string, runId: string) => until(`${runId} to fail`, () => service.store.runs(session).find((r) => r.id === runId && r.status === "failed"));
  return { service, s, launch, failed, progress };
}

const PLAIN =
  "a boat.dev sandbox couldn't reach the hub's Claude account at 10.0.0.5: it is on a private network, which hosted sandboxes reach only on the team's tailnet. Connect Tailscale in Settings › Hub › Machines";

test("a lead whose box can't reach Claude tries once more after a while, then fails as `sandbox` in plain words", async () => {
  HOSTED_RETRY.ms = 200;
  const probed: string[] = [];
  const { s, launch, failed, progress } = await node(async (url) => {
    probed.push(url);
    throw new Error(`the box can't reach Claude at 10.0.0.5:8317: curl: (28) Connection timed out after 10001 milliseconds`);
  });
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => void warned.push(String(m));
  try {
    await launch("s-lead", "r1", "lead");
    const run = await failed("s-lead", "r1");
    // Twice, each in a box of its own, both gone.
    expect(probed).toEqual([ENDPOINT, ENDPOINT]);
    expect(s.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/sandboxes" && !String(c.body?.name ?? "").startsWith("fleetd build")).length).toBe(2);
    await until("the boxes to go", () => s.boxes.size === 0);
    expect(run.failure?.class).toBe("sandbox");
    expect(run.failure?.message).toBe(PLAIN);
    // Nothing a person can't read: no path, no curl, no wrapper around this machine's claude.
    for (const bad of ["/", "curl", "could not start", "cwd", "settings.json", "(28)"]) expect(run.failure?.message).not.toContain(bad);
    // The log keeps the detail.
    expect(warned.some((w) => w.includes("a hosted box can't reach Claude") && w.includes("curl: (28)"))).toBe(true);
    expect(warned.some((w) => w.includes("tried once more"))).toBe(true);
    // The run's progress line: the computer at boat.dev (its template built the first time), the repo, then again.
    const p = progress("r1");
    expect(p.said).toEqual([
      "Starting its computer at boat.dev",
      "Starting its computer at boat.dev (first time: a few minutes)",
      "Cloning the repo",
      "Starting its computer at boat.dev again",
      "Starting its computer at boat.dev",
      "Cloning the repo",
    ]);
    expect(p.ended).toBe("failed");
  } finally {
    console.warn = warn;
  }
});

test("a lead whose first try fails starts on its second; the progress line ends once claude runs in the box", async () => {
  HOSTED_RETRY.ms = 50;
  let tries = 0;
  const { service, launch, progress } = await node(async () => {
    if (++tries === 1) throw new Error("the box can't reach Claude at 10.0.0.5:8317: curl: (7) Failed to connect");
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await launch("s-lead2", "r1", "lead");
    await until("the progress line to end", () => progress("r1").ended);
    expect(progress("r1").ended).toBe("completed");
    expect(tries).toBe(2);
    // The template was built by then, and the second box needed no build.
    expect(progress("r1").said.filter((w) => w.includes("first time"))).toHaveLength(1);
    expect(service.store.runs("s-lead2").find((r) => r.id === "r1")?.status).not.toBe("failed");
  } finally {
    console.warn = warn;
  }
});

test("a task's start that can't reach Claude fails at once as `sandbox`: its recovery is the one retry", async () => {
  HOSTED_RETRY.ms = 60_000;
  let tries = 0;
  const { launch, failed } = await node(async () => {
    tries++;
    throw new Error("the box can't reach Claude at 10.0.0.5:8317: curl: (28) Connection timed out");
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await launch("s-task", "r1", "worker");
    const run = await failed("s-task", "r1");
    expect(tries).toBe(1);
    expect(run.failure?.class).toBe("sandbox");
    expect(run.failure?.message).toBe(PLAIN);
  } finally {
    console.warn = warn;
  }
});
