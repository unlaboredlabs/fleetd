import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activityFile, COMMAND_MAX, writeActivity } from "../src/node/mac_tool/activity.ts";
import { answer, here, shown, UNAVAILABLE, which } from "../src/cli/mac_tool.ts";
import { hubCall } from "../src/node/browser/node.ts";
import { MacClient } from "../src/node/mac_tool/client.ts";
import { FOLDER_DAYS, Host, shellLine, sweep } from "../src/node/mac_tool/host.ts";
import { host as macHost, isOwnMac, self, start as startMac, startedIn, worktreeOf } from "../src/node/mac_tool/index.ts";
import { binDir, forwarder, forwarderDir, installForwarder, launchEnv, shim } from "../src/node/mac_tool/shim.ts";
import { openAnswer, sealStep } from "../src/node/mac_tool/protocol.ts";
import { NodeBoxKey } from "../src/node/identity.ts";
import { publicKeyOf } from "../src/shared/sealed_box.ts";
import { tempHome } from "./helpers.ts";
import { testNode } from "./node_helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach((fn) => fn()));

/** An agent's node, a stand-in for the agents' Mac in a temp folder, and the hub's two calls between them. `own`: the
 * agent's machine is the Mac itself, as the hub's `mac_where` names a Mac that runs agents to its own agents; `sims`,
 * the `mac_call`'s simulators at once. */
