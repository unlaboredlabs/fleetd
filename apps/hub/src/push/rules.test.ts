import type { DecisionKey } from "@fleetd/contracts";
import { describe, expect, it } from "vitest";
import { ask } from "../leads/testKit.ts";
import { COALESCE_MS, type LoudItem, loudAsk, parseQuietHours, plan, pushLine, quietUntil } from "./rules.ts";

const item = (line: string, breaksQuiet = false): LoudItem => ({ line, breaksQuiet });
const T0 = Date.parse("2026-10-17T12:00:00Z");

describe("loud asks", () => {
  it("are money, credential and irreversible asks that block a step, and approvals reopened unrun", () => {
    expect(loudAsk(ask(1, "pay", { class: "money", blocks: "the launch", text: "Buy the domain?" }), false)).toEqual({
      line: "A1 money decision: Buy the domain?",
      breaksQuiet: true,
      askId: "A1",
    });
    expect(loudAsk(ask(2, "key", { kind: "secret", class: "credential", blocks: "nothing" }), false)).toBeUndefined();
    expect(loudAsk(ask(3, "name", { class: "product", blocks: "the launch" }), false)).toBeUndefined();
    const gated = { argv: ["true"], cwd: "/w", class: "credential" as const, reason: "rotate the key", timeoutSec: 60 };
    const reopened = ask(4, "gated.a4" as DecisionKey, { kind: "approve", class: "credential", gated, evidence: "not run: hub restarted before execution; answer again to run" });
    expect(loudAsk(reopened, false)).toBeUndefined();
    expect(loudAsk(reopened, true)).toEqual({
      line: "A4 credential approval again: rotate the key (not run: hub restarted before execution; answer again to run)",
      breaksQuiet: false,
      askId: "A4",
    });
    expect(loudAsk(ask(5, "pay", { class: "money", blocks: "x", state: "answered" }), false)).toBeUndefined();
  });

  it("fold into one line", () => {
    expect(pushLine([item("A1 money decision: Buy?")])).toBe("A1 money decision: Buy?");
    expect(pushLine([item("A1"), item("A2"), item("A3")])).toBe("A1 (+2 more)");
    expect(loudAsk(ask(6, "x", { class: "irreversible", blocks: "y", text: "Drop\nthe old\tdatabase" }), false)?.line).toBe("A6 irreversible decision: Drop the old database");
  });
});

describe("quiet hours", () => {
  it("parse HH:MM-HH:MM and nothing else", () => {
    expect(parseQuietHours("23:00-08:00")).toEqual({ start: 1380, end: 480 });
    expect(parseQuietHours(" 01:30 - 02:00 ")).toEqual({ start: 90, end: 120 });
    expect(parseQuietHours("11pm-8am")).toBeUndefined();
    expect(parseQuietHours("08:00-08:00")).toBeUndefined();
  });

  it("end at the next local end time, across midnight and in policy.tz", () => {
    const quiet = parseQuietHours("23:00-08:00");
    expect(quietUntil(Date.parse("2026-10-17T23:30:00Z"), "UTC", quiet)).toBe(Date.parse("2026-10-18T08:00:00Z"));
    expect(quietUntil(Date.parse("2026-10-18T07:59:30Z"), "UTC", quiet)).toBe(Date.parse("2026-10-18T08:00:00Z"));
    expect(quietUntil(Date.parse("2026-10-18T08:00:00Z"), "UTC", quiet)).toBeUndefined();
    // 21:30 UTC is 23:30 in Berlin (CEST, +2).
    expect(quietUntil(Date.parse("2026-10-17T21:30:00Z"), "Europe/Berlin", quiet)).toBe(Date.parse("2026-10-18T06:00:00Z"));
    expect(quietUntil(Date.parse("2026-10-17T21:30:00Z"), "UTC", quiet)).toBeUndefined();
    expect(quietUntil(T0, "UTC", undefined)).toBeUndefined();
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
