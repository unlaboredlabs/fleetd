// An agent's build on the agents' Mac outlives the restarts an update makes (Nov 26: from 18:02 to 18:46 UTC each
// automatic update restarted the workspace, then the Mac's node, and every `mac run` on the Mac died with it): the job
// runs on under its own relay (node/mac_tool/job.ts), the next node takes it back with its output and its end, and the
// agent's `mac run` follows it again from where its output stopped once the Mac is back.
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { followJob } from "../src/cli/mac_tool.ts";
import { NodeBoxKey } from "../src/node/identity.ts";
import { Host } from "../src/node/mac_tool/host.ts";
import { capped } from "../src/node/mac_tool/job.ts";
import { tempHome } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach((fn) => fn()));

const caller = (task: string) => ({ machineId: "devbox", projectId: "p1", taskId: task, threadId: `t-${task}` });

function mac(root?: string) {
  const home = root ? undefined : tempHome();
  const host = new Host(root ?? join(home!.dir, "work"), new NodeBoxKey(crypto.getRandomValues(new Uint8Array(32))));
  cleanups.push(() => (host.endJobs(), host.stop()));
  if (home) cleanups.push(home.done);
  return host;
}

type Logs = { dataB64: string; offset: number; done: boolean; exitCode?: number };

/** The job's whole output and exit code, as `mac run` follows it. */
async function follow(host: Host, task: string, job: number): Promise<{ out: string; exitCode?: number }> {
  const agent = host.agent(caller(task));
  let out = "";
  let offset = 0;
  for (;;) {
    const [logs] = (await host.step(agent, { step: "logs", job, offset })) as [Logs, Uint8Array];
    out += Buffer.from(logs.dataB64, "base64").toString();
    offset = logs.offset;
    if (logs.done) return { out, ...(logs.exitCode === undefined ? {} : { exitCode: logs.exitCode }) };
  }
}

/** What job `job` of `task` logged so far. */
const logged = (host: Host, task: string, job: number) => {
  const log = join(host.root, task, "jobs", `${job}.log`);
  return existsSync(log) ? readFileSync(log, "utf8") : "";
};

const until = async (ok: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !ok(); await Bun.sleep(20)) if (Date.now() > end) throw new Error("timed out");
};

test("a job outlives its node's restart: the next node takes it back, its output masked and its exit code kept", async () => {
  const one = mac();
  const agent = one.agent(caller("T1"));
  const env = [{ name: "TOKEN", value: "s3cr3t-value" }];
  // It runs until the test lets it go (a file in its folder), so it's running when each node looks, however slow the machine.
  const [run] = (await one.step(agent, {
    step: "run",
    args: ["echo before $TOKEN; while [ ! -e go ]; do sleep 0.05; done; echo after $TOKEN; exit 7"],
    env,
    background: false,
  })) as [{ job: number }, Uint8Array];
  await until(() => logged(one, "T1", run.job).includes("before"));
  // The node stops, as an update restarts it, with the job still running.
  one.stop();
  expect(one.activity().jobs).toHaveLength(1);

  const two = mac(one.root);
  two.adoptJobs();
  expect(two.activity().jobs).toEqual([expect.objectContaining({ agent: "T1", projectId: "p1", job: run.job })]);
  writeFileSync(join(one.root, "T1", "go"), "");
  expect(await follow(two, "T1", run.job)).toEqual({ out: "before ***TOKEN***\nafter ***TOKEN***\n", exitCode: 7 });
  const [ps] = (await two.step(two.agent(caller("T1")), { step: "ps" })) as [{ jobs: { job: number; running: boolean; exitCode?: number; command: string }[] }, Uint8Array];
  expect(ps.jobs).toEqual([expect.objectContaining({ job: run.job, running: false, exitCode: 7, command: expect.stringContaining("$TOKEN") })]);

  // A third node finds it ended, and numbers the agent's next job after it.
  const three = mac(one.root);
  three.adoptJobs();
  expect(three.activity().jobs).toEqual([]);
  const [next] = (await three.step(three.agent(caller("T1")), { step: "run", args: ["echo next"], env: [], background: true })) as [{ job: number }, Uint8Array];
  expect(next.job).toBe(run.job + 1);
  expect(await follow(three, "T1", next.job)).toEqual({ out: "next\n", exitCode: 0 });
}, 30_000);

