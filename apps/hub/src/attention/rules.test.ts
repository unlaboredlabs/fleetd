import type { DecisionKey } from "@fleetd/contracts";
import { describe, expect, it } from "vitest";
import { ask } from "../leads/testKit.ts";
import { askAttention, parseQuietHours, quietHours, quietUntil, quietWindows } from "./rules.ts";

const T0 = Date.parse("2026-10-17T12:00:00Z");

describe("ask attention", () => {
  it("marks money, credential and irreversible asks that block a step, and approvals reopened unrun", () => {
    expect(askAttention(ask(1, "pay", { class: "money", blocks: "the launch" }), false)).toBe("urgent");
    expect(askAttention(ask(2, "drop", { class: "irreversible", blocks: "the migration" }), false)).toBe("urgent");
    expect(askAttention(ask(3, "key", { kind: "secret", class: "credential", blocks: "the deploy" }), false)).toBe("loud");
    expect(askAttention(ask(4, "key", { kind: "secret", class: "credential", blocks: "nothing" }), false)).toBeUndefined();
    expect(askAttention(ask(5, "name", { class: "product", blocks: "the launch" }), false)).toBeUndefined();
    const gated = { argv: ["true"], cwd: "/w", class: "credential" as const, reason: "rotate the key", timeoutSec: 60 };
    const reopened = ask(6, "gated.a6" as DecisionKey, { kind: "approve", class: "credential", gated, evidence: "not run: hub restarted" });
    expect(askAttention(reopened, false)).toBeUndefined();
    expect(askAttention(reopened, true)).toBe("loud");
    expect(askAttention(ask(7, "pay", { class: "money", blocks: "x", state: "answered" }), false)).toBeUndefined();
  });
});

describe("quiet hours", () => {
  it("are 23:00-08:00 until a policy.quiet_hours decision sets others or turns them off", () => {
    expect(quietHours(undefined)).toEqual({ start: 1380, end: 480 });
    expect(quietHours("01:30-02:00")).toEqual({ start: 90, end: 120 });
    expect(quietHours("off")).toBeUndefined();
  });

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

  it("come out as absolute windows: the one under way, then the next", () => {
    const quiet = parseQuietHours("23:00-08:00");
    const w = (from: string, to: string) => ({ fromMs: Date.parse(from), toMs: Date.parse(to) });
    expect(quietWindows(T0, "UTC", quiet)).toEqual([w("2026-10-17T23:00:00Z", "2026-10-18T08:00:00Z")]);
    expect(quietWindows(Date.parse("2026-10-18T01:15:30Z"), "UTC", quiet)).toEqual([
      w("2026-10-17T23:00:00Z", "2026-10-18T08:00:00Z"),
      w("2026-10-18T23:00:00Z", "2026-10-19T08:00:00Z"),
    ]);
    // 12:00 UTC is 14:00 in Berlin: quiet from 21:00 UTC.
    expect(quietWindows(T0, "Europe/Berlin", quiet)).toEqual([w("2026-10-17T21:00:00Z", "2026-10-18T06:00:00Z")]);
    expect(quietWindows(T0, "UTC", undefined)).toEqual([]);
  });
});
