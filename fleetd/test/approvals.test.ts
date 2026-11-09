// Ports the core of crates/fleetd/src/hub/approvals/tests.rs against fakes: no node, no live hub.
import { expect, test } from "bun:test";
import { type ApprovalCaller, Approvals, type GatedRunInput } from "../src/hub/approvals/index.ts";
import { chatItem, requestOutcome, wakeLine } from "../src/hub/approvals/outcome.ts";
import { checksDone, onThreadEvent } from "../src/hub/approvals/permissions.ts";
import {
  type ApprovalHooks,
  defaultHooks,
  type GatedOutcome,
  NodeCommandError,
  type PendingPermission,
  type PermissionDecision,
  type SecretOutcome,
} from "../src/hub/approvals/ports.ts";
import { claimPurchase, openPurchase, openSecureInput, personOnly, purchaseFilled } from "../src/hub/approvals/purchases.ts";
import { parseSecretSink, secretEnvName } from "../src/hub/approvals/sink.ts";
import { Requests } from "../src/hub/approvals/store.ts";
import { shownArgv } from "../src/hub/approvals/text.ts";
import { EventLog } from "../src/hub/store/events.ts";
import { HubDb } from "../src/hub/store/db.ts";
import type { HubEvent, HumanRequest, ProjectRef } from "../src/shared/contracts.ts";

class Fake {
  db = HubDb.memory();
  now = Date.parse("2026-11-08T10:00:00.000Z");
  clock = { now: () => this.now };
  events = new EventLog(this.db, this.clock);
  runs: [string, Record<string, unknown>][] = [];
  delivered: [string, Record<string, unknown>][] = [];
  answers: { machine: string; thread: string; request: string; decision: PermissionDecision; by?: string }[] = [];
  woken: string[] = [];
  gatedReply: () => Promise<GatedOutcome> = async () => ({ exitCode: 0, outputTail: "migrated 3 tables\n", timedOut: false });
  resumeReply: (id: string) => Promise<GatedOutcome> = async () => ({ outputTail: "", timedOut: false, unknown: "it has no result" });
  secretReply: () => Promise<SecretOutcome> = async () => ({ fingerprint: "ab12cd34" });
  linked = true;
  /** Whether the node is linked when the hub looks. */
  isLinked = () => this.linked;
  pending: PendingPermission | undefined;
  hooks: ApprovalHooks = { ...defaultHooks(), naviLead: async () => true };
  private wakers: (() => void)[] = [];

  approvals(): Approvals {
    return new Approvals({
      requests: new Requests(this.db),
      clock: this.clock,
      events: this.events,
      hooks: this.hooks,
      sleep: async () => {
        await Bun.sleep(1);
        this.now += 1000;
      },
      nodes: {
        deliverSecret: async (m, input) => {
          this.delivered.push([m, input]);
          return this.secretReply();
        },
        runGated: async (m, input) => {
          this.runs.push([m, input]);
          return this.gatedReply();
        },
        resumeGated: async (_m, id) => this.resumeReply(id),
        isLinked: async () => this.isLinked(),
        answerPermission: async (machine, thread, request, decision, by) => {
          this.answers.push({ machine, thread, request, decision, by });
        },
        pendingPermission: async () => this.pending,
      },
      hub: {
        boxKey: async (m) => (m === "lab-a" ? "A".repeat(43) + "=" : m === "lab-old" ? null : undefined),
        workspaceRoot: async (p) => (p.projectId === "p1" ? "/w/p1" : undefined),
        wakeRequest: async (r) => {
          this.woken.push(`${r.requestId} ${r.state}`);
          for (const w of this.wakers.splice(0)) w();
        },
        mcpServers: async () => [],
      },
    });
  }

  async wokenTimes(n: number): Promise<void> {
    while (this.woken.length < n) await new Promise<void>((resolve) => this.wakers.push(resolve));
  }

  request(id: string): HumanRequest {
    return new Requests(this.db).get(id)!;
  }

  types(): string[] {
    return this.events.page(0).events.map((e) => e.type);
  }
}

const p1: ProjectRef = { machineId: "lab-a", projectId: "p1" };
const person: ApprovalCaller = {
  human: true,
  name: "desk",
  person: { personId: "P1", name: "Ada" },
  allowsOperate: () => true,
};
const agent: ApprovalCaller = { human: false, name: "lead", allowsOperate: () => true };
const migration = (): GatedRunInput => ({
  argv: ["sh", "-c", "make migrate"],
  class: "irreversible",
  reason: "apply the schema change",
  timeoutSec: 600,
});
const SEALED = Buffer.alloc(60, 7).toString("base64");