function setup({ own = false, sims }: { own?: boolean; sims?: number | null } = {}) {
  const macHome = tempHome();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const host = new Host(join(macHome.dir, "mac"), new NodeBoxKey(secret));
  if (own) host.own = "devbox";
  const agent = testNode("devbox");
  const caller = { machineId: "devbox", projectId: "p1", taskId: "T7", threadId: "t1" };
  const sent: Record<string, unknown>[] = [];
  agent.link.answer = async (op, args) => {
    if (op === "mac_send") sent.push(args);
    if (op === "mac_where") {
      const key = Buffer.from(publicKeyOf(secret)).toString("base64");
      return own ? { machineId: "devbox", boxPubKey: key, name: "Ada's MacBook", here: true } : { machineId: "mac1", boxPubKey: key, name: "Mac mini" };
    }
    if (op === "mac_send") {
      const answer = await host.answer({ id: "c1", caller, sealed: String(args.sealed), ...(sims === undefined ? {} : { sims }) });
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
  cleanups.push(macHome.done, agent.done, work.done, () => (host.endJobs(), host.stop()));
  const side = { home: agent.node.home, call: (op: string, args: Record<string, unknown>, opts: { threadId: string; cwd: string; waitMs: number }) => hubCall(agent.node, op, args, opts) };
  return { host, client: new MacClient(side, () => ["/pinned/fleetd-bun-1"]), wt, macRoot: join(macHome.dir, "mac"), secret, caller, sent, agentHome: agent.node.home };
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
  expect(file).toEqual({ step: "pull", path: join(wt, "from-mac.txt"), bytes: 6, mac: { name: "Mac mini" } });
  expect(readFileSync(join(wt, "from-mac.txt"), "utf8")).toBe("built\n");
  await client.call("t1", wt, { step: "pull", path: "build" });
  expect(readFileSync(join(wt, "build", "out", "a.txt"), "utf8")).toBe("built\n");
  // Never outside the agent's folder on the Mac, or outside the worktree here.
  // A file that is there, on any OS: this worktree's own, outside the agent's folder on the Mac.
  await expect(client.call("t1", wt, { step: "pull", path: join(wt, "app.txt") })).rejects.toThrow("outside your folder on the Mac");
  await expect(client.call("t1", wt, { step: "pull", path: "app.txt", to: "../x" })).rejects.toThrow("outside your worktree");
}, 30_000);

test("on the agent's own Mac: no push, its jobs run in its worktree, and its pulls read from there", async () => {
  const { client, wt, macRoot } = setup({ own: true });
  writeFileSync(join(wt, "app.txt"), "v1\n");
  const pushed = await client.call("t1", wt, { step: "push" });
  expect(pushed).toEqual({ step: "push", folder: wt, sentBytes: 0, mac: { name: "Ada's MacBook", here: true } });
  expect(existsSync(join(macRoot, "T7", "repo"))).toBe(false);
  // A change made after is what the job sees: it runs in the worktree itself.
  writeFileSync(join(wt, "app.txt"), "v2\n");
  const run = (await client.call("t1", wt, { step: "run", args: ["cat app.txt && pwd -P && echo built > made.txt && echo $FLEETD_MAC_REPO"] })) as { job: number };
  let out = "";
  let offset = 0;
  for (let i = 0; i < 20 && !out.endsWith(`${wt}\n`); i++) {
    const logs = (await client.call("t1", wt, { step: "logs", job: run.job, offset })) as { dataB64: string; offset: number; done: boolean };
    out += Buffer.from(logs.dataB64, "base64").toString();
    offset = logs.offset;
    if (logs.done) break;
  }
  const real = Bun.spawnSync(["realpath", wt]).stdout.toString().trim();
  expect(out).toBe(`v2\n${real}\n${wt}\n`);
  expect(readFileSync(join(wt, "made.txt"), "utf8")).toBe("built\n");
  // A pull copies within the worktree; the job's own folder (its logs, its screenshots) stays reachable too.
  const pulled = (await client.call("t1", wt, { step: "pull", path: "made.txt", to: "out/made.txt" })) as { path: string };
  expect(pulled.path).toBe(join(wt, "out", "made.txt"));
  expect(readFileSync(pulled.path, "utf8")).toBe("built\n");
  await expect(client.call("t1", wt, { step: "pull", path: "/etc/hosts" })).rejects.toThrow("outside your folder on the Mac");
}, 30_000);

test("a job's login shell puts the job's own PATH back in front of the system's", () => {
  const argv = shellLine(["xcodebuild", "-version"]);
  if (argv[0] === "/bin/zsh") expect(argv).toEqual(["/bin/zsh", "-lc", 'PATH="$FLEETD_MAC_PATH:$PATH"; xcodebuild -version']);
  else expect(argv).toEqual(["/bin/sh", "-c", "xcodebuild -version"]);
});

test("which Mac: a Mac that runs agents lends them its own, and each command says which it used", () => {
  const plain = testNode("laptop");
  cleanups.push(plain.done);
  expect(isOwnMac(plain.node, "darwin")).toBe(true);
  expect(isOwnMac(plain.node, "linux")).toBe(false);
  expect(isOwnMac({ ...plain.node, config: { ...plain.node.config, agentsMac: true } } as never, "darwin")).toBe(false);
  expect(isOwnMac({ ...plain.node, config: { ...plain.node.config, runner: true } } as never, "darwin")).toBe(false);
  // A person's own Mac: its agents' folders under the node's home, and Xcode's own DerivedData (the person's builds)
  // never swept; only the agents' Mac sweeps that.
  const own = macHost(plain.node);
  expect(own.root).toBe(join(plain.node.home, "mac", "work"));
  expect(own.xcodeData).toBeUndefined();
  const tool = testNode("mac1", { agentsMac: true });
  cleanups.push(tool.done);
  expect(macHost(tool.node).xcodeData).toEndWith(join("Library", "Developer", "Xcode", "DerivedData"));
  expect(which({ step: "run", job: 1, mac: { name: "Ada's MacBook", here: true } })).toBe(
    "mac: on this Mac (Ada's MacBook), the one you run on: jobs run in your worktree, no push needed\n",
  );
  expect(which({ step: "run", job: 1, mac: { name: "Mac mini" } })).toBe("mac: on the agents' Mac (Mac mini)\n");
  expect(shown({ step: "push", folder: "/w/repo", sentBytes: 0, mac: { name: "Ada's MacBook", here: true } })).toBe("nothing to push: jobs run in your worktree (/w/repo)\n");
});

test("a step names a worktree only for the Mac's own agents, and only one that is there", async () => {
  const { host, secret, caller } = setup();
  const key = Buffer.alloc(32, 1);
  const wt = tempHome();
  cleanups.push(wt.done);
  let n = 0;
  /** The job's folder for a `run` naming `worktree`, or the Mac's refusal. */
  const ranIn = async (worktree: string) => {
    const envelope = { thread: "t1", atMs: Date.now(), nonce: `w${++n}`, answerKey: key.toString("base64"), step: { step: "run" as const, args: ["pwd -P"], env: [], background: true }, worktree };
    const a = await host.answer({ id: String(n), caller, sealed: sealStep(publicKeyOf(secret), envelope) });
    const [answer] = openAnswer(key, a.sealed!)!;
    if (answer.error) return answer.error.message;
    await Bun.sleep(300);
    return readFileSync(join(host.root, "T7", "jobs", `${(answer.done as { job: number }).job}.log`), "utf8").trim();
  };
  const real = (p: string) => Bun.spawnSync(["realpath", p]).stdout.toString().trim();
  // The agents' Mac ignores it: its jobs run in the agent's own folder there.
  expect(await ranIn(wt.dir)).toBe(real(join(host.root, "T7")));
  // A Mac that runs agents takes it from its own machine's agents alone.
  host.own = "mac9";
  expect(await ranIn(wt.dir)).toBe(real(join(host.root, "T7")));
  host.own = "devbox";
  expect(await ranIn(wt.dir)).toBe(real(wt.dir));
  expect(await ranIn("/no/such/worktree")).toBe("/no/such/worktree is no worktree on this Mac");
});

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
  const { host, client, wt, sent, agentHome } = setup();
  host.sims = {
    held: new Map(),
    touch: () => {},
    ran: () => {},
    env: () => undefined,
    start: async () => ({ step: "sim_start", udid: "U1", device: "iPhone 17" }),
    end: () => true,
  } as never;
  const fwd = forwarderDir(agentHome, "t1");
  expect(await client.call("t1", wt, { step: "sim_start" })).toEqual({ step: "sim_start", udid: "U1", device: "iPhone 17", mac: { name: "Mac mini" } });
  const script = readFileSync(join(fwd, "agent-device"), "utf8");
  expect(script).toContain("exec '/pinned/fleetd-bun-1' mac agent-device \"$@\"");
  expect(statSync(join(fwd, "agent-device")).mode & 0o777).toBe(0o700);
  expect(launchEnv(agentHome, "t1", "/usr/bin")[0]?.[1]).toBe(`${fwd}:${binDir(agentHome)}:/usr/bin`);
  expect(await client.call("t1", wt, { step: "sim_end" })).toEqual({ step: "sim_end", ended: true, mac: { name: "Mac mini" } });
  expect(existsSync(fwd)).toBe(false);
  // Only the start asks the hub for the simulator's screen.
  expect(sent.map((s) => s.sim)).toEqual([true, undefined]);
});

