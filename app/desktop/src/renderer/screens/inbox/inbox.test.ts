import { describe, expect, it } from "vitest";
import fixture from "../../../../fixtures/inbox/asks.json";
import type { Ask, HubEvent, InboxReplyOutput, Machine } from "../../../shared/contracts";
import { choices, displayLabel, humanizeKey } from "../../../shared/contracts/asks";
import { answerLabel, cardKey, cardOptions, cleanFreeText, pickLabel, replyFor, secretEnvLines, takesSkip } from "./ask";
import {
  answering,
  answeringAs,
  attentionItems,
  deliveredAt,
  emptyUi,
  needsYou,
  normalizeAsk,
  replied,
  secretSent,
  secretTarget,
  undone,
} from "./model";

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
    expect(choices(old).map(displayLabel)).toEqual([
      "public frozen PNG snapshot under an unguessable URL, served without login",
      "Public snapshot",
      "Image only",
    ]);
    expect(cardOptions(old).some((o) => o.detail !== undefined)).toBe(false);
    expect(humanizeKey("a-monthly-vs-week")).toBe("A monthly vs week");
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

describe("the inbox's own state over the data layer's asks", () => {
  const open = asks.map((a) => ({ ask: a }));
  const ids = (list: readonly Ask[] | undefined) => list?.map((a) => a.askId);
  const ok = (extra: Partial<InboxReplyOutput["applied"][number]>): InboxReplyOutput => ({
    parsed: true,
    applied: [{ askId: "A11", number: 1, outcome: "answered", ...extra }],
  });

  it("collapses an answer in place, opens a 10 s undo when the hub keeps one, and finds the receipt in the events", () => {
    const sent = answering(emptyUi, ask("A11"), { type: "option", key: "public-snapshot" });
    // The open copy (the layer still lists it until the hub's event) gives way to the collapsed one, in place.
    expect(ids(needsYou(open, sent))).toEqual(["A11", "A12", "A13", "A14", "A15", "A16", "A17"]);
    expect(needsYou(open, sent)?.filter((a) => a.askId === "A11")).toHaveLength(1);
    // Once the layer drops it, the answered one stays where it was.
    expect(ids(needsYou(open.slice(1), sent))).toEqual(["A11", "A12", "A13", "A14", "A15", "A16", "A17"]);
    const back = replied(sent, "A11", ok({ label: "A public snapshot link", undoUntil: "2026-10-19T10:30:10.000Z" }), 1_000);
    expect(back.answered.get("A11")).toMatchObject({ label: "A public snapshot link", undoBy: 11_000, deliveredAt: null, sending: false });
    const events: HubEvent[] = [
      { seq: 8, at: "2026-10-19T10:30:05.000Z", type: "ask.answered", summary: "", data: { askId: "A11" } },
      { seq: 9, at: "2026-10-19T10:30:11.000Z", type: "ask.delivered", summary: "", data: { askId: "A11", deliveredAt: "2026-10-19T10:30:11.500Z" } },
    ];
    expect(deliveredAt(events, "A11")).toBe("2026-10-19T10:30:11.500Z");
    expect(deliveredAt(events, "A12")).toBeUndefined();
  });

  it("is loading while the layer's asks are, and lists one order's asks for the order view", () => {
    expect(needsYou(undefined, emptyUi)).toBeUndefined();
    expect(ids(needsYou(open, emptyUi, { workstreamId: "W2" }))).toEqual(["A14", "A15", "A17"]);
    expect(ids(needsYou(open, emptyUi, { project: "devbox/storefront" }))).toHaveLength(7);
    expect(ids(needsYou(open, emptyUi, { project: "buildbox/api" }))).toEqual([]);
  });

  it("gives an answer without an undo window (an older hub, an approval) its receipt at once", () => {
    const sent = answering(emptyUi, ask("A14"), { type: "verb", verb: "go" });
    const back = replied(sent, "A14", { parsed: true, applied: [{ askId: "A14", outcome: "answered", decisionId: "D4" }] }, 5_000);
    expect(back.answered.get("A14")).toMatchObject({ label: "Approved", undoBy: null, deliveredAt: new Date(5_000).toISOString() });
  });

  it("reopens the card with the hub's hint when the reply is refused, and gives way to the open ask after an undo", () => {
    const sent = answering(emptyUi, ask("A12"), { type: "skip" });
    const refused = replied(sent, "A12", { parsed: false, applied: [], hint: "Item 2 is not open." }, 0);
    expect(refused.answered.has("A12")).toBe(false);
    expect(refused.errors.get("A12")).toBe("Item 2 is not open.");
    const taken = undone(replied(sent, "A12", ok({ askId: "A12", outcome: "skipped" }), 0), "A12");
    expect(taken.answered.get("A12")).toMatchObject({ undone: true, undoBy: null });
    // Not open in the layer yet: still the collapsed card ("Taking it back…"); open again: the open card.
    expect(needsYou(open.filter((i) => i.ask.askId !== "A12"), taken)?.some((a) => a.askId === "A12")).toBe(true);
    expect(needsYou(open, taken)?.filter((a) => a.askId === "A12")).toEqual([ask("A12")]);
  });

  it("names the project, never its id, and keeps loud events as attention items", () => {
    const projects = { "devbox/storefront": { title: "storefront" } } as never;
    const loud: HubEvent = {
      seq: 12,
      type: "thread.failed",
      at: "2026-10-19T10:29:00.000Z",
      machineId: "devbox",
      projectId: "storefront",
      summary: "An implementer stopped: the tests would not start.",
      attention: "loud",
    };
    const quiet: HubEvent = { seq: 13, at: "2026-10-19T10:29:30.000Z", type: "task.done", summary: "quiet" };
    expect(attentionItems({ attention: [loud], events: [loud, quiet], projects })).toEqual([
      { seq: 12, at: "2026-10-19T10:29:00.000Z", summary: "An implementer stopped: the tests would not start.", urgent: false, project: "storefront" },
    ]);
  });

  it("leaves an urgent ask's filing out, so an answered ask doesn't linger as worth a look", () => {
    const filed: HubEvent = {
      seq: 9,
      type: "ask.created",
      at: "2026-10-19T10:30:00.000Z",
      summary: "A3 [money] billing.team.trial: Free trial length for the Team plan?",
      attention: "urgent",
    };
    expect(attentionItems({ attention: [filed], events: [filed], projects: {} })).toEqual([]);
  });
});

