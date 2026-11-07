// Set up this Mac for agents' steps (model.ts): the code, a replace to confirm, the join, the grants, the Test.
import { describe, expect, it } from "vitest";
import type { MacCheck } from "../../../shared/contracts";
import type { MacFound, MacHealthRead } from "../../../shared/macSetup";
import { checkView, digitsOf, initial, passes, reduce, spaced, START_MS, stepOf, type Event, type State } from "./model";

const FOUND: MacFound = { hubUrl: "http://devbox:4790", hubName: "devbox", machineId: "mac", existing: false, here: { kind: "none" } };
const run = (events: Event[], from: State = initial): State => events.reduce(reduce, from);
const typed = (code: string): Event => ({ type: "code", value: code });

const check = (id: string, state: "ok" | "fail" | "warn" | "unknown", extra: Partial<MacCheck> = {}): MacCheck => ({ id, state, message: `${id} is ${state}`, ...extra });
const read = (checks: MacCheck[], over: Partial<MacHealthRead> = {}): MacHealthRead => ({
  health: { user: "ada", checks },
  writtenAt: 10_000,
  checkedAt: 10_000,
  now: 11_000,
  hubAnswers: true,
  ...over,
});
const checking = (extra: Event[] = []): Extract<State, { step: "check" }> => {
  const s = run([typed("123456"), { type: "submit" }, { type: "redeemed", outcome: { ok: true, found: FOUND } }, { type: "join", join: { state: "done", steps: [] }, at: 1000 }, ...extra]);
  if (s.step !== "check") throw new Error(s.step);
  return s;
};

describe("the code", () => {
  it("keeps only six digits, shown in two groups", () => {
    expect(digitsOf("12a 3-45 678")).toBe("123456");
    expect(spaced("1234")).toBe("123 4");
    expect(spaced("12")).toBe("12");
  });

  it("submits only six digits, once", () => {
    expect(run([typed("12345"), { type: "submit" }])).toMatchObject({ step: "code", busy: false });
    const busy = run([typed("123456"), { type: "submit" }]);
    expect(busy).toMatchObject({ step: "code", busy: true });
    expect(reduce(busy, typed("999999"))).toBe(busy);
  });

  it("asks for the hub's address only once the Mac didn't find the hub, prefilled with the one it tried", () => {
    expect(initial).toMatchObject({ askHub: false });
    const s = run([
      typed("123456"),
      { type: "submit" },
      { type: "redeemed", outcome: { ok: false, failure: { message: "Can't reach a hub", field: "hub", hub: "http://devbox:4790" } } },
    ]);
    expect(s).toMatchObject({ step: "code", askHub: true, hub: "http://devbox:4790", code: "123456", busy: false });
  });

  it("clears a wrong code, so it is typed again from its first digit, and says what to do", () => {
    const s = run([typed("123456"), { type: "submit" }, { type: "redeemed", outcome: { ok: false, failure: { message: "That code isn't open.", fix: "Get a new code.", field: "code" } } }]);
    expect(s).toMatchObject({ step: "code", code: "", failure: { fix: "Get a new code." } });
    expect(reduce(s, typed("1"))).toMatchObject({ failure: undefined });
  });
});

describe("replacing a node", () => {
  it("joins at once when there is nothing to replace", () => {
    expect(run([typed("123456"), { type: "submit" }, { type: "redeemed", outcome: { ok: true, found: FOUND } }])).toEqual({ step: "join", found: FOUND });
  });

  it("asks first when this Mac's node or the hub's machine of that name is replaced; Cancel goes back to the code", () => {
    const mine = { ...FOUND, here: { kind: "node" as const, machineId: "studio", hub: "http://other:4790" } };
    const asked = run([typed("123456"), { type: "submit" }, { type: "redeemed", outcome: { ok: true, found: mine } }]);
    expect(asked).toMatchObject({ step: "confirm", replaces: "studio" });
    expect(reduce(asked, { type: "confirm" })).toEqual({ step: "join", found: mine });
    expect(reduce(asked, { type: "startOver" })).toEqual(initial);
    const theirs = run([typed("123456"), { type: "submit" }, { type: "redeemed", outcome: { ok: true, found: { ...FOUND, existing: true } } }]);
    expect(theirs).toMatchObject({ step: "confirm", replaces: "mac" });
  });
});

