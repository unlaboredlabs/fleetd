import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../src/data/chat";
import type { ChatMessage } from "../../src/data/chat-contract";
import { arrivalsOf, authorLabel, chatRows, ENTER_MS, dayLabel, heldLabel, latestLabel, newestKey, rowIndexOf, type Row } from "./model";

const at = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, d, h, m)).toISOString();
const NOW = Date.parse(at(19, 18));
const item = (id: string, author: ChatItem["author"], time: string, over: Partial<ChatItem> = {}): ChatItem => ({
  id,
  author,
  kind: "message",
  text: `text ${id}`,
  at: time,
  attachments: [],
  state: "sent",
  ...over,
});
const rows = (items: ChatItem[], over: Partial<Parameters<typeof chatRows>[0]> = {}) =>
  chatRows({ items, hasOlder: false, loadingOlder: false, nowMs: NOW, timeZone: "UTC", ...over });

describe("the chat's rows", () => {
  it("divide days, show an author once per run and fleetd's own messages as one-liners", () => {
    const r = rows([
      item("a", "lead", at(18, 9)),
      item("b", "lead", at(19, 9)),
      item("c", "lead", at(19, 9, 3)),
      item("d", "system", at(19, 9, 4), { kind: "event", text: "Woken: the human sent a message." }),
      item("e", "lead", at(19, 9, 5)),
      item("f", "lead", at(19, 9, 30)),
    ]);
    expect(r.map((x) => (x.kind === "message" ? `${x.kind}:${x.item.id}:${x.head ? "head" : "-"}` : x.kind === "day" ? `day:${x.label}` : x.kind))).toEqual([
      "top",
      "day:Yesterday",
      "message:a:head",
      "day:Today",
      "message:b:head",
      "message:c:-",
      "event",
      "message:e:head",
      "message:f:head",
    ]);
    expect(rows([])[0]).toEqual({ kind: "top", key: "top", state: "start" });
    expect(rows([], { hasOlder: true })[0]).toMatchObject({ state: "more" });
    expect(rows([], { hasOlder: true, loadingOlder: true })[0]).toMatchObject({ state: "loading" });
  });

  it("never show a held chat as current: offline, or connected before it is read again", () => {
    expect(rows([], { hasOlder: true, held: true, offline: true })[0]).toMatchObject({ state: "held" });
    // Connected, not read yet (or the read failed): never "once you're connected" while connected.
    expect(rows([], { hasOlder: true, held: true, offline: false })[0]).toMatchObject({ state: "reread" });
    expect(heldLabel(true, "as of 09:02")).toBe("Offline, as of 09:02");
    expect(heldLabel(false, "as of 09:02")).toBe("Last known, as of 09:02");
    expect(heldLabel(false, undefined)).toBe("Last known");
  });

  it("name who wrote each message from its key, and start a new run when that changes", () => {
    const hub = (author: "human" | "agent", over: Record<string, string>) =>
      ({ messageId: "m", projectRef: { machineId: "devbox", projectId: "app" }, seq: 1, author, text: "", createdAt: at(19, 9), state: "final", ...over }) as const;
    const r = rows([
      item("a", "human", at(19, 9)),
      item("b", "human", at(19, 9, 1), { message: hub("human", { client: "cli" }) }),
      item("c", "agent", at(19, 9, 2), { message: hub("agent", { by: "nightly-ci" }) }),
      item("d", "agent", at(19, 9, 3), { message: hub("agent", { by: "scout" }) }),
      item("e", "agent", at(19, 9, 4), { message: hub("agent", { by: "scout" }) }),
    ]);
    const shown = r.flatMap((x) => (x.kind === "message" ? [`${x.item.id}:${x.head ? authorLabel(x.item) : "-"}:${x.run ? "run" : "-"}`] : []));
    // Yours have no header (where you wrote shows on the receipt), but still start a run apart from the lead's.
    expect(shown).toEqual(["a:-:run", "b:-:-", "c:Agent · nightly-ci:run", "d:Agent · scout:run", "e:-:-"]);
  });

  it("mark where you stopped reading, at the first message from someone else since", () => {
    const seq = (id: string, author: ChatItem["author"], n: number, m = n, over: Partial<ChatItem> = {}) =>
      item(id, author, at(19, 9, m), { ...over, message: { seq: n } as ChatItem["message"] });
    const items = [seq("a", "lead", 1), seq("b", "human", 2), seq("c", "human", 3), seq("d", "system", 4, 4, { kind: "event" }), seq("e", "lead", 5)];
    const kinds = (r: readonly Row[]) => r.flatMap((x) => (x.kind === "new" ? ["new"] : "item" in x ? [x.item.id] : []));
    // Your own messages since aren't news; the event after them is.
    expect(kinds(rows(items, { seenSeq: 1 }))).toEqual(["a", "b", "c", "new", "d", "e"]);
    expect(kinds(rows(items, { seenSeq: 4 }))).toEqual(["a", "b", "c", "d", "new", "e"]);
    // The first new message shows who wrote it, even in a run.
    const run = [seq("x", "lead", 1), seq("y", "lead", 2)];
    expect(rows(run, { seenSeq: 1 }).find((x) => x.kind === "message" && x.item.id === "y")).toMatchObject({ head: true });
    expect(rows(run).find((x) => x.kind === "message" && x.item.id === "y")).toMatchObject({ head: false });
    expect(kinds(rows(items, {})).includes("new")).toBe(false);
    // The pages loaded don't reach back to what you saw: no divider until they do.
    expect(kinds(rows(items.slice(2), { seenSeq: 1, hasOlder: true })).includes("new")).toBe(false);
    expect(kinds(rows(items.slice(1), { seenSeq: 1, hasOlder: false }))).toEqual(["b", "c", "new", "d", "e"]);
  });

  it("offer the way back to the newest message only while scrolled up, counting what arrived below", () => {
    const before = rows([item("a", "human", at(19, 9)), item("b", "lead", at(19, 9, 1))], { activity: true });
    const from = newestKey(before);
    expect(from).toBe("b");
    expect(latestLabel(before, undefined)).toBeUndefined();
    expect(latestLabel(before, from)).toBe("Latest");
    // Two from the lead and an event arrive, and yours, which you know about; an older page loads above.
    const after = rows([
      item("o", "lead", at(19, 8)),
      item("a", "human", at(19, 9)),
      item("b", "lead", at(19, 9, 1)),
      item("c", "lead", at(19, 9, 2)),
      item("d", "human", at(19, 9, 3)),
      item("e", "system", at(19, 9, 4), { kind: "event" }),
      item("f", "lead", at(19, 9, 5), { state: "streaming" }),
    ]);
    expect(latestLabel(after, from)).toBe("3 new");
    expect(latestLabel(rows([]), newestKey(rows([])))).toBe("Latest");
  });

  it("put the lead's activity after the newest item, never under a reply still streaming", () => {
    const r = rows([item("a", "lead", at(19, 9)), item("d", "system", at(19, 9, 3), { kind: "event", text: "#12 merged" })]);
    expect(rowIndexOf(r, "d")).toBe(3);
    // Under its reply, and once asked again, under the person's message.
    const lead = [item("a", "human", at(19, 9)), item("b", "lead", at(19, 9, 1))];
    expect(rows(lead, { activity: true }).slice(-2).map((x) => x.kind)).toEqual(["message", "activity"]);
    const asked = [...lead, item("c", "human", at(19, 9, 2))];
    expect(rows(asked, { activity: true }).slice(-3).map((x) => x.kind)).toEqual(["message", "message", "activity"]);
    expect(rows([], { activity: true }).map((x) => x.kind)).toEqual(["top", "activity"]);
    const streaming = [item("a", "human", at(19, 9)), item("b", "lead", at(19, 9, 1), { state: "streaming" })];
    expect(rows(streaming, { activity: true }).some((x) => x.kind === "activity")).toBe(false);
    expect(rowIndexOf(r, "nope")).toBeUndefined();
  });

  it("put how long the lead worked under the reply its turn ended with", () => {
    const turn = Date.parse(at(19, 9));
    const lead = [item("a", "human", at(19, 9)), item("b", "lead", at(19, 9, 3)), item("c", "system", at(19, 9, 4), { kind: "event" })];
    const kinds = (r: ReturnType<typeof rows>) => r.map((x) => (x.kind === "message" ? `message:${x.item.id}` : x.kind));
    expect(kinds(rows(lead, { workedSince: turn })).slice(-3)).toEqual(["message:b", "activity", "event"]);
    // A person's message after it, waiting for the next turn: the line stays with the reply.
    expect(kinds(rows([...lead, item("d", "human", at(19, 9, 5))], { workedSince: turn })).slice(3)).toEqual(["message:b", "activity", "event", "message:d"]);
    // The lead's newest reply is older than the turn: it didn't write in it, so no line claims it.
    expect(rows(lead, { workedSince: turn + 600_000 }).some((x) => x.kind === "activity")).toBe(false);
  });

  it("place a row whose time doesn't parse under today, rather than throwing", () => {
    // Intl throws a RangeError on an invalid date; a reply streaming ahead of its message once had "".
    const r = rows([item("a", "lead", at(18, 9)), item("s", "lead", "", { state: "streaming" })]);
    expect(r.map((x) => (x.kind === "day" ? `day:${x.label}` : x.kind === "message" ? `message:${x.item.id}` : x.kind))).toEqual([
      "top",
      "day:Yesterday",
      "message:a",
      "day:Today",
      "message:s",
    ]);
  });

  it("show history from before the chat as the conversation it was, under one divider", () => {
    const old = (id: string, author: ChatItem["author"], time: string): ChatItem =>
      item(id, author, time, { kind: "event", message: { history: "order" } as ChatItem["message"] });
    const r = rows([old("h1", "human", at(19, 8)), old("h2", "lead", at(19, 8, 1)), item("n1", "human", at(19, 9))]);
    expect(r.map((x) => (x.kind === "message" ? `${x.item.id}:${x.history ? "history" : "now"}` : x.kind))).toEqual([
      "top",
      "history",
      "day",
      "h1:history",
      "h2:history",
      "n1:now",
    ]);
  });

  it("draw a run as one stack, ending where the author changes, and put the time over a long pause", () => {
    const r = rows([
      item("a", "lead", at(19, 9)),
      item("b", "lead", at(19, 9, 1)),
      item("c", "human", at(19, 9, 2)),
      item("d", "human", at(19, 11, 30)),
      item("e", "lead", at(19, 11, 31)),
    ]);
    expect(r.map((x) => (x.kind === "message" ? `${x.item.id}:${x.run ? "run" : "-"}:${x.end ? "end" : "-"}` : x.kind === "time" ? `time:${x.label}` : x.kind))).toEqual([
      "top",
      "day",
      "a:run:-",
      "b:-:end",
      "c:run:end",
      "time:11:30",
      "d:run:end",
      "e:run:end",
    ]);
  });

  it("link your reply to the bubble it quotes, and an ask to the button you pressed", () => {
    const ask = item("a", "lead", at(19, 9, 1), {
      text: "```fleetd-block\n{}\n```",
      message: { parts: [{ start: 0, end: 22, block: { v: 1, kind: "ask", question: "Merge?" } }] } as unknown as ChatItem["message"],
    });
    const r = rows([item("q", "lead", at(19, 9)), ask, item("b", "human", at(19, 9, 2), { text: "> text q\n\nyes" }), item("c", "human", at(19, 9, 3), { text: "Approve" })]);
    const msg = (id: string) => r.find((x) => x.kind === "message" && x.item.id === id);
    expect(msg("b")).toMatchObject({ reply: { quote: "text q", body: "yes", target: "q" } });
    expect(msg("a")).toMatchObject({ answered: { "0": "Approve" } });
  });

  it("link a reply to the message its replyTo names, over an older one its quote matches too", () => {
    const named = { replyTo: { messageId: "p", part: 0 } } as unknown as ChatItem["message"];
    const r = rows([item("p", "lead", at(19, 9), { text: "same" }), item("q", "lead", at(19, 9, 1), { text: "same" }), item("b", "human", at(19, 9, 2), { text: "> same\n\nyes", message: named })]);
    expect(r.find((x) => x.kind === "message" && x.item.id === "b")).toMatchObject({ reply: { quote: "same", body: "yes", target: "p" } });
  });

  it("word days plainly", () => {
    expect(dayLabel(at(19, 1), NOW, "UTC")).toBe("Today");
    expect(dayLabel(at(18, 1), NOW, "UTC")).toBe("Yesterday");
    expect(dayLabel(at(12, 1), NOW, "UTC")).toBe("Mon 12 Oct");
    expect(dayLabel(new Date(Date.UTC(2025, 2, 3)).toISOString(), NOW, "UTC")).toBe("Mon 3 Mar 2025");
  });
});