async function refused(p: Promise<unknown>): Promise<{ code: string; message: string; fix?: string }> {
  try {
    await p;
  } catch (e) {
    return e as never;
  }
  throw new Error("expected a refusal");
}

test("approve runs the stored command and wakes the lead with its outcome", async () => {
  const fake = new Fake();
  const a = fake.approvals();
  const open = await a.gatedRun(p1, migration());
  expect([open.requestId, open.state]).toEqual(["Q1", "open"]);
  expect(open.text).toBe('Run sh -c "make migrate" on lab-a in /w/p1: apply the schema change');
  const item = chatItem(open);
  expect([item.kind, item.state]).toEqual(["command_approval", "open"]);
  expect(fake.runs).toEqual([]);
  expect((await refused(a.answer(agent, "Q1", true))).code).toBe("forbidden");
  expect((await refused(a.answer({ ...person, allowsOperate: () => false }, "Q1", true))).code).toBe("forbidden");
  expect((await refused(a.answer(person, "Q9", true))).code).toBe("not_found");

  const approved = await a.answer(person, "Q1", true);
  expect(approved.answeredBy).toBe("human:desk");
  await fake.wokenTimes(1);
  expect(fake.runs).toEqual([["lab-a", { argv: ["sh", "-c", "make migrate"], cwd: "/w/p1", timeoutSec: 600, requestId: "Q1" }]]);
  const ran = fake.request("Q1");
  expect([ran.state, ran.exitCode, ran.evidence]).toEqual(["ran", 0, "exit 0 on lab-a, approved by human:desk"]);
  expect(ran.outputTail).toBe("migrated 3 tables");
  expect(ran.finishedAt! >= approved.answeredAt!).toBe(true);
  expect(approved.finishedAt).toBeUndefined();
  expect(fake.woken).toEqual(["Q1 ran"]);
  expect(wakeLine(ran)).toBe(
    "- Q1 your command `sh -c \"make migrate\"`: ran: exit 0 on lab-a, approved by human:desk\n  > migrated 3 tables",
  );
  const again = await refused(a.answer(person, "Q1", true));
  expect([again.code, again.message]).toEqual(["invalid", "Q1 already ran."]);
  expect(fake.runs.length).toBe(1);
  // Opened urgent (irreversible), then updated as it was answered, marked running and settled.
  const evs = fake.events.page(0).events;
  expect(evs.map((e) => e.type)).toEqual(["request.opened", "request.updated", "request.updated", "request.updated"]);
  expect(evs[0]!.attention).toBe("urgent");
  expect(evs[0]!.summary).toBe('Q1 open: sh -c "make migrate"');
  expect(evs[0]!.data).toEqual({ requestId: "Q1", kind: "approval", state: "open", workstreamId: null, by: null });
});

test("deny never runs the command", async () => {
  const fake = new Fake();
  const a = fake.approvals();
  await a.gatedRun(p1, migration());
  const denied = await a.answer(person, "Q1", false, "not on a Friday");
  expect([denied.state, denied.evidence]).toEqual(["denied", "not on a Friday"]);
  expect(fake.runs).toEqual([]);
  expect(fake.woken).toEqual(["Q1 denied"]);
  expect(requestOutcome(denied).outcome).toBe(
    "denied by human:desk: not on a Friday; don't run it, say in the chat what you do instead",
  );
});

const offline = async (): Promise<GatedOutcome> => {
  throw new NodeCommandError("offline", "lab-a's node is not linked to the hub");
};

// An approval given while its node restarts (an update) waits for the node to link again, then runs, once.
test("an approval given while its node restarts runs once the node links again", async () => {
  const fake = new Fake();
  const a = fake.approvals();
  await a.gatedRun(p1, migration());
  // The node is back 3 s after the approval.
  const back = fake.now + 3000;
  fake.isLinked = () => fake.now >= back;
  fake.gatedReply = async () => (fake.isLinked() ? { exitCode: 0, outputTail: "migrated 3 tables\n", timedOut: false } : offline());
  await a.answer(person, "Q1", true);
  await fake.wokenTimes(1);
  const done = fake.request("Q1");
  expect([done.state, done.exitCode]).toEqual(["ran", 0]);
  // Sent once while unlinked, and once when back: never again while unlinked.
  expect(fake.runs).toHaveLength(2);
  expect(fake.woken).toEqual(["Q1 ran"]);
});

