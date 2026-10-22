// M2 lab scenario 3, "push to a listener" (docs: M2 spec). Run by the lab harness once the hub and
// both lab nodes are up; costs two tiny mechanics turns on lab-b.
//   - Webhook: a local receiver answers the first delivery 500, then 200. The signature verifies and the
//     redelivery succeeds.
//   - `fleetd listen --exec 'cat >> out.jsonl'`: each thread.completed lands exactly once across a listener restart,
//     including one that completed while the listener was down.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { MECHANICS, verifySignature } from "./harness.ts";

type Body = Record<string, any>;

export interface PushLabContext {
  readonly hubUrl: string;
  /** An operate key on every machine. */
  readonly key: string;
  /** Scratch directory for this scenario; it may not exist yet. */
  readonly dir: string;
  readonly callTool: (name: string, args?: Record<string, unknown>) => Promise<{ readonly isError: boolean; readonly body: Body }>;
  /** Starts `fleetd <args>` with the harness's scrubbed environment plus `env`, tracked under `name` for cleanup. */
  readonly startCli: (name: string, args: Array<string>, env?: Record<string, string>) => void;
  readonly stopCli: (name: string) => Promise<void>;
  readonly ok: (line: string) => void;
  readonly check: (cond: unknown, what: string) => void;
}

const MACHINE = "lab-b";

interface Received {
  readonly id: string;
  readonly seq: number;
  readonly status: number;
  readonly signed: boolean;
  readonly atMs: number;
}

/** Answers the very first request 500 and every later one 200, checking each signature with `secret()`. */
const startReceiver = async (secret: () => string) => {
  const received: Array<Received> = [];
  const server = http.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const headers = {
        "webhook-id": String(req.headers["webhook-id"]),
        "webhook-timestamp": String(req.headers["webhook-timestamp"]),
        "webhook-signature": String(req.headers["webhook-signature"]),
      };
      const status = received.length === 0 ? 500 : 200;
      received.push({
        id: headers["webhook-id"],
        seq: (JSON.parse(body) as Body).seq,
        status,
        signed: verifySignature(secret(), headers, body, Math.floor(Date.now() / 1000)),
        atMs: Date.now(),
      });
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/fleetd-hook`, received, close: () => new Promise<void>((r) => server.close(() => r())) };
};

async function until<A>(what: string, ms: number, probe: () => Promise<A | undefined> | A | undefined): Promise<A> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out after ${ms / 1000}s: ${what}`);
}

