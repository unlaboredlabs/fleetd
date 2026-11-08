import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MacClient } from "../src/node/mac_tool/client.ts";
import { Host } from "../src/node/mac_tool/host.ts";
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
  return { host, client: new MacClient(agent.node), wt, macRoot: join(macHome.dir, "mac"), secret, caller };
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
  await expect(client.call("t1", wt, { step: "pull", path: "/etc/hostname" })).rejects.toThrow("outside your folder on the Mac");
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