// A node that doesn't link again within 30 s: nothing ran, so the approval goes back to the person.
test("an approval whose node stays offline goes back to the person after 30 s", async () => {
  const fake = new Fake();
  const a = fake.approvals();
  await a.gatedRun(p1, migration());
  fake.linked = false;
  fake.gatedReply = offline;
  const approvedAt = fake.now;
  await a.answer(person, "Q1", true);
  await fake.wokenTimes(1);
  expect(fake.now - approvedAt).toBeGreaterThanOrEqual(30_000);
  const back = fake.request("Q1");
  expect(back.state).toBe("open");
  expect(back.answeredBy).toBeUndefined();
  expect(back.evidence!.startsWith("not run: lab-a's node was offline when human:desk approved it")).toBe(true);
  expect(fake.runs).toHaveLength(1);
});

test("a secret is entered by request id and only its fingerprint is kept", async () => {
  const fake = new Fake();
  const a = fake.approvals();
  const open = await a.requestSecret(p1, { key: "stripe.test_key", sink: "env:lab-a:/srv/app/.env", text: "The Stripe test key" });
  const item = chatItem(open);
  expect([item.kind, item.requestId]).toEqual(["secret_request", "Q1"]);
  expect((await refused(a.submitSecret(agent, "Q1", SEALED))).code).toBe("forbidden");
  const out = await a.submitSecret(person, "Q1", SEALED);
  expect(out).toEqual({ requestId: "Q1", fingerprint: "ab12cd34", next: "Saved on lab-a; the lead hears it in its next wake." });
  expect(fake.delivered).toEqual([["lab-a", { sink: "env:lab-a:/srv/app/.env", sealed: SEALED, secretKey: "stripe.test_key" }]]);
  const stored = fake.request("Q1");
  expect([stored.state, stored.secret?.fingerprint, stored.evidence]).toEqual(["stored", "ab12cd34", "fingerprint ab12cd34"]);
  expect(stored.answeredByPerson).toEqual({ personId: "P1", name: "Ada" });
  expect(JSON.stringify(stored)).not.toContain(SEALED);
  expect(fake.woken).toEqual(["Q1 stored"]);
  expect(requestOutcome(stored).outcome).toBe("stored on lab-a (fingerprint ab12cd34); use it from its sink, you never see the value");
  expect((await refused(a.submitSecret(person, "Q1", SEALED))).message).toBe("Q1 is already stored.");

  // A sink fleetd can't write, a machine it doesn't know, one that takes no secrets, a node that refuses.
  expect((await refused(a.requestSecret(p1, { key: "k", sink: "env:lab-a:/a/../b", text: "t" }))).code).toBe("invalid");
  expect((await refused(a.requestSecret(p1, { key: "k", sink: "env:lab-z:/a", text: "t" }))).code).toBe("not_found");
  await a.requestSecret(p1, { key: "k", sink: "file:lab-old:/a", text: "t" });
  expect((await refused(a.submitSecret(person, "Q2", SEALED))).message).toBe("lab-old's node takes no secrets: it publishes no box key.");
  await a.requestSecret(p1, { key: "k", sink: "file:lab-a:/a", text: "t" });
  fake.secretReply = async () => ({ error: "the box does not open" });
  expect((await refused(a.submitSecret(person, "Q3", SEALED))).message).toBe("lab-a's node could not save it: the box does not open.");
  fake.secretReply = async () => {
    throw new NodeCommandError("offline", "not linked");
  };
  expect((await refused(a.submitSecret(person, "Q3", SEALED))).code).toBe("machine_offline");
  expect(fake.request("Q3").state).toBe("open");
});

test("an order sink is checked by its order's hooks", async () => {
  const fake = new Fake();
  const a = fake.approvals();
  const sink = "order:lab-a:W12";
  // Until the orders area sets its hook, an order takes no variable.
  expect((await refused(a.requestSecret(p1, { key: "gh.token", sink, text: "t" }))).code).toBe("invalid");
  const saved: unknown[] = [];
  fake.hooks.orderRefusal = async () => undefined;
  fake.hooks.orderEnvSaved = async (s) => {
    saved.push(s);
    return undefined;
  };
  expect((await refused(a.requestSecret(p1, { key: "x", sink: "order:lab-old:W12", text: "t" }))).message).toBe(
    "An order's variable goes to the machine its agents run on, lab-a, not lab-old.",
  );
  expect((await refused(a.requestSecret(p1, { key: "claude.code", sink, text: "t", envName: "CLAUDE_X" }))).message).toBe(
    "CLAUDE_X is fleetd's or claude's own: an order can't set it.",
  );
  const open = await a.requestSecret(p1, { key: "gh.token", sink, text: "t" });
  expect(open.workstreamId).toBe("W12");
  await a.submitSecret(person, "Q1", SEALED);
  expect(fake.delivered[0]![1]).toEqual({ sink, sealed: SEALED, secretKey: "gh.token", projectId: "p1" });
  expect(saved).toEqual([{ project: p1, orderId: "W12", name: "GH_TOKEN", fingerprint: "ab12cd34", bytes: 12, requestId: "Q1" }]);
  expect(requestOutcome(fake.request("Q1")).outcome).toStartWith("set for W12's agents on lab-a (fingerprint ab12cd34)");
});

