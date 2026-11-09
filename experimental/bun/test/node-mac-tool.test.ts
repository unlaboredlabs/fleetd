import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activityFile, COMMAND_MAX, writeActivity } from "../src/node/mac_tool/activity.ts";
import { MacClient } from "../src/node/mac_tool/client.ts";
import { FOLDER_DAYS, Host, sweep } from "../src/node/mac_tool/host.ts";
import { self, start as startMac } from "../src/node/mac_tool/index.ts";
import { binDir, forwarder, forwarderDir, launchEnv, shim } from "../src/node/mac_tool/shim.ts";
import { sealStep } from "../src/node/mac_tool/protocol.ts";
import { NodeBoxKey } from "../src/node/identity.ts";
import { publicKeyOf } from "../src/shared/sealed_box.ts";
import { tempHome } from "./helpers.ts";
import { testNode } from "./node_helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach((fn) => fn()));

/** An agent's node, a stand-in for the agents' Mac in a temp folder, and the hub's two calls between them. */
function setup() {
  const macHome = tempHome();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const host = new Host(join(macHome.dir, "mac"), new NodeBoxKey(secret));
  const agent = testNode("devbox");
  const caller = { machineId: "devbox", projectId: "p1", taskId: "T7", threadId: "t1" };
  agent.link.answer = async (op, args) => {
    if (op === "mac_where") return { machineId: "mac1", boxPubKey: Buffer.from(publicKeyOf(secret)).toString("base64") };
    if (op === "mac_send") {
      const answer = await host.answer({ id: "c1", caller, sealed: String(args.sealed) });
      if (answer.error) throw Object.assign(new Error(answer.error.message), { toJSON: () => answer.error });
      return { sealed: answer.sealed! };
    }
    return {};
  };
  // The agent's worktree: a git checkout with a file and an ignored one.
  const work = tempHome();
  const wt = join(work.dir, "repo");
  mkdirSync(wt);
  Bun.spawnSync(["git", "init", "-q", wt]);
  writeFileSync(join(wt, "app.txt"), "v1\n");
  writeFileSync(join(wt, ".gitignore"), "build/\n");
  cleanups.push(macHome.done, agent.done, work.done, () => host.stop());
  return { host, client: new MacClient(agent.node, () => ["/pinned/fleetd-bun-1"]), wt, macRoot: join(macHome.dir, "mac"), secret, caller };
}

test("push, run, logs and pull: the agent's worktree on the Mac, its job's output, and its files back", async () => {
  const { client, wt, macRoot } = setup();
  const pushed = (await client.call("t1", wt, { step: "push" })) as { folder: string; sentBytes: number };
  expect(pushed.folder).toBe(join(macRoot, "T7", "repo"));
  expect(pushed.sentBytes).toBeGreaterThan(0);
  expect(readFileSync(join(pushed.folder, "app.txt"), "utf8")).toBe("v1\n");
  // A second push of the same tree sends nothing; a change sends only what's new.
  expect(((await client.call("t1", wt, { step: "push" })) as { sentBytes: number }).sentBytes).toBe(0);
  writeFileSync(join(wt, "app.txt"), "v2\n");
  await client.call("t1", wt, { step: "push" });
  expect(readFileSync(join(pushed.folder, "app.txt"), "utf8")).toBe("v2\n");

  const run = (await client.call("t1", wt, {
    step: "run",
    args: ["mkdir -p build/out && echo built > build/out/a.txt && cat app.txt && echo token=$TOKEN"],
    env: [{ name: "TOKEN", value: "s3cr3t-value" }],
  })) as { job: number };
  let out = "";
  let offset = 0;
  for (let i = 0; i < 20; i++) {
    const logs = (await client.call("t1", wt, { step: "logs", job: run.job, offset })) as { dataB64: string; offset: number; done: boolean; exitCode?: number };
    out += Buffer.from(logs.dataB64, "base64").toString();
    offset = logs.offset;
    if (logs.done) {
      expect(logs.exitCode).toBe(0);
      break;
    }
  }
  // The values it was given are masked in its log.
  expect(out).toBe("v2\ntoken=***TOKEN***\n");
  const ps = (await client.call("t1", wt, { step: "ps" })) as { jobs: { job: number; running: boolean; exitCode?: number }[] };
  expect(ps.jobs).toEqual([expect.objectContaining({ job: run.job, running: false, exitCode: 0 })]);

  const file = await client.call("t1", wt, { step: "pull", path: "build/out/a.txt", to: "from-mac.txt" });
  expect(file).toEqual({ step: "pull", path: join(wt, "from-mac.txt"), bytes: 6 });
  expect(readFileSync(join(wt, "from-mac.txt"), "utf8")).toBe("built\n");
  await client.call("t1", wt, { step: "pull", path: "build" });
  expect(readFileSync(join(wt, "build", "out", "a.txt"), "utf8")).toBe("built\n");
  // Never outside the agent's folder on the Mac, or outside the worktree here.
  // A file that is there, on any OS: this worktree's own, outside the agent's folder on the Mac.
  await expect(client.call("t1", wt, { step: "pull", path: join(wt, "app.txt") })).rejects.toThrow("outside your folder on the Mac");
  await expect(client.call("t1", wt, { step: "pull", path: "app.txt", to: "../x" })).rejects.toThrow("outside your worktree");
}, 30_000);

