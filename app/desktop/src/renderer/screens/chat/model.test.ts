import { describe, expect, it } from "vitest";
import type { Steer, Workstream } from "../../../shared/contracts";
import type { ChatItem } from "../../src/data/chat";
import { leadSteers, steerReceipt } from "../live/steerModel";
import { authorLabel, chatRows, dayLabel, heldLabel, latestLabel, newestKey, ordersInView, rowIndexOf, type Row } from "./model";

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
  chatRows({ items, hasOlder: false, loadingOlder: false, strip: false, nowMs: NOW, timeZone: "UTC", ...over });

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

  it("put the live strip under the lead's newest message and after the field that answers it, never between them", () => {
    const r = rows(
      [
        item("a", "lead", at(19, 9)),
        item("b", "human", at(19, 9, 1)),
        item("c", "lead", at(19, 9, 2), { state: "streaming" }),
        item("d", "system", at(19, 9, 3), { kind: "event", text: "#12 merged" }),
        item("e", "lead", at(19, 9, 4), { kind: "secret" }),
      ],
      { strip: true },
    );
    expect(r.map((x) => x.kind)).toEqual(["top", "day", "message", "message", "message", "event", "inline", "strip"]);
    expect(rows([item("a", "human", at(19, 9))], { strip: true }).at(-1)?.kind).toBe("strip");
    expect(rowIndexOf(r, "d")).toBe(5);
    // A reply after the field: the strip stays under the lead's message, before the reply.
    const replied = rows(
      [item("a", "lead", at(19, 9)), item("b", "lead", at(19, 9, 1), { kind: "gated" }), item("c", "human", at(19, 9, 2)), item("d", "lead", at(19, 9, 3), { kind: "secret" })],
      { strip: true },
    );
    expect(replied.map((x) => x.kind)).toEqual(["top", "day", "message", "inline", "strip", "message", "inline"]);
    // The lead's activity goes after the newest item: under its reply, ahead of the strip there.
    const lead = [item("a", "human", at(19, 9)), item("b", "lead", at(19, 9, 1))];
    expect(rows(lead, { strip: true, activity: true }).slice(-3).map((x) => x.kind)).toEqual(["message", "activity", "strip"]);
    // Asked again: under the person's message, the strip staying under the lead's reply.
    const asked = [...lead, item("c", "human", at(19, 9, 2))];
    expect(rows(asked, { strip: true, activity: true }).slice(-4).map((x) => x.kind)).toEqual(["message", "strip", "message", "activity"]);
    expect(rows([], { activity: true }).map((x) => x.kind)).toEqual(["top", "activity"]);
    const streaming = [item("a", "human", at(19, 9)), item("b", "lead", at(19, 9, 1), { state: "streaming" })];
    expect(rows(streaming, { activity: true }).some((x) => x.kind === "activity")).toBe(false);
    expect(rowIndexOf(r, "nope")).toBeUndefined();
  });

  it("put how long the lead worked under the reply its turn ended with", () => {
    const turn = Date.parse(at(19, 9));
    const lead = [item("a", "human", at(19, 9)), item("b", "lead", at(19, 9, 3)), item("c", "system", at(19, 9, 4), { kind: "event" })];
    const kinds = (r: ReturnType<typeof rows>) => r.map((x) => (x.kind === "message" ? `message:${x.item.id}` : x.kind));
    expect(kinds(rows(lead, { strip: true, workedSince: turn })).slice(-4)).toEqual(["message:b", "activity", "strip", "event"]);
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

  it("word days plainly", () => {
    expect(dayLabel(at(19, 1), NOW, "UTC")).toBe("Today");
    expect(dayLabel(at(18, 1), NOW, "UTC")).toBe("Yesterday");
    expect(dayLabel(at(12, 1), NOW, "UTC")).toBe("Mon 12 Oct");
    expect(dayLabel(new Date(Date.UTC(2025, 2, 3)).toISOString(), NOW, "UTC")).toBe("Mon 3 Mar 2025");
  });
});

