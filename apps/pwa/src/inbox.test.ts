import { Ask, Batch, Machine, type InboxReplyOutput } from "@fleetd/contracts";

type ReplyOutput = typeof InboxReplyOutput.Type;
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { approvalRows, inboxItems, pairingToken, replyEcho, secretTarget, statusLine, tapsFor } from "./inbox.ts";

const withoutUndefined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

// Fixtures go through the contracts' decoders, so the PWA is tested against shapes the hub can actually send.
const ask = (fields: Record<string, unknown>): Ask =>
  Schema.decodeUnknownSync(Ask)(withoutUndefined({
    askId: "A1",
    projectRef: { machineId: "forge", projectId: "p1" },
    kind: "decide",
    key: "api.health.path",
    class: "product",
    text: "Which health path?",
    recommendation: "/healthz",
    blocks: "nothing",
    proceededOnRec: false,
    state: "open",
    batchId: "B1",
    number: 1,
    createdAt: "2026-10-17T10:00:00.000Z",
    ...fields,
  }));
const batch = (batchId: string, items: Array<[number, string]>, state = "open"): Batch =>
  Schema.decodeUnknownSync(Batch)({ batchId, createdAt: "2026-10-17T10:00:00.000Z", items: items.map(([number, askId]) => ({ number, askId })), state });
const machine = (fields: Record<string, unknown>): Machine =>
  Schema.decodeUnknownSync(Machine)({ machineId: "forge", name: "forge", tags: [], status: "online", lastSeenAt: "2026-10-17T10:00:00.000Z", t3: null, nodeVersion: "0.0.0", ...fields });

const BOX_KEY = Buffer.alloc(32, 7).toString("base64");

describe("inboxItems", () => {
  it("lists open asks of open batches, newest batch first, by number", () => {
    const asks = [
      ask({ askId: "A1", batchId: "B1", number: 2 }),
      ask({ askId: "A2", batchId: "B1", number: 1 }),
      ask({ askId: "A3", batchId: "B2", number: 1 }),
      ask({ askId: "A4", batchId: "B2", number: 2, state: "answered" }),
      ask({ askId: "A5", batchId: "B9", number: 1 }),
    ];
    const batches = [batch("B2", [[2, "A4"], [1, "A3"]]), batch("B1", [[2, "A1"], [1, "A2"]]), batch("B9", [[1, "A5"]], "closed")];
    expect(inboxItems(batches, asks).map((item) => `${item.batchId}#${item.number}:${item.ask.askId}`)).toEqual(["B2#1:A3", "B1#1:A2", "B1#2:A1"]);
  });

  it("drops an item moved to a later batch with 'later'", () => {
    const moved = ask({ askId: "A1", batchId: "B2", number: 1 });
    expect(inboxItems([batch("B2", [[1, "A1"]]), batch("B1", [[3, "A1"]])], [moved]).map((item) => item.batchId)).toEqual(["B2"]);
  });
});

describe("tapsFor", () => {
  const raws = (a: Ask) => tapsFor(a, 3).map((tap) => tap.raw);

  it("answers a decide ask with its recommendation, options or no", () => {
    expect(raws(ask({ options: ["/healthz", "/status"] }))).toEqual(["3 go", "3 a", "3 b", "3 no"]);
    expect(tapsFor(ask({}), 3)[0]!.label).toBe("Go: /healthz");
  });

  it("ticks a checklist done", () => {
    const checklist = ask({ kind: "do", recommendation: undefined, steps: [{ text: "Log in", where: "browser" }] });
    expect(tapsFor(checklist, 3).map((tap) => [tap.label, tap.raw])).toEqual([["✓ Done", "3 done"], ["No", "3 no"]]);
  });

  it("approves or rejects a gated run with go or no", () => {
    const approve = ask({
      kind: "approve",
      class: "irreversible",
      recommendation: undefined,
      gated: { argv: ["sh", "-c", "echo hi"], class: "irreversible", reason: "prod deploy", timeoutSec: 1800 },
    });
    expect(tapsFor(approve, 3).map((tap) => [tap.label, tap.raw])).toEqual([["Approve", "3 go"], ["Reject", "3 no"]]);
  });

  it("offers a secret only a decline: the value is entered, never tapped", () => {
    const secret = ask({ kind: "secret", class: "credential", recommendation: undefined, sink: "env:forge:/srv/app/.env" });
    expect(raws(secret)).toEqual(["3 no"]);
  });
});

