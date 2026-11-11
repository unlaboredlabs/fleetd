import { describe, expect, it } from "vitest";
import type { HubState } from "../../../shared/hub";
import type { Quiet } from "../updates/quiet";
import { hubLine, linkMark, machinesLine, menuLines, setupLine, updateLine, workMark, type MenuInput, type MenuMachine } from "./youMenu";

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
