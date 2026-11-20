// A hub with no computer connected runs a bot's agent (D558): the team connects its own boat.dev key and the hub's Claude
// API key, nothing else. The hub starts its own runner (hub/runner), a fleetd node that joins it over the hub's own
// address and runs every agent in a box of the team's provider; a bot cloned there gets a writer, which runs in a boat.dev
// box (the stand-in's, its box running here as the provider would run it) to a result, pushes its branch and opens a
// PR. No real claude (the factory lab's offline stand-in), no network, and the hub's clock is the test's.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hub } from "../../src/hub/api/hub.ts";
import { type Caller, Registry } from "../../src/hub/api/registry.ts";
import { serve, stop } from "../../src/hub/http/index.ts";
import { doctor } from "../../src/hub/doctor/index.ts";
import { boxKey } from "../../src/hub/hub_links/store.ts";
import { leadCalls } from "../../src/hub/lead_calls/index.ts";
import { leads } from "../../src/hub/leads/index.ts";
import { dialUrl, Runner, runner, type Spawn } from "../../src/hub/runner/index.ts";
import { registerAll } from "../../src/hub/serve/areas.ts";
import { startAll } from "../../src/hub/serve/loops.ts";
import { slots } from "../../src/hub/slots/index.ts";
import { HubDb } from "../../src/hub/store/db.ts";
import { store } from "../../src/hub/store/hub_store.ts";
import { readConfig, writeConfig } from "../../src/node/config.ts";
import { joinConfig, startNode, type RunningNode } from "../../src/node/index.ts";
import { BOX_CLAUDE, hostedProbe } from "../../src/node/place/hosted.ts";
import { useRunner } from "../../src/node/place/index.ts";
import { BOX_DIR } from "../../src/node/sandbox/remote/bootstrap.ts";
import { Boxes, setBoxes } from "../../src/node/sandbox/remote/boxes.ts";
import { provider } from "../../src/sandbox/providers/index.ts";
import { RUNNER_ID } from "../../src/shared/sandbox.ts";
import { publicKeyOf, seal } from "../../src/shared/sealed_box.ts";
import { seedHubDb } from "../helpers.ts";
import { boatStandIn, KEY, localRunner } from "./stand_ins.ts";

setDefaultTimeout(180_000);

