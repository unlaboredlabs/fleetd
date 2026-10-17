import type { DecisionKey } from "@fleetd/contracts";
import { describe, expect, it } from "vitest";
import { ask } from "../leads/testKit.ts";
import { COALESCE_MS } from "../attention/rules.ts";
import { askLine, type LoudItem, plan, pushLine } from "./rules.ts";

const item = (line: string, breaksQuiet = false): LoudItem => ({ line, breaksQuiet });
const T0 = Date.parse("2026-10-17T12:00:00Z");

describe("push lines", () => {
  it("name the ask, and why it is back", () => {
    expect(askLine(ask(1, "pay", { class: "money", blocks: "the launch", text: "Buy the domain?" }), false)).toBe("A1 money decision: Buy the domain?");
    const gated = { argv: ["true"], cwd: "/w", class: "credential" as const, reason: "rotate the key", timeoutSec: 60 };
    const reopened = ask(4, "gated.a4" as DecisionKey, { kind: "approve", class: "credential", gated, evidence: "not run: hub restarted before execution; answer again to run" });
    expect(askLine(reopened, true)).toBe("A4 credential approval again: rotate the key (not run: hub restarted before execution; answer again to run)");
    expect(askLine(ask(6, "x", { class: "irreversible", blocks: "y", text: "Drop\nthe old\tdatabase" }), false)).toBe("A6 irreversible decision: Drop the old database");
  });

  it("fold into one line", () => {
    expect(pushLine([item("A1 money decision: Buy?")])).toBe("A1 money decision: Buy?");
    expect(pushLine([item("A1"), item("A2"), item("A3")])).toBe("A1 (+2 more)");
  });
});

describe("push plan", () => {
  it("sends at once, then at most once per 20 minutes with everything since folded in", () => {
    expect(plan([], T0, undefined, undefined)).toEqual({ kind: "idle" });
    expect(plan([item("a")], T0, undefined, undefined)).toEqual({ kind: "send", items: [item("a")], held: [] });
    expect(plan([item("b"), item("c")], T0 + 60_000, T0, undefined)).toEqual({ kind: "wait", untilMs: T0 + COALESCE_MS });
    expect(plan([item("b"), item("c")], T0 + COALESCE_MS, T0, undefined)).toEqual({ kind: "send", items: [item("b"), item("c")], held: [] });
  });

  it("during quiet hours sends only money and irreversible items and holds the rest until they end", () => {
    const end = T0 + 3_600_000;
    const credential = item("credential");
    const money = item("money", true);
    expect(plan([credential], T0, undefined, end)).toEqual({ kind: "wait", untilMs: end });
    expect(plan([credential, money], T0, undefined, end)).toEqual({ kind: "send", items: [money], held: [credential] });
    // Breaking through still respects the 20-minute window.
    expect(plan([money], T0 + 60_000, T0, end)).toEqual({ kind: "wait", untilMs: T0 + COALESCE_MS });
    expect(plan([credential], end, T0, undefined)).toEqual({ kind: "send", items: [credential], held: [] });
  });
});
