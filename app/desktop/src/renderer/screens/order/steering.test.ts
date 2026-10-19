// Regressions from #187's review: a steer cut off by the link is never "not sent" and never shows twice; a
// redirect can't send twice; a jump to a tool call opens its fold and lights the call.
import { describe, expect, it } from "vitest";
import type { Steer, TailItem } from "./contracts";
import { buildConversation, entryIndexAt, jumpTarget, type Entry } from "./conversation";
import { emptyOrder, orderReducer, type OrderAction, type OrderData } from "./data";
import { reconnectWatcher, redirectId, redirecting, type Sending } from "./sending";

const T0 = "2026-10-19T09:00:00.000Z";
const later = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
const row = (requestId: string, text: string, over: Partial<Sending> = {}): Sending => ({
  requestId,
  target: { workstreamId: "W1" },
  workstreamId: "W1",
  text,
  mode: "queue",
  at: T0,
  state: { t: "sending" },
  ...over,
});
const steer = (id: string, text: string, over: Partial<Steer> = {}): Steer => ({
  id,
  target: { workstreamId: "W1" },
  workstreamId: "W1",
  thread: { machineId: "devbox", threadId: "t-lead" },
  runId: `run-${id}`,
  by: { kind: "human", keyName: "your console" },
  mode: "queue",
  text,
  stage: "delivered",
  queuedAt: later(1),
  ...over,
});
const run = (actions: readonly OrderAction[]): OrderData => actions.reduce(orderReducer, emptyOrder("W1"));
const conv = (d: OrderData, extra: Partial<Parameters<typeof buildConversation>[0]> = {}): Entry[] =>
  buildConversation({ tail: [], workstreamId: "W1", events: [], leadWorking: false, steers: d.steers, sending: d.sending, lanes: [], ...extra });
const says = (c: Entry[]) => c.filter((e) => e.kind === "say");
const lineOf = (e: Entry | undefined) => (e?.kind === "say" ? e.receipt?.line : undefined);

