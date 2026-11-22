// Set up this Mac for agents' steps (model.ts): the code, a replace to confirm, the join, the grants, the Test.
import { describe, expect, it } from "vitest";
import type { MacCheck } from "../../../shared/contracts";
import type { MacFound, MacHealthRead, MacLink } from "../../../shared/macSetup";
import { checkView, digitsOf, initial, passes, reduce, setupRows, spaced, STALL_MS, START_MS, statusLine, stepOf, waits, type Event, type State } from "./model";

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
  hubBehind: null,
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

describe("which hub", () => {
  it("lists the hubs found for the person to pick, and sends the code once one is picked", () => {
    const asked = run([
      typed("123456"),
      { type: "submit" },
      { type: "redeemed", outcome: { ok: false, failure: { message: "This Mac found 2 hubs. Which is yours?", field: "hub", choices: ["http://a:4790", "http://b:4790"] } } },
    ]);
    expect(asked).toMatchObject({ step: "code", busy: false, code: "123456", choices: ["http://a:4790", "http://b:4790"], askHub: false });
    expect(reduce(asked, { type: "pick", hub: "http://b:4790" })).toMatchObject({ hub: "http://b:4790", askHub: true, busy: true, choices: undefined, failure: undefined });
    // Picked before the code is whole: it waits for the sixth digit.
    expect(reduce(reduce(initial, typed("12")), { type: "pick", hub: "http://b:4790" })).toMatchObject({ busy: false, hub: "http://b:4790" });
  });
});

