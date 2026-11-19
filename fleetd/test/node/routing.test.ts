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