test("a job the next node took back ends with mac kill, and one whose relay is gone reads as ended", async () => {
  const one = mac();
  const agent = one.agent(caller("T2"));
  const [run] = (await one.step(agent, { step: "run", args: ["echo up; sleep 30"], env: [], background: true })) as [{ job: number }, Uint8Array];
  // Killed only once it said so: a kill before its first line leaves nothing to read.
  await until(() => logged(one, "T2", run.job) === "up\n");
  one.stop();

  const two = mac(one.root);
  two.adoptJobs();
  const a = two.agent(caller("T2"));
  expect((await two.step(a, { step: "kill", job: run.job }))[0]).toEqual({ step: "kill", job: run.job, killed: true });
  expect(await follow(two, "T2", run.job)).toEqual({ out: "up\n", exitCode: 143 });
  expect(two.activity().jobs).toEqual([]);
}, 30_000);

test("mac run follows its job again through a lost link, from where its output stopped, saying so once", async () => {
  const asked: number[] = [];
  const answers = [
    { ok: { step: "logs", dataB64: Buffer.from("one\n").toString("base64"), offset: 4, done: false } },
    { text: "mac: the link to the fleetd workspace dropped before it answered\n", code: 69, lost: true },
    { text: "mac: Machine mac is offline.\n", code: 69, lost: true },
    { ok: { step: "logs", dataB64: Buffer.from("two\n").toString("base64"), offset: 8, done: true, exitCode: 3 } },
  ];
  const out: string[] = [];
  const err: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array, cb?: () => void) => (out.push(String(chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : chunk)), cb?.(), true)) as never;
  process.stderr.write = ((chunk: string) => (err.push(chunk), true)) as never;
  let code: number;
  try {
    code = await followJob(
      5,
      true,
      async (step) => (asked.push(step.offset as number), answers.shift()!),
      async () => {},
    );
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
  }
  expect(code).toBe(3);
  expect(out.join("")).toBe("one\ntwo\n");
  expect(asked).toEqual([0, 4, 4, 4]);
  expect(err.join("")).toMatch(/dropped before it answered\nmac: job 5 keeps running on the Mac; following it again once it's back\nmac: back on the Mac after \d+ s; job 5 goes on\n$/);
});

test("a job's log read once (mac logs without -f) doesn't wait through a lost link", async () => {
  const err: string[] = [];
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => (err.push(chunk), true)) as never;
  let code: number;
  try {
    code = await followJob(5, false, async () => ({ text: "mac: Machine mac is offline.\n", code: 69, lost: true }), async () => {});
  } finally {
    process.stderr.write = writeErr;
  }
  expect(code).toBe(69);
  expect(err.join("")).toBe("mac: Machine mac is offline.\nmac: job 5 may still run on the Mac: mac logs 5 -f follows it\n");
});

test("a job's log says where it stops, also when its output reached the cap exactly at the end of a piece", () => {
  const note = "\n[fleetd: this log stops here, at 1 MB; the job runs on]\n";
  const log = (pieces: string[]) => {
    const out: Uint8Array[] = [];
    const write = capped(2 ** 20, (b) => out.push(b));
    for (const p of pieces) write(p);
    return Buffer.concat(out).toString();
  };
  const piece = "y".repeat(64 * 1024);
  // 16 pieces of 64 KB fill 1 MB to the byte; the 17th is the first past it.
  const exact = log(Array.from({ length: 17 }, () => piece));
  expect(exact).toBe("y".repeat(2 ** 20) + note);
  expect(log([piece.repeat(17)])).toBe("y".repeat(2 ** 20) + note);
  // Under the cap, or right at it with nothing after: no line.
  expect(log(Array.from({ length: 16 }, () => piece))).toBe("y".repeat(2 ** 20));
  expect(log(["a", "b"])).toBe("ab");
});
