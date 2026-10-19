// Regressions from #187's review: a steer cut off by the link is never "not sent" and never shows twice; a
// redirect can't send twice; a jump to a tool call opens its fold and lights the call. And from the parity review:
// no hub is not a refusal, a not-sent steer can be resent or let go, and nothing is lost by leaving the order.
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { Steer, TailItem } from "../../../shared/contracts";
import { buildConversation, entryIndexAt, jumpTarget, type Entry } from "./conversationModel";
import { callKey, type DataLayer } from "../../src/data/queries";
import { createDataStore } from "../../src/data/store";
import { createOutbox, draftKey, steersInput } from "./outbox";
import { sendingReceipt } from "./receipts";
import { emptySteering, logView, steeringReducer, type Steering, type SteeringAction } from "./data";
import { noSends, reconnectWatcher, redirectId, redirecting, sendsReducer, unsettled, type OrderSends, type SendAction, type Sending } from "./sending";

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
type Both = Steering & OrderSends;
type Action = SteeringAction | SendAction;
// The view's reads and the outbox's rows together. A steer the hub answers with goes into the steers_list answer
// (outbox.ts), which the view merges like any refetch.
const step = (d: Both, a: Action): Both => {
  if (a.t === "sending" || a.t === "drop") return { ...d, ...sendsReducer(d, a) };
  if (a.t !== "sent") return { ...d, ...steeringReducer(d, a) };
  const sends = sendsReducer(d, a);
  return { ...d, ...(a.result.ok ? steeringReducer(d, { t: "steers", steers: [a.result.steer] }) : {}), ...sends };
};
const run = (actions: readonly Action[]): Both => actions.reduce(step, { ...emptySteering(), ...noSends });
const conv = (d: Both, extra: Partial<Parameters<typeof buildConversation>[0]> = {}): Entry[] =>
  buildConversation({ tail: [], workstreamId: "W1", events: [], leadWorking: false, steers: d.steers, sending: d.sending, lanes: [], ...extra });
const says = (c: Entry[]) => c.filter((e) => e.kind === "say");
const lineOf = (e: Entry | undefined) => (e?.kind === "say" ? e.receipt?.line : undefined);

