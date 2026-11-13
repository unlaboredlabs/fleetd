// A Mac joined as the agents' Mac, removed from the hub, then joined again with a new code (W655): against a hub on a
// scratch home, the node as its service runs it (`node run`, its config written as `--mac` writes it: that flag is for
// macOS only). Removed, its node stops as that machine, and its next start waits for a new join instead of dialling
// the hub again; joined again, it runs the Mac's checks, which the app's set-up window waits for.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Fleet } from "./golden.ts";

setDefaultTimeout(90_000);
const SRC = join(import.meta.dir, "../../src/main.ts");
const fleets: Fleet[] = [];
afterAll(async () => {
  for (const f of fleets) await f.stop();
});

const fleet = (name: string) => {
  const f = new Fleet(name);
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
  /** The node as its service starts it: stderr piped, so a node with no enrolled config waits rather than exits. */
  const start = () => {
    const proc = Bun.spawn([process.execPath, SRC, "node", "run", "--home", home], { cwd: mac.cwd, env: mac.env(), stdout: "ignore", stderr: "pipe" });
    const said = new Response(proc.stderr).text();
    return { proc, said };
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
  expect(await node.said).toContain("mac-1 was removed from this hub");
  expect(config()).toMatchObject({ enrolled: false, removed: true, machineId: "mac-1", agentsMac: true });

  // Its service starts it again: it waits for a new join, and runs no checks as the removed machine.
  since = Date.now();
  node = start();
  await Bun.sleep(3000);
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