describe("what enters with motion", () => {
  /** A hub message at `seq`. */
  const hub = (id: string, seq: number, author: ChatItem["author"] = "lead", over: Partial<ChatItem> = {}) =>
    item(id, author, at(19, 9), { message: { messageId: id, seq } as ChatMessage, ...over });
  const entering = (a: ReturnType<typeof arrivalsOf>) => Object.fromEntries([...a.entering].map(([k, v]) => [k, v.step]));

  it("opens still, then a lead reply and your send each enter once, a step apart when they come together", () => {
    const opened = arrivalsOf(undefined, [hub("a", 1), hub("b", 2, "human")], true, NOW);
    expect(entering(opened)).toEqual({});
    const next = arrivalsOf(opened, [hub("a", 1), hub("b", 2, "human"), hub("c", 3), hub("d", 4)], true, NOW + 10);
    expect(entering(next)).toEqual({ c: 0, d: 1 });
    const send = item("r1", "human", at(19, 9), { state: "pending", clientRequestId: "r1" });
    const sent = arrivalsOf(next, [...next.items, send], true, NOW + 20);
    expect(sent.entering.get("r1")).toEqual({ at: NOW + 20, step: 0 });
    // Updated again (the receipt), nothing enters twice.
    expect(arrivalsOf(sent, [...sent.items], true, NOW + 30).entering).toEqual(sent.entering);
  });

  it("keeps your send's row as the hub echoes it under its own id, so it doesn't enter again", () => {
    const opened = arrivalsOf(undefined, [hub("a", 1)], true, NOW);
    const send = item("r1", "human", at(19, 9), { state: "pending", clientRequestId: "r1" });
    const sent = arrivalsOf(opened, [hub("a", 1), send], true, NOW + 10);
    const copy = hub("m1", 2, "human", { clientRequestId: "r1" });
    const echoed = arrivalsOf(sent, [hub("a", 1), copy], true, NOW + 50);
    expect(entering(echoed)).toEqual({ r1: 0 });
    expect(echoed.entering.get("r1")).toBe(sent.entering.get("r1"));
    // One row, under one key, from the send to the hub's copy: the list keeps its element and its measured height.
    const keys = (items: ChatItem[]) => chatRows({ items, hasOlder: false, loadingOlder: false, nowMs: NOW }).filter((r) => r.kind === "message").map((r) => r.key);
    expect(keys([hub("a", 1), copy])).toEqual(keys([hub("a", 1), send]));
  });

  it("enters a streamed reply as the lead starts writing, and its text again once written", () => {
    const opened = arrivalsOf(undefined, [hub("a", 1)], true, NOW);
    const writing = arrivalsOf(opened, [hub("a", 1), item("s", "lead", at(19, 9), { state: "streaming" })], true, NOW + 10);
    expect(writing.entering.get("s")?.at).toBe(NOW + 10);
    const more = arrivalsOf(writing, [hub("a", 1), hub("s", 2, "lead", { state: "streaming", text: "more" })], true, NOW + 20);
    expect(more.entering.get("s")?.at).toBe(NOW + 10);
    const done = arrivalsOf(more, [hub("a", 1), hub("s", 2)], true, NOW + 900);
    expect(done.entering.get("s")?.at).toBe(NOW + 900);
  });

  it("shows older pages loading above, and fleetd's one-liners and history, still", () => {
    const opened = arrivalsOf(undefined, [hub("c", 10), hub("d", 11)], true, NOW);
    const older = arrivalsOf(opened, [hub("a", 8), hub("b", 9), hub("c", 10), hub("d", 11)], true, NOW + 10);
    expect(entering(older)).toEqual({});
    const quiet = arrivalsOf(
      older,
      [...older.items, hub("e", 12, "system", { kind: "event" }), hub("f", 13, "lead", { message: { messageId: "f", seq: 13, history: {} } as ChatMessage })],
      true,
      NOW + 20,
    );
    expect(entering(quiet)).toEqual({});
  });

  it("shows what a drop and the reconnect's page bring still, and enters what comes after", () => {
    const opened = arrivalsOf(undefined, [hub("a", 1)], true, NOW);
    const dropped = arrivalsOf(opened, [hub("a", 1)], false, NOW + 10);
    const sendHeld = arrivalsOf(dropped, [hub("a", 1), item("r1", "human", at(19, 9), { state: "queued", clientRequestId: "r1" })], false, NOW + 20);
    const back = arrivalsOf(sendHeld, [hub("a", 1), hub("b", 2), hub("c", 3), hub("m1", 4, "human", { clientRequestId: "r1" })], true, NOW + 30);
    expect(entering(back)).toEqual({});
    expect(entering(arrivalsOf(back, [...back.items, hub("d", 5)], true, NOW + 40))).toEqual({ d: 0 });
  });

  it("lets an arrival go once its motion is long over", () => {
    const opened = arrivalsOf(undefined, [hub("a", 1)], true, NOW);
    const next = arrivalsOf(opened, [hub("a", 1), hub("b", 2)], true, NOW);
    expect(entering(arrivalsOf(next, [hub("a", 1), hub("b", 2), hub("c", 3)], true, NOW + ENTER_MS))).toEqual({ c: 0 });
  });
});
