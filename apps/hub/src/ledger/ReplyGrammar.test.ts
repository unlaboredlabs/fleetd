import { AskId, BatchId, DecisionKey, MachineId, ProjectId, type Ask } from "@fleetd/contracts";
import { describe, expect, it } from "vitest";
import { type ReplyPlan, type Verb, parseReply, resolvePlan } from "./ReplyGrammar.ts";

const go: Verb = { kind: "accept" };
const nvm: Verb = { kind: "reject" };
const done: Verb = { kind: "done" };
const later: Verb = { kind: "later" };
const opt = (index: number): Verb => ({ kind: "option", index });
const txt = (text: string): Verb => ({ kind: "text", text });
const items = (...pairs: ReadonlyArray<[number, Verb] | [number, Verb, string]>) =>
  pairs.map(([number, verb, note]) => (note === undefined ? { number, verb } : { number, verb, note }));
const plan = (extra: Partial<ReplyPlan>): ReplyPlan => ({ items: [], prefs: [], forgets: [], ...extra });

describe("parseReply", () => {
  const ok: ReadonlyArray<[string, ReplyPlan]> = [
    ["1 go", plan({ items: items([1, go]) })],
    ["1 go 2 nvm 3 recs fine", plan({ items: items([1, go], [2, nvm], [3, go]) })],
    ["1 yes", plan({ items: items([1, go]) })],
    ["1 y", plan({ items: items([1, go]) })],
    ["1 ok", plan({ items: items([1, go]) })],
    ["1 rec", plan({ items: items([1, go]) })],
    ["1 recs ok", plan({ items: items([1, go]) })],
    ["1 GO", plan({ items: items([1, go]) })],
    ["1 no 2 drop 3 skip 4 n", plan({ items: items([1, nvm], [2, nvm], [3, nvm], [4, nvm]) })],
    ["1 a 2 b 3 f", plan({ items: items([1, opt(0)], [2, opt(1)], [3, opt(5)]) })],
    ["1a2b", plan({ items: items([1, opt(0)], [2, opt(1)]) })],
    ["1 done", plan({ items: items([1, done]) })],
    ["4 later", plan({ items: items([4, later]) })],
    ["1-3 go", plan({ items: items([1, go], [2, go], [3, go]) })],
    ["1 - 2 nvm", plan({ items: items([1, nvm], [2, nvm]) })],
    ["1,3 go", plan({ items: items([1, go], [3, go]) })],
    ["1, 3 , 5 b", plan({ items: items([1, opt(1)], [3, opt(1)], [5, opt(1)]) })],
    ["1-2,4 go", plan({ items: items([1, go], [2, go], [4, go]) })],
    ["1 go, 2 nvm", plan({ items: items([1, go], [2, nvm]) })],
    ["1 go; 2 nvm", plan({ items: items([1, go], [2, nvm]) })],
    ["1 go\n2 nvm\n", plan({ items: items([1, go], [2, nvm]) })],
    ["  1   go   ", plan({ items: items([1, go]) })],
    ["1: /status", plan({ items: items([1, txt("/status")]) })],
    ["1 : use pnpm, not npm; 2 go", plan({ items: items([1, txt("use pnpm, not npm")], [2, go]) })],
    ['2 "keep email sign-in" 3 go', plan({ items: items([2, txt("keep email sign-in")], [3, go]) })],
    ["2 “curly quotes”", plan({ items: items([2, txt("curly quotes")]) })],
    ["1 go: cheaper", plan({ items: items([1, go, "cheaper"]) })],
    ['1 no "too pricey" 2 go', plan({ items: items([1, nvm, "too pricey"], [2, go]) })],
    ["recs fine", plan({ rest: go })],
    ["recs", plan({ rest: go })],
    ["RECS OK", plan({ rest: go })],
    ["1 nvm recs fine", plan({ items: items([1, nvm]), rest: go })],
    ["all nvm", plan({ rest: nvm })],
    ["all later", plan({ rest: later })],
    ["all: ship it", plan({ rest: txt("ship it") })],
    ["#B3 1 go", plan({ batch: 3, items: items([1, go]) })],
    ["#b12 recs fine", plan({ batch: 12, rest: go })],
    ["pref: always use pnpm", plan({ prefs: ["always use pnpm"] })],
    ["pref: dark mode first; 1 go", plan({ prefs: ["dark mode first"], items: items([1, go]) })],
    ["forget D12", plan({ forgets: [12] })],
    ["forget d3 forget D4", plan({ forgets: [3, 4] })],
    ["1 go forget D2", plan({ items: items([1, go]), forgets: [2] })],
  ];
  it.each(ok)("parses %j", (raw, expected) => {
    expect(parseReply(raw)).toEqual({ parsed: true, plan: expected });
  });

  const bad: ReadonlyArray<[string, RegExp]> = [
    ["", /empty/u],
    ["   \n ", /empty/u],
    ["1", /needs an answer/u],
    ["1 2 go", /needs an answer/u],
    ["1 maybe", /"maybe" is not an answer word/u],
    ["1 good", /"good" is not an answer word/u],
    ["1 g", /"g" is not an answer word/u],
    ["0 go", /no item 0/u],
    ["3-1 go", /backwards/u],
    ["1 go 1 nvm", /answered twice/u],
    ["1-3 go 2 nvm", /answered twice/u],
    ["1:", /empty/u],
    ["1: ; 2 go", /empty/u],
    ['1 "unclosed', /not closed/u],
    ['1 ""', /empty/u],
    ["1 go #B2", /must come first/u],
    ["recs fine all nvm", /only one of/u],
    ["all", /needs an answer/u],
    ["forget", /needs a decision id/u],
    ["forget 12", /needs a decision id/u],
    ["pref:", /empty/u],
    ["hello", /Could not read "hello"/u],
    ["go 1", /Could not read "go"/u],
    ["1 go!", /Could not read "!"/u],
    [`1: ${"x".repeat(2001)}`, /longer than 2000/u],
    ["1-500 go", /too long/u],
  ];
  it.each(bad)("refuses %j", (raw, hint) => {
    const result = parseReply(raw);
    expect(result.parsed).toBe(false);
    if (!result.parsed) {
      expect(result.hint).toMatch(hint);
      expect(result.hint).toContain("Reply like");
    }
  });
});

