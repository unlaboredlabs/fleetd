import { describe, expect, it } from "vitest";
import fixture from "../../../../fixtures/inbox/asks.json";
import { answerLabel, cardOptions, choices, cleanFreeText, humanizeKey, optionLabel, pickLabel, replyFor, takesSkip } from "./ask";
import type { Ask, InboxReplyOutput } from "./contracts";
import { answering, emptyInbox, needsYou, normalizeAsk, replied, undone, withAsks, withEvent, withSnapshot } from "./model";

const asks = fixture.asks as unknown as Ask[];
const ask = (id: string): Ask => {
  const found = asks.find((a) => a.askId === id);
  if (found === undefined) throw new Error(`no ${id} in the fixture`);
  return found;
};

describe("the card's options", () => {
  it("lists the recommendation first, once, with its reason, and the others with their consequences", () => {
    const options = cardOptions(ask("A11"));
    expect(options.map((o) => o.label)).toEqual(["A public snapshot link", "Copy the image only"]);
    expect(options[0]).toMatchObject({ recommended: true, reason: expect.stringContaining("frozen image") as unknown });
    expect(options[1]?.recommended).toBe(false);
    expect(options[1]?.reason).toBeUndefined();
    expect(options.every((o) => o.detail !== undefined)).toBe(true);
  });

  it("renders an old label-less ask: humanized keys, its free-text recommendation first, no consequences", () => {
    const old = ask("A13");
    expect(choices(old).map(optionLabel)).toEqual([
      "public frozen PNG snapshot under an unguessable URL, served without login",
      "Public snapshot",
      "Image only",
    ]);
    expect(cardOptions(old).some((o) => o.detail !== undefined)).toBe(false);
    expect(humanizeKey("a-monthly-vs-week")).toBe("Monthly vs week");
    // A hub from before labels sends the options as bare strings.
    const bare = normalizeAsk({ ...old, options: ["public-snapshot", "image-only"] } as unknown as Ask);
    expect(bare.options).toEqual([{ key: "public-snapshot" }, { key: "image-only" }]);
    expect(humanizeKey("Keep the old URL")).toBe("Keep the old URL");
  });

  it("gives approvals and checklists their two plain answers and no Skip", () => {
    expect(cardOptions(ask("A14")).map((o) => o.label)).toEqual(["Approve", "Deny"]);
    expect(cardOptions(ask("A15")).map((o) => o.label)).toEqual(["Done", "Won't do it"]);
    expect(takesSkip(ask("A14"))).toBe(false);
    expect(takesSkip(ask("A11"))).toBe(true);
  });
});

describe("the reply each pick sends (grammar.rs)", () => {
  it("answers the recommendation with go and other options by their letter in the stored order", () => {
    const a = ask("A11");
    expect(replyFor(a, { type: "option", key: "public-snapshot" })).toBe("1 go");
    // image-only is options[0] even though the card lists it second.
    expect(replyFor(a, { type: "option", key: "image-only" })).toBe("1 a");
    expect(replyFor(ask("A13"), { type: "option", key: "image-only" })).toBe("3 b");
  });

  it("sends free text on one line without the separators that would end it early", () => {
    expect(replyFor(ask("A12"), { type: "text", text: "  weekly;\nbut show both  " })).toBe("2: weekly, but show both");
    expect(replyFor(ask("A12"), { type: "text", text: " \n " })).toBeNull();
    expect(cleanFreeText("x".repeat(2500))).toHaveLength(2000);
  });

  it("skips, approves and ticks done", () => {
    expect(replyFor(ask("A12"), { type: "skip" })).toBe("2 skip");
    expect(replyFor(ask("A14"), { type: "verb", verb: "go" })).toBe("4 go");
    expect(replyFor(ask("A15"), { type: "verb", verb: "done" })).toBe("5 done");
    expect(replyFor({ ...ask("A11"), number: undefined } as unknown as Ask, { type: "skip" })).toBeNull();
  });

  it("says what was chosen in the human's words", () => {
    expect(pickLabel(ask("A12"), { type: "skip" })).toBe("Skipped for now (lead keeps: Monthly plan vs this week's usage)");
    expect(pickLabel(ask("A14"), { type: "verb", verb: "no" })).toBe("Denied");
    const answer = { value: "prorated", by: "human:mac", at: "2026-10-19T10:30:00.000Z", raw: "2 b", kind: "option" as const };
    expect(answerLabel(ask("A12"), answer)).toBe("Prorate the plan to the week");
  });
});

