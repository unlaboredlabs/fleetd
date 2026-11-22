// What the node routes to the screens' areas: a session's `fleetd mac` step to node.area("local")'s `mac`.
import { expect, test } from "bun:test";
import { LeadRelay, answerLine } from "../../src/node/lead/index.ts";
import { Masker } from "../../src/node/mask.ts";

const line = (call: Record<string, unknown>) => JSON.stringify({ t: "lead_call", id: "m1", cwd: "/w", call });

test("a session's `mac` step goes to the local area's handler; a shell's is refused, and a node without one says so", async () => {
  const asked: [string, unknown][] = [];
  const hooks = {
    relay: new LeadRelay(),
    identify: () => ({ kind: "session" as const, session: "t1" }),
    maskFor: () => new Masker(),
    mac: async (session: string, frame: Record<string, unknown>) => {
      asked.push([session, (frame.call as { argv?: unknown }).argv]);
      return session === "t1" ? { result: { exitCode: 0, output: "ok" } } : { error: { code: "failed", message: "no" } };
    },
  };
  expect(await answerLine(line({ op: "mac", argv: ["uname"] }), 42, hooks)).toEqual({ t: "lead_result", id: "m1", result: { exitCode: 0, output: "ok" } });
  expect(asked).toEqual([["t1", ["uname"]]]);
  const fromShell = await answerLine(line({ op: "mac", argv: ["uname"] }), 42, { ...hooks, identify: () => ({ kind: "outside" as const }) });
  expect(fromShell).toMatchObject({ t: "lead_result", id: "m1", error: { code: "forbidden", message: "the agents' Mac is for agents' sessions, and this call comes from none" } });
  const failed = await answerLine(line({ op: "mac" }), 42, { ...hooks, identify: () => ({ kind: "session" as const, session: "t2" }) });
  expect(failed).toEqual({ t: "lead_result", id: "m1", error: { code: "failed", message: "no" } });
  const { mac: _, ...without } = hooks;
  expect(await answerLine(line({ op: "mac" }), 42, without)).toMatchObject({ error: { code: "invalid", message: "this node doesn't reach the agents' Mac" } });
});

test("an agent can't make the node's vault fills itself: only the node hosting its browser asks the hub; vault_items is its own", async () => {
  const sent: Record<string, unknown>[] = [];
  const relay = new LeadRelay();
  relay.call = async (frame) => (sent.push(frame.call), { id: frame.id, result: { items: [] } });
  const hooks = { relay, identify: () => ({ kind: "session" as const, session: "t1" }), maskFor: () => new Masker() };
  for (const op of ["vault_fill", "vault_filled"]) {
    const answer = await answerLine(line({ op, sessionId: `B${"0".repeat(32)}`, item: "Shop", field: "password", page: "https://shop.devbox.test/" }), 42, hooks);
    expect(answer).toMatchObject({ t: "lead_result", id: "m1", error: { code: "forbidden", message: `${op} is the node's own call for a browser session` } });
  }
  expect(sent).toEqual([]);
  expect(await answerLine(line({ op: "vault_items", kind: "login" }), 42, hooks)).toEqual({ t: "lead_result", id: "m1", result: { items: [] } });
  expect(sent).toEqual([{ op: "vault_items", kind: "login" }]);
});

test("a hosted box's own `fleetd mac` sends mac_where and mac_send as its session, sealed and unmasked; a session on the machine can't", async () => {
  const sent: { call: Record<string, unknown>; threadId?: string; waitMs?: number }[] = [];
  const relay = new LeadRelay();
  relay.call = async (frame, waitMs) => (sent.push({ call: frame.call, threadId: frame.threadId, waitMs }), { id: frame.id, result: { ok: true } });
  const hooks = { relay, identify: () => ({ kind: "session" as const, session: "t1" }), maskFor: () => new Masker([["K", "S3CRET-VALUE"]]) };
  const box = { box: "t1" };
  // A push's 2 MB piece, past the 256 KiB other calls may be.
  const sealed = `S3CRET-VALUE${"A".repeat(3 << 20)}`;
  expect(await answerLine(line({ op: "mac_where" }), box, hooks)).toEqual({ t: "lead_result", id: "m1", result: { ok: true } });
  // The step names the box's session, whatever the call says: the Mac checks its envelope against it.
  expect(await answerLine(line({ op: "mac_send", machineId: "mac", threadId: "t2", sealed }), box, hooks)).toEqual({ t: "lead_result", id: "m1", result: { ok: true } });
  expect(sent.map((s) => [s.call.op, s.threadId, s.call.threadId, s.waitMs])).toEqual([
    ["mac_where", "t1", undefined, 180_000],
    ["mac_send", "t1", "t1", 180_000],
  ]);
  expect(sent[1]?.call.sealed).toBe(sealed);
  // On the machine itself the node makes them, never a session.
  for (const op of ["mac_where", "mac_send"]) {
    expect(await answerLine(line({ op, sealed: "x" }), 42, hooks)).toMatchObject({ error: { code: "forbidden", message: `${op} is the node's own call for a browser session` } });
  }
  expect(sent).toHaveLength(2);
});