const ref = { machineId: MachineId.make("lab-a"), projectId: ProjectId.make("p1") };
const B1 = BatchId.make("B1");
const ask = (n: number, extra: Partial<Ask> = {}): Ask => ({
  askId: AskId.make(`A${n}`),
  projectRef: ref,
  kind: "decide",
  key: DecisionKey.make(`k.${n}`),
  class: "product",
  text: `Question ${n}?`,
  recommendation: `rec${n}`,
  blocks: "nothing",
  proceededOnRec: true,
  state: "open",
  batchId: B1,
  number: n,
  createdAt: "2026-10-17T09:00:00.000Z",
  ...extra,
});

const resolve = (raw: string, batch: ReadonlyArray<Ask>) => {
  const parsed = parseReply(raw);
  if (!parsed.parsed) throw new Error(parsed.hint);
  return resolvePlan(parsed.plan, "B1", batch.map((a) => ({ number: a.number!, ask: a })));
};
const summary = (raw: string, batch: ReadonlyArray<Ask>) => {
  const result = resolve(raw, batch);
  return result.ok
    ? result.actions.map((a) => (a.kind === "answer" ? `${a.number}=${a.value}` : `${a.number}:${a.kind}`))
    : result.hint;
};

describe("resolvePlan", () => {
  const money = ask(2, { class: "money", options: ["Team", "Free"], recommendation: "Free" });
  const { recommendation: _unused, ...todo } = ask(3, {
    kind: "do",
    class: "credential",
    steps: [{ text: "Create the token", where: "browser" }],
  });
  const batch = [ask(1), money, todo];

  it("accepts recommendations, picks options, takes free text", () => {
    expect(summary("1 go 2 a", batch)).toEqual(["1=rec1", "2=Team"]);
    expect(summary("1: my own", batch)).toEqual(["1=my own"]);
    expect(summary("3 done", batch)).toEqual(["3=done"]);
  });

  it("withdraws a rejected product ask but logs a rejected money ask as no", () => {
    expect(summary("1 nvm 2 no", batch)).toEqual(["1:withdraw", "2=no"]);
  });

  it("recs fine accepts every open item with a recommendation and leaves do-asks open", () => {
    expect(summary("recs fine", batch)).toEqual(["1=rec1", "2=Free"]);
    expect(summary("1 nvm recs fine", batch)).toEqual(["1:withdraw", "2=Free"]);
  });

  it("leaves items not mentioned open", () => {
    expect(summary("2 b", batch)).toEqual(["2=Free"]);
  });

  it("skips answered and moved items for recs, but refuses naming them", () => {
    const answered = ask(1, { state: "answered" });
    const moved = ask(2, { batchId: BatchId.make("B2") });
    expect(summary("recs fine", [answered, moved, todo])).toEqual([]);
    expect(summary("1 go", [answered, moved, todo])).toMatch(/Item 1 of B1 is already answered/u);
    expect(summary("2 go", [answered, moved, todo])).toMatch(/already moved/u);
  });

  it("refuses verbs that do not fit the item", () => {
    expect(summary("5 go", batch)).toMatch(/B1 has no item 5/u);
    expect(summary("1 c", batch)).toMatch(/Item 1 has no option c/u);
    expect(summary("2 c", batch)).toMatch(/Item 2 has no option c/u);
    expect(summary("3 go", batch)).toMatch(/do-ask/u);
    expect(summary("1 done", batch)).toMatch(/not a checklist/u);
  });

  it("all <verb> applies to every open item not mentioned", () => {
    expect(summary("1 go all later", batch)).toEqual(["1=rec1", "2:later", "3:later"]);
  });

  describe("approve and secret asks", () => {
    const { recommendation: _a, ...approve } = ask(4, {
      kind: "approve",
      class: "irreversible",
      gated: { argv: ["sh", "-c", "deploy"], cwd: "/w/p1", class: "irreversible", reason: "prod deploy", timeoutSec: 1800 },
    });
    const { recommendation: _s, ...secret } = ask(5, { kind: "secret", class: "credential", sink: "env:lab-a:/w/p1/.env" });
    const gated = [ask(1), approve, secret];

    it("takes go to run an approve ask and no or nvm to refuse it", () => {
      expect(summary("4 go", gated)).toEqual(["4=go"]);
      expect(summary("4 yes", gated)).toEqual(["4=go"]);
      expect(summary("4 no", gated)).toEqual(["4=no"]);
      expect(summary("4 nvm", gated)).toEqual(["4=no"]);
      expect(summary("4 later", gated)).toEqual(["4:later"]);
    });

    it("never approves or answers a secret in bulk", () => {
      expect(summary("recs fine", gated)).toEqual(["1=rec1"]);
      expect(summary("all go", gated)).toEqual(["1=rec1"]);
      expect(summary("all no", gated)).toEqual(["1:withdraw"]);
    });

    it("refuses anything else for them, and never takes a secret's value", () => {
      expect(summary("4: go ahead", gated)).toMatch(/"4 go" to run it or "4 no"/u);
      expect(summary("4 a", gated)).toMatch(/stored command/u);
      expect(summary("4 done", gated)).toMatch(/stored command/u);
      expect(summary("5: not-a-real-secret-123", gated)).toMatch(/Never put a secret in a reply/u);
      expect(summary("5: not-a-real-secret-123", gated)).not.toMatch(/not-a-real-secret-123/u);
      expect(summary("5 go", gated)).toMatch(/asks for a secret/u);
      expect(summary("5 no", gated)).toEqual(["5=no"]);
    });
  });
});
