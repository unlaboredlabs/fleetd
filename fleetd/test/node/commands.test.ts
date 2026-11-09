// What the hub has a node run: cmd checks confined to its roots, sealed secrets written to their sinks, approved
// commands that read them back (scrubbed from their output) and keep their result for a gated_resume, node actions,
// and lead calls relayed over the link with the calling process's session named by the kernel.
import { expect, jest, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNodeAction } from "../../src/node/actions/index.ts";
import { runCmdCheck, scrubValues } from "../../src/node/cmd/index.ts";
import { GatedRuns } from "../../src/node/gated/index.ts";
import { loadOrCreateBoxKey } from "../../src/node/identity.ts";
import { HUB_UNREACHABLE, LeadRelay, answerLine, attribute, serveLeadSocket } from "../../src/node/lead/index.ts";
import { Masker } from "../../src/node/mask.ts";
import { deliverSecret, envFileWith, parseSecretSink, secretEnvName, type SecretsContext } from "../../src/node/secrets/index.ts";
import { orderEnvFile, orderVarsForSpawn } from "../../src/node/secrets/env.ts";
import type { NodeFrame } from "../../src/node/wire.ts";
import { tempHome } from "../helpers.ts";

// Each command is a process of its own, given up to its timeoutSec: a loaded machine (CI, or a busy devbox) takes
// longer than bun's 5 s default.
setDefaultTimeout(30_000);

test("a cmd check runs in its roots only, its whole group killed at the timeout", async () => {
  const home = tempHome();
  try {
    const roots = [home.dir];
    const ran = await runCmdCheck({ id: "c1", cwd: home.dir, argv: ["sh", "-c", "echo out; echo err >&2; exit 3"], timeoutSec: 10 }, roots, home.dir);
    expect(ran).toMatchObject({ id: "c1", exitCode: 3, timedOut: false });
    expect(ran.outputTail).toContain("out");
    expect(ran.outputTail).toContain("err");
    const home2 = await runCmdCheck({ id: "c2", cwd: home.dir, argv: ["sh", "-c", "echo $FLEETD_NODE_HOME"], timeoutSec: 10 }, roots, home.dir);
    expect(home2.outputTail.trim()).toBe(home.dir);
    const outside = await runCmdCheck({ id: "c3", cwd: "/", argv: ["true"], timeoutSec: 10 }, roots);
    expect(outside.exitCode).toBeNull();
    expect(outside.outputTail).toStartWith("fleetd node refused to run this: / is outside cmdRoots");
    const slow = await runCmdCheck({ id: "c4", cwd: home.dir, argv: ["sh", "-c", "sleep 30 & sleep 30"], timeoutSec: 1 }, roots);
    expect(slow).toMatchObject({ exitCode: null, timedOut: true, outputTail: "[fleetd: killed after 1 s]" });
    const missing = await runCmdCheck({ id: "c5", cwd: home.dir, argv: ["no-such-binary-x"], timeoutSec: 5 }, roots);
    expect(missing.outputTail).toBe("could not start no-such-binary-x: spawn no-such-binary-x ENOENT");
    expect(scrubValues("a sekret b sekret-long", ["sekret", "sekret-long"])).toBe("a [secret] b [secret]");
  } finally {
    home.done();
  }
});

test("a sealed secret lands in its env sink (0600) and an approved command reads it back, scrubbed", async () => {
  const home = tempHome();
  try {
    const box = loadOrCreateBoxKey(home.dir);
    const ctx: SecretsContext = { machineId: "devbox", roots: [home.dir], home: home.dir, boxKey: box };
    const sealed = Buffer.from(box.seal(new TextEncoder().encode("s3cr3t-value"))).toString("base64");
    const env = join(home.dir, "app.env");
    writeFileSync(env, "export STRIPE_KEY=old\nOTHER=1\nSTRIPE_KEY=dup\n");
    const result = deliverSecret({ id: "d1", sink: `env:devbox:${env}`, sealed, secretKey: "stripe.key" }, ctx);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(readFileSync(env, "utf8")).toBe("export STRIPE_KEY=s3cr3t-value\nOTHER=1\n");
    expect(statSync(env).mode & 0o777).toBe(0o600);
    expect(deliverSecret({ id: "d2", sink: `env:other:${env}`, sealed, secretKey: "stripe.key" }, ctx).error).toBe("the sink is on other, not on devbox");
    expect(deliverSecret({ id: "d3", sink: "env:devbox:/etc/x", sealed, secretKey: "stripe.key" }, ctx).error).toContain("outside cmdRoots");
    expect(deliverSecret({ id: "d4", sink: `file:devbox:${home.dir}/k`, sealed: "AAAA", secretKey: "k" }, ctx).error).toContain("was not sealed to devbox");

    const gated = new GatedRuns(home.dir, "devbox");
    const run = { id: "g1", argv: ["sh", "-c", "echo key=$K"], cwd: home.dir, timeoutSec: 10, secretEnv: [{ name: "K", secretKey: "stripe.key" }], requestId: "Q1" };
    const done = await gated.run(run, "hub-1", ctx);
    expect(done).toMatchObject({ exitCode: 0, outputTail: "key=[secret]\n" });
    // The hub lost the result: it asks again, and gets it under its new frame id; another hub gets none.
    expect(await gated.resume({ id: "g2", requestId: "Q1", timeoutSec: 10 }, "hub-1")).toMatchObject({ id: "g2", exitCode: 0 });
    expect((await gated.resume({ id: "g3", requestId: "Q1", timeoutSec: 10 }, "hub-2")).unknown).toContain("no record");
    const never = await gated.run({ ...run, id: "g4", requestId: "Q2", secretEnv: [{ name: "K", secretKey: "nope" }] }, "hub-1", ctx);
    expect(never.error).toContain("was never delivered to devbox");
  } finally {
    home.done();
  }
});