test("a Mac's simulators at once: as its screens settings say, from each call and at once when they change", async () => {
  const { host, client, wt } = setup({ own: true, sims: 3 });
  let budget: number | undefined;
  const sims = {
    held: new Map(),
    cap: undefined as number | undefined,
    touch: () => {},
    ran: () => {},
    env: () => undefined,
    start: async () => {
      budget = sims.cap;
      return { step: "sim_start", udid: "U1", device: "iPhone 17" };
    },
    end: () => true,
  };
  host.sims = sims as never;
  expect(await client.call("t1", wt, { step: "sim_start" })).toMatchObject({ step: "sim_start", udid: "U1", mac: { here: true } });
  expect(budget).toBe(3);
  // A change in Settings reaches the Mac at once (node_action mac_sims), its default again with null.
  host.setSims(1);
  expect(sims.cap).toBe(1);
  host.setSims(null);
  expect(sims.cap).toBeUndefined();
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
  host.sims = { activity: () => [{ agent: "T7", projectId: "p1", device: "iPhone 17", sinceMs: 5 }], touch: () => {}, ran: () => {}, env: () => undefined } as never;
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
  // A session that held a simulator across the node's restart: its forwarder names the node before's pin.
  installForwarder(agent.node.home, "t8", ["/gone/fleetd-bun-1"]);
  startMac(agent.node);
  expect(readFileSync(join(forwarderDir(agent.node.home, "t8"), "agent-device"), "utf8")).toBe(forwarder(self(agent.node)));
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

test("mac from a session's scratch dir works on the worktree its record names, a taken-over one's too", () => {
  const home = tempHome();
  cleanups.push(home.done);
  // A task restarted fresh: its session t2 works in t1's worktree, and its scratch dir is named after t1's id.
  const wt = join(home.dir, "worktrees", "p1", "t1");
  mkdirSync(wt, { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", wt]).exitCode).toBe(0);
  const scratch = join(home.dir, "tmp", new Bun.CryptoHasher("sha256").update("t1").digest("hex").slice(0, 16));
  mkdirSync(scratch, { recursive: true });
  const agent = testNode("devbox");
  cleanups.push(agent.done);
  const started = new Map([["t2", wt]]);
  agent.node.area("sessions", () => ({ maskFor: () => { throw new Error("none"); }, secretsFor: () => [], sessionCwd: (t: string) => started.get(t) }));
  expect(startedIn(agent.node, "t2")).toBe(wt);
  expect(worktreeOf(scratch, startedIn(agent.node, "t2"))).toBe(wt);
  // From inside the worktree, its checkout, as before.
  mkdirSync(join(wt, "src"));
  expect(worktreeOf(join(wt, "src"), undefined)).toBe(wt);
  // A session the node has no record of, or a node with no sessions: it says where to run mac from.
  expect(() => worktreeOf(scratch, startedIn(agent.node, "t3"))).toThrow(`${scratch} is in no git checkout, and this session has no worktree of its own`);
  const bare = testNode("devbox");
  cleanups.push(bare.done);
  expect(startedIn(bare.node, "t2")).toBeUndefined();
});


test("in a hosted box, fleetd mac is its own node's half: the worktree pushed and run from the box, only mac_where and mac_send sent up its node.sock", async () => {
  const { host, wt, secret, caller, macRoot } = setup();
  const box = tempHome();
  cleanups.push(box.done);
  // What reaches the box's node.sock: each hub call, as the session's.
  const sent: { op: unknown; threadId: unknown }[] = [];
  const send = async (call: Record<string, unknown>) => {
    sent.push({ op: call.op, threadId: call.threadId });
    if (call.op === "mac_where") return { result: { machineId: "mac1", boxPubKey: Buffer.from(publicKeyOf(secret)).toString("base64") } };
    const answer = await host.answer({ id: "c1", caller, sealed: String(call.sealed) });
    return answer.error ? { error: answer.error } : { result: { sealed: answer.sealed } };
  };
  const pushed = (await here(box.dir, { step: "push" }, "t1", join(wt, "."), send)) as { result: { op: string; step: string; folder: string } };
  expect(pushed.result).toMatchObject({ op: "mac", step: "push", folder: join(macRoot, "T7", "repo") });
  expect(readFileSync(join(pushed.result.folder, "app.txt"), "utf8")).toBe("v1\n");
  expect(new Set(sent.map((s) => s.op))).toEqual(new Set(["mac_where", "mac_send"]));
  expect(sent.filter((s) => s.op === "mac_send").every((s) => s.threadId === "t1")).toBe(true);
  // Its scratch files stay in the box's folder for it.
  expect(existsSync(join(box.dir, "tmp"))).toBe(true);
  // A step the Mac refuses comes back as the node's error frame would; none without a session.
  host.sims = undefined;
  expect(((await here(box.dir, { step: "sim_start" }, "t1", wt, send)) as { error: { code: string } }).error.code).toBeString();
  expect(await here(box.dir, { step: "ps" }, undefined, wt, send)).toMatchObject({ error: { code: "forbidden" } });
  // node.sock not reached (the box's link moving, sendToNode's thrown words): the reason said, as the hub away is.
  const away = async (): Promise<Record<string, unknown>> => {
    throw "fleetd is restarting; try again";
  };
  const answered = (await here(box.dir, { step: "ps" }, "t1", wt, away)) as { error: { code: string; message: string } };
  expect(answered.error).toMatchObject({ code: "machine_offline", message: "fleetd is restarting; try again" });
  expect(answer(answered)).toEqual({ text: "mac: fleetd is restarting; try again\nmac: try again shortly\n", code: UNAVAILABLE, lost: true });
}, 30_000);