describe("a secret ask's destination", () => {
  const secret = { ...ask("A11"), kind: "secret", sink: "env:devbox:/srv/storefront/.env", envName: "STRIPE_KEY" } as Ask;
  const key = "a".repeat(43) + "=";
  const machines = (m: Partial<Machine>): Record<string, Machine> => ({
    devbox: { machineId: "devbox", name: "devbox", status: "online", lastSeenAt: "", nodeVersion: "1", tags: [], ...m },
  });

  it("seals to the sink machine's key and says where the value lands", () => {
    expect(secretTarget(machines({ boxPubKey: key }), secret)).toEqual({
      ok: true,
      machine: "devbox",
      boxPubKey: key,
      where: "as STRIPE_KEY in /srv/storefront/.env on devbox",
    });
  });

  it("says why it can't be sent, with what to do, before anything is typed", () => {
    const cases: Array<[Record<string, Machine>, Ask, string]> = [
      [machines({}), secret, "Update fleetd on devbox"],
      [machines({ status: "offline", boxPubKey: key }), secret, "back online"],
      [{}, secret, "add that machine"],
      [machines({ boxPubKey: key }), { ...secret, sink: "env:devbox:relative" }, "with a destination"],
    ];
    for (const [state, a, fix] of cases) {
      const target = secretTarget(state, a);
      expect(target.ok).toBe(false);
      if (!target.ok) expect(target.fix).toContain(fix);
    }
  });
});

describe("the card's keys", () => {
  const press = (key: string, extra: Partial<Parameters<typeof cardKey>[0]> = {}) => ({
    key,
    code: /^[1-9]$/u.test(key) ? `Digit${key}` : key,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    ...extra,
  });
  const onCard = { inField: false, onButton: false };

  it("picks with 1–9 and N and confirms with Enter on the card", () => {
    expect(cardKey(press("3"), onCard)).toEqual({ kind: "pick", n: 3 });
    expect(cardKey(press("n"), onCard)).toEqual({ kind: "no" });
    expect(cardKey(press("Enter"), onCard)).toEqual({ kind: "enter" });
    expect(cardKey(press("Enter"), { inField: false, onButton: true })).toBeUndefined();
  });

  it("leaves every key typed in a field alone, so a secret or an answer keeps its 1s, ns and Enter", () => {
    for (const key of ["1", "n", "N", "Enter", "9"]) expect(cardKey(press(key), { inField: true, onButton: false })).toBeUndefined();
    expect(cardKey(press("2", { isComposing: true }), onCard)).toBeUndefined();
    expect(cardKey(press("2", { metaKey: true }), onCard)).toBeUndefined();
  });
});

describe("what an approval and a secret show", () => {
  it("names every secret an approved command gets, never a value", () => {
    const approve = ask("A14");
    if (approve.gated === undefined) throw new Error("A14 has no command");
    expect(secretEnvLines(approve.gated)).toEqual(["`DATABASE_URL` gets the secret `staging.db_url`"]);
    expect(secretEnvLines({ ...approve.gated, secretEnv: undefined } as never)).toEqual([]);
  });

  it("keeps the node's fingerprint for the receipt", () => {
    const sealed = answeringAs(emptyUi, ask("A17"), "Sealed and sent");
    expect(secretSent(sealed, "A17", 0, "ab12cd34").answered.get("A17")).toMatchObject({ fingerprint: "ab12cd34", sending: false });
  });
});