test("a lead withdraws its own project's requests only, and a removed project's close", async () => {
  const fake = new Fake();
  const a = fake.approvals();
  await a.gatedRun(p1, migration());
  await a.requestSecret(p1, { key: "a.b", sink: "file:lab-a:/x", text: "t" });
  expect((await refused(a.withdraw({ machineId: "lab-a", projectId: "p2" }, "lead", "Q1"))).code).toBe("not_found");
  const done = await a.withdraw(p1, "lead:lab-a/p1", "Q1");
  expect([done.state, done.evidence, done.answeredBy]).toEqual(["denied", "withdrawn by the lead", "lead:lab-a/p1"]);
  expect((await refused(a.withdraw(p1, "lead", "Q1"))).message).toBe("Q1 is already denied.");
  await a.closeOpen(p1, undefined, "the project was removed");
  expect([fake.request("Q2").state, fake.request("Q2").evidence]).toEqual(["withdrawn", "the project was removed"]);
});

test("after a restart an approved command goes back to the person and never runs late", async () => {
  const fake = new Fake();
  const a = fake.approvals();
  await a.gatedRun(p1, migration());
  new Requests(fake.db).updateFrom("Q1", "open", (r) => {
    r.state = "approved";
    r.answeredBy = "human:desk";
  });
  fake.approvals().reopenUnfinished();
  const back = fake.request("Q1");
  expect([back.state, back.evidence]).toEqual(["open", "not run: the hub restarted before it ran; approve it again to run it"]);
  expect(fake.runs).toEqual([]);
});

test("a command whose run spans a restart or a dropped link reports its kept result, or that it may have run", async () => {
  const fake = new Fake();
  const a = fake.approvals();
  await a.gatedRun(p1, migration());
  await a.gatedRun(p1, migration());
  const requests = new Requests(fake.db);
  for (const id of ["Q1", "Q2"]) {
    requests.updateFrom(id, "open", (r) => {
      r.state = "approved";
      r.answeredBy = "human:desk";
      r.evidence = "running on lab-a, approved by human:desk";
    });
  }
  // The node was away a while, then answers Q1 with its kept result and has none for Q2.
  fake.linked = false;
  fake.resumeReply = async (id) =>
    id === "Q1" ? { exitCode: 2, outputTail: "boom", timedOut: false } : { outputTail: "", timedOut: false, unknown: "it has no result for Q2" };
  const b = fake.approvals();
  b.reopenUnfinished();
  await Bun.sleep(5);
  // They still count as running there, from the database, though this hub process never sent them: an update of
  // lab-a waits for them.
  expect([b.runningOn("lab-a"), b.runningOn("lab-b")]).toEqual([2, 0]);
  fake.linked = true;
  await fake.wokenTimes(2);
  expect([fake.request("Q1").state, fake.request("Q1").evidence]).toEqual(["ran", "exit 2 on lab-a, approved by human:desk"]);
  // Their results came.
  expect(b.runningOn("lab-a")).toBe(0);
  const q2 = fake.request("Q2");
  expect(q2.state).toBe("open");
  expect(q2.evidence).toBe(
    "interrupted, may have run: the hub restarted while it ran on lab-a, and it has no result for Q2; check on lab-a whether it ran before you approve it again",
  );
  expect(fake.runs).toEqual([]);

  // A link dropped mid-run: asked again once back, never run again.
  await a.gatedRun(p1, migration());
  fake.gatedReply = async () => {
    throw new NodeCommandError("lost", "the link dropped");
  };
  fake.resumeReply = async () => ({ exitCode: 0, outputTail: "done", timedOut: true });
  await a.answer(person, "Q3", true);
  await fake.wokenTimes(3);
  expect(fake.request("Q3").evidence).toBe("killed after 600 s on lab-a, approved by human:desk");
  expect(fake.runs.length).toBe(1);
});

