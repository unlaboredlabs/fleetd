// A Mac joined as the agents' Mac, removed from the hub, then joined again with a new code (W655): against a hub on a
// scratch home, the node as its service runs it (`node run`, its config written as `--mac` writes it: that flag is for
// macOS only). Removed, its node stops as that machine, and its next start waits for a new join instead of dialling
// the hub again; joined again, it runs the Mac's checks, which the app's set-up window waits for.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Fleet } from "./golden.ts";

setDefaultTimeout(90_000);
const SRC = join(import.meta.dir, "../../src/main.ts");
const fleets: Fleet[] = [];
// Side by side: one after another, its hubs' stops ran past the hook's time and left their homes in $TMPDIR.
afterAll(async () => {
  await Promise.all(fleets.map((f) => f.stop()));
}, 30_000);

// Every fleet with the stand-ins a real node starts: its joins and runs install nothing and check no real claude.
const fleet = (name: string) => {
  const f = new Fleet(name, { tools: true });
  fleets.push(f);
  return f;
};

test("a Mac removed from the hub stops as that machine, and joined again with a new code runs its checks", async () => {
  const hub = fleet("rejoin-hub");
  await hub.startHub();
  const mac = fleet("rejoin-mac");
  const home = join(mac.home, "node");
  const config = () => JSON.parse(readFileSync(join(home, "node.json"), "utf8"));
  const checked = () => (existsSync(join(home, "mac-health.checked")) ? statSync(join(home, "mac-health.checked")).mtimeMs : 0);
  const code = async () => /fle_[a-z2-7]{52}/.exec((await hub.run(["pair", "--worker", "mac-1"])).stdout)![0];
  /** The join's enroll step (machine_plan.ts), then node.json as `--mac` writes it. */
  const join_ = async () => {
    const joined = await mac.run(["node", "join", "--hub", hub.hubUrl, "--token-file", "-", "--machine", "mac-1", "--home", home, "--enroll-only"], { stdin: `${await code()}\n` });
    expect(joined.code).toBe(0);
    writeFileSync(join(home, "node.json"), JSON.stringify({ ...config(), mac: { enabled: true }, agentsMac: true }));
  };
  /** The node as its service starts it: stderr piped, so a node with no enrolled config waits rather than exits.
   * `saying`: what it said so far. */
  const start = () => {
    const proc = Bun.spawn([process.execPath, SRC, "node", "run", "--home", home], { cwd: mac.cwd, env: mac.env(), stdout: "ignore", stderr: "pipe" });
    let text = "";
    const said = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr) text += decoder.decode(chunk, { stream: true });
      return text;
    })();
    return { proc, said, saying: () => text };
  };
  const checks = async (after: number) => {
    for (const end = Date.now() + 30_000; Date.now() < end; await Bun.sleep(100)) if (checked() > after) return true;
    return false;
  };

  await join_();
  let since = Date.now();
  let node = start();
  expect(await checks(since)).toBe(true);

  // Removed while the Mac was off: its node comes back to a hub that says it was removed, and stops as that machine.
  node.proc.kill("SIGTERM");
  await node.proc.exited;
  const removed = await hub.run(["machine", "remove", "mac-1", "--force"]);
  expect(removed.code).toBe(0);
  node = start();
  expect(await node.proc.exited).toBe(0);
  // In the node's own words, naming the workspace's address: the wire's reason says "hub" for older nodes.
  const said = await node.said;
  expect(said).toContain("mac-1 was removed from http");
  expect(said).not.toContain("hub");
  expect(config()).toMatchObject({ enrolled: false, removed: true, machineId: "mac-1", agentsMac: true });

  // Its service starts it again: it waits for a new join, and runs no checks as the removed machine. Stopped once it
  // says it waits, however long a loaded machine takes to start it: a stop before then is a process that never waited.
  since = Date.now();
  node = start();
  const waiting = node;
  for (const end = Date.now() + 60_000; !waiting.saying().includes("stays stopped") && waiting.proc.exitCode === null && Date.now() < end; ) await Bun.sleep(50);
  // Said once, with how to join again or take fleetd off, not every few minutes.
  expect(node.saying()).toContain("so this node stays stopped");
  expect(node.saying()).toContain("run fleetd uninstall");
  expect(node.proc.exitCode).toBeNull();
  expect(checked()).toBeLessThan(since);
  node.proc.kill("SIGTERM");
  expect(await node.proc.exited).toBe(0);
  expect(await node.said).toContain("mac-1 was removed from");

  // Joined again with a new code, the same hub: the node runs its checks, and set-up goes on to its Test.
  await join_();
  expect(config().enrolled).toBe(true);
  expect(config().removed).toBeUndefined();
  since = Date.now();
  node = start();
  expect(await checks(since)).toBe(true);
  node.proc.kill("SIGTERM");
  await node.proc.exited;
});