test("an order: sink becomes one variable of the order's agents, sourced from a script that holds no value", () => {
  const home = tempHome();
  try {
    const box = loadOrCreateBoxKey(home.dir);
    const ctx: SecretsContext = { machineId: "devbox", roots: [home.dir], home: home.dir, boxKey: box };
    const sealed = Buffer.from(box.seal(new TextEncoder().encode("tok'en"))).toString("base64");
    const r = deliverSecret({ id: "o1", sink: "order:devbox:W12", sealed, secretKey: "github.token", envName: "GITHUB_TOKEN", projectId: "p1" }, ctx);
    expect(r.fingerprint).toBeDefined();
    expect(orderVarsForSpawn(home.dir, "p1", "W12").vars).toEqual([["GITHUB_TOKEN", "tok'en"]]);
    expect(readFileSync(join(home.dir, "order-env/p1/W12.sh"), "utf8")).toBe("export GITHUB_TOKEN='tok'\\''en'\n");
    expect(orderEnvFile(home.dir, "p1", "W12")).not.toContain("tok");
    expect(deliverSecret({ ...{ id: "o2", sink: "order:devbox:W12", sealed, secretKey: "x", envName: "CLAUDE_X", projectId: "p1" } }, ctx).error).toContain("fleetd's or claude's own");
  } finally {
    home.done();
  }
});

test("sinks parse as the contracts' do, and env files keep their other lines", () => {
  expect(parseSecretSink("env:devbox:/a/b")).toEqual({ kind: "env", machineId: "devbox", path: "/a/b" });
  expect(parseSecretSink("file:devbox:/a/../b")).toBeUndefined();
  expect(parseSecretSink("order:devbox:W7")).toEqual({ kind: "order", machineId: "devbox", path: "W7" });
  expect(parseSecretSink("fill:devbox:B0123456789abcdef0123456789abcdef")?.kind).toBe("fill");
  expect(secretEnvName("stripe.test-key")).toBe("STRIPE_TEST_KEY");
  expect(secretEnvName("1abc")).toBeUndefined();
  expect(envFileWith("", "A", "1")).toBe("A=1\n");
  expect(envFileWith("B=2", "A", "1")).toBe("B=2\nA=1\n");
});

test("node actions: a probe reads the commit email, and what the Bun node doesn't do is answered as not done", async () => {
  const probe = await runNodeAction({ id: "a1", action: "probe" }, {});
  expect(probe).toMatchObject({ id: "a1", ok: true, message: "probed" });
  expect(await runNodeAction({ id: "a2", action: "hold" }, { hold: () => 2 })).toMatchObject({ ok: true, steps: 2, message: "holding; 2 mid-step" });
  expect(await runNodeAction({ id: "a3", action: "update", update: { version: "1", channel: "stable" } }, {})).toMatchObject({ ok: false, stage: "install" });
});

test("a lead call goes out under a node id and its answer comes back under the caller's; a dropped link fails it", async () => {
  const relay = new LeadRelay();
  const sent: NodeFrame[] = [];
  const detach = relay.attach((f) => sent.push(f), []);
  const answer = relay.call({ id: "cli-1", cwd: "/w", call: { op: "task_list" } });
  await Bun.sleep(0);
  expect(sent[0]).toMatchObject({ t: "lead_call", id: "lc-1", call: { op: "task_list" } });
  relay.resolve({ id: "lc-1", result: { tasks: [] } });
  expect(await answer).toEqual({ id: "cli-1", result: { tasks: [] } });
  const dropped = relay.call({ id: "cli-2", cwd: "/w", call: { op: "task_list" } });
  await Bun.sleep(0);
  detach();
  expect((await dropped).error?.code).toBe("machine_offline");
});