test("two answers at once run the command once; one guarded write moves a request", async () => {
  const fake = new Fake();
  const a = fake.approvals();
  await a.gatedRun(p1, migration());
  const both = await Promise.allSettled([a.answer(person, "Q1", true), a.answer(person, "Q1", false)]);
  expect(both.filter((r) => r.status === "fulfilled").length).toBe(1);
  await fake.wokenTimes(1);
  expect(fake.runs.length).toBeLessThanOrEqual(1);
  const requests = new Requests(fake.db);
  await a.gatedRun(p1, migration());
  requests.updateFrom("Q2", "open", (r) => {
    r.state = "denied";
  });
  expect(() => requests.updateFrom("Q2", "open", (r) => (r.state = "approved"))).toThrow("Q2 is already denied");
  // The kind rule holds on every write.
  expect(() => requests.update("Q2", (r) => (r.state = "stored"))).toThrow("a Approval request is never stored");
});

const prompt = (requestId: string, toolName: string, summary: string, input?: unknown): PendingPermission => ({
  requestId,
  toolName,
  summary,
  ...(input !== undefined ? { input } : {}),
});
const threadEvent = (type: string, permission?: PendingPermission): HubEvent => ({
  seq: 1,
  at: "2026-11-08T10:00:00.000Z",
  type,
  machineId: "lab-a",
  projectId: "p1",
  threadId: "T1",
  summary: "",
  ...(permission ? { data: { permission: { ...permission, input: undefined } } } : {}),
});

test("a prompt becomes one approval and approve runs the tool with exactly the input shown", async () => {
  const fake = new Fake();
  const a = fake.approvals();
  const input = { to: "ada@example.com", body: "hi" };
  fake.pending = prompt("p-1", "mcp__mail__send", "send a mail", input);
  await onThreadEvent(a, threadEvent("thread.waiting", fake.pending));
  // The same prompt again files nothing more.
  await onThreadEvent(a, threadEvent("thread.waiting", fake.pending));
  const open = fake.request("Q1");
  // A tool of the person's own server asks, with the policy's preview of exactly what it sends.
  expect(open.permission).toEqual({
    threadId: "T1",
    requestId: "p-1",
    toolName: "mcp__mail__send",
    summary: "send a mail",
    input,
    preview: { server: "mail", tool: "send", action: "send", title: "Use send on mail", input: '{\n  "body": "hi",\n  "to": "ada@example.com"\n}' },
  });
  expect(fake.request("Q2")).toBeUndefined();
  await a.answer(person, "Q1", true);
  expect(fake.answers).toEqual([
    { machine: "lab-a", thread: "T1", request: "p-1", decision: { behavior: "allow", updatedInput: input }, by: "human" },
  ]);
  expect(fake.request("Q1").evidence).toBe("allowed on lab-a, answered by human:desk");

  // A prompt that goes away closes its request.
  fake.pending = prompt("p-2", "Write", "a file", { path: "/x" });
  await onThreadEvent(a, threadEvent("thread.waiting", fake.pending));
  await onThreadEvent(a, threadEvent("thread.completed"));
  expect([fake.request("Q2").state, fake.request("Q2").evidence]).toEqual(["denied", "expired: the run ended"]);

  // A prompt whose input the node didn't send is refused, and nothing filed.
  fake.pending = prompt("p-3", "Write", "a big file");
  await onThreadEvent(a, threadEvent("thread.waiting", fake.pending));
  expect(fake.request("Q3")).toBeUndefined();
  expect(fake.answers.at(-1)!.decision).toEqual({
    behavior: "deny",
    message: "Blocked by fleetd: what this call would do is too large to show on an approval card.",
  });
  expect(fake.answers.at(-1)!.by).toBe("hub_rule");

  // Only a lead's prompts are the relay's.
  fake.hooks.naviLead = async () => false;
  fake.pending = prompt("p-4", "Write", "x", {});
  await onThreadEvent(a, threadEvent("thread.waiting", fake.pending));
  expect(fake.request("Q3")).toBeUndefined();
});