test("the Mac takes a step once, only for the session the hub names, sealed to its own key", async () => {
  const { host, secret, caller } = setup();
  const envelope = { thread: "t1", atMs: Date.now(), nonce: "n1", answerKey: Buffer.alloc(32, 1).toString("base64"), step: { step: "ps" as const } };
  const sealed = sealStep(publicKeyOf(secret), envelope);
  expect((await host.answer({ id: "1", caller, sealed })).sealed).toBeDefined();
  expect((await host.answer({ id: "2", caller, sealed })).error?.message).toBe("the step came a second time");
  const other = sealStep(publicKeyOf(secret), { ...envelope, nonce: "n2" });
  expect((await host.answer({ id: "3", caller: { ...caller, threadId: "t2" }, sealed: other })).error?.message).toBe(
    "the step was sealed for another agent's session",
  );
  const stale = sealStep(publicKeyOf(secret), { ...envelope, nonce: "n3", atMs: Date.now() - 10 * 60_000 });
  expect((await host.answer({ id: "4", caller, sealed: stale })).error?.message).toContain("more than 5 minutes");
  const wrong = sealStep(publicKeyOf(crypto.getRandomValues(new Uint8Array(32))), { ...envelope, nonce: "n4" });
  expect((await host.answer({ id: "5", caller, sealed: wrong })).error?.message).toBe("the step was not sealed to this Mac's key");
  expect(existsSync(join(host.root, "T7", "bin", "xcodebuild"))).toBe(true);
});

test("a step's absent fields may come as null, as the Rust client sends them", async () => {
  const { host, client, wt } = setup();
  await client.call("t1", wt, { step: "push" });
  const agent = host.agent({ machineId: "devbox", projectId: "p1", taskId: "T7", threadId: "t1" });
  const snapshot = Bun.spawnSync(["git", "-C", join(host.root, "T7", "repo"), "rev-parse", "HEAD"]).stdout.toString().trim();
  // A checkout sent again with `"pack": null`: what the Mac holds already.
  const [done] = await host.step(agent, { step: "checkout", snapshot, pack: null } as never);
  expect(done).toEqual({ step: "checkout", folder: join(host.root, "T7", "repo") });
  const { destination } = await import("../src/node/mac_tool/client.ts");
  mkdirSync(join(wt, "out"));
  expect(destination(wt, "build/a.txt", null)).toBe(join(wt, "a.txt"));
}, 30_000);

test("mac sim start puts the forwarding agent-device first on the session's PATH, and mac sim end takes it off", async () => {
  const { host, client, wt } = setup();
  const agentHome = (client as unknown as { node: { home: string } }).node.home;
  host.sims = {
    held: new Map(),
    touch: () => {},
    env: () => undefined,
    start: async () => ({ step: "sim_start", udid: "U1", device: "iPhone 17" }),
    end: () => true,
  } as never;
  const fwd = forwarderDir(agentHome, "t1");
  expect(await client.call("t1", wt, { step: "sim_start" })).toEqual({ step: "sim_start", udid: "U1", device: "iPhone 17" });
  const script = readFileSync(join(fwd, "agent-device"), "utf8");
  expect(script).toContain("exec '/pinned/fleetd-bun-1' mac agent-device \"$@\"");
  expect(statSync(join(fwd, "agent-device")).mode & 0o777).toBe(0o700);
  expect(launchEnv(agentHome, "t1", "/usr/bin")[0]?.[1]).toBe(`${fwd}:${binDir(agentHome)}:/usr/bin`);
  expect(await client.call("t1", wt, { step: "sim_end" })).toEqual({ step: "sim_end", ended: true });
  expect(existsSync(fwd)).toBe(false);
});

