import { describe, expect, it } from "vitest";
import { attentionEvent, FALLBACK_POLICY, Notifier, policyFrom, policyStale, quietAt, type AttentionEvent, type Policy } from "./notifier";

const MIN = 60_000;
const T0 = Date.parse("2026-10-17T10:00:00.000Z");
const storefront = { machineId: "devbox", projectId: "storefront" };
const api = { machineId: "devbox", projectId: "api" };

const event = (summary: string, attention: "loud" | "urgent" | null, at: Partial<AttentionEvent> = {}): AttentionEvent => ({
  type: "chat.message",
  summary,
  attention,
  project: null,
  messageId: null,
  ...at,
});
const needed = () => true;

describe("Notifier", () => {
  it("opens the project's chat at the message it is about", () => {
    const n = new Notifier();
    n.push(event("storefront: 1. Buy the domain? I'd say yes.", "urgent", { project: storefront, messageId: "m-7" }));
    expect(n.due(T0, FALLBACK_POLICY, needed)).toEqual({
      title: "fleetd needs you",
      body: "storefront: 1. Buy the domain? I'd say yes.",
      target: { kind: "chat", machineId: "devbox", projectId: "storefront", messageId: "m-7" },
    });
  });

  it("notifies at once, then at most once per window, folding the rest into one", () => {
    const policy: Policy = { coalesceMs: 20 * MIN, quiet: [] };
    const n = new Notifier();
    n.push(event("first", "loud", { project: storefront }));
    expect(n.due(T0, policy, needed)).not.toBeNull();
    n.push(event("storefront again", "loud", { project: storefront, messageId: "m-8" }));
    n.push(event("storefront once more", "loud", { project: storefront, messageId: "m-9" }));
    expect(n.due(T0 + 19 * MIN, policy, needed)).toBeNull();
    // Two about one project open that chat, at no single message.
    expect(n.due(T0 + 20 * MIN, policy, needed)).toMatchObject({
      body: "storefront again (+1 more)",
      target: { kind: "chat", machineId: "devbox", projectId: "storefront" },
    });
    n.push(event("storefront", "loud", { project: storefront }));
    n.push(event("api", "loud", { project: api }));
    expect(n.due(T0 + 40 * MIN, policy, needed)?.target).toEqual({ kind: "status" });
    n.push(event("buildbox breaker open", "loud", { type: "usage.breaker" }));
    expect(n.due(T0 + 60 * MIN, policy, needed)?.target).toEqual({ kind: "machines" });
  });

  it("holds loud items in quiet windows and lets urgent ones through", () => {
    const policy: Policy = { coalesceMs: 20 * MIN, quiet: [[T0 - 60 * MIN, T0 + 60 * MIN]] };
    const n = new Notifier();
    n.push(event("loud one", "loud", { project: api }));
    expect(n.due(T0, policy, needed)).toBeNull();
    n.push(event("drop the db?", "urgent", { project: storefront }));
    expect(n.due(T0, policy, needed)?.body).toBe("drop the db?");
    expect(n.due(T0 + 60 * MIN, policy, needed)?.body).toBe("loud one");
  });

  it("drops a project you answered meanwhile", () => {
    const n = new Notifier();
    n.push(event("storefront asks", "loud", { project: storefront }));
    expect(n.due(T0, FALLBACK_POLICY, (p) => p.projectId !== "storefront")).toBeNull();
  });

  it("cuts long summaries to one line", () => {
    const n = new Notifier();
    n.push(event("word ".repeat(60), "loud"));
    const body = n.due(T0, FALLBACK_POLICY, needed)?.body ?? "";
    expect(body).toHaveLength(140);
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
    expect(policyStale(policy, T0 + 60 * MIN)).toBe(true);
    expect(policyFrom({ quiet: [] })).toBeNull();
  });

  it("reads the project and the message an event marked for attention is about", () => {
    expect(
      attentionEvent({ seq: 1, type: "chat.message", summary: "s", attention: "urgent", machineId: "devbox", projectId: "storefront", data: { messageId: "m-1" } }),
    ).toEqual({ type: "chat.message", summary: "s", attention: "urgent", project: storefront, messageId: "m-1" });
    expect(
      attentionEvent({
        seq: 4,
        type: "chat.message",
        summary: "s",
        attention: "loud",
        data: { projectRef: storefront, messageId: "m-2", author: "lead", seq: 9, state: "final" },
      }),
    ).toMatchObject({ project: storefront, messageId: "m-2" });
    expect(attentionEvent({ seq: 2, type: "thread.failed", summary: "x" })).toBeNull();
    expect(attentionEvent({ seq: 3, type: "usage.breaker", summary: "x", attention: "loud" })?.project).toBeNull();
  });
});
