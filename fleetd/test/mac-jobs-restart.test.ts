// An agent's build on the agents' Mac outlives the restarts an update makes (Nov 26: from 18:02 to 18:46 UTC each
// automatic update restarted the workspace, then the Mac's node, and every `mac run` on the Mac died with it): the job
// runs on under its own relay (node/mac_tool/job.ts), the next node takes it back with its output and its end, and the
// agent's `mac run` follows it again from where its output stopped once the Mac is back.
import { afterEach, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { followJob } from "../src/cli/mac_tool.ts";
import { NodeBoxKey } from "../src/node/identity.ts";
import { Host } from "../src/node/mac_tool/host.ts";
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

const until = async (ok: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !ok(); await Bun.sleep(20)) if (Date.now() > end) throw new Error("timed out");
};

test("a job outlives its node's restart: the next node takes it back, its output masked and its exit code kept", async () => {
  const one = mac();
  const agent = one.agent(caller("T1"));
  const env = [{ name: "TOKEN", value: "s3cr3t-value" }];
  const [run] = (await one.step(agent, { step: "run", args: ["echo before $TOKEN; sleep 1.5; echo after $TOKEN; exit 7"], env, background: false })) as [{ job: number }, Uint8Array];
  await until(() => readdirSync(join(one.root, "T1", "jobs")).includes(`${run.job}.json`));
  // The node stops, as an update restarts it, with the job still running.
  one.stop();
  expect(one.activity().jobs).toHaveLength(1);

  const two = mac(one.root);
  two.adoptJobs();
  expect(two.activity().jobs).toEqual([expect.objectContaining({ agent: "T1", projectId: "p1", job: run.job })]);
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
  await until(() => readdirSync(join(one.root, "T2", "jobs")).includes(`${run.job}.json`));
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
