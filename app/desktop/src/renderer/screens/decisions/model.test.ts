import { describe, expect, it } from "vitest";
import type { Decision, DecisionOrder } from "../../../shared/contracts";
import { NO_FILTERS, applyFilters, fateWord, keyWords, liveCount, metaLine, overturnProblem, placesOf, threadsOf, when, whoWord } from "./model";

const PROJECT = { kind: "project", projectRef: { machineId: "devbox", projectId: "shop" } } as const;
const order = (workstreamId: string) => ({ kind: "workstream", workstreamId }) as const;

let n = 0;
const decision = (over: Partial<Decision> = {}): Decision => ({
  decisionId: `D${++n}`,
  key: "api.health.path",
  scope: PROJECT,
  value: "/healthz",
  source: "lead",
  by: "lead:devbox/shop",
  state: "active",
  at: "2026-10-25T09:00:00.000Z",
  ...over,
});

const ORDERS: DecisionOrder[] = [{ workstreamId: "W3", title: "Checkout v2" }];

describe("the Decisions tab's threads", () => {
  it("folds what a decision replaced under the one in force, newest first", () => {
    const first = decision({ value: "/health", at: "2026-10-20T09:00:00.000Z", state: "superseded" });
    const second = decision({ value: "/healthz", at: "2026-10-22T09:00:00.000Z", state: "superseded", supersedes: first.decisionId });
    const now = decision({ value: "/livez", source: "human", by: "human:desk", at: "2026-10-25T09:00:00.000Z", supersedes: second.decisionId });
    const [t, ...rest] = threadsOf([second, now, first], []);
    expect(rest).toEqual([]);
    expect(t?.head).toBe(now);
    expect(t?.live).toBe(true);
    expect(t?.earlier).toEqual([second, first]);
    expect(t && metaLine(t)).toBe("You · Whole project · 2 earlier");
  });

  it("keeps one key apart per scope, and names an order by its title", () => {
    const wide = decision({ key: "payments.provider", value: "stripe" });
    const checkout = decision({ key: "payments.provider", value: "adyen", scope: order("W3") });
    const threads = threadsOf([wide, checkout], ORDERS);
    expect(threads.map((t) => [t.head.value, t.where.label])).toEqual([
      ["stripe", "Whole project"],
      ["adyen", "Checkout v2"],
    ]);
  });

  it("puts a revoked key below the ones in force, with the revoke on top of its own history", () => {
    const revoked = decision({
      key: "db.engine",
      value: "sqlite",
      state: "retired",
      at: "2026-10-25T10:00:00.000Z",
      retired: { by: "human:desk", at: "2026-10-25T11:00:00.000Z", why: "we need replicas" },
    });
    const live = decision({ at: "2026-10-01T09:00:00.000Z" });
    const threads = threadsOf([revoked, live], []);
    expect(threads.map((t) => [t.key, t.live])).toEqual([
      ["api.health.path", true],
      ["db.engine", false],
    ]);
    expect(fateWord(revoked)).toBe("Revoked by you");
    expect(fateWord(decision({ state: "superseded" }))).toBe("Replaced");
  });

  it("never shows an id: not a decision's, not an order's", () => {
    const unknownOrder = decision({ scope: order("W9"), value: "x" });
    const [t] = threadsOf([unknownOrder], ORDERS);
    expect(t?.where.label).toBe("An order");
    const shown = t === undefined ? "" : [t.words, metaLine(t), fateWord(t.head), whoWord(t.head)].join(" ");
    expect(shown).not.toMatch(/\b[DW]\d+\b/u);
    expect(placesOf(threadsOf([unknownOrder], ORDERS)).map((p) => p.label)).toEqual(["Whole project", "An order"]);
  });

  it("counts only the decisions in force", () => {
    expect(liveCount([decision(), decision({ state: "superseded" }), decision({ state: "retired" })])).toBe(1);
  });
});

describe("a key in plain words", () => {
  it("drops the dots and dashes, and capitalises the first word and short acronyms", () => {
    expect(keyWords("api.health.path")).toBe("API health path");
    expect(keyWords("policy.quiet_hours")).toBe("Policy quiet hours");
    expect(keyWords("payments.provider")).toBe("Payments provider");
    expect(keyWords("ci.required-checks")).toBe("CI required checks");
    expect(keyWords("db")).toBe("DB");
  });
});

describe("search and filters", () => {
  const lead = decision({ key: "api.health.path", value: "/healthz", why: "the load balancer default" });
  const yours = decision({ key: "payments.provider", value: "adyen", source: "human", by: "human:desk", scope: order("W3") });
  const old = decision({ key: "ui.theme", value: "dark", state: "superseded", at: "2026-10-01T09:00:00.000Z" });
  const nowTheme = decision({ key: "ui.theme", value: "system", at: "2026-10-02T09:00:00.000Z" });
  const threads = threadsOf([lead, yours, old, nowTheme], ORDERS);
  const keys = (f: Partial<typeof NO_FILTERS>) => applyFilters(threads, { ...NO_FILTERS, ...f }).map((t) => t.key);

  it("matches every word against the value, the key in words, the order, the why and earlier values", () => {
    expect(keys({ query: "balancer" })).toEqual(["api.health.path"]);
    expect(keys({ query: "API path" })).toEqual(["api.health.path"]);
    expect(keys({ query: "checkout" })).toEqual(["payments.provider"]);
    expect(keys({ query: "dark" })).toEqual(["ui.theme"]);
    expect(keys({ query: "balancer adyen" })).toEqual([]);
    expect(keys({ query: "  " })).toHaveLength(3);
  });

  it("filters by who decided the one in force, and by where it applies", () => {
    expect(keys({ who: "you" })).toEqual(["payments.provider"]);
    expect(keys({ who: "lead" })).toEqual(["api.health.path", "ui.theme"]);
    expect(keys({ where: "W3" })).toEqual(["payments.provider"]);
    expect(keys({ where: "project", who: "you" })).toEqual([]);
  });
});

describe("when, short", () => {
  const now = Date.parse("2026-10-25T15:00:00.000Z");
  it("says the time today, the weekday this week, the date before, and the year when it differs", () => {
    expect(when("2026-10-25T09:05:00.000Z", now, "UTC")).toBe("09:05");
    expect(when("2026-10-22T09:05:00.000Z", now, "UTC")).toMatch(/^Thu/u);
    expect(when("2026-10-01T09:05:00.000Z", now, "UTC")).toMatch(/1/u);
    expect(when("2025-10-01T09:05:00.000Z", now, "UTC")).toMatch(/2025/u);
    expect(when("soon", now)).toBe("");
  });
});

describe("the overturn form", () => {
  it("asks for a new value that differs, and always a why", () => {
    expect(overturnProblem("change", " ", "x", "/healthz")).toMatch(/instead/u);
    expect(overturnProblem("change", "/healthz ", "x", "/healthz")).toMatch(/already/u);
    expect(overturnProblem("change", "/livez", "", "/healthz")).toMatch(/why/u);
    expect(overturnProblem("revoke", "", "the probe moved", "/healthz")).toBeUndefined();
    expect(overturnProblem("revoke", "", "x".repeat(2001), "/healthz")).toMatch(/2,000/u);
  });
});