describe("the inbox state", () => {
  const loaded = withAsks(withSnapshot(emptyInbox, { cursor: 1, projects: fixture.projects, attention: [] }), asks);
  const ok = (extra: Partial<InboxReplyOutput["applied"][number]>): InboxReplyOutput => ({
    parsed: true,
    applied: [{ askId: "A11", number: 1, outcome: "answered", ...extra }],
  });

  it("collapses an answer in place, opens a 10 s undo when the hub keeps one, and shows the receipt", () => {
    const sent = answering(loaded, ask("A11"), { type: "option", key: "public-snapshot" });
    expect(sent.open.map((a) => a.askId)).not.toContain("A11");
    expect(needsYou(sent).map((a) => a.askId)).toEqual(["A11", "A12", "A13", "A14", "A15", "A16"]);
    const back = replied(sent, "A11", ok({ label: "A public snapshot link", undoUntil: "2026-10-19T10:30:10.000Z" }), 1_000);
    expect(back.answered.get("A11")).toMatchObject({ label: "A public snapshot link", undoBy: 11_000, deliveredAt: null, sending: false });
    // A fetch that was already in flight still lists it: it stays collapsed.
    expect(withAsks(back, asks).open.map((a) => a.askId)).not.toContain("A11");
    const delivered = withEvent(back, {
      seq: 9,
      type: "ask.delivered",
      data: { askId: "A11", deliveredAt: "2026-10-19T10:30:11.000Z" },
    });
    expect(delivered.answered.get("A11")).toMatchObject({ undoBy: null, deliveredAt: "2026-10-19T10:30:11.000Z" });
  });

  it("gives an answer without an undo window (an older hub, an approval) its receipt at once", () => {
    const sent = answering(loaded, ask("A14"), { type: "verb", verb: "go" });
    const back = replied(sent, "A14", { parsed: true, applied: [{ askId: "A14", outcome: "answered", decisionId: "D4" }] }, 5_000);
    expect(back.answered.get("A14")).toMatchObject({ label: "Approved", undoBy: null, deliveredAt: new Date(5_000).toISOString() });
  });

  it("reopens the card with the hub's hint when the reply is refused, and after an undo", () => {
    const sent = answering(loaded, ask("A12"), { type: "skip" });
    const refused = replied(sent, "A12", { parsed: false, applied: [], hint: "Item 2 is not open." }, 0);
    expect(refused.open.map((a) => a.askId)).toEqual(["A11", "A12", "A13", "A14", "A15", "A16"]);
    expect(refused.errors.get("A12")).toBe("Item 2 is not open.");
    const reopened = undone(replied(sent, "A12", ok({ askId: "A12", outcome: "skipped" }), 0), ask("A12"));
    expect(reopened.answered.has("A12")).toBe(false);
    expect(reopened.open.map((a) => a.askId)).toContain("A12");
  });

  it("names the project, never its id, and keeps loud events as attention items", () => {
    expect(loaded.projects.get("devbox/storefront")).toBe("storefront");
    const next = withEvent(loaded, {
      seq: 12,
      type: "thread.failed",
      at: "2026-10-19T10:29:00.000Z",
      machineId: "devbox",
      projectId: "storefront",
      summary: "An implementer stopped: the tests would not start.",
      attention: "loud",
    });
    expect(next.attention).toEqual([
      { seq: 12, at: "2026-10-19T10:29:00.000Z", summary: "An implementer stopped: the tests would not start.", urgent: false, project: "storefront" },
    ]);
    expect(withEvent(next, { seq: 13, type: "task.done", summary: "quiet" })).toBe(next);
  });
});