describe("your steers to the lead", () => {
  const steer = (n: number, time: string, stage: Steer["stage"], over: Partial<Steer> = {}): Steer => ({
    id: `S${String(n)}`,
    target: { workstreamId: "W1" },
    workstreamId: "W1",
    thread: { machineId: "devbox", threadId: "lead" },
    runId: `r${String(n)}`,
    by: { kind: "human", keyName: "laptop" },
    mode: "now",
    text: `steer ${String(n)}`,
    stage,
    queuedAt: time,
    ...over,
  });
  const shown = (r: readonly Row[]) =>
    r.flatMap((x) =>
      x.kind === "steer" ? [`steer:${x.steer.id}:${steerReceipt(x.steer).line}`] : x.kind === "message" ? [`message:${x.item.id}`] : x.kind === "activity" ? ["activity"] : [],
    );

  it("show in the chat at their time with their receipt; a steer to one of its agents, or the lead's own, never", () => {
    // order_get lists them newest first, across the project's orders; this window's send waits for the list.
    const listed = [
      steer(4, at(19, 9, 20), "withdrawn"),
      steer(3, at(19, 9, 15), "queued", { target: { taskId: "T1" } }),
      steer(2, at(19, 9, 10), "acknowledged", { ackExcerpt: "Shipping the card first." }),
      steer(1, at(19, 9, 12), "delivered", { by: { kind: "lead" } }),
    ];
    const sent = [steer(5, at(19, 9, 40), "queued")];
    const items = [item("a", "human", at(19, 9)), item("b", "lead", at(19, 9, 5)), item("c", "lead", at(19, 9, 30))];
    expect(shown(rows(items, { steers: leadSteers(listed, sent), activity: true }))).toEqual([
      "message:a",
      "message:b",
      "steer:S2:Acknowledged",
      "steer:S4:Withdrawn: it never saw this",
      "message:c",
      "steer:S5:Stopping its current step…",
      "activity",
    ]);
    // The hub's answer replaces what the window kept from its send.
    expect(leadSteers([steer(5, at(19, 9, 40), "delivered", { how: "stopped" })], sent).map((x) => x.stage)).toEqual(["delivered"]);
  });

  it("wait for their page, and aren't shown twice beside the chat's history from before it existed", () => {
    const items = [item("b", "lead", at(19, 9, 5)), item("c", "lead", at(19, 9, 30))];
    const steers = [steer(1, at(19, 9), "acknowledged"), steer(2, at(19, 9, 10), "delivered"), steer(3, at(19, 9, 40), "delivered")];
    expect(shown(rows(items, { steers, hasOlder: true }))).toEqual(["message:b", "steer:S2:Delivered", "message:c", "steer:S3:Delivered"]);
    const copy = item("h", "human", at(19, 9, 10), { kind: "event", text: "steer 2", message: { messageId: "h", projectRef: { machineId: "devbox", projectId: "app" }, seq: 1, author: "human", text: "steer 2", createdAt: at(19, 9, 10), state: "final", history: "steer" } });
    expect(shown(rows([copy, ...items], { steers: [steers[1] as Steer] })).filter((x) => x.startsWith("steer"))).toEqual([]);
  });

  it("are read from the open orders, and from those that ended within the pages", () => {
    const w = (id: string, created: string, updated: string, state: Workstream["state"]) => ({ workstreamId: id, createdAt: created, updatedAt: updated, state }) as Workstream;
    const listed = [w("W4", at(19, 12), at(19, 13), "done"), w("W3", at(19, 8), at(19, 10), "done"), w("W2", at(18, 8), at(18, 9), "stopped"), w("W1", at(17, 8), at(17, 9), "running")];
    expect(ordersInView(["W9"], listed, undefined)).toEqual(["W1", "W2", "W3", "W4", "W9"]);
    expect(ordersInView(["W9"], listed, at(19, 9))).toEqual(["W1", "W3", "W4", "W9"]);
  });
});