describe("opening the window again", () => {
  const at = 5000;
  it("opens on the join running, a join still to run, or a joined Mac's status", () => {
    expect(reduce(initial, { type: "resume", status: { kind: "joining", found: FOUND }, at })).toEqual({ step: "join", found: FOUND });
    expect(reduce(initial, { type: "resume", status: { kind: "traded", found: FOUND }, at })).toEqual({ step: "confirm", found: FOUND, replaces: undefined, resumed: true });
    // A Mac joined already opens on its status, never on setup's steps again.
    expect(reduce(initial, { type: "resume", status: { kind: "joined", found: { ...FOUND, existing: true } }, at })).toEqual({ step: "status", found: { ...FOUND, existing: true } });
    expect(stepOf({ step: "status", found: FOUND }, at)).toBe("Test");
  });

  it("says what became of a code spent with nothing joined, until a new one is typed", () => {
    const spent = reduce(initial, { type: "resume", status: { kind: "spent", failure: { message: "Cancelled: nothing changed on this Mac.", fix: "The code you typed is spent." } }, at });
    expect(spent).toMatchObject({ step: "code", notice: { message: "Cancelled: nothing changed on this Mac." } });
    expect(reduce(spent, typed("4"))).toMatchObject({ notice: undefined });
    expect(reduce(initial, { type: "resume", status: { kind: "fresh" }, at })).toBe(initial);
  });

  it("never overrides what the person has started here", () => {
    const typing = reduce(initial, typed("12"));
    expect(reduce(typing, { type: "resume", status: { kind: "joining", found: FOUND }, at })).toBe(typing);
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

  it("says a grant an update lost in the node's words, not as one never turned on", () => {
    const lost = check("screen_recording", "fail", { message: "macOS stopped counting fleetd's Screen Recording with the update to 0.9.1.", fix: "In Terminal at the Mac, then turn fleetd off and on again in System Settings" });
    const s = checking([{ type: "health", read: read([check("accessibility", "fail", { fix: "In Terminal at the Mac, then turn on fleetd" }), lost]) }]);
    const view = checkView(s, 2000);
    expect(view).toMatchObject({ kind: "grants", grants: [{ id: "accessibility", granted: false }, { id: "screen_recording", granted: false, lost: lost.message }] });
    expect(view.kind === "grants" && "lost" in (view.grants[0] ?? {})).toBe(false);
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

  it("ends green with Xcode not installed yet: the check waits with its App Store button, and holds up only simulators", () => {
    const grants = [check("accessibility", "ok"), check("screen_recording", "ok")];
    const first = checking([{ type: "health", read: read(grants, { writtenAt: 10_000, checkedAt: 9000 }) }]);
    const noXcode = check("xcode", "warn", { fix: "Install Xcode from the App Store", command: 'open "macappstore://apps.apple.com/app/id497799835"' });
    const sim = check("ios_runtime", "warn", { message: "Waits for Xcode: the Xcode check says what it needs." });
    const done = reduce(first, { type: "health", read: read([...grants, noXcode, sim], { writtenAt: 12_000, checkedAt: 12_000, now: 12_500 }) }) as typeof first;
    const view = checkView(done, 2000);
    expect(view).toMatchObject({ kind: "test", green: true, checks: [{}, {}, { id: "xcode", opens: "app_store" }, { id: "ios_runtime" }] });
    const rows = view.kind === "test" ? view.checks : [];
    // The Xcode check says what to do; the simulator one only waits, and a passing check has nothing to say.
    expect(rows.map(waits)).toEqual([false, false, true, false]);
    // A switch command is a command to copy, not a page.
    const switched = { id: "xcode", state: "warn", message: "Xcode-beta.app is in /Applications", command: "sudo xcode-select -s /Applications/Xcode-beta.app/Contents/Developer" } as const;
    expect(waits(switched)).toBe(true);
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

describe("every check a row, live", () => {
  // The join ended at 1000 by the page's clock; the node writes its files after it.
  const rowsAt = (r: MacHealthRead | undefined, now: number, extra: Event[] = []) => {
    const s = checking(r === undefined ? extra : [...extra, { type: "health", read: r }]);
    return Object.fromEntries(setupRows(s, now).map((row) => [row.id, row]));
  };

  it("the first checks arrive as the node starts: the permissions show at once, before its slower run of the rest", () => {
    // Before anything: the node is starting, and every row after it says what it waits on.
    const before = rowsAt(undefined, 2000);
    expect(before["node"]).toMatchObject({ state: "running" });
    expect(before["accessibility"]).toMatchObject({ state: "waiting", line: "Waits for the node" });
    expect(before["test"]).toMatchObject({ state: "waiting" });
    // Its first write holds the permissions alone, and its link dialing: each permission is a row with its Allow.
    const first = rowsAt(read([check("accessibility", "fail"), check("screen_recording", "fail"), check("screen_capture", "unknown")], { writtenAt: 1500, checkedAt: null, link: { state: "linking", since: 1400 } }), 2000);
    expect(first["node"]).toMatchObject({ state: "done" });
    expect(first["link"]).toMatchObject({ state: "running", line: "Reaching devbox" });
    expect(first["accessibility"]).toMatchObject({ state: "needs_you", action: { kind: "grant", pane: "accessibility" } });
    expect(first["screen_recording"]).toMatchObject({ state: "needs_you", action: { kind: "grant", pane: "screen_recording" } });
    expect(first["screen_capture"]).toMatchObject({ state: "waiting", line: "Waits for Screen Recording" });
    expect(first["checks"]).toMatchObject({ state: "running" });
  });

  it("a step the person does is seen at the next read, with no click here", () => {
    const off = read([check("accessibility", "fail"), check("screen_recording", "ok"), check("screen_capture", "fail")], { writtenAt: 1500, link: { state: "linked", since: 1400 } });
    expect(rowsAt(off, 2000)["screen_capture"]).toMatchObject({ state: "needs_you", action: { kind: "grant", pane: "screen_capture" } });
    const on = read([check("accessibility", "ok"), check("screen_recording", "ok"), check("screen_capture", "ok")], { writtenAt: 1600, link: { state: "linked", since: 1400 } });
    const rows = rowsAt(on, 2100, [{ type: "health", read: off }]);
    expect(rows["accessibility"]).toMatchObject({ state: "done", line: "Allowed" });
    expect(rows["screen_capture"]).toMatchObject({ state: "done", line: "Allowed" });
  });

  it("a check that stalls says why after a short wait, with one way forward", () => {
    // The node never writes: past STALL_MS it says so, with its restart.
    expect(rowsAt(undefined, 1000 + STALL_MS - 1)["node"]?.state).toBe("running");
    expect(rowsAt(undefined, 1000 + STALL_MS + 1)["node"]).toMatchObject({ state: "failed", line: "The node hasn't started.", action: { kind: "restart" } });
    // The hub never answers its link.
    const dialing = read([check("accessibility", "ok")], { writtenAt: 1500, checkedAt: null, link: { state: "linking", since: 1400 } });
    expect(rowsAt(dialing, 1400 + STALL_MS + 1)["link"]).toMatchObject({ state: "failed", line: "devbox isn't answering this Mac.", action: { kind: "restart" } });
    // The hub refuses it: only a new code joins it, and the row says so in the hub's words.
    const refused = read([check("accessibility", "ok")], { writtenAt: 1500, link: { state: "refused", why: "mac is not enrolled: run fleetd pair --worker mac on the hub", since: 1450 } });
    expect(rowsAt(refused, 1500)["link"]).toMatchObject({ state: "failed", action: { kind: "newCode" } });
    expect(rowsAt(refused, 1500)["link"]?.line).toContain("devbox refused this Mac: mac is not enrolled");
  });

  it("every check green and the Test run since the permissions came on: ready, and Done opens the Mac's status", () => {
    const green = [check("accessibility", "ok"), check("screen_recording", "ok"), check("screen_capture", "ok"), check("xcode", "ok"), check("tools", "ok")];
    const s = checking([
      { type: "health", read: read(green, { writtenAt: 1500, checkedAt: 1500, link: { state: "linked", since: 1400 } }) },
      { type: "health", read: read(green, { writtenAt: 2500, checkedAt: 2500, link: { state: "linked", since: 1400 } }) },
    ]);
    const rows = setupRows(s, 2600);
    expect(rows.map((r) => r.state).every((st) => st === "done")).toBe(true);
    expect(rows.map((r) => r.id)).toEqual(["node", "link", "accessibility", "screen_recording", "screen_capture", "xcode", "tools", "test"]);
    expect(reduce(s, { type: "finish" })).toEqual({ step: "status", found: FOUND });
  });

  it("a node that stopped as this hub's machine sends the window back to a new code, saying why", () => {
    const gone = { message: "devbox doesn't know this Mac any more.", fix: "To set it up again, type a new code." };
    expect(reduce(checking(), { type: "health", read: read([], { gone }) })).toMatchObject({ step: "code", notice: gone });
  });

  it("the status line: connected while linked, else why not", () => {
    const status = (link: MacLink, over: Partial<MacHealthRead> = {}) =>
      statusLine({ found: FOUND, hubId: null, activity: null, disk: null, macBehind: null, health: read([], { writtenAt: 100_000, link, ...over }) }, 100_000);
    expect(status({ state: "linked", since: 1 })).toEqual({ text: "Connected to devbox", tone: "ok" });
    expect(status({ state: "down", since: 1 })).toEqual({ text: "Not connected: devbox isn’t answering", tone: "warn" });
    expect(status({ state: "refused", why: "no", since: 1 })).toEqual({ text: "Not connected: devbox refused this Mac", tone: "warn" });
    expect(status({ state: "linked", since: 1 }, { writtenAt: 1 }).text).toContain("isn’t running");
  });
});