test("an agents' Mac its hub holds no key for says so and waits for a new code, rather than being refused every few seconds", async () => {
  const hub = fleet("unknown-hub");
  await hub.startHub();
  const mac = fleet("unknown-mac");
  const home = join(mac.home, "node");
  // Joined once, then forgotten by the hub with no removed key kept (as a hub did before it kept them).
  const token = /fle_[a-z2-7]{52}/.exec((await hub.run(["pair", "--worker", "mac-2"])).stdout)![0];
  expect((await mac.run(["node", "join", "--hub", hub.hubUrl, "--token-file", "-", "--machine", "mac-2", "--home", home, "--enroll-only"], { stdin: `${token}\n` })).code).toBe(0);
  const config = () => JSON.parse(readFileSync(join(home, "node.json"), "utf8"));
  writeFileSync(join(home, "node.json"), JSON.stringify({ ...config(), machineId: "mac-forgotten", name: "mac-forgotten", agentsMac: true }));
  const proc = Bun.spawn([process.execPath, SRC, "node", "run", "--home", home], { cwd: mac.cwd, env: mac.env(), stdout: "ignore", stderr: "pipe" });
  const said = new Response(proc.stderr).text();
  // It stops as that machine, as a removed one does: its service then waits for a new join.
  expect(await proc.exited).toBe(0);
  expect(await said).toContain("mac-forgotten is not enrolled");
  expect(config()).toMatchObject({ enrolled: false, removed: true, agentsMac: true });
  // And it wrote why, which the app's setup window shows in place of a wait for checks.
  expect(JSON.parse(readFileSync(join(home, "mac-link.json"), "utf8"))).toMatchObject({ state: "refused", why: expect.stringContaining("is not enrolled") });
});

test("Stop being the agents' Mac removes it from its hub and clears the node, and with the hub down still clears it", async () => {
  const hub = fleet("leave-hub");
  await hub.startHub();
  const join_ = async (mac: Fleet, id: string) => {
    const home = join(mac.home, "node");
    const token = /fle_[a-z2-7]{52}/.exec((await hub.run(["pair", "--worker", id])).stdout)![0];
    expect((await mac.run(["node", "join", "--hub", hub.hubUrl, "--token-file", "-", "--machine", id, "--home", home, "--enroll-only"], { stdin: `${token}\n` })).code).toBe(0);
    const config = JSON.parse(readFileSync(join(home, "node.json"), "utf8"));
    writeFileSync(join(home, "node.json"), JSON.stringify({ ...config, agentsMac: true }));
    return home;
  };
  /** The machines the hub holds a node key for. */
  const machines = () => {
    const db = new Database(join(hub.hubHome, "hub.sqlite"), { readonly: true });
    try {
      return db.query<{ machine_id: string }, []>("SELECT machine_id FROM node_keys").all().map((r) => r.machine_id);
    } finally {
      db.close();
    }
  };

  const mac = fleet("leave-mac");
  const home = await join_(mac, "mac-3");
  expect(machines()).toContain("mac-3");
  const left = await mac.run(["node", "leave", "--home", home]);
  expect(left.code).toBe(0);
  expect(left.stdout.trim().split("\n").at(-1)).toBe("left: removed");
  expect(existsSync(home)).toBe(false);
  expect(machines()).not.toContain("mac-3");

  // The hub down at that moment: this Mac is clean all the same, and says the hub still lists it.
  const other = fleet("leave-offline");
  const otherHome = await join_(other, "mac-4");
  await hub.stop();
  const offline = await other.run(["node", "leave", "--home", otherHome]);
  expect(offline.code).toBe(0);
  expect(offline.stdout).toContain("wasn't reached: it shows mac-4 offline until an admin removes it there");
  expect(offline.stdout.trim().split("\n").at(-1)).toBe("left: unreached");
  expect(existsSync(otherHome)).toBe(false);
});

test("a worker that isn't the agents' Mac doesn't leave by itself: nothing stops, nothing is told, nothing is deleted", async () => {
  const hub = fleet("leave-worker-hub");
  await hub.startHub();
  const worker = fleet("leave-worker");
  const home = join(worker.home, "node");
  const token = /fle_[a-z2-7]{52}/.exec((await hub.run(["pair", "--worker", "box-1"])).stdout)![0];
  expect((await worker.run(["node", "join", "--hub", hub.hubUrl, "--token-file", "-", "--machine", "box-1", "--home", home, "--enroll-only"], { stdin: `${token}\n` })).code).toBe(0);
  const refused = await worker.run(["node", "leave", "--home", home]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("box-1 isn't the agents' Mac, so it doesn't leave by itself");
  expect(existsSync(join(home, "node.json"))).toBe(true);
  expect(existsSync(join(home, "node-key.pem"))).toBe(true);
});