export async function scenarioPush(ctx: PushLabContext): Promise<void> {
  fs.mkdirSync(ctx.dir, { recursive: true });
  let secret = "";
  const receiver = await startReceiver(() => secret);
  const listenHome = path.join(ctx.dir, "listen-home");
  const cursorFile = path.join(listenHome, ".fleetd", "listen", "lab.cursor");
  const out = path.join(ctx.dir, "out.jsonl");
  const keyFile = path.join(ctx.dir, "key");
  fs.writeFileSync(keyFile, `${ctx.key}\n`, { mode: 0o600 });
  const listenArgs = ["listen", "--hub", ctx.hubUrl, "--key-file", keyFile, "--types", "thread.completed", "--machines", MACHINE, "--name", "lab", "--exec", `cat >> '${out}'`];
  const outSeqs = () => (fs.existsSync(out) ? fs.readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as Body).seq as number) : []);

  let subscriptionId: string | undefined;
  try {
    const status = (await ctx.callTool("fleetd_status")).body;
    const project = status.projects.find((p: Body) => p.machineId === MACHINE);
    ctx.check(project, `${MACHINE} has a project`);
    let cursor = status.cursor as number;

    const set = await ctx.callTool("subscription_set", {
      url: receiver.url,
      types: ["thread.completed"],
      machines: [MACHINE],
      clientRequestId: randomUUID(),
    });
    ctx.check(!set.isError && String(set.body.secret).startsWith("whsec_"), `subscription_set returned a secret: ${set.body.code ?? "ok"}`);
    secret = set.body.secret;
    subscriptionId = set.body.subscriptionId;
    ctx.ok(`subscription_set ${subscriptionId} -> ${receiver.url}`);

    // Seed the listener's cursor at the current end so it cannot miss the first completion while it connects.
    fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
    fs.writeFileSync(cursorFile, `${cursor}\n`);
    ctx.startCli("listen-1", listenArgs, { HOME: listenHome });

    const completed = async (threadId: string) => {
      for (;;) {
        const page = (await ctx.callTool("events_wait", { cursor, machineId: MACHINE, types: ["thread.completed", "thread.failed"], timeoutSec: 50 })).body;
        cursor = page.cursor;
        const done = page.events.find((e: Body) => e.threadId === threadId);
        if (done !== undefined) {
          ctx.check(done.type === "thread.completed", `thread ended with ${done.type}: ${done.summary}`);
          return done.seq as number;
        }
      }
    };

    // 1. A completion reaches the webhook (after one 500) and the listener.
    const launched = await ctx.callTool("thread_launch", {
      machineId: MACHINE,
      projectId: project.projectId,
      prompt: "Reply with the single word OK and nothing else.",
      model: MECHANICS.model,
      effort: MECHANICS.effort,
      title: "fleetd test:lab push",
      clientRequestId: randomUUID(),
    });
    ctx.check(!launched.isError, `thread_launch: ${JSON.stringify(launched.body)}`);
    const threadId = launched.body.threadId as string;
    const first = await completed(threadId);
    ctx.ok(`thread.completed seq=${first} for ${threadId}`);

    const delivered = await until("webhook redelivery of the first completion", 60_000, () =>
      receiver.received.find((r) => r.seq === first && r.status === 200),
    );
    const failed = receiver.received.find((r) => r.seq === first && r.status === 500);
    ctx.check(failed !== undefined, "the first delivery was answered 500");
    ctx.check(failed!.signed && delivered.signed, "both deliveries carry a valid Standard Webhooks signature");
    ctx.check(failed!.id === delivered.id, "the redelivery keeps its webhook-id");
    ctx.ok(`webhook: 500 then 200 after ${((delivered.atMs - failed!.atMs) / 1000).toFixed(1)}s, signature verified`);

    await until("listener wrote the first completion", 60_000, () => (outSeqs().includes(first) ? true : undefined));
    ctx.ok(`listen: out.jsonl has seq ${first}`);

    // 2. Stop the listener; a completion while it is down arrives once it restarts, and nothing repeats.
    await ctx.stopCli("listen-1");
    const persisted = Number(fs.readFileSync(cursorFile, "utf8"));
    ctx.check(persisted >= first, `cursor ${persisted} persisted past seq ${first}`);
    const sent = await ctx.callTool("thread_send", {
      machineId: MACHINE,
      threadId,
      message: "Reply with the single word OK again.",
      clientRequestId: randomUUID(),
    });
    ctx.check(!sent.isError, `thread_send: ${JSON.stringify(sent.body)}`);
    const second = await completed(threadId);
    ctx.ok(`thread.completed seq=${second} while the listener was stopped`);
    ctx.startCli("listen-2", listenArgs, { HOME: listenHome });
    await until("restarted listener wrote the second completion", 60_000, () => (outSeqs().includes(second) ? true : undefined));
    await ctx.stopCli("listen-2");

    const seqs = outSeqs();
    ctx.check(seqs.filter((s) => s === first).length === 1 && seqs.filter((s) => s === second).length === 1, `each completion once in out.jsonl: ${seqs.join(",")}`);
    ctx.check(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!), `out.jsonl in seq order: ${seqs.join(",")}`);
    ctx.ok(`listen: exactly once across a restart (${seqs.join(", ")})`);

    await until("webhook delivery of the second completion", 60_000, () => receiver.received.find((r) => r.seq === second && r.status === 200));
    ctx.check(receiver.received.filter((r) => r.status === 200 && r.seq === first).length === 1, "the first completion was acknowledged once");
    ctx.ok(`webhook: ${receiver.received.length} requests, all signed: ${receiver.received.every((r) => r.signed)}`);
  } finally {
    if (subscriptionId !== undefined) await ctx.callTool("subscription_delete", { subscriptionId });
    await receiver.close();
  }
}