describe("approvalRows", () => {
  it("shows the exact argv, the workspace when cwd is absent, and the injected secret names", () => {
    const rows = new Map(
      approvalRows({
        argv: ["sh", "-c", 'echo "a  b" > /tmp/x'],
        class: "money",
        reason: "pay invoice",
        timeoutSec: 90,
        secretEnv: [{ name: "STRIPE_KEY", secretKey: "stripe.test_key" as never }],
      }),
    );
    expect(rows.get("argv")).toBe('["sh","-c","echo \\"a  b\\" > /tmp/x"]');
    expect(rows.get("cwd")).toBe("the project workspace");
    expect(rows.get("timeout")).toBe("2 min");
    expect(rows.get("secret env")).toBe("STRIPE_KEY ← stripe.test_key");
  });
});

describe("replyEcho", () => {
  it("shows the hub's echo, or its hint when the reply didn't parse", () => {
    expect(replyEcho({ parsed: true, echo: "Logged: 1 → go (D12)", applied: [] } as ReplyOutput)).toEqual({ text: "Logged: 1 → go (D12)", ok: true });
    expect(replyEcho({ parsed: false, hint: 'Reply like "1 go"', applied: [] } as ReplyOutput)).toEqual({ text: 'Reply like "1 go"', ok: false });
  });
});

describe("secretTarget", () => {
  const secret = ask({ kind: "secret", class: "credential", recommendation: undefined, sink: "env:forge:/srv/app/.env" });

  it("finds the sink machine's box key", () => {
    expect(secretTarget(secret, [machine({ machineId: "lab" }), machine({ boxPubKey: BOX_KEY })])).toEqual({ ok: true, machineId: "forge", boxPubKey: BOX_KEY });
  });

  it("says why the secret can't be sealed now", () => {
    expect(secretTarget(secret, [])).toMatchObject({ ok: false, reason: "The hub doesn't know machine forge." });
    expect(secretTarget(secret, [machine({})])).toMatchObject({ ok: false, reason: expect.stringContaining("no box key") });
    expect(secretTarget(secret, [machine({ boxPubKey: BOX_KEY, status: "offline" })])).toMatchObject({
      ok: false,
      reason: "forge is offline. Try again when it is online.",
    });
  });
});

describe("statusLine", () => {
  const machines = [machine({}), machine({ machineId: "mac", status: "offline" })];
  const usage = (machineId: string, state: "open" | "closed") =>
    ({ machineId, login: "subscription", breaker: { state }, parked: { leads: 0, tasks: 0 }, lastEvents: [], probes: { observable: false } }) as never;

  it("counts machines online and open asks, and names machines whose usage is paused", () => {
    expect(statusLine("live", machines, 1, undefined)).toBe("1/2 machines online · 1 open ask");
    expect(statusLine("live", machines, 4, [usage("forge", "closed")])).toBe("1/2 machines online · 4 open asks · usage ok");
    expect(statusLine("live", machines, 0, [usage("forge", "open")])).toBe("1/2 machines online · 0 open asks · usage paused on forge");
    expect(statusLine("offline", machines, 0, undefined)).toBe("offline, reconnecting · 0 open asks");
  });
});

describe("pairingToken", () => {
  it("reads the token from the link, a pasted link or the bare token", () => {
    expect(pairingToken("#pair=tok_123")).toBe("tok_123");
    expect(pairingToken(" https://hub.example.ts.net/#pair=tok_123 ")).toBe("tok_123");
    expect(pairingToken("tok_123")).toBe("tok_123");
    expect(pairingToken("")).toBeUndefined();
    expect(pairingToken("https://hub.example.ts.net/")).toBeUndefined();
  });
});