describe("joining", () => {
  const joining = run([typed("123456"), { type: "submit" }, { type: "redeemed", outcome: { ok: true, found: FOUND } }]);

  it("tries the same code again only when it failed before the token was spent", () => {
    const early = reduce(joining, { type: "join", join: { state: "failed", steps: [], failure: { message: "Couldn't download fleetd" }, retry: true }, at: 0 });
    expect(reduce(early, { type: "retry" })).toEqual({ step: "join", found: FOUND });
    const late = reduce(joining, { type: "join", join: { state: "failed", steps: [], failure: { message: "No GUI login." } }, at: 0 });
    expect(reduce(late, { type: "retry" })).toBe(late);
    expect(reduce(late, { type: "startOver", failure: { message: "No GUI login." } })).toMatchObject({ step: "code", failure: { message: "No GUI login." } });
  });

  it("goes on to the checks once joined", () => {
    expect(reduce(joining, { type: "join", join: { state: "done", steps: [] }, at: 5 })).toEqual({ step: "check", found: FOUND, since: 5, restarting: false });
    const started = reduce(joining, { type: "join", join: { state: "running", steps: [] }, at: 2 });
    expect(reduce(started, { type: "join", join: { state: "done", steps: [] }, at: 5 })).toMatchObject({ since: 2 });
  });
});

describe("the checks", () => {
  it("waits for the node's first checks, then offers a restart", () => {
    const s = checking();
    expect(checkView(s, 2000)).toEqual({ kind: "starting", late: false });
    expect(checkView(s, 1000 + START_MS + 1)).toEqual({ kind: "starting", late: true });
    // Checks written long ago are a node that stopped.
    expect(checkView(checking([{ type: "health", read: read([], { writtenAt: 2000, checkedAt: 2000, now: 200_000 }) }]), 2000).kind).toBe("starting");
  });

  it("shows the two grants until both are on, each seen as it turns on", () => {
    const s = checking([{ type: "health", read: read([check("accessibility", "ok"), check("screen_recording", "fail"), check("xcode", "ok")]) }]);
    expect(checkView(s, 2000)).toMatchObject({ kind: "grants", grants: [{ id: "accessibility", granted: true }, { id: "screen_recording", granted: false }] });
    expect(stepOf(s, 2000)).toBe("Permissions");
  });

  it("counts only a run of every check made since the join started", () => {
    // The join's first report starts the clock; checks run before it are an older node's.
    const s = run([
      typed("123456"),
      { type: "submit" },
      { type: "redeemed", outcome: { ok: true, found: FOUND } },
      { type: "join", join: { state: "running", steps: [] }, at: 400 },
      { type: "join", join: { state: "done", steps: [] }, at: 9000 },
    ]);
    if (s.step !== "check") throw new Error(s.step);
    expect(s.since).toBe(400);
    const grants = [check("accessibility", "ok"), check("screen_recording", "fail")];
    expect(checkView(reduce(s, { type: "health", read: read(grants, { checkedAt: 300 }) }) as typeof s, 2000).kind).toBe("starting");
    expect(checkView(reduce(s, { type: "health", read: read(grants, { checkedAt: 500 }) }) as typeof s, 2000).kind).toBe("grants");
  });

  it("is green only after the node ran every check with both grants on, each passing (or still at it) and the hub answering", () => {
    const grants = [check("accessibility", "ok"), check("screen_recording", "ok")];
    // Both grants on at 10 000, by the 2-second re-read: the last full run (at 9 000) was before them.
    const first = checking([{ type: "health", read: read([...grants, check("xcode", "ok")], { writtenAt: 10_000, checkedAt: 9000 }) }]);
    expect(checkView(first, 2000)).toMatchObject({ kind: "test", settled: false, green: false });
    expect(stepOf(first, 2000)).toBe("Test");
    const after = (checks: MacCheck[], over: Partial<MacHealthRead> = {}) => reduce(first, { type: "health", read: read(checks, { writtenAt: 12_000, checkedAt: 12_000, now: 12_500, ...over }) }) as typeof first;
    const failing = after([...grants, check("xcode", "fail", { fix: "Install Xcode." })]);
    expect(checkView(failing, 2000)).toMatchObject({ kind: "test", settled: true, green: false, checks: [{}, {}, { id: "xcode", fix: "Install Xcode." }] });
    expect(checkView(after([...grants, check("gui_session", "warn")], { hubAnswers: false }), 2000)).toMatchObject({ green: false, hubAnswers: false });
    // A check the node is still at (its tools installing) is a warning, never a failure.
    const installing = after([...grants, check("gui_session", "warn"), check("tools", "unknown", { message: "Installing…" })]);
    expect(checkView(installing, 2000)).toMatchObject({ kind: "test", green: true });
    expect(passes({ id: "tools", state: "unknown", message: "Installing…" })).toBe(true);
    expect(passes({ id: "xcode", state: "fail", message: "No Xcode." })).toBe(false);
  });

  it("restarts the node once at a time, and says why when it can't", () => {
    const s = reduce(checking(), { type: "restart" });
    expect(s).toMatchObject({ restarting: true });
    // A restart's checks count only once the node ran them again.
    expect(reduce(s, { type: "restarted", outcome: { ok: true }, at: 77 })).toMatchObject({ restarting: false, since: 77 });
    expect(reduce(s, { type: "restart" })).toBe(s);
    expect(reduce(s, { type: "restarted", outcome: { ok: false, failure: { message: "No LaunchAgent." } }, at: 0 })).toMatchObject({ restarting: false, restartFailure: { message: "No LaunchAgent." } });
  });
});