const MAIN = join(import.meta.dir, "../../src/main.ts");
const FAKE_CLAUDE = join(import.meta.dir, "../../../tests/lab/factory/fakeClaude.ts");
const tmp = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-no-machine-"));
// Nothing here may reach the person's own fleet, home or git config: sessions take HOME from the node's environment.
// Put back at the end, with the stand-ins below: the next test file in this process sees its own.
const ENV = { FLEETD_HOME: join(tmp, "fleetd"), HOME: join(tmp, "home"), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@devbox.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@devbox.test" };
const before = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
Object.assign(process.env, ENV);
mkdirSync(ENV.HOME, { recursive: true });
const claudeBefore = BOX_CLAUDE.path;

const cleanups: (() => unknown)[] = [];
afterAll(async () => {
  for (const f of cleanups.reverse()) await f();
  for (const [k, v] of Object.entries(before)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  BOX_CLAUDE.path = claudeBefore;
  delete hostedProbe.probe;
  rmSync(tmp, { recursive: true, force: true });
});

function sh(cwd: string, cmd: string): string {
  const r = Bun.spawnSync(["sh", "-c", cmd], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function script(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

async function until<T>(what: string, f: () => T | undefined | Promise<T | undefined>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

test("with no computer connected, a provider's key and a Claude account run a bot's writer in a hosted box to a result and a PR", async () => {
  // The provider: boat.dev's stand-in, each box run here.
  const local = localRunner(join(tmp, "boxes"), BOX_DIR);
  const boat = boatStandIn(local.runner);
  local.track(boat);
  cleanups.push(() => boat.stop(), () => local.cleanup());
  const fleetdScript = new TextEncoder().encode(`#!/bin/sh\nexec ${process.execPath} ${MAIN} "$@"\n`);
  const sha = new Bun.CryptoHasher("sha256").update(fleetdScript).digest("hex");
  // Claude in the box: the offline stand-in, which runs a message's `lab-run:` lines and answers with the reply set.
  const lab = join(tmp, "lab");
  mkdirSync(lab, { recursive: true });
  writeFileSync(join(lab, "replies.json"), JSON.stringify([["say hello", "Done: said hello and opened https://github.com/acme/demo/pull/1"]]));
  BOX_CLAUDE.path = script(join(tmp, "claude"), `FLEETD_LAB_DIR=${lab} exec ${process.execPath} ${FAKE_CLAUDE} "$@"\n`);
  // A stand-in box has no curl of a box's: its check of Claude is the test's.
  hostedProbe.probe = async () => {};
  // GitHub, as far as a PR goes: gh records the PR it was asked for.
  const prs = join(tmp, "prs.txt");
  const gh = script(join(tmp, "gh"), `echo "$PWD $(git rev-parse --abbrev-ref HEAD) $*" >> ${prs}\necho https://github.com/acme/demo/pull/1\n`);

  // The hub, on a clock of the test's own that moves on with real time.
  const home = join(tmp, "hub");
  seedHubDb(home);
  const t0 = performance.now();
  const clock = { now: () => Date.parse("2026-11-08T12:00:00.000Z") + Math.round(performance.now() - t0) };
  const hub = new Hub({ home, listen: { host: "127.0.0.1", port: 0 } }, HubDb.open(home), clock);
  const tools = new Registry();
  registerAll(tools);
  // The runner's node, in this process: what `fleetd node join --runner` and `node run` start, with boat.dev's stand-in.
  let node: RunningNode | undefined;
  let url = "";
  const spawn: Spawn = (args, stdin) => {
    const at = args.indexOf("--home");
    const nodeHome = args[at + 1]!;
    const joining = args[1] === "join";
    const config = joining ? joinConfig(nodeHome, { hub: url, token: stdin!, machine: RUNNER_ID, runner: true }) : readConfig(nodeHome)!;
    if (joining) writeConfig(nodeHome, config);
    const started = startNode(nodeHome, config, joining ? stdin : undefined, false, {
      boxes: (h, m, k) =>
        new Boxes(h, m, k, {
          provider: (p, auth) => provider(p, auth, { urls: { api: `${boat.url}/api/v1`, sandbox: (box, port) => `${boat.url}/box/${box}/${port}` }, pollMs: 5 }),
          source: () => ({ sha256: sha, bytes: async () => fleetdScript }),
        }),
    }).then((n) => {
      // A stand-in box shares this machine's paths, and its guest answers the agent's node.sock at the node's own path
      // (a real box has its own): the node's file makes way, as hosted_place.test.ts's does.
      rmSync(join(nodeHome, "node.sock"), { force: true });
      return (node = n);
    });
    return {
      exited: started.then((n) => n.done),
      kill: () => void started.then((n) => n.stop()),
    };
  };
  hub.area("runner", (h) => new Runner(h, spawn, undefined));
  const server = serve(hub, tools, 0);
  url = dialUrl("127.0.0.1", server.port!);
  cleanups.push(async () => {
    hub.shutdown.abort();
    await node?.stop();
    useRunner(undefined);
    setBoxes(undefined);
    await stop(server);
    hub.db.close();
  });
  doctor(hub).runCmd = async () => ({ ran: false, error: "ENOENT" });
  doctor(hub).health = async () => ({ ok: true }) as never;
  startAll(hub);
  runner(hub).start(url);
  // No machine at all, and no runner while nothing hosted is connected.
  expect(store(hub).machinesList()).toEqual([]);
  expect(runner(hub).running).toBe(false);

  const ownerId = "p_aaaaaaaa";
  hub.db.conn.query("INSERT INTO people (person_id, name, role, created_ms) VALUES (?, 'Owner', 'owner', 0)").run(ownerId);
  const owner: Caller = {
    keyId: "k_owner",
    name: "owner-desk",
    prefix: "fld_x",
    grants: [{ role: "admin", machines: "*" }],
    createdAt: new Date(clock.now()).toISOString(),
    kind: "human",
    person: { personId: ownerId, name: "Owner" },
  };
  const call = async (tool: string, input: Record<string, unknown>): Promise<any> => {
    const r = await tools.call(hub, owner, tool, input);
    if ("output" in r) return r.output;
    throw new Error(`${tool}: ${r.error.kind === "tool" ? `${r.error.error.message} ${r.error.error.fix ?? ""}` : r.error.kind}`);
  };

  // 1. Where agents run: the team's own boat.dev key. The hub starts its runner, which joins and checks the key.
  const sealedKey = Buffer.from(seal(publicKeyOf(boxKey(hub)), new TextEncoder().encode(JSON.stringify({ key: KEY })))).toString("base64");
  const connected = await call("sandbox_connect", { provider: "boat", sealed: sealedKey, limit: 2 });
  expect(connected.providers.find((p: { provider: string }) => p.provider === "boat").check).toMatchObject({ ok: true });
  expect(runner(hub).running).toBe(true);
  const machine = store(hub).machineGet(RUNNER_ID)!;
  expect(machine).toMatchObject({ machineId: RUNNER_ID, name: "Hosted sandboxes", runner: true });

  // 2. Claude: the hub's API key, sealed to the runner as the app seals it to every machine.
  const claudeKey = Buffer.from(seal(Buffer.from(machine.boxPubKey!, "base64"), new TextEncoder().encode("sk-ant-test-0123456789"))).toString("base64");
  await call("claude_hub_api_set", { sealed: [{ machineId: RUNNER_ID, sealed: claudeKey }], endpoint: "https://160.79.104.10" });
  await until("the runner on the hub's Claude account", () => store(hub).machineGet(RUNNER_ID)?.status === "online");

  // 3. A bot: its repo cloned into the runner's home (origin here stands for GitHub).
  const origin = join(tmp, "origin.git");
  sh(tmp, `git init -q --bare -b main ${origin}`);
  const seed = join(tmp, "seed");
  sh(tmp, `git clone -q ${origin} ${seed} && cd ${seed} && echo demo > README.md && git add -A && git commit -qm init && git push -q origin main`);
  const checkout = join(runner(hub).home, "src", "demo");
  sh(tmp, `git clone -q ${origin} ${checkout}`);
  // This is about the writer's box: the stand-in's boxes share this machine's paths, so the new bot's lead isn't also
  // started ahead in one of its own (chat-flow.test.ts and sessions.test.ts cover that start).
  leads(hub).startAhead = async () => {};
  const added = await call("project_add", { machineId: RUNNER_ID, path: checkout, title: "demo" });
  expect(added.machineId ?? RUNNER_ID).toBe(RUNNER_ID);

  // 4. Its lead's order, and a writer.
  const lead = async (c: Record<string, unknown>): Promise<any> => {
    const answer = (await leadCalls(hub).answer(RUNNER_ID, { id: crypto.randomUUID(), cwd: checkout, call: c as never })) as { result?: unknown; error?: { message: string } };
    if (answer.error) throw new Error(`${String(c.op)}: ${answer.error.message}`);
    return answer.result;
  };
  const brief = await lead({ op: "brief_create", text: "Say hello.", brief: { goal: "Say hello.", why: "the test", pointers: [], constraints: [], doneWhen: ["a PR"] } });
  const workstreamId = brief.workstreamId as string;
  const prompt = [
    "Please say hello.",
    "lab-run: echo hello > hello.txt && git add hello.txt && git commit -qm 'say hello'",
    "lab-run: git push -q origin HEAD",
    `lab-run: ${gh} pr create --fill`,
  ].join("\n");
  const spawned = await lead({ op: "task_spawn", workstreamId, title: "say hello", kind: "write", prompt });
  const taskId = spawned.task.taskId as string;

  // It runs in a box of boat.dev's, made from the team's key, and comes to its result.
  const task = await until("the writer's result", async () => {
    const t = (await lead({ op: "task_list", taskId })).tasks[0] as { state: string; threadRef: { machineId: string } } | undefined;
    if (t?.state === "failed" || t?.state === "cancelled") throw new Error(`the writer ended ${t.state}: ${JSON.stringify(t)}`);
    return t?.state === "idle" || t?.state === "done" ? t : undefined;
  });
  expect(task.threadRef.machineId).toBe(RUNNER_ID);
  expect(JSON.stringify(task)).toContain("said hello and opened https://github.com/acme/demo/pull/1");
  expect(boat.calls.some((c) => c.method === "POST" && c.path === "/api/v1/sandboxes" && !String(c.body?.name ?? "").startsWith("fleetd build"))).toBe(true);
  // Its branch is on origin with its commit, and its PR was opened from its worktree on that branch.
  const branch = sh(origin, "git for-each-ref --format='%(refname:short)' refs/heads/fleetd/");
  expect(branch).toStartWith(`fleetd/${taskId}-`);
  expect(sh(origin, `git log -1 --format=%s ${branch}`)).toBe("say hello");
  expect(readFileSync(prs, "utf8")).toContain(`${branch} pr create --fill`);
  // The slot board put it in boat.dev: the runner has no slots of its own, and its agents' worktrees are in its home.
  expect(readFileSync(prs, "utf8")).toStartWith(join(runner(hub).home, "worktrees"));
  const own = slots(hub).state().perMachine?.find((m) => m.machineId === RUNNER_ID);
  expect(own?.auto).toBe(0);
});