test("deny tells the run who said no, and the checker's verdicts go, ask and block", async () => {
  const fake = new Fake();
  const a = fake.approvals();
  fake.pending = prompt("p-1", "WebFetch", "fetch", { url: "https://example.com" });
  await onThreadEvent(a, threadEvent("thread.waiting", fake.pending));
  await a.answer(person, "Q1", false, "not that site");
  expect(fake.answers.at(-1)!.decision).toEqual({ behavior: "deny", message: "human:desk said no (Q1): not that site" });

  // Under the checker, a risky action (a site visit) is judged; go runs it and logs it.
  const logged: string[] = [];
  let verdict: "go" | "ask" | "block" = "go";
  Object.assign(fake.hooks, {
    siteVisit: () => "example.org",
    naviSite: async () => false,
    naviApprovals: async () => ({ mode: "checker", model: "m", effort: "low", defaults: true }),
    naviCheck: async () => ({ note: { verdict, reason: "a plain read" } }),
    naviAutoApproved: async (_p: ProjectRef, act: { tool: string }, by: string) => {
      logged.push(`${by} ${act.tool}`);
    },
  } satisfies Partial<ApprovalHooks>);
  fake.pending = prompt("p-2", "WebFetch", "fetch", { url: "https://example.org" });
  await onThreadEvent(a, threadEvent("thread.waiting", fake.pending));
  await checksDone(a);
  expect(fake.answers.at(-1)).toMatchObject({ request: "p-2", decision: { behavior: "allow" }, by: "hub_rule" });
  expect(logged).toEqual(["checker WebFetch"]);
  expect(fake.request("Q2")).toBeUndefined();

  verdict = "ask";
  fake.pending = prompt("p-3", "WebFetch", "fetch", { url: "https://example.org/a" });
  await onThreadEvent(a, threadEvent("thread.waiting", fake.pending));
  await checksDone(a);
  expect(fake.request("Q2")!.permission!.checker).toEqual({ verdict: "ask", reason: "a plain read" });
  expect(fake.request("Q2")!.permission!.site).toBe("example.org");

  verdict = "block";
  const input = { url: "https://example.org/b" };
  fake.pending = prompt("p-4", "WebFetch", "fetch", input);
  await onThreadEvent(a, threadEvent("thread.waiting", fake.pending));
  await checksDone(a);
  expect((fake.answers.at(-1)!.decision as { message: string }).message).toStartWith("Blocked by fleetd's approval checker: a plain read.");
  // Approved anyway: the Navi hears it, and the same call runs once when it asks again.
  await a.answer(person, "Q3", true);
  expect(fake.request("Q3").evidence).toBe("approved anyway: call it again with exactly the same input, and it runs once");
  fake.pending = prompt("p-5", "WebFetch", "fetch", input);
  await onThreadEvent(a, threadEvent("thread.waiting", fake.pending));
  expect(fake.answers.at(-1)).toMatchObject({ request: "p-5", decision: { behavior: "allow" } });
  expect(fake.request("Q3").state).toBe("ran");
});

test("a purchase is a record approved as it opens and its card fills once within its window", async () => {
  const fake = new Fake();
  const a = fake.approvals();
  const session = `B${"0".repeat(32)}`;
  const call = {
    sessionId: session,
    page: "https://shop.example/checkout",
    purchase: {
      shop: { name: "Shop", domain: "shop.example" },
      total: { amount: "12.00", currency: "EUR" },
      items: [{ name: "a mug", quantity: 1 }],
    },
  } as never;
  const r = openPurchase(a, p1, call, { ref: "op://Personal/Visa" }, true);
  expect([r.state, r.answeredBy, r.text]).toEqual(["approved", "fleetd:no-ask", "Pay 12.00 EUR at Shop (shop.example) with Visa (Personal)"]);
  expect(fake.types()).toEqual(["request.opened"]);
  expect(() => claimPurchase(a, p1, "Q1", `B${"1".repeat(32)}`)).toThrow("Q1 was asked for in another browser session.");
  expect(claimPurchase(a, p1, "Q1", session)).toEqual({ requestId: "Q1", domain: "shop.example", card: "op://Personal/Visa" });
  expect(() => claimPurchase(a, p1, "Q1", session)).toThrow("Q1's card was filled already: a purchase fills once.");
  // Nothing typed: it may be filled again.
  purchaseFilled(a, p1, { requestId: "Q1", ok: false, typed: false, message: "no card fields" });
  expect(fake.request("Q1").state).toBe("approved");
  fake.now += 16 * 60_000;
  expect(() => claimPurchase(a, p1, "Q1", session)).toThrow(
    "Q1 expired: its card wasn't filled within 15 minutes of the approval.",
  );
  expect(fake.request("Q1").state).toBe("failed");
  expect(personOnly(fake.request("Q1"))).toBe(true);
});

