import { describe, expect, it } from "vitest";
import type { HubState } from "../../../shared/hub";
import type { AppUpdate, UpdatesState } from "../../../shared/updates";
import { updateStatus } from "../updates/model";
import { quietOf, type Quiet } from "../updates/quiet";
import { appLine, hostedLine, hubLine, linkMark, machinesLine, menuLines, offersWhole, setupLine, startLine, updateLine, updateToLine, workMark, type MenuInput, type MenuMachine } from "./youMenu";

const HUB = "https://devbox.example.ts.net:4790";
const NOW = Date.parse("2026-10-19T09:03:07.195Z");
const live: HubState = { phase: "live", hub: HUB, protocol: 1 };
const down: HubState = { phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", fix: "Start the hub", retryAt: 0 };

const machine = (name: string, status: MenuMachine["status"] = "online"): MenuMachine => ({ machineId: name, name, status });
const quiet = (kind: Quiet["kind"], note?: Partial<NonNullable<Quiet["note"]>>): Quiet => ({
  kind,
  word: { text: "Update", tone: "accent" },
  note: note === undefined ? null : { title: "", details: false, ...note },
});
const TRY_AGAIN = { label: "Try again", act: "update" } as const;
/** An update that didn't go in, as an admin reads it (the status's title and button) and as a member is told. */
const failed = quiet("failed", { title: "1 machine didn't update", action: TRY_AGAIN, details: true });
const toldFailed = quiet("failed", { title: "Not updated" });
const menu = (over: Partial<MenuInput> = {}) =>
  menuLines({ hub: live, label: null, quiet: null, admin: true, machines: [machine("devbox")], setupLeft: 0, now: NOW, timeZone: "UTC", ...over });
/** A menu's lines as a person reads them: the words, then the action or the quiet word at the end. */
const read = (over: Partial<MenuInput> = {}) => menu(over).map((l) => [l.text, l.action ?? l.aside].filter((x) => x !== undefined).join(" · "));

describe("the hub's line", () => {
  it("is a dot and the hub's short name while all is well, and opens Settings › You › Hubs & devices", () => {
    expect(menu()).toEqual([{ key: "hub", mark: "success", text: "devbox", name: "devbox", does: { to: "hubs" } }]);
    expect(menu({ admin: false })).toEqual(menu());
    expect(read({ label: "Personal" })).toEqual(["Personal"]);
    // A hub reached by address has no shorter name.
    expect(hubLine({ ...live, hub: "http://100.64.0.1:4790" }, null, null, NOW).text).toBe("100.64.0.1");
  });

  it("never holds an address, a port, a version or a hub's reason", () => {
    const states: HubState[] = [live, { ...live, version: "0.6.0-edge.202610231030+9e07d31" }, down, { phase: "refused", hub: HUB, message: "This key was revoked" }, { phase: "connecting", hub: HUB, attempt: 3 }];
    for (const hub of states) expect(read({ hub }).join(" ")).not.toMatch(/https?:|4790|edge|revoked|listening/u);
  });

  it("says in one line what is wrong with the link, and the one thing to do", () => {
    expect(read({ hub: down })).toEqual(["Can't reach devbox · Retry"]);
    expect(menu({ hub: down })[0]).toMatchObject({ mark: "warning", does: { to: "retry" } });
    expect(read({ hub: { phase: "refused", hub: HUB, message: "This key was revoked" }, label: "Acme" })).toEqual(["Acme refused the key · Pair again"]);
    expect(menu({ hub: { phase: "refused", hub: HUB, message: "" } })[0]).toMatchObject({ mark: "danger", does: { to: "pair" } });
    expect(read({ hub: { phase: "unpaired" } })).toEqual(["Not paired with a hub · Pair"]);
    expect(read({ hub: { phase: "unpaired" }, label: "Acme" })).toEqual(["Acme isn't paired · Pair"]);
  });

  it("is calm on the first dial, and out of reach in the same words from the second on", () => {
    expect(menu({ hub: { phase: "connecting", hub: HUB, attempt: 1 } })).toEqual([{ key: "hub", mark: "quiet", text: "Connecting to devbox…", name: "devbox", does: { to: "hubs" } }]);
    expect(read({ hub: { phase: "connecting", hub: HUB, attempt: 2 } })).toEqual(["Can't reach devbox · Trying…"]);
    expect(read({ hub: { phase: "connecting", hub: "", attempt: 1 } })).toEqual(["Connecting to the hub…"]);
  });

  it("keeps its name through a restart, its dot opened to a ring; an update's turns to Retry after 30 s and an outage after 2 minutes", () => {
    const away = (ms: number, updatingTo?: string): HubState => ({ ...down, restarting: NOW - ms, ...(updatingTo === undefined ? {} : { updatingTo }) });
    expect(menu({ hub: away(1_000, "0.9.3") })).toEqual([{ key: "hub", mark: "ring", text: "devbox", name: "devbox", aside: "Updating…", does: { to: "hubs" } }]);
    expect(read({ hub: away(1_000) })).toEqual(["devbox · Restarting…"]);
    expect(read({ hub: away(40_000, "0.9.3") })).toEqual(["devbox is still updating · Retry"]);
    expect(read({ hub: away(130_000, "0.9.3") })).toEqual(["Can't reach devbox · Retry"]);
  });

  it("says a reconnect after a wake quietly for its first seconds, then as any outage", () => {
    expect(menu({ hub: { ...down, waking: NOW - 2_000 } })).toEqual([{ key: "hub", mark: "quiet", text: "devbox", name: "devbox", aside: "Reconnecting…", does: { to: "hubs" } }]);
    expect(read({ hub: { phase: "connecting", hub: HUB, attempt: 0, waking: NOW - 9_000 } })).toEqual(["devbox · Reconnecting…"]);
    expect(read({ hub: { ...down, waking: NOW - 10_000 } })).toEqual(["Can't reach devbox · Retry"]);
    // Past them, redials about once a second (main/hub/client.ts) keep the same words between attempts and during one.
    expect(read({ hub: { phase: "connecting", hub: HUB, attempt: 12, waking: NOW - 12_000 } })).toEqual(["Can't reach devbox · Trying…"]);
  });

  it("says an update going on or just in as a quiet word at its end, never a line of its own", () => {
    expect(read({ quiet: quiet("updating", {}) })).toEqual(["devbox · Updating…"]);
    expect(read({ quiet: quiet("updated", { at: Date.parse("2026-10-19T09:00:00Z") }) })).toEqual(["devbox · Updated 09:00"]);
    expect(read({ quiet: quiet("updated", {}) })).toEqual(["devbox · Updated"]);
  });

  it("marks the hub's name in its words, the one part a long name may cut short; never the words that say what is wrong", () => {
    const label = "Acme Robotics shared build hub, Berlin 2"; // 40 characters, the longest a label can be
    const states: HubState[] = [live, down, { phase: "refused", hub: HUB, message: "" }, { phase: "unpaired" }, { phase: "connecting", hub: HUB, attempt: 1 }, { phase: "connecting", hub: HUB, attempt: 3 }, { ...down, restarting: NOW - 40_000, updatingTo: "0.9.3" }];
    for (const hub of states) {
      const [line] = menu({ hub, label });
      expect(line?.name).toBe(label);
      expect(line?.text).toContain(label);
    }
    expect(hubLine({ phase: "unpaired" }, null, null, NOW).name).toBeUndefined();
    expect(machinesLine([machine("devbox"), machine("buildbox", "offline")], true)?.name).toBe("buildbox");
    expect(machinesLine([machine("a", "offline"), machine("b", "offline")], true)?.name).toBeUndefined();
  });

  it("says nothing else while the hub doesn't answer: what it alone knows would be stale", () => {
    expect(read({ hub: down, quiet: failed, machines: [machine("buildbox", "offline")], setupLeft: 2 })).toEqual(["Can't reach devbox · Retry"]);
  });
});

describe("an update that needs someone", () => {
  it("offers the one to take in the status's own title and button: the hub's to an admin, the app's own to anyone", () => {
    const hub = quiet("available", { title: "Update available", action: { label: "Update", act: "update" } });
    expect(updateLine(hub)).toEqual({ key: "update", mark: "update", text: "Update available", action: "Update", does: { to: "update", act: "update" } });
    const app = quiet("available", { title: "Update available", action: { label: "Restart to update", act: "app" } });
    expect(updateLine(app)).toMatchObject({ text: "Update available", action: "Restart to update", does: { to: "update", act: "app" } });
    // Nothing a button does (a machine to update by hand): an admin's page says what.
    expect(updateLine(quiet("available", { title: "1 machine is behind", details: true }))).toMatchObject({ text: "1 machine is behind", action: "Open", does: { to: "updates" } });
    expect(updateLine(quiet("available", { title: "Update available" }))).toBeNull();
    expect(updateLine(null)).toBeNull();
  });

  it("says one that didn't go in as the status says it: an admin tries again, a member is told who to ask", () => {
    expect(updateLine(failed)).toEqual({ key: "update", mark: "danger", text: "1 machine didn't update", action: "Try again", does: { to: "update", act: "update" } });
    expect(updateLine(quiet("failed", { title: "The update stopped", action: { label: "Start over", act: "startOver" } }))).toMatchObject({ action: "Start over", does: { to: "update", act: "startOver" } });
    expect(updateLine(toldFailed)).toEqual({ key: "update", mark: "danger", text: "Not updated", aside: "Ask an admin" });
  });

  it("leaves one going on or just in to the hub's line", () => {
    expect(updateLine(quiet("updating", { title: "Updating the hub…" }))).toBeNull();
    expect(updateLine(quiet("updated", { title: "Updated" }))).toBeNull();
    expect(updateLine(quiet("restarting"))).toBeNull();
  });
});

describe("machines and setup", () => {
  it("names an admin the one machine that needs them and opens its page, or counts several", () => {
    expect(machinesLine([machine("devbox"), machine("buildbox", "offline")], true)).toEqual({ key: "machines", mark: "warning", text: "buildbox is offline", name: "buildbox", action: "Open", does: { to: "machines", machineId: "buildbox" } });
    expect(machinesLine([machine("devbox"), machine("buildbox", "degraded")], true)).toMatchObject({ text: "buildbox needs a look" });
    expect(machinesLine([machine("a", "offline"), machine("b", "offline"), machine("c")], true)).toMatchObject({ text: "2 machines offline", does: { to: "machines" } });
    expect(machinesLine([machine("a", "offline"), machine("b", "degraded")], true)).toMatchObject({ text: "2 machines need a look" });
    expect(machinesLine([machine("devbox")], true)).toBeNull();
    expect(machinesLine(undefined, true)).toBeNull();
    expect(machinesLine([], true)).toBeNull();
  });

  it("says fleetd's computers aren't ready and why, with its fix's own button, opening its row, never the runner's machine page", () => {
    const hosted = { machineId: "hosted", name: "Hosted sandboxes", runner: true } as const;
    const boat = [{ provider: "boat", limit: 20, running: 3 }];
    // Ready: nothing to say, and the runner is no machine of the team's.
    expect(hostedLine([machine("devbox"), { ...hosted, status: "online" }], boat, true)).toBeNull();
    expect(machinesLine([machine("devbox"), { ...hosted, status: "degraded" }], true)).toBeNull();
    // No Claude account: Connect, in Your accounts.
    expect(hostedLine([machine("devbox"), { ...hosted, status: "degraded", degradedCause: "claude_login" }], boat, true)).toEqual({
      key: "hosted",
      mark: "warning",
      text: "fleetd's computers: it needs a Claude account",
      action: "Connect",
      does: { to: "accounts" },
    });
    // A refusal: its reason, and Try again, which tests the key on the row.
    const trouble = { what: "start", reason: "billing", message: "fleetd's computers refused: billing isn't set up on the account", fix: "try again later" };
    expect(hostedLine([{ ...hosted, status: "online" }], [{ provider: "boat", limit: 20, running: 3, trouble }], true)).toEqual({
      key: "hosted",
      mark: "warning",
      text: "fleetd's computers: billing isn't set up",
      action: "Try again",
      does: { to: "hosted", retry: "boat" },
    });
    // fleetd's computers' own account out of starts (W791): when they start again, never "its plan's limit", and
    // nothing to press.
    const limit = { what: "start", reason: "limit", message: "fleetd's computers can't start more right now", freeAt: "2026-11-24T11:18:00.000Z" };
    expect(hostedLine([{ ...hosted, status: "online" }], [{ provider: "boat", limit: 25, running: 0, trouble: limit }], true)).toEqual({
      key: "hosted",
      mark: "warning",
      text: expect.stringMatching(/^fleetd's computers can't start more right now; they start again at \d\d:18$/),
      action: "Open",
      does: { to: "hosted" },
    });
    // Starting: a quiet line that marks nothing.
    const starting = hostedLine([{ ...hosted, status: "degraded", degradedCause: "starting", degradedReason: "Starting…" }], boat, true);
    expect(starting).toEqual({ key: "hosted", mark: "quiet", text: "fleetd's computers are starting…", does: { to: "hosted" } });
    expect(workMark([starting], null)).toBeNull();
    // Stuck for another reason: that, with Open.
    expect(hostedLine([{ ...hosted, status: "degraded", degradedReason: "its network has no IPv4 address. Fix: reconnect it" }], boat, true)).toMatchObject({
      text: "fleetd's computers: it didn't start",
      action: "Open",
      does: { to: "hosted" },
    });
    // A member reads it only when hosted is all the team has, with who to ask.
    expect(hostedLine([machine("devbox"), { ...hosted, status: "degraded", degradedCause: "claude_login" }], boat, false)).toBeNull();
    expect(hostedLine([{ ...hosted, status: "degraded", degradedCause: "claude_login" }], boat, false)).toEqual({
      key: "hosted",
      mark: "warning",
      text: "fleetd's computers: it needs a Claude account",
      aside: "Ask an admin",
    });
  });

  it("tells a member only when no machine is online, and who to ask", () => {
    expect(machinesLine([machine("devbox"), machine("buildbox", "offline")], false)).toBeNull();
    expect(machinesLine([machine("devbox", "offline"), machine("buildbox", "offline")], false)).toEqual({ key: "machines", mark: "warning", text: "All machines offline", aside: "Ask an admin" });
  });

  it("says what is true of them in the Machines page's words: connected but degraded isn't offline", () => {
    expect(machinesLine([machine("devbox", "degraded"), machine("buildbox", "degraded")], false)).toEqual({ key: "machines", mark: "warning", text: "All machines degraded", aside: "Ask an admin" });
    expect(machinesLine([machine("devbox", "degraded"), machine("buildbox", "offline")], false)).toEqual({ key: "machines", mark: "warning", text: "No machine online", aside: "Ask an admin" });
  });

  it("counts an admin's setup steps left, and never shows a member", () => {
    expect(setupLine(1, true)).toEqual({ key: "setup", mark: "warning", text: "1 setup step left", action: "Finish", does: { to: "setup" } });
    expect(setupLine(3, true)).toMatchObject({ text: "3 setup steps left" });
    expect(setupLine(0, true)).toBeNull();
    expect(setupLine(3, false)).toBeNull();
  });

  it("keeps Get started's steps left as one quiet row to come back to, anyone's, and never marks your picture", () => {
    expect(startLine(2)).toEqual({ key: "start", mark: "quiet", text: "Finish setting up", aside: "2 left", does: { to: "start" } });
    expect(startLine(0)).toBeNull();
    expect(read({ startLeft: 1, admin: false })).toEqual(["devbox", "Finish setting up · 1 left"]);
    expect(workMark([null, null, startLine(2)], null)).toBeNull();
  });

  it("orders everything off at once: the hub, the update, machines, setup", () => {
    const all = { quiet: failed, machines: [machine("devbox"), machine("buildbox", "offline")], setupLeft: 1 } as const;
    expect(read(all)).toEqual(["devbox", "1 machine didn't update · Try again", "buildbox is offline · Open", "1 setup step left · Finish"]);
    expect(read({ ...all, quiet: toldFailed, admin: false })).toEqual(["devbox", "Not updated · Ask an admin"]);
  });
});

describe("the mark on your picture", () => {
  it("is the link's while a hub is really out of reach or refused the key, in the menu's own words", () => {
    expect(linkMark(live, null, NOW)).toBeNull();
    expect(linkMark({ phase: "connecting", hub: HUB, attempt: 1 }, null, NOW)).toBeNull();
    expect(linkMark({ ...down, restarting: NOW - 1_000, updatingTo: "0.9.3" }, null, NOW)).toBeNull();
    expect(linkMark({ phase: "unpaired" }, null, NOW)).toBeNull();
    expect(linkMark(down, null, NOW)).toEqual({ tone: "warning", why: "Can't reach devbox" });
    expect(linkMark({ phase: "refused", hub: HUB, message: "" }, "Acme", NOW)).toEqual({ tone: "danger", why: "Acme refused the key" });
  });

  it("is a machine's before setup's, naming the hub when there are several", () => {
    const lines = [machinesLine([machine("buildbox", "offline"), machine("devbox")], true), setupLine(2, true)];
    expect(workMark(lines, null)).toEqual({ tone: "warning", why: "buildbox is offline" });
    expect(workMark([null, setupLine(2, true)], "Acme")).toEqual({ tone: "warning", why: "2 setup steps left (Acme)" });
    expect(workMark([null, null], null)).toBeNull();
  });
});

describe("this app's own update, with two hubs", () => {
  const MINE = "0.6.0-edge.202610221030+4f1c2ab";
  const NEXT = "0.6.0-edge.202610231030+9e07d31";
  const app = (kind: AppUpdate, cli = MINE): UpdatesState => ({ current: MINE, app: kind, release: { cli, app: NEXT } });
  const CLOUD: HubState = { ...live, hub: "https://weishang.fleetd.dev" };
  /** The menu as You.tsx lays it out: a self-run hub and a fleetd cloud team (no hub_update), each with its rows, then this app's. */
  const rows = (state: UpdatesState, admin = true) => {
    const hubs = [
      { hub: live, label: "devbox", updates: true },
      { hub: CLOUD, label: "weishang", updates: false },
    ].flatMap(({ hub, label, updates }) => {
      const status = updateStatus({ app: state, hub: { url: hub.hub, version: MINE }, updates, administers: admin, withApp: false, now: NOW, timeZone: "UTC" });
      return menu({ hub, label, admin, quiet: quietOf({ status, hub, administers: admin, now: NOW }) });
    });
    const own = appLine(state, offersWhole(hubs));
    return [...hubs, ...(own === null ? [] : [own])].map((l) => [l.text, l.action ?? l.aside].filter((x) => x !== undefined).join(" · "));
  };

  it("says Restart to update once, below the hubs, as the app's row and no hub's", () => {
    expect(rows(app({ kind: "ready", version: NEXT }))).toEqual(["devbox", "weishang", "Update available · Restart to update"]);
    expect(rows(app({ kind: "ready", version: NEXT }), false)).toEqual(["devbox", "weishang", "Update available · Restart to update"]);
    expect(appLine(app({ kind: "ready", version: NEXT }))).toEqual({ key: "app", mark: "update", text: "Update available", action: "Restart to update", does: { to: "update", act: "app" } });
  });

  it("says its download, its restart and its failure once too", () => {
    expect(rows(app({ kind: "available", version: NEXT, percent: 40, restart: true }))).toEqual(["devbox", "weishang", "Updating this app…"]);
    expect(rows(app({ kind: "failed", during: "download", reason: "The download stopped." }))).toEqual(["devbox", "weishang", "This app didn't update · Try again"]);
    expect(rows(app({ kind: "manual", version: NEXT }))).toEqual(["devbox", "weishang", "Update available · Download"]);
  });

  it("keeps a self-run hub's own update under that hub, and never gives a cloud team one", () => {
    expect(rows(app({ kind: "current" }, NEXT))).toEqual(["devbox", "Update available · Update", "weishang"]);
    // The hub's Update ends in this app's restart, so this app's own offer waits for it; a member has no Update, so it shows.
    expect(rows(app({ kind: "ready", version: NEXT }, NEXT))).toEqual(["devbox", "Update available · Update", "weishang"]);
    expect(rows(app({ kind: "ready", version: NEXT }, NEXT), false)).toEqual(["devbox", "weishang", "Update available · Restart to update"]);
    expect(rows(app({ kind: "failed", during: "download", reason: "The download stopped." }, NEXT))).toEqual(["devbox", "Update available · Update", "weishang", "This app didn't update · Try again"]);
  });

  it("says nothing of it with none to say, and on the web, which has none", () => {
    expect(rows(app({ kind: "current" }))).toEqual(["devbox", "weishang"]);
    expect(rows(app({ kind: "checking" }))).toEqual(["devbox", "weishang"]);
    expect(appLine({ current: MINE, app: { kind: "unsupported" }, release: null })).toBeNull();
    expect(appLine(null)).toBeNull();
  });
});

describe("the update row under your name", () => {
  const offer = (to: string, act: "update" | "app" = "update") =>
    ({ kind: "available", title: "Update available", to, action: { label: "Update", act }, rows: [] }) as const;

  it("names the version an update to take brings, and its press is the Updates page's button", () => {
    expect(updateToLine(offer("0.9.4+20261123.5877c50"))).toEqual({ key: "app", mark: "accent", text: "Update to 0.9.4", does: { to: "update", act: "update" } });
    expect(updateToLine(offer("0.9.5+20261124.abcdef0", "app"))?.does).toEqual({ to: "update", act: "app" });
  });

  it("is there only while an update is there to take", () => {
    expect(updateToLine(null)).toBeNull();
    expect(updateToLine({ kind: "current", title: "Up to date", rows: [] })).toBeNull();
    // A member's: an owner or admin installs it, so nothing to press.
    expect(updateToLine({ kind: "available", title: "Update available", to: "0.9.4+20261123.abc", quiet: true, rows: [] })).toBeNull();
    expect(updateToLine({ kind: "updating", title: "Updating…", rows: [] })).toBeNull();
  });
});