describe("a steer the link cut off", () => {
  const words = "skip the docs page";
  const cut: OrderAction[] = [
    { t: "sending", s: row("crid-1", words) },
    { t: "sent", requestId: "crid-1", result: { ok: false, code: "disconnected", message: "the link to the hub dropped" } },
  ];

  it("waits to be sent again, and is never called not sent", () => {
    const d = run(cut);
    expect(d.sending).toHaveLength(1);
    expect(d.sending[0]?.state.t).toBe("reconnecting");
    expect(lineOf(says(conv(d))[0])).toMatch(/^sending… \(reconnecting/);
    expect(lineOf(says(conv(d))[0])).not.toMatch(/not sent/);
  });

  it("shows once when the hub turns out to have it, before and after the resend answers", () => {
    // The snapshot's steers_list refetch lands first: the hub has it as S12.
    const refetched = run([...cut, { t: "steers", steers: [steer("S12", words)] }]);
    expect(says(conv(refetched)).map((e) => e.text)).toEqual([words]);
    expect(lineOf(says(conv(refetched))[0])).toMatch(/^S12 · delivered/);
    // The resend with the same id: the hub dedupes and answers with the stored S12.
    const resent = run([
      ...cut,
      { t: "steers", steers: [steer("S12", words)] },
      { t: "sending", s: row("crid-1", words) },
      { t: "sent", requestId: "crid-1", result: { ok: true, steer: steer("S12", words) } },
    ]);
    expect(resent.sending).toHaveLength(0);
    expect(resent.steers.map((s) => s.id)).toEqual(["S12"]);
    expect(says(conv(resent))).toHaveLength(1);
  });

  it("is resent only after the link was really lost, with its own id", () => {
    const watch = reconnectWatcher();
    const rows = run(cut).sending;
    expect(watch({ t: "snapshot" }, rows)).toEqual([]);
    expect(watch({ t: "state", state: { phase: "retrying" } }, rows)).toEqual([]);
    const again = watch({ t: "snapshot" }, rows);
    expect(again.map((r) => r.requestId)).toEqual(["crid-1"]);
    expect(watch({ t: "snapshot" }, rows)).toEqual([]);
  });

  it("is not sent only when the hub refuses it, with the hub's words behind Details", () => {
    const d = run([
      { t: "sending", s: row("crid-2", words) },
      { t: "sent", requestId: "crid-2", result: { ok: false, code: "forbidden", message: "keys of kind agent can't steer" } },
    ]);
    const e = says(conv(d))[0];
    expect(e?.kind === "say" && e.receipt).toMatchObject({ stage: "not_sent", tone: "bad", detail: "keys of kind agent can't steer" });
    expect(lineOf(e)).not.toContain("keys of kind");
  });

  it("a retry of a refused steer keeps one row under the same id", () => {
    const d = run([
      { t: "sending", s: row("crid-3", words) },
      { t: "sent", requestId: "crid-3", result: { ok: false, code: "offline", message: "no hub" } },
      { t: "sending", s: row("crid-3", words) },
    ]);
    expect(d.sending.map((s) => [s.requestId, s.state.t])).toEqual([["crid-3", "sending"]]);
  });
});

describe("interrupt and redirect", () => {
  const ignored = steer("S12", "skip the docs page", { stage: "unacknowledged", ackExcerpt: "Continuing." });

  it("is one request per steer, and isn't offered while it is in flight or once it is done", () => {
    expect(redirectId("S12")).toBe("redirect:S12");
    const twice = run([
      { t: "steers", steers: [ignored] },
      { t: "sending", s: row(redirectId("S12"), ignored.text, { mode: "now", at: later(10) }) },
      { t: "sending", s: row(redirectId("S12"), ignored.text, { mode: "now", at: later(10) }) },
    ]);
    expect(twice.sending).toHaveLength(1);
    const inFlight = conv(twice, { redirected: redirecting(twice.sending, twice.redirected) });
    expect(inFlight[0]?.kind === "say" && inFlight[0].receipt?.act).toBeUndefined();

    const done = run([
      { t: "steers", steers: [ignored] },
      { t: "sending", s: row(redirectId("S12"), ignored.text, { mode: "now", at: later(10) }) },
      { t: "sent", requestId: redirectId("S12"), result: { ok: true, steer: steer("S13", ignored.text, { mode: "now", queuedAt: later(10) }) } },
    ]);
    expect([...done.redirected]).toEqual(["S12"]);
    const after = conv(done, { redirected: redirecting(done.sending, done.redirected) });
    expect(after.map((e) => e.kind === "say" && e.receipt?.act)).toEqual([undefined, undefined]);
    // Without a redirect it is offered.
    expect(conv(run([{ t: "steers", steers: [ignored] }]))[0]).toMatchObject({ receipt: { act: { kind: "redirect", steerId: "S12" } } });
  });
});

describe("a transcript jump to a tool call", () => {
  it("lands on its fold, opens it and lights the call itself", () => {
    const a = (s: number, summary: string): TailItem => ({ kind: "action", at: later(s), action: { at: later(s), kind: "command", status: "completed", summary, failed: false } });
    const c = buildConversation({
      tail: [{ kind: "message", at: later(0), role: "assistant", text: "Starting." }, a(10, "pnpm install"), a(20, "pnpm test"), a(30, "pnpm build"), { kind: "message", at: later(40), role: "assistant", text: "Done." }],
      workstreamId: "W1",
      events: [],
      leadWorking: false,
      steers: [],
      sending: [],
      lanes: [],
    });
    const i = entryIndexAt(c, later(20));
    const fold = c[i];
    expect(fold?.kind).toBe("fold");
    if (fold === undefined) throw new Error("no row");
    expect(jumpTarget(fold, later(20))).toEqual({ open: true, call: 1 });
    expect(jumpTarget(c[0] as Entry, later(0))).toEqual({ open: false });
  });
});