test("a secure input is a sealed field, or a 1Password fill with no ask", async () => {
  const fake = new Fake();
  const a = fake.approvals();
  const session = `B${"a".repeat(32)}`;
  const input = { site: { name: "Gov", domain: "gov.example" }, target: "#pass", label: "Passport number", why: "the form asks" };
  const typed = openSecureInput(a, p1, { sessionId: session, input }, true);
  expect([typed.kind, typed.state, typed.secret?.sink]).toEqual(["secret", "open", `fill:lab-a:${session}`]);
  const out = await a.submitSecret(person, "Q1", SEALED);
  expect(out.next).toBe("Filled into Passport number on gov.example; the lead never sees it.");
  expect(fake.delivered[0]![1].requestId).toBe("Q1");
  expect(fake.request("Q1").secureInput?.filledAt).toBeDefined();
  const op = openSecureInput(a, p1, { sessionId: session, input: { ...input, ref: "op://Personal/Gov/password" } }, true);
  expect([op.kind, op.state]).toEqual(["approval", "approved"]);
  expect(requestOutcome(op).outcome).toBe(
    "approved: call secure_input_fill with requestId Q2 within 15 minutes, on that page",
  );
});

test("sinks, names and argv read as the Rust hub's", () => {
  expect(parseSecretSink("env:devbox:/home/w/.env")).toEqual({ machineId: "devbox" });
  expect(parseSecretSink("order:devbox:W12")).toEqual({ machineId: "devbox", order: "W12" });
  expect(parseSecretSink(`fill:devbox:B${"0".repeat(32)}`)).toEqual({ machineId: "devbox", fill: `B${"0".repeat(32)}` });
  for (const bad of ["env:devbox:rel", "env:devbox:/a//b", "env:devbox:/a/./b", "file:Dev:/a", "env:devbox:/a\nb", "order:devbox:W0"]) {
    expect(parseSecretSink(bad)).toBeUndefined();
  }
  expect(secretEnvName("stripe.test-key")).toBe("STRIPE_TEST_KEY");
  expect(secretEnvName("1password.x")).toBeUndefined();
  expect(shownArgv(["git", "commit", "-m", "a b", "naïve"])).toBe('git commit -m "a b" naïve');
});

test("the tools and lead calls go through the hub's registries", async () => {
  const { Hub } = await import("../src/hub/api/hub.ts");
  const { Registry } = await import("../src/hub/api/registry.ts");
  const { registerAll } = await import("../src/hub/serve/areas.ts");
  const { store } = await import("../src/hub/store/hub_store.ts");
  const { leadCalls } = await import("../src/hub/lead_calls/index.ts");
  const { registerLeadCalls } = await import("../src/hub/approvals/lead_calls.ts");
  const { approvals } = await import("../src/hub/approvals/index.ts");
  const hub = new Hub({ home: "", listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), { now: () => Date.now() });
  const at = new Date().toISOString();
  store(hub).machineUpsert({ machineId: "lab-a", name: "lab-a", nodeVersion: "1", status: "online", lastSeenAt: at } as never);
  store(hub).projectsUpsertMany("lab-a", [
    { machineId: "lab-a", projectId: "p1", title: "P1", workspaceRoot: "/w/p1", lastActivityAt: at, threads: { running: 0, total: 0 } } as never,
  ]);
  hub.db.conn.run(
    "INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (7, 'lab-a', 'p2', 'open', '{}')",
  );
  registerLeadCalls(hub);
  const lead = { projectRef: p1, by: "lead:lab-a/p1", agent: { kind: "lead" } } as never;
  const gated = leadCalls(hub).handler("gated_run")!;
  expect(await gated(lead, { op: "gated_run", argv: ["make"], class: "irreversible", reason: "build" })).toEqual({
    requestId: "Q1",
    state: "open",
    next: "carry on with other work: the person approves or denies it in chat, and the exit code and output tail arrive in a wake.",
  });
  expect(approvals(hub).get("Q1")!.gated).toEqual({ argv: ["make"], cwd: "/w/p1", class: "irreversible", reason: "build", timeoutSec: 1800 });
  expect((await refused(Promise.resolve(gated(lead, { op: "gated_run", argv: ["make"], class: "irreversible", reason: "b", workstreamId: "W7" })))).message).toBe(
    "There is no workstream W7 in your project.",
  );
  // A machine with no box key takes no secrets.
  await leadCalls(hub).handler("request_secret")!(lead, { op: "request_secret", key: "a.b", sink: "file:lab-a:/x", text: "t" });

  const tools = new Registry();
  registerAll(tools);
  const human = { keyId: "k", name: "desk", prefix: "fld_x", grants: [{ role: "operate" as const, machines: "*" as const }], createdAt: at, kind: "human" as const };
  const listed = await tools.call(hub, human, "requests_list", {});
  expect((listed as { output: { requests: HumanRequest[] } }).output.requests.map((r) => r.requestId)).toEqual(["Q2", "Q1"]);
  const submit = await tools.call(hub, human, "secret_submit", { requestId: "Q2", sealed: SEALED });
  expect(submit).toMatchObject({ error: { kind: "tool", error: { code: "invalid", message: "lab-a's node takes no secrets: it publishes no box key." } } });
  const denied = await tools.call(hub, human, "approval_answer", { requestId: "Q1", decision: "deny", message: "no" });
  expect((denied as { output: { request: HumanRequest } }).output.request.state).toBe("denied");
  await leadCalls(hub).handler("request_withdraw")!(lead, { op: "request_withdraw", requestId: "Q2" });
  expect(approvals(hub).get("Q2")!.state).toBe("withdrawn");
  // Another person's Navi's requests are theirs alone.
  hub.db.conn.run(
    "INSERT INTO project_settings (machine_id, project_id, only_me, owner_person) VALUES ('lab-a', 'p1', 1, 'P9')",
  );
  const hidden = await tools.call(hub, { ...human, person: { personId: "P1", name: "Ada" } }, "requests_list", {});
  expect((hidden as { output: { requests: HumanRequest[] } }).output.requests).toEqual([]);
});

