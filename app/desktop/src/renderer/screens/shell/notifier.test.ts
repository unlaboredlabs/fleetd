import { describe, expect, it } from "vitest";
import { attentionEvent, FALLBACK_POLICY, Notifier, policyFrom, policyStale, quietAt, type AttentionEvent, type Policy } from "./notifier";

const MIN = 60_000;
const T0 = Date.parse("2026-10-17T10:00:00.000Z");

const event = (summary: string, attention: "loud" | "urgent" | null, askId: string | null = null): AttentionEvent => ({
  type: askId === null ? "usage.breaker" : "ask.created",
  summary,
  attention,
  askId,
});
const open = () => true;

describe("Notifier", () => {
  it("notifies at once, then at most once per window with the rest folded in", () => {
    const policy: Policy = { coalesceMs: 20 * MIN, quiet: [] };
    const n = new Notifier();
    n.push(event("A1 pay: Buy the\ndomain?", "urgent", "A1"), 0);
    n.push(event("thread failed", null), 0);
    expect(n.due(T0, policy, open)).toEqual({ title: "fleetd needs you", body: "A1 pay: Buy the domain?", target: { kind: "ask", askId: "A1" } });
    expect(n.due(T0, policy, open)).toBeNull();
    n.push(event("buildbox breaker open", "loud"), 0);
    n.push(event("A2 token", "loud", "A2"), 0);
    expect(n.due(T0 + 19 * MIN, policy, open)).toBeNull();
    expect(n.due(T0 + 20 * MIN, policy, open)).toMatchObject({ body: "buildbox breaker open (+1 more)", target: { kind: "inbox" } });
    n.push(event("devbox breaker open", "loud"), 0);
    expect(n.due(T0 + 40 * MIN, policy, open)?.target).toEqual({ kind: "machines" });
  });

  it("holds loud items in quiet windows and lets urgent ones through", () => {
    const policy: Policy = { coalesceMs: 20 * MIN, quiet: [[T0 - 60 * MIN, T0 + 60 * MIN]] };
    const n = new Notifier();
    n.push(event("A1 token", "loud", "A1"), 0);
    expect(n.due(T0, policy, open)).toBeNull();
    n.push(event("A2 drop the db", "urgent", "A2"), 0);
    expect(n.due(T0, policy, open)?.body).toBe("A2 drop the db");
    expect(n.due(T0 + 59 * MIN, policy, open)).toBeNull();
    expect(n.due(T0 + 60 * MIN, policy, open)?.body).toBe("A1 token");
  });

  it("drops asks answered meanwhile, but only on a read sent after they arrived", () => {
    const policy: Policy = { coalesceMs: 20 * MIN, quiet: [] };
    const n = new Notifier();
    n.push(event("first", "loud"), 0);
    expect(n.due(T0, policy, open)).not.toBeNull();
    const landed = (last: number) => (_: string, sent: number) => last <= sent;
    n.push(event("A3 pay", "urgent", "A3"), 4);
    expect(n.due(T0 + 20 * MIN, policy, landed(4))).not.toBeNull();
    n.push(event("A4 pay", "urgent", "A4"), 4);
    expect(n.due(T0 + 40 * MIN, policy, landed(5))).toBeNull();
  });

  it("cuts long summaries to one line", () => {
    const n = new Notifier();
    n.push(event(`${"word ".repeat(60)}`, "loud"), 0);
    const body = n.due(T0, FALLBACK_POLICY, open)?.body ?? "";
    expect([...body]).toHaveLength(140);
    expect(body.endsWith("…")).toBe(true);
  });
});

describe("policy", () => {
  it("reads the hub's windows and goes stale after the last", () => {
    const policy = policyFrom({ coalesceSec: 1200, quiet: [{ from: "2026-10-17T09:00:00.000Z", to: "2026-10-17T11:00:00.000Z" }] });
    expect(policy).toEqual({ coalesceMs: 20 * MIN, quiet: [[T0 - 60 * MIN, T0 + 60 * MIN]] });
    if (policy === null) return;
    expect(quietAt(policy, T0)).toBe(true);
    expect(quietAt(policy, T0 + 60 * MIN)).toBe(false);
    expect(policyStale(policy, T0)).toBe(false);
    expect(policyStale(policy, T0 + 60 * MIN)).toBe(true);
    expect(policyStale(FALLBACK_POLICY, T0)).toBe(false);
    expect(policyFrom({ quiet: [] })).toBeNull();
  });

  it("reads only events the hub marked for attention", () => {
    expect(attentionEvent({ seq: 1, type: "ask.created", summary: "A1 pay", attention: "urgent", data: { askId: "A1" } })).toEqual({
      type: "ask.created",
      summary: "A1 pay",
      attention: "urgent",
      askId: "A1",
    });
    expect(attentionEvent({ seq: 2, type: "thread.failed", summary: "x" })).toBeNull();
    expect(attentionEvent({ seq: 3, type: "usage.breaker", summary: "x", attention: "loud", data: { askId: "A9" } })?.askId).toBeNull();
  });
});