describe("a steer the link cut off", () => {
  const words = "skip the docs page";
  const cut: Action[] = [
    { t: "sending", s: row("crid-1", words) },
    { t: "sent", requestId: "crid-1", result: { ok: false, code: "disconnected", message: "the link to the hub dropped" } },
  ];

  it("waits to be sent again, and is never called not sent", () => {
    const d = run(cut);
    expect(d.sending).toHaveLength(1);
    expect(d.sending[0]?.state.t).toBe("reconnecting");
    expect(lineOf(says(conv(d))[0])).toMatch(/^sending… the link to the hub dropped/);
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
    expect(inFlight[0]?.kind === "say" && inFlight[0].receipt?.acts).toBeUndefined();

    const done = run([
      { t: "steers", steers: [ignored] },
      { t: "sending", s: row(redirectId("S12"), ignored.text, { mode: "now", at: later(10) }) },
      { t: "sent", requestId: redirectId("S12"), result: { ok: true, steer: steer("S13", ignored.text, { mode: "now", queuedAt: later(10) }) } },
    ]);
    expect([...done.redirected]).toEqual(["S12"]);
    const after = conv(done, { redirected: redirecting(done.sending, done.redirected) });
    expect(after.map((e) => e.kind === "say" && e.receipt?.acts)).toEqual([undefined, undefined]);
    // Without a redirect it is offered.
    expect(conv(run([{ t: "steers", steers: [ignored] }]))[0]).toMatchObject({ receipt: { acts: [{ kind: "redirect", steerId: "S12" }] } });
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


describe("after a reconnect resets the reads", () => {
  it("shows no steer or log from before the drop until steers_list and thread_tail answer again", () => {
    const local = run([{ t: "steers", steers: [steer("S3", "skip the docs page", { stage: "queued" })] }]);
    const base = { pageLoaded: true, hasLeadThread: true, local, stream: [{ messageId: "m", text: "old" }] };
    const reset = logView({ ...base, tailLoaded: false, steersLoaded: false });
    expect(reset).toEqual({ logReady: false, tail: [], steers: [], streamed: [] });
    expect(logView({ ...base, tailLoaded: true, steersLoaded: false }).logReady).toBe(false);
    const back = logView({ ...base, tailLoaded: true, steersLoaded: true });
    expect(back.logReady).toBe(true);
    expect(back.steers.map((s) => s.id)).toEqual(["S3"]);
    expect(logView({ ...base, hasLeadThread: false, tailLoaded: false, steersLoaded: true }).logReady).toBe(true);
  });
});

describe("a steer the hub doesn't have", () => {
  const words = "skip the docs page";
  type Outcome = { ok: true; output: Steer } | { ok: false; error: { code: string; message: string } };

  /** An outbox on a real data store and query cache, with steer_send answered from `answers` in turn. */
  function harness(answers: Outcome[]) {
    const store = createDataStore();
    store.setState({ hub: { phase: "live", hub: "devbox:4710", protocol: 1 }, fresh: true, generation: 1 });
    const queryClient = new QueryClient();
    const ids: string[] = [];
    const call = ((tool: string, input: { clientRequestId: string }) => {
      if (tool !== "steer_send") throw new Error(tool);
      ids.push(input.clientRequestId);
      return Promise.resolve(answers.shift() ?? { ok: false, error: { code: "invalid", message: "no answer scripted" } });
    }) as unknown as DataLayer["call"];
    const box = createOutbox({ call, queryClient, store });
    const rows = () => box.store.getState().orders["W1"]?.sending ?? [];
    return { store, queryClient, ids, box, rows };
  }
  const refused: Outcome = { ok: false, error: { code: "forbidden", message: "keys of kind agent can't steer" } };
  const offline: Outcome = { ok: false, error: { code: "offline", message: "Not connected to the hub." } };
  const timeout: Outcome = { ok: false, error: { code: "timeout", message: "no answer in 15 s" } };
  const cutOff: Outcome = { ok: false, error: { code: "disconnected", message: "the link dropped" } };
  const lead = { workstreamId: "W1" } as const;

  it("is not sent when the hub refuses it, and can be resent under its id, edited back into its box, or let go", async () => {
    const h = harness([refused, refused]);
    expect(await h.box.steer("W1", lead, words, "queue", "crid-1")).toBe("failed");
    const [failed] = h.rows();
    if (failed === undefined) throw new Error("no row");
    const r = sendingReceipt(failed);
    expect(r).toMatchObject({ stage: "not_sent", line: "not sent: the hub refused it", detail: "keys of kind agent can't steer" });
    expect(r.acts?.map((a) => a.kind)).toEqual(["resend", "edit", "dismiss"]);

    expect(await h.box.resend("W1", "crid-1")).toBe("failed");
    expect(h.ids).toEqual(["crid-1", "crid-1"]);
    expect(h.rows()).toHaveLength(1);

    h.box.edit("W1", "crid-1");
    expect(h.rows()).toHaveLength(0);
    expect(h.box.store.getState().drafts[draftKey("W1", lead)]).toEqual({ text: words });
  });

  it("with no hub, leaves no row: the words stay in the box; a resend with no hub says so, not 'refused'", async () => {
    const h = harness([offline, refused, offline]);
    h.store.setState({ hub: { phase: "retrying", hub: "devbox:4710", reason: "refused", retryAt: 0 } });
    expect(await h.box.steer("W1", lead, words, "queue", "crid-2")).toBe("offline");
    expect(h.ids).toEqual([]);
    // Main can know before the store does.
    h.store.setState({ hub: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    expect(await h.box.steer("W1", lead, words, "queue", "crid-2")).toBe("offline");
    expect(h.rows()).toHaveLength(0);

    expect(await h.box.steer("W1", lead, words, "queue", "crid-3")).toBe("failed");
    expect(await h.box.resend("W1", "crid-3")).toBe("failed");
    expect(h.rows()[0]?.state).toMatchObject({ t: "failed", offline: true });
    const [row] = h.rows();
    expect(row && sendingReceipt(row).line).toBe("not sent: not connected to the hub");
    h.box.dismiss("W1", "crid-3");
    expect(h.rows()).toHaveLength(0);
  });

  it("unanswered twice on a live link offers Resend under the same id, never 'reconnecting' forever", async () => {
    const h = harness([timeout, timeout, { ok: true, output: steer("S12", words) }]);
    expect(await h.box.steer("W1", lead, words, "queue", "crid-4")).toBe("pending");
    const [row] = h.rows();
    expect(row?.state.t).toBe("unanswered");
    expect(row && sendingReceipt(row)).toMatchObject({ stage: "unanswered", acts: [{ kind: "resend" }, { kind: "dismiss" }] });
    expect(await h.box.resend("W1", "crid-4")).toBe("sent");
    expect(h.rows()).toHaveLength(0);
    expect(h.ids).toEqual(["crid-4", "crid-4", "crid-4"]);
  });

  it("is resent after a reconnect with nothing mounted, and its receipt is in the order's steers_list answer", async () => {
    const h = harness([cutOff, { ok: true, output: steer("S12", words) }]);
    const key = callKey("steers_list", steersInput("W1"));
    h.queryClient.setQueryData(key, { steers: [steer("S11", "earlier")] });
    expect(await h.box.steer("W1", lead, words, "queue", "crid-5")).toBe("pending");
    expect(h.rows()[0]?.state.t).toBe("reconnecting");
    h.store.setState({ hub: { phase: "connecting", hub: "devbox:4710", attempt: 1 }, fresh: false });
    h.store.setState({ hub: { phase: "live", hub: "devbox:4710", protocol: 1 }, fresh: true, generation: 2 });
    await vi.waitFor(() => expect(h.rows()).toHaveLength(0));
    expect(h.ids).toEqual(["crid-5", "crid-5"]);
    expect(h.queryClient.getQueryData<{ steers: Steer[] }>(key)?.steers.map((s) => s.id)).toEqual(["S11", "S12"]);
  });

  it("shows once in the steer sheet too when the hub turns out to have it", () => {
    const cut = row("crid-6", words, { state: { t: "reconnecting" } });
    expect(unsettled([cut], [steer("S12", words)])).toEqual([]);
    expect(unsettled([cut], [steer("S12", "other words")])).toEqual([cut]);
  });
});