test("openRequests lists the open ones, newest first", async () => {
  const { Hub } = await import("../src/hub/api/hub.ts");
  const { openRequests } = await import("../src/hub/approvals/index.ts");
  const hub = new Hub({ home: "", listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), { now: () => 0 });
  const requests = new Requests(hub.db);
  for (const w of ["W1", "W2", "W1"]) {
    requests.create({ projectRef: p1, workstreamId: w, kind: "approval", text: "t", gated: migration() as never, at: "x", atMs: 0 });
  }
  requests.updateFrom("Q2", "open", (r) => (r.state = "denied"));
  expect(openRequests(hub, 500).map((r) => [r.requestId, r.workstreamId])).toEqual([
    ["Q3", "W1"],
    ["Q1", "W1"],
  ]);
  expect(openRequests(hub, 1).length).toBe(1);
  expect(openRequests(hub, 10, { machineId: "lab-a", projectId: "p2" })).toEqual([]);
});

test("the navi port's hooks are looked up at each call, the defaults kept for the rest", async () => {
  const { Hub } = await import("../src/hub/api/hub.ts");
  const { naviFilled } = await import("../src/hub/approvals/wire.ts");
  const hub = new Hub({ home: "", listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), { now: () => 0 });
  const hooks = naviFilled(hub, defaultHooks());
  expect(await hooks.naviLead(p1, "T1")).toBe(false);
  hub.area("navi_hooks", () => ({ naviLead: async () => true }));
  expect(await hooks.naviLead(p1, "T1")).toBe(true);
  expect(await hooks.naviSite(p1, "x.example")).toBeUndefined();
});

test("a thread event that throws is logged, and the follower goes on", async () => {
  const { followThreads } = await import("../src/hub/approvals/permissions.ts");
  const fake = new Fake();
  const stop = new AbortController();
  let calls = 0;
  fake.hooks.naviLead = async () => {
    calls++;
    if (calls === 1) throw new Error("the navi port failed");
    return true;
  };
  const a = new Approvals({ ...fake.approvals().deps, hooks: fake.hooks, signal: stop.signal });
  const quiet = console.error;
  console.error = () => {};
  const following = followThreads(a);
  await Bun.sleep(5);
  for (const id of ["p-1", "p-2"]) {
    fake.pending = { requestId: id, toolName: "Write", summary: "x", input: { path: `/${id}` } };
    fake.events.append({ at: "x", type: "thread.waiting", machineId: "lab-a", projectId: "p1", threadId: "T1", summary: "", data: { permission: { requestId: id, toolName: "Write", summary: "x" } } });
    await Bun.sleep(20);
  }
  stop.abort();
  await following;
  console.error = quiet;
  expect(calls).toBe(2);
  expect(fake.request("Q1")?.permission?.requestId).toBe("p-2");
});