/** Moves the fake clock by `ms`, letting what it wakes run. */
async function tick(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// The hub restarting for an update drops the link for seconds: a call made meanwhile waits for it to come back and is
// answered. Past a minute down, a call waits only 5 s as before.
test("a call rides through the hub restarting", async () => {
  jest.useFakeTimers();
  try {
    const relay = new LeadRelay();
    relay.attach(() => {}, [])();
    const frame = { id: "cli-1", cwd: "/w", call: { op: "decisions_search", query: "health" } };
    let answer: unknown;
    const calling = relay.call(frame).then((a) => (answer = a));
    await tick(8_000);
    expect(answer).toBeUndefined();
    const sent: NodeFrame[] = [];
    const detach = relay.attach((f) => sent.push(f), []);
    await tick(0);
    expect(sent[0]).toMatchObject({ t: "lead_call", call: { op: "decisions_search" } });
    relay.resolve({ id: (sent[0] as unknown as { id: string }).id, result: { op: "decisions_search", decisions: [] } });
    await calling;
    expect(answer).toEqual({ id: "cli-1", result: { op: "decisions_search", decisions: [] } });

    detach();
    await tick(60_000);
    const started = Date.now();
    let late: { error?: { message: string } } | undefined;
    const lateCall = relay.call(frame).then((a) => (late = a));
    await tick(4_999);
    expect(late).toBeUndefined();
    await tick(1);
    await lateCall;
    expect(Date.now() - started).toBe(5_000);
    expect(late?.error?.message).toBe(HUB_UNREACHABLE);
  } finally {
    jest.useRealTimers();
  }
});

test("the session a call comes from is the process's, never the frame's claim", () => {
  const frame = { id: "c", cwd: "/w", call: { op: "task_list" } };
  expect(attribute(frame, { kind: "session", session: "t1" })).toMatchObject({ threadId: "t1" });
  expect(attribute({ ...frame, threadId: "lead" }, { kind: "session", session: "t1" })).toMatchObject({ error: { code: "forbidden" } });
  expect(attribute({ ...frame, threadId: "lead" }, { kind: "outside" })).toMatchObject({ error: { code: "forbidden" } });
  expect(attribute(frame, { kind: "detached", session: "t1" })).toMatchObject({ error: { code: "forbidden" } });
  expect(attribute(frame, undefined)).toMatchObject({ error: { code: "forbidden" } });
  expect(new Masker([["TOKEN", "abcd1234"]]).value({ text: "x abcd1234 y", [Buffer.from("abcd1234").toString("base64")]: 1 })).toEqual({
    text: "x ***TOKEN*** y",
    "***TOKEN***": 1,
  });
});

test("the lead socket names the caller by its pid (SO_PEERCRED), masks a session's call and relays it", async () => {
  const home = tempHome();
  try {
    mkdirSync(home.dir, { recursive: true });
    const relay = new LeadRelay();
    const sent: NodeFrame[] = [];
    relay.attach((f) => {
      sent.push(f);
      queueMicrotask(() => relay.resolve({ id: String(f.id), result: { ok: true } }));
    }, []);
    let caller = 0;
    const path = join(home.dir, "node.sock");
    const stop = await serveLeadSocket(path, {
      relay,
      identify: (pid) => ((caller = pid), { kind: "session", session: "t1" }),
      maskFor: () => new Masker([["SECRET", "hunter22"]]),
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const answer = await new Promise<string>((resolve) => {
      let buf = "";
      void Bun.connect({
        unix: path,
        socket: {
          open: (s) => void s.write(`${JSON.stringify({ t: "lead_call", id: "x1", cwd: "/w", call: { op: "ask_lead", question: "is hunter22 ok?" } })}\n`),
          data: (_s, d) => void (buf += new TextDecoder().decode(d)),
          close: () => resolve(buf),
        },
      });
    });
    expect(caller).toBe(process.pid);
    expect(JSON.parse(answer)).toEqual({ t: "lead_result", id: "x1", result: { ok: true } });
    expect(sent[0]).toMatchObject({ threadId: "t1", call: { question: "is ***SECRET*** ok?" } });
    expect(await answerLine("not json", 1, { relay, identify: () => ({ kind: "outside" }), maskFor: () => new Masker() })).toMatchObject({ error: { code: "invalid" } });
    stop();
  } finally {
    home.done();
  }
});