test("the Mac sweeps agents' folders nothing touched for FOLDER_DAYS, with their snapshots, and keeps the rest", async () => {
  const { client, wt, macRoot } = setup();
  await client.call("t1", wt, { step: "push" });
  const mirror = join(macRoot, ".mirrors", "p1.git");
  const ref = () => Bun.spawnSync(["git", "-C", mirror, "rev-parse", "-q", "--verify", "refs/fleetd/T7"]).exitCode;
  expect(ref()).toBe(0);
  mkdirSync(join(macRoot, "T8"));
  writeFileSync(join(macRoot, "T8", ".used"), "");
  const now = Date.now();
  // Two days on, nothing goes; four days on from T7's last step, it goes, and T8 (touched since) stays.
  expect(await sweep(macRoot, FOLDER_DAYS, now + 2 * 86_400_000)).toEqual([]);
  const old = (now - 4 * 86_400_000) / 1000;
  utimesSync(join(macRoot, "T7", ".used"), old, old);
  expect(await sweep(macRoot, FOLDER_DAYS, now)).toEqual(["T7"]);
  expect(existsSync(join(macRoot, "T7"))).toBe(false);
  expect(existsSync(join(macRoot, "T8"))).toBe(true);
  expect(existsSync(join(macRoot, ".cache")) || existsSync(mirror)).toBe(true);
  expect(ref()).not.toBe(0);
}, 30_000);

test("a big sweep leaves the node's event loop free while it removes", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  const root = join(home.dir, "mac");
  const big = join(root, "T9");
  for (let d = 0; d < 20; d++) {
    mkdirSync(join(big, "DerivedData", `d${d}`), { recursive: true });
    for (let f = 0; f < 50; f++) writeFileSync(join(big, "DerivedData", `d${d}`, `f${f}.o`), "x");
  }
  writeFileSync(join(big, ".used"), "");
  const old = (Date.now() - 4 * 86_400_000) / 1000;
  utimesSync(join(big, ".used"), old, old);
  // A timer standing in for the node's link: a sweep run on the loop would let it fire only once it had finished.
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  const swept = sweep(root, FOLDER_DAYS);
  const ticksAtStart = ticks;
  expect(await swept).toEqual(["T9"]);
  clearInterval(timer);
  expect(ticksAtStart).toBe(0);
  expect(ticks).toBeGreaterThan(0);
  expect(existsSync(big)).toBe(false);
});

test("the menu bar's activity: agents' simulators and running jobs, oldest first, written only when it changes", async () => {
  const { host, client, wt } = setup();
  await client.call("t1", wt, { step: "push" });
  const run = (await client.call("t1", wt, { step: "run", args: [`sleep 5 # ${"x".repeat(300)}`], background: true })) as { job: number };
  host.sims = { activity: () => [{ agent: "T7", projectId: "p1", device: "iPhone 17", sinceMs: 5 }], touch: () => {}, env: () => undefined } as never;
  const now = host.activity();
  expect(now.simulators).toEqual([{ agent: "T7", projectId: "p1", device: "iPhone 17", sinceMs: 5 }]);
  expect(now.jobs).toEqual([expect.objectContaining({ agent: "T7", projectId: "p1", job: run.job })]);
  expect(now.jobs[0]!.command.endsWith("…")).toBe(true);
  expect([...now.jobs[0]!.command].length).toBe(COMMAND_MAX + 1);
  const home = tempHome();
  cleanups.push(home.done);
  const written = writeActivity(home.dir, now, undefined);
  expect(JSON.parse(readFileSync(activityFile(home.dir), "utf8"))).toEqual(now);
  writeFileSync(activityFile(home.dir), "{}");
  // The same activity again isn't written.
  expect(writeActivity(home.dir, host.activity(), written)).toBe(written);
  expect(readFileSync(activityFile(home.dir), "utf8")).toBe("{}");
  await client.call("t1", wt, { step: "kill", job: run.job });
}, 30_000);

test("an agent node writes `mac` at its start and puts it on every session's PATH; the agents' Mac doesn't", () => {
  const agent = testNode("devbox");
  cleanups.push(agent.done);
  startMac(agent.node);
  const bin = join(binDir(agent.node.home), "mac");
  expect(readFileSync(bin, "utf8")).toMatch(/^#!\/bin\/sh\n# fleetd's: .*\nexec '.+' mac "\$@"\n$/);
  // The node's own command, pinned once (a compiled build's copy under bin/): the shim runs it.
  expect(readFileSync(bin, "utf8")).toBe(shim(self(agent.node)));
  expect(statSync(bin).mode & 0o777).toBe(0o755);
  const path = new Map(agent.node.area("launch").env("t9", "/usr/bin")).get("PATH");
  expect(path).toBe(`${forwarderDir(agent.node.home, "t9")}:${binDir(agent.node.home)}:/usr/bin`);
  expect(shim(["/opt/it's/fleetd"])).toContain(`exec '/opt/it'\\''s/fleetd' mac "$@"`);
  expect(forwarder(["/b/bun", "/src/main.ts"])).toContain(`exec '/b/bun' '/src/main.ts' mac agent-device "$@"`);
});
