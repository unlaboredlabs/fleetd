// @vitest-environment happy-dom
// The app paired with two hubs: one sidebar with every hub's bots in List, one hub's at a time in Hubs, each hub's
// connection on its own row (one offline never blocks the other), the Dock badge over both, and a project opening on
// its own hub, whose calls go to that hub only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import type { HubEntry } from "../../../shared/hubs";
import { createHubSet } from "../../src/data/hubs";
import { HubsProvider } from "../../src/data/react";
import { AT, live, snapshot } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { runCommand } from "../palette/registry";
import { closeAddProject } from "../projects/store";
import { onItsHub } from "./effects";
import { currentRoute } from "./navigation";
import { Shell } from "./Shell";
import { resetHubSwipe } from "./hubSwipe";
import { FINGERS, fingers, JITTERY_MAC_SWIPE, momentum, scrollDown, SLOW_MAC_SWIPE, swipe, swipeFingers, type Scroll } from "./hubSwipe.samples";
import { resetSidebarView, showHub } from "./sidebarLayout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeHub {
  send: (frame: HubFrame) => void;
  calls: Array<{ tool: string; input: unknown }>;
}

const fake = vi.hoisted(() => {
  // `discover` and `add`: what project_discover and project_add answer, when a test sets them.
  const hubs = new Map<string, { listeners: Set<(frame: unknown) => void>; calls: Array<{ tool: string; input: unknown }>; discover?: unknown; add?: unknown }>();
  const badge: number[] = [];
  // The chat each hub streams, as the page last asked (hub.chat): a project, or null for none.
  const chats: Array<[string, unknown]> = [];
  // What a clicked notification or a fleetd:// link hands the window (main's opener).
  const opened = new Set<(target: unknown) => void>();
  const of = (id: string) => {
    const held = hubs.get(id) ?? { listeners: new Set(), calls: [] };
    hubs.set(id, held);
    return held;
  };
  const done = () => Promise.resolve();
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    vibrancy: false,
    softwareCompositing: false,
    version: "test",
    app: {
      onMenuCommand: () => () => undefined,
      onOpen: (listener: (target: unknown) => void) => (opened.add(listener), () => opened.delete(listener)),
      notify: () => Promise.resolve(true),
      setBadge: (n: number) => (badge.push(n), done()),
      setMenuState: done,
      presence: () => Promise.resolve(true),
      linkHandler: () => Promise.resolve({ packaged: false, handler: false }),
      logError: done,
    },
    updates: { state: () => new Promise(() => undefined), subscribe: () => () => undefined },
    hubs: { list: () => Promise.resolve([]), subscribe: () => () => undefined, update: () => Promise.resolve({ ok: true }) },
    hub: {
      subscribe: (id: string, listener: (frame: unknown) => void) => {
        of(id).listeners.add(listener);
        return () => of(id).listeners.delete(listener);
      },
      call: (id: string, tool: string, input: unknown) => {
        of(id).calls.push({ tool, input });
        // The board, which the sidebar's counts read, and New bot's discover when a test gives one; nothing else.
        if (tool === "orders_board") return Promise.resolve({ ok: true, output: { orders: [] } });
        const discover = of(id).discover;
        if (tool === "project_discover" && discover !== undefined) return Promise.resolve({ ok: true, output: discover });
        const add = of(id).add;
        if (tool === "project_add" && add !== undefined) return Promise.resolve({ ok: true, output: add });
        return Promise.resolve({ ok: false, error: { code: "not_found", message: `${tool} isn't faked` } });
      },
      chat: (id: string, project: unknown) => (chats.push([id, project]), done()),
      focus: done,
      watch: done,
      input: done,
      resync: done,
      retryNow: done,
      cache: { read: () => Promise.resolve(null), write: done },
      forget: done,
    },
    pair: { store: () => Promise.resolve(null), probe: (hub: string) => Promise.resolve({ answers: false, hub }), start: () => new Promise(() => undefined) },
    system: { hostName: () => Promise.resolve("devbox") },
  });
  return { hubs, of, badge, opened, chats };
});

const hub = (id: string): FakeHub => ({
  send: (frame) => {
    for (const l of fake.of(id).listeners) l(frame);
  },
  calls: fake.of(id).calls,
});

const project = (machineId: string, projectId: string): HubFrame => {
  const frame = snapshot(1);
  if (frame.t !== "snapshot") throw new Error("not a snapshot");
  return {
    t: "snapshot",
    snapshot: {
      ...frame.snapshot,
      machines: [{ machineId, name: machineId, nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [] }],
      projects: [{ machineId, projectId, title: projectId, workspaceRoot: `/srv/${projectId}`, lastActivityAt: AT, threads: { running: 0, waiting: 0, idle: 0, failed: 0 } }],
      chats: [{ projectRef: { machineId, projectId }, lastSeq: 1, needsYou: true, leadWorking: false }],
    },
  };
};

/** A hub with two projects, the second one newer. */
const withTwo = (machineId: string, projectId: string, own: string): HubFrame => {
  const frame = project(machineId, projectId);
  if (frame.t !== "snapshot") throw new Error("not a snapshot");
  const mine = { machineId, projectId: own, title: own, workspaceRoot: `/srv/${own}`, lastActivityAt: new Date(Date.parse(AT) + 60_000).toISOString(), threads: { running: 0, waiting: 0, idle: 0, failed: 0 } };
  return { t: "snapshot", snapshot: { ...frame.snapshot, projects: [...frame.snapshot.projects, mine] } };
};

/** A hub with no bot and no machine yet, as a new fleetd cloud team's. */
const empty: HubFrame = (() => {
  const frame = snapshot(1);
  if (frame.t !== "snapshot") throw new Error("not a snapshot");
  return { t: "snapshot", snapshot: { ...frame.snapshot, machines: [], projects: [], chats: [] } };
})();

/** A hub with a machine and no bot yet. */
const machineOnly = (machineId: string): HubFrame => {
  const frame = project(machineId, "unused");
  if (frame.t !== "snapshot") throw new Error("not a snapshot");
  return { t: "snapshot", snapshot: { ...frame.snapshot, projects: [], chats: [] } };
};

const offline: HubFrame = { t: "state", state: { phase: "retrying", hub: "http://acme-hub:4790", reason: "connection refused", retryAt: Date.parse(AT) + 60_000 } };

let host: HTMLDivElement;
let root: Root;

const mount = async (entries: HubEntry[]) => {
  const set = createHubSet(window.fleetd, entries);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <HubsProvider hubs={set}>
        <UiProvider>
          <Shell />
        </UiProvider>
      </HubsProvider>,
    );
    await Promise.resolve();
  });
};

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
/** The sidebar's bots, by name, in order (each named by one of `names`); not the next hub's, sliding in beside them. */
const bots = (...names: string[]) =>
  [...host.querySelectorAll<HTMLElement>("nav[aria-label='Sidebar'] [data-reorder-row] button")].filter((b) => b.closest("[inert]") === null).flatMap((b) => names.filter((n) => b.textContent.startsWith(n)).slice(0, 1));
/** The hub row's switcher, as a screen reader hears it: the hub on show, and what is off with any. */
const switcher = () => host.querySelector<HTMLElement>("[data-opens='hubs']");
/** Opens a menu from its trigger, as the keys do (a press opens it on pointer-down, which the DOM here has no way to give). */
const openMenu = (trigger: HTMLElement | null | undefined) => act(() => void trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
const closeMenu = () => act(() => void document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
/** A menu row's words, without its mark or what sits at its end. */
const words = (r: HTMLElement) => r.querySelector("[data-text]")?.textContent ?? "";
/** The switcher's menu: each hub by its name, and the lines under it that say what is off. */
const hubMenu = () => {
  openMenu(switcher());
  const rows = [...document.querySelectorAll<HTMLElement>("[role='menu'] [role='menuitem']")].map((r) => (r.dataset["line"] === undefined ? words(r) : `  ${words(r)}`));
  closeMenu();
  return rows;
};
/** Picks a hub in the switcher's menu. */
const pickHub = (name: string) => {
  openMenu(switcher());
  act(() => [...document.querySelectorAll<HTMLElement>("[role='menu'] [role='menuitem']")].find((r) => words(r) === name)?.click());
};
const rowNamed = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("nav button, aside button, button")].find((b) => b.textContent.startsWith(name));

beforeEach(() => {
  window.location.hash = "#/";
  window.localStorage.clear();
  fake.hubs.clear();
  fake.badge.length = 0;
  fake.chats.length = 0;
  resetSidebarView();
  resetHubSwipe();
});
afterEach(() => {
  // New bot's state outlives the window, as it does the dialog: the next test opens a fresh one.
  act(() => closeAddProject());
  act(() => root.unmount());
  host.remove();
});

it("shows each hub's bots, each hub with its own connection, one offline beside one live", async () => {
  await mount([
    { id: "hub", label: "Personal" },
    { id: "a1b2", label: "Acme", color: "amber" },
  ]);
  act(() => {
    hub("hub").send(live());
    hub("hub").send(project("devbox", "storefront"));
    hub("a1b2").send(offline);
  });
  await settle();
  expect(bots("storefront", "billing")).toEqual(["storefront"]);
  // The offline hub on show waits without claiming to load.
  act(() => showHub("a1b2"));
  await settle();
  const acme = host.querySelector('section[aria-label="Acme"]');
  expect(acme?.querySelector('[aria-label="Loading bots"]')?.getAttribute("aria-busy")).toBe("false");
  act(() => showHub("hub"));
  await settle();
  // One offline marks the switcher, saying which; its menu has both hubs, and under Acme what is off.
  expect(switcher()?.getAttribute("aria-label")).toBe("Personal, Can't reach Acme");
  expect(hubMenu()).toEqual(["Personal", "Acme", "  Can't reach Acme", "Add a hub…"]);

  // Acme comes back: its project joins the list, and the badge counts both hubs' projects that need you.
  act(() => {
    hub("a1b2").send(live());
    hub("a1b2").send(project("laptop", "billing"));
  });
  await settle();
  act(() => showHub("a1b2"));
  await settle();
  expect(bots("storefront", "billing")).toEqual(["billing"]);
  // Back: nothing off with either hub (Personal's bot still wants you, which the switcher says on its own).
  expect(switcher()?.getAttribute("aria-label")).toBe("Acme, another hub needs you");
  expect(fake.badge.at(-1)).toBe(2);
});

it("opens a bot on its own hub, and that hub alone gets its calls", async () => {
  await mount([
    { id: "hub", label: "Personal" },
    { id: "a1b2", label: "Acme" },
  ]);
  act(() => {
    hub("hub").send(live());
    hub("hub").send(project("devbox", "storefront"));
    hub("a1b2").send(live());
    hub("a1b2").send(project("laptop", "billing"));
  });
  await settle();
  // On Personal's project first, so what stays on screen across the switch (the panel) must move to Acme too.
  act(() => {
    window.location.hash = "#/project/devbox/storefront/agents?at=hub";
  });
  // The panel loads in a chunk of its own, and its tabs' lists in another.
  await act(() => import("../panel/ProjectPanel"));
  await act(() => import("../panel/panes"));
  await settle();
  await settle();
  expect(host.querySelector('[data-screen="agents"]')).not.toBeNull();
  const before = hub("hub").calls.length;
  const acmeBefore = hub("a1b2").calls.length;
  act(() => showHub("a1b2"));
  await settle();
  act(() => rowNamed("billing")?.click());
  await settle();
  await settle();
  expect(window.location.hash).toBe("#/project/laptop/billing?at=a1b2");
  const about = (calls: FakeHub["calls"]) => calls.filter((c) => JSON.stringify(c.input).includes("billing"));
  expect(about(hub("a1b2").calls).length).toBeGreaterThan(0);
  expect(about(hub("hub").calls.slice(before))).toEqual([]);
  // The panel's whole-fleet reads after the switch are Acme's, never Personal's.
  const fleetReads = (calls: FakeHub["calls"]) => calls.filter((c) => c.tool === "agents_list").length;
  expect(fleetReads(hub("hub").calls.slice(before))).toBe(0);
  expect(fleetReads(hub("a1b2").calls.slice(acmeBefore))).toBeGreaterThan(0);
  // A link the screen builds without a hub stays on the hub it is on.
  act(() => {
    window.location.hash = "#/factory";
  });
  await settle();
  expect(currentRoute()).toMatchObject({ id: "factory", at: "a1b2" });
});

/** The chats streaming, as `<hub>:<bot>`: what each hub was last asked for, the one on screen; none, one hub left. */
const streaming = () => {
  const last = new Map(fake.chats);
  const on = [...last].flatMap(([at, p]) => (p === null || p === undefined ? [] : [`${at}:${(p as { projectId: string }).projectId}`]));
  return on.length === 1 ? on[0] : on.length === 0 ? null : on.join(" + ");
};
/** Two hubs of two bots each: Personal's storefront and Ada (newer), Acme's billing and ledger (newer). */
const twoByTwo = () =>
  act(() => {
    hub("hub").send(live());
    hub("hub").send(withTwo("devbox", "storefront", "Ada"));
    hub("a1b2").send(live());
    hub("a1b2").send(withTwo("laptop", "billing", "ledger"));
  });
const open = async (hash: string) => {
  act(() => {
    window.location.hash = hash;
  });
  await settle();
};

describe.each([
  ["desktop", "desktop"],
  ["web", "web"],
])("switching hubs in the %s app", (_, shell) => {
  const fleetd = window.fleetd as { shell?: string };
  beforeEach(() => {
    Object.assign(fleetd, { shell });
  });
  afterEach(() => {
    delete fleetd.shell;
  });

  it("opens the hub switched to with its list, from the switcher, the marks, ⇧⌘[ / ⇧⌘] and a swipe: the chat of the hub just left never stays on screen", async () => {
    await mount([
      { id: "hub", label: "Personal" },
      { id: "a1b2", label: "Acme" },
    ]);
    twoByTwo();
    await settle();
    await open("#/project/devbox/storefront?at=hub");
    expect(streaming()).toBe("hub:storefront");
    // Acme has no chat of its own yet: its home, its newest.
    pickHub("Acme");
    await settle();
    expect(currentRoute()).toMatchObject({ id: "project", project: { projectId: "ledger" }, at: "a1b2" });
    expect(streaming()).toBe("a1b2:ledger");
    expect(bots("storefront", "Ada", "billing", "ledger")).toEqual(["ledger", "billing"]);
    // Picking the hub already on screen changes nothing.
    pickHub("Acme");
    await settle();
    expect(window.location.hash).toBe("#/project/laptop/ledger?at=a1b2");
    const { swipe, lift, done } = swiping();
    try {
      for (const go of [
        () => act(() => host.querySelector<HTMLElement>("[role='group'][aria-label='Hubs'] button[aria-label='Personal']")?.click()),
        () => act(() => void runCommand("hub.next")),
        () => void swipe([[-4, 0], [-60, 0], [-60, 0], [-60, 0], [-60, 0]]),
      ]) {
        const was = currentRoute().at;
        go();
        lift();
        const now = currentRoute().at;
        expect(now).not.toBe(was);
        expect(streaming()?.startsWith(`${now}:`)).toBe(true);
        expect(marks()).toEqual(now === "hub" ? ["[Personal]", "Acme"] : ["Personal", "[Acme]"]);
      }
    } finally {
      done();
    }
  });
});

it("switches back to where you were on each hub, its last chat", async () => {
  await mount([
    { id: "hub", label: "Personal" },
    { id: "a1b2", label: "Acme" },
  ]);
  twoByTwo();
  await settle();
  // Each hub's older bot, not the one its home would open.
  await open("#/project/devbox/storefront?at=hub");
  pickHub("Acme");
  await settle();
  act(() => rowNamed("billing")?.click());
  await settle();
  expect(streaming()).toBe("a1b2:billing");
  pickHub("Personal");
  await settle();
  expect(window.location.hash).toBe("#/project/devbox/storefront?at=hub");
  expect(streaming()).toBe("hub:storefront");
  pickHub("Acme");
  await settle();
  expect(window.location.hash).toBe("#/project/laptop/billing?at=a1b2");
  expect(streaming()).toBe("a1b2:billing");
});

it("switches to a hub's home when the chat last open on it is gone, and to Get started on a hub with no bot", async () => {
  // Acme's last chat was a bot since removed or archived.
  window.localStorage.setItem("fleetd.lastChats", JSON.stringify({ a1b2: "a1b2:laptop/retired" }));
  await mount([
    { id: "hub", label: "Personal" },
    { id: "a1b2", label: "Acme" },
    { id: "c3d4", label: "Studio" },
  ]);
  twoByTwo();
  act(() => {
    hub("c3d4").send(live());
    hub("c3d4").send(empty);
  });
  await settle();
  await open("#/project/devbox/storefront?at=hub");
  pickHub("Acme");
  await settle();
  expect(window.location.hash).toBe("#/project/laptop/ledger?at=a1b2");
  expect(streaming()).toBe("a1b2:ledger");
  pickHub("Studio");
  await settle();
  expect(currentRoute()).toMatchObject({ id: "home", at: "c3d4" });
  expect(host.querySelector('[data-screen="home.empty"]')).not.toBeNull();
  expect(streaming()).toBeNull();
});

it("keeps each hub's last chat across a restart of the app", async () => {
  const start = async () => {
    await mount([
      { id: "hub", label: "Personal" },
      { id: "a1b2", label: "Acme" },
    ]);
    twoByTwo();
    await settle();
  };
  await start();
  await open("#/project/laptop/billing?at=a1b2");
  await open("#/project/devbox/storefront?at=hub");
  act(() => root.unmount());
  host.remove();
  fake.chats.length = 0;
  // A new launch, on Personal: Acme opens on billing, the chat last open there, not on its home.
  await start();
  expect(streaming()).toBe("hub:storefront");
  pickHub("Acme");
  await settle();
  expect(window.location.hash).toBe("#/project/laptop/billing?at=a1b2");
  expect(streaming()).toBe("a1b2:billing");
});

it("opens a first-hub notification on the first hub, even while another hub is on screen", async () => {
  await mount([
    { id: "hub", label: "Personal" },
    { id: "a1b2", label: "Acme" },
  ]);
  act(() => {
    hub("hub").send(live());
    hub("hub").send(project("devbox", "storefront"));
    hub("a1b2").send(live());
    hub("a1b2").send(project("laptop", "billing"));
  });
  await settle();
  act(() => showHub("a1b2"));
  await settle();
  act(() => rowNamed("billing")?.click());
  await settle();
  // Every hub's notification names its hub, the first's too.
  const target = onItsHub({ kind: "chat", machineId: "devbox", projectId: "storefront" }, "hub");
  expect(target).toEqual({ kind: "chat", machineId: "devbox", projectId: "storefront", at: "hub" });
  expect(onItsHub({ kind: "notifications" }, "a1b2")).toEqual({ kind: "notifications" });
  act(() => {
    for (const open of fake.opened) open(target);
  });
  await settle();
  expect(window.location.hash).toBe("#/project/devbox/storefront?at=hub");
  // One posted before there were several hubs names none: it is the first's. The removed Status page's opens home.
  act(() => rowNamed("billing")?.click());
  act(() => {
    for (const open of fake.opened) open({ kind: "status" });
  });
  await settle();
  expect(window.location.hash).toBe("#/project/devbox/storefront?at=hub");
});

it("⌘1–9 open the rows on show: the hub on show's, the screen's until another is picked", async () => {
  await mount([
    { id: "hub", label: "Personal" },
    { id: "a1b2", label: "Acme" },
  ]);
  act(() => {
    hub("hub").send(live());
    hub("hub").send(project("devbox", "storefront"));
    hub("a1b2").send(live());
    hub("a1b2").send(project("laptop", "billing"));
  });
  await settle();
  expect(bots("storefront", "billing")).toEqual(["storefront"]);
  act(() => {
    runCommand("project.open.1");
  });
  expect(window.location.hash).toBe("#/project/devbox/storefront?at=hub");
  // Picked at the top: Acme's bots, and only them.
  pickHub("Acme");
  await settle();
  expect(bots("storefront", "billing")).toEqual(["billing"]);
  act(() => {
    runCommand("project.open.1");
  });
  expect(window.location.hash).toBe("#/project/laptop/billing?at=a1b2");
});

it("orders the list from its ⋯ by name or the ones that want you first, draws it compact, and keeps that on this computer", async () => {
  await mount([{ id: "hub", label: "devbox" }]);
  act(() => {
    hub("hub").send(live());
    hub("hub").send(withTwo("devbox", "storefront", "Ada"));
  });
  await settle();
  expect(bots("Ada", "storefront")).toEqual(["Ada", "storefront"]);
  const pick = (name: string) => {
    openMenu(host.querySelector<HTMLElement>("[data-opens='list-menu']"));
    act(() => [...document.querySelectorAll<HTMLElement>("[role='menu'] [role='menuitemradio'], [role='menu'] [role='menuitemcheckbox']")].find((r) => r.textContent === name)?.click());
  };
  pick("Name");
  await settle();
  expect(bots("Ada", "storefront")).toEqual(["Ada", "storefront"]);
  pick("Compact rows");
  await settle();
  expect(host.querySelector("nav[aria-label='Sidebar']")?.hasAttribute("data-compact")).toBe(true);
  expect(JSON.parse(window.localStorage.getItem("fleetd.sidebarList") ?? "null")).toEqual({ sort: "name", compact: true });
  // Opened again: as it was left.
  act(() => root.unmount());
  host.remove();
  resetSidebarView();
  await mount([{ id: "hub", label: "devbox" }]);
  await settle();
  expect(host.querySelector("nav[aria-label='Sidebar']")?.hasAttribute("data-compact")).toBe(true);
});

/**
 * `#/`'s redirect to its project never lands, as when the packaged smoke sets `#/` again before the page reads it:
 * the page keeps showing the project from `#/` itself. Returns the undo.
 */
const holdHome = () => {
  const replace = vi.spyOn(window.location, "replace").mockImplementation(() => undefined);
  return () => replace.mockRestore();
};

it("keeps the chat it shows streaming when `#/` comes back before the page reads the home redirect", async () => {
  window.location.hash = "#/";
  const reset = holdHome();
  await mount([{ id: "hub", label: "devbox" }]);
  act(() => {
    hub("hub").send(live());
    hub("hub").send(project("devbox", "storefront"));
  });
  await settle();
  await settle();
  expect(window.location.hash).toBe("#/");
  expect(host.querySelector('[data-screen^="chat"]')).not.toBeNull();
  // The chat on screen is the one the hub streams.
  expect(fake.chats.at(-1)).toEqual(["hub", { machineId: "devbox", projectId: "storefront" }]);
  reset();
});

it("opens `#/`'s last bot on its own hub, the chat streaming from there, even if the redirect is never read", async () => {
  // The last project opened was Acme's billing (kept by hub and project, shell's LAST_PROJECT).
  window.localStorage.setItem("fleetd.lastProject", "a1b2:laptop/billing");
  window.location.hash = "#/";
  const reset = holdHome();
  await mount([
    { id: "hub", label: "Personal" },
    { id: "a1b2", label: "Acme" },
  ]);
  act(() => {
    hub("hub").send(live());
    hub("hub").send(project("devbox", "storefront"));
    hub("a1b2").send(live());
    hub("a1b2").send(project("laptop", "billing"));
  });
  await settle();
  await settle();
  expect(window.location.hash).toBe("#/");
  expect(host.querySelector('[data-screen^="chat"]')).not.toBeNull();
  // Acme streams billing's chat; Personal was never asked for it, and its own chat is closed.
  expect(fake.chats.filter(([id]) => id === "a1b2").at(-1)).toEqual(["a1b2", { machineId: "laptop", projectId: "billing" }]);
  expect(fake.chats.filter(([id, p]) => id === "hub" && p !== null)).toEqual([]);
  // And the chat's own reads went to Acme.
  const about = (calls: FakeHub["calls"]) => calls.filter((c) => JSON.stringify(c.input).includes("billing"));
  expect(about(hub("a1b2").calls).length).toBeGreaterThan(0);
  expect(about(hub("hub").calls)).toEqual([]);
  reset();
});

it("with one hub, shows no name and no group: the sidebar is as it always was", async () => {
  await mount([{ id: "hub", label: "devbox" }]);
  act(() => {
    hub("hub").send(live());
    hub("hub").send(project("devbox", "storefront"));
  });
  await settle();
  expect(host.textContent).not.toContain("Bots");
  expect(switcher()?.getAttribute("aria-label")).toBe("devbox");
  expect(hubMenu()).toEqual(["devbox", "Add a hub…"]);
  act(() => rowNamed("storefront")?.click());
  expect(window.location.hash).toBe("#/project/devbox/storefront");
});

it("says which hub a new bot goes to with several hubs, the hub on screen first, and nothing with one", async () => {
  await mount([
    { id: "hub", label: "Personal" },
    { id: "a1b2", label: "Acme" },
  ]);
  act(() => {
    hub("hub").send(live());
    hub("a1b2").send(live());
  });
  await settle();
  act(() => {
    window.location.hash = "#/projects/add?at=a1b2";
  });
  // The sheet loads in a chunk of its own.
  await act(() => import("../projects/AddProjectScreen"));
  await settle();
  await settle();
  const picker = () => document.querySelector<HTMLElement>("[role='combobox'][aria-label='Hub']");
  expect(picker()?.textContent).toContain("Acme");
  act(() => root.unmount());
  root = createRoot(host);

  await mount([{ id: "hub", label: "devbox" }]);
  act(() => hub("hub").send(live()));
  act(() => {
    window.location.hash = "#/projects/add";
  });
  await settle();
  await settle();
  expect(document.querySelector("[data-screen='projects.add']")).not.toBeNull();
  expect(picker()).toBeNull();
});

/**
 * New bot opened on Personal, whose last bot is the one opened, a name typed, then Acme (sent `acme`) picked in its
 * Adds to. Returns what was on screen before the pick, to compare with after.
 */
const pickAcme = async (acme: HubFrame) => {
  // The last bot opened is on Personal: going to Acme's home must not open it, which took the dialog back.
  window.localStorage.setItem("fleetd.lastProject", "devbox/storefront");
  await mount([
    { id: "hub", label: "Personal" },
    { id: "a1b2", label: "Acme" },
  ]);
  act(() => {
    hub("hub").send(live());
    hub("hub").send(project("devbox", "storefront"));
    hub("a1b2").send(live());
    hub("a1b2").send(acme);
  });
  await settle();
  act(() => {
    window.location.hash = "#/projects/add";
  });
  await act(() => import("../projects/AddProjectScreen"));
  await settle();
  await settle();
  expect(hubPicker()?.textContent).toContain("Personal");
  await type("Name", "Garden notes");
  const before = { dialog: dialog(), backdrop: dialog()?.previousElementSibling, field: nameField(), screen: host.querySelector("[data-screen='shell']") };
  // What leaves the page from here: a node the dialog, its backdrop or the app is made of, taken out to be made again.
  const removed: Node[] = [];
  const watch = new MutationObserver((records) => removed.push(...records.flatMap((r) => [...r.removedNodes])));
  watch.observe(document.body, { childList: true, subtree: true });
  await act(async () => {
    hubPicker()?.focus();
    hubPicker()?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await Promise.resolve();
  });
  await settle();
  const option = [...document.querySelectorAll<HTMLElement>("[role='option']")].find((o) => o.textContent === "Acme");
  await act(async () => {
    option?.click();
    await Promise.resolve();
  });
  await settle();
  await settle();
  await settle();
  watch.disconnect();
  return { before, removed };
};

const hubPicker = () => document.querySelector<HTMLElement>("[role='combobox'][aria-label='Hub']");
const dialog = () => document.querySelector<HTMLElement>("[data-screen='projects.add']");
const nameField = () => document.querySelector<HTMLInputElement>("input[aria-label='Name']");
const type = async (label: string, text: string) => {
  const el = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (el === null) throw new Error(`no field ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

it("switches New bot to the hub picked in Adds to in place: nothing remounts, the name and focus stay, the app under it stays", async () => {
  fake.of("a1b2").discover = { machines: [{ machineId: "laptop", online: true, cloneRoot: "/home/l/src", projectsRoot: "/home/l/fleetd/projects", repos: [] }], github: { owners: [], repos: [] }, best: "laptop" };
  const { before, removed } = await pickAcme(machineOnly("laptop"));
  expect(hubPicker()?.textContent).toContain("Acme");
  // The same dialog, backdrop, field and app: none of them left the page and came back (the flash).
  expect(dialog()).toBe(before.dialog);
  expect(dialog()?.previousElementSibling).toBe(before.backdrop);
  expect(nameField()).toBe(before.field);
  expect(host.querySelector("[data-screen='shell']")).toBe(before.screen);
  const parts = [before.dialog, before.backdrop, before.field, before.screen];
  expect(removed.filter((n) => parts.some((p) => p != null && (n === p || n.contains(p))))).toEqual([]);
  // What was typed stays, and focus is where it was: on Adds to.
  expect(nameField()?.value).toBe("Garden notes");
  expect(document.activeElement).toBe(hubPicker());
  // Under it, Personal's chat as it was; Acme was asked what it can make a bot on, and its machine is the one offered.
  expect(window.location.hash).toBe("#/project/devbox/storefront?at=hub");
  expect(hub("a1b2").calls.some((c) => c.tool === "project_discover")).toBe(true);
  expect(dialog()?.textContent).toContain("On laptop");
});

it("picks a hub with no bot and no machine in Adds to, and keeps it there", async () => {
  await pickAcme(empty);
  expect(dialog()).not.toBeNull();
  expect(hubPicker()?.textContent).toContain("Acme");
  expect(nameField()?.value).toBe("Garden notes");
});

it("opens New bot on the hub on view, from the sidebar's +, the palette and a link, with that hub's machine", async () => {
  window.localStorage.setItem("fleetd.lastProject", "devbox/storefront");
  fake.of("hub").discover = { machines: [{ machineId: "devbox", online: true, cloneRoot: "/home/d/src", projectsRoot: "/home/d/fleetd/projects", repos: [] }], github: { owners: [], repos: [] }, best: "devbox" };
  fake.of("a1b2").discover = { machines: [{ machineId: "laptop", online: true, cloneRoot: "/home/l/src", projectsRoot: "/home/l/fleetd/projects", repos: [] }], github: { owners: [], repos: [] }, best: "laptop" };
  await mount([
    { id: "hub", label: "Personal" },
    { id: "a1b2", label: "Acme" },
  ]);
  act(() => {
    hub("hub").send(live());
    hub("hub").send(project("devbox", "storefront"));
    hub("a1b2").send(live());
    hub("a1b2").send(machineOnly("laptop"));
  });
  await settle();
  await act(() => import("../projects/AddProjectScreen"));
  const opened = async (open: () => void) => {
    act(open);
    await settle();
    await settle();
    await settle();
    const shown = { hub: hubPicker()?.textContent, on: dialog()?.textContent.includes("On laptop") ? "laptop" : dialog()?.textContent.includes("On devbox") ? "devbox" : null };
    act(() => closeAddProject());
    await settle();
    return shown;
  };
  // Acme on view, and on screen its home: it has no bot yet.
  pickHub("Acme");
  await settle();
  expect(window.location.hash).toBe("#/?at=a1b2");
  const plus = () => host.querySelector<HTMLElement>("[data-opens='projects.add']");
  expect(await opened(() => plus()?.click())).toEqual({ hub: "Acme", on: "laptop" });
  expect(await opened(() => runCommand("go:projects.add"))).toEqual({ hub: "Acme", on: "laptop" });
  // A link naming a hub adds to that one.
  expect(await opened(() => void (window.location.hash = "#/projects/add?at=hub"))).toEqual({ hub: "Personal", on: "devbox" });
  // Back on Personal: its own.
  pickHub("Personal");
  await settle();
  expect(await opened(() => plus()?.click())).toEqual({ hub: "Personal", on: "devbox" });
  expect(await opened(() => runCommand("go:projects.add"))).toEqual({ hub: "Personal", on: "devbox" });
});

it("makes the bot on the hub picked in Adds to, and opens its chat there once that hub lists it", async () => {
  fake.of("a1b2").discover = { machines: [{ machineId: "laptop", online: true, cloneRoot: "/home/l/src", projectsRoot: "/home/l/fleetd/projects", repos: [] }], github: { owners: [], repos: [] }, best: "laptop" };
  fake.of("a1b2").add = { machineId: "laptop", path: "/home/l/fleetd/projects/notes", projectId: "notes", created: true, inspect: { ci: { workflows: [], requiredChecks: [] }, merge: { protected: false, rulesets: [] }, leadNeeds: "a plain folder with no git", notes: [] } };
  await pickAcme(machineOnly("laptop"));
  expect(document.body.textContent).toContain("On laptop");
  const press = async (button: HTMLElement | null | undefined) => {
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    await settle();
  };
  await type("Name", "Notes");
  await press([...document.querySelectorAll<HTMLButtonElement>("[data-screen='projects.add'] button")].find((b) => b.textContent === "Create"));
  expect(hub("a1b2").calls.filter((c) => c.tool === "project_add").map((c) => c.input)).toEqual([expect.objectContaining({ machineId: "laptop", title: "Notes" })]);
  expect(hub("hub").calls.filter((c) => c.tool === "project_add")).toEqual([]);
  // Made with no repo: the dialog is done at once and lets go of Acme, the screen still on Personal's chat. The chat
  // opens once Acme's snapshot lists the bot, on Acme.
  expect(dialog()).toBeNull();
  expect(window.location.hash).toBe("#/project/devbox/storefront?at=hub");
  act(() => hub("a1b2").send(project("laptop", "notes")));
  await settle();
  expect(window.location.hash).toBe("#/project/laptop/notes?at=a1b2");
});

it("opens on the one sidebar on a computer that kept the old List or Rail layout", async () => {
  window.localStorage.setItem("fleetd.sidebarLayout", "rail");
  resetSidebarView();
  await mount([
    { id: "hub", label: "Personal" },
    { id: "a1b2", label: "Acme" },
  ]);
  act(() => {
    hub("hub").send(live());
    hub("hub").send(project("devbox", "storefront"));
    hub("a1b2").send(live());
    hub("a1b2").send(project("laptop", "billing"));
  });
  await settle();
  expect(switcher()?.getAttribute("aria-label")).toMatch(/^Personal\b/u);
  expect(bots("storefront", "billing")).toEqual(["storefront"]);
  expect(host.querySelector("[data-layout]")).toBeNull();
});

it("opens Settings on another hub over the chat you were in, never that chat in the other hub's frame, and closes back to it", async () => {
  await mount([
    { id: "hub", label: "Personal" },
    { id: "a1b2", label: "Acme" },
  ]);
  act(() => {
    hub("hub").send(live());
    hub("hub").send(project("devbox", "storefront"));
    hub("a1b2").send(live());
    hub("a1b2").send(project("laptop", "billing"));
  });
  act(() => {
    window.location.hash = "#/project/devbox/storefront?at=hub";
  });
  await settle();
  await settle();
  const last = window.localStorage.getItem("fleetd.lastProject");
  expect(last).not.toBeNull();
  // Acme's settings, while Personal's chat is on screen.
  act(() => {
    window.location.hash = "#/settings/general?at=a1b2";
  });
  await settle();
  // The sheet is Settings' own chunk: it shows once that has loaded.
  await vi.waitFor(async () => {
    await settle();
    expect(document.querySelector("[aria-label='Close settings']")).not.toBeNull();
  });
  // Under the sheet: Acme's own chat, streamed by Acme; Personal's storefront is never asked of Acme, and stays the
  // one `#/` opens.
  expect(fake.chats.filter(([id, p]) => id === "a1b2" && (p as { projectId?: string } | null)?.projectId === "storefront")).toEqual([]);
  expect(window.localStorage.getItem("fleetd.lastProject")).toBe(last);
  act(() => document.querySelector<HTMLButtonElement>("[aria-label='Close settings']")?.click());
  await settle();
  expect(window.location.hash).toBe("#/project/devbox/storefront?at=hub");
  expect(window.localStorage.getItem("fleetd.lastProject")).toBe(last);
});

it("switches the hub a Hub page manages in place: the sheet and the app under it stay, the page's reads go to the other hub", async () => {
  await mount([
    { id: "hub", label: "Personal" },
    { id: "a1b2", label: "Acme" },
  ]);
  act(() => {
    hub("hub").send(live());
    hub("hub").send(project("devbox", "storefront"));
    hub("a1b2").send(live());
    hub("a1b2").send(project("laptop", "billing"));
  });
  act(() => {
    window.location.hash = "#/project/devbox/storefront?at=hub";
  });
  await settle();
  act(() => {
    window.location.hash = "#/settings/hub/people?at=hub";
  });
  await vi.waitFor(async () => {
    await settle();
    expect(document.querySelector("[data-managing='hub'] [data-admin-hub='a1b2']")).not.toBeNull();
  });
  const sheet = document.querySelector("[data-sheet='settings']");
  const frame = host.querySelector("[data-screen='shell']");
  // Nothing of the sheet leaves the screen meanwhile, not even for a frame: a sheet mounted again plays its entrance
  // again, the scrim from clear and the sheet from nothing, which flashes the whole window.
  const removed: Node[] = [];
  const watch = new MutationObserver((records) => records.forEach((r) => removed.push(...r.removedNodes)));
  watch.observe(document.body, { childList: true, subtree: true });
  act(() => document.querySelector<HTMLButtonElement>("[data-admin-hub='a1b2']")?.click());
  await settle();
  watch.disconnect();
  expect(document.querySelector("[data-managing='a1b2']")).not.toBeNull();
  expect(document.querySelector("[data-sheet='settings']")).toBe(sheet);
  expect(removed.filter((n) => n === sheet || n === frame || n.contains(sheet))).toEqual([]);
  // The app under it is still the chat you were in, on its own hub; the page reads Acme's people.
  expect(host.querySelector("[data-screen='shell']")).toBe(frame);
  expect(fake.chats.filter(([id, p]) => id === "a1b2" && p !== null)).toEqual([]);
  expect(hub("a1b2").calls.some((c) => c.tool === "people_list")).toBe(true);
});

/**
 * The swipe across the sidebar (hubSwipe.ts), on the clock: a list as wide as the default sidebar, and wheel events
 * as a trackpad sends them, 10 ms apart. Returns whether the page let the list scroll with each.
 */
const swiping = () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(256);
  const swipe = (deltas: ReadonlyArray<readonly [number, number]>): boolean[] =>
    deltas.map(([dx, dy]) => {
      const e = new WheelEvent("wheel", { deltaX: dx, deltaY: dy, bubbles: true, cancelable: true });
      act(() => {
        // Over a row of the list on show, as a trackpad's swipe starts.
        (host.querySelector("nav[aria-label='Sidebar'] [data-reorder-row] button") ?? host.querySelector("nav"))?.dispatchEvent(e);
        vi.advanceTimersByTime(10);
      });
      return !e.defaultPrevented;
    });
  /** Fingers off: the pause that ends the gesture, and the spring's settle. */
  const lift = () => act(() => void vi.advanceTimersByTime(1000));
  const done = () => {
    width.mockRestore();
    vi.useRealTimers();
  };
  return { swipe, lift, done };
};
/** The list on show where it belongs: not moved, not moving, nothing beside it. */
const inPlace = () => {
  const list = host.querySelector<HTMLElement>("nav[aria-label='Sidebar'] [class*='list']");
  expect(list?.style.transform).toBe("");
  expect(list?.parentElement?.hasAttribute("data-moving")).toBe(false);
  expect(host.querySelector("nav [aria-hidden][inert]")).toBeNull();
};
const marks = () => [...host.querySelectorAll<HTMLElement>("[role='group'][aria-label='Hubs'] button")].map((b) => (b.getAttribute("aria-current") === null ? b.getAttribute("aria-label") : `[${b.getAttribute("aria-label") ?? ""}]`));
const twoHubs = async () => {
  await mount([
    { id: "hub", label: "Personal" },
    { id: "a1b2", label: "Acme", color: "amber" },
  ]);
  act(() => {
    hub("hub").send(live());
    hub("hub").send(project("devbox", "storefront"));
    hub("a1b2").send(live());
    hub("a1b2").send(project("laptop", "billing"));
  });
  await settle();
};

it("switches to the next hub on a swipe across the sidebar, once a gesture however far it goes, and back on the next", async () => {
  await twoHubs();
  expect(marks()).toEqual(["[Personal]", "Acme"]);
  const { swipe, lift, done } = swiping();
  try {
    // Two fingers left, past a whole width and on: Acme, and no further; the list never scrolled with it.
    const free = swipe(Array.from({ length: 40 }, () => [14, 1] as const));
    expect(free.slice(1).every((f) => !f)).toBe(true);
    expect(bots("storefront", "billing")).toEqual(["billing"]);
    expect(switcher()?.getAttribute("aria-label")).toContain("Acme");
    expect(marks()).toEqual(["Personal", "[Acme]"]);
    // Its momentum, the other way, in the same gesture: swallowed.
    swipe(Array.from({ length: 30 }, () => [-12, 0] as const));
    expect(bots("storefront", "billing")).toEqual(["billing"]);
    lift();
    // A new gesture, fingers right, a little over half way and let go: it settles back on Personal.
    swipe([[-4, 0], [-30, 0], [-40, 0], [-40, 0], [-30, 0]]);
    expect(bots("storefront", "billing")).toEqual(["billing"]);
    lift();
    expect(bots("storefront", "billing")).toEqual(["storefront"]);
    expect(marks()).toEqual(["[Personal]", "Acme"]);
    // Not far enough: back where it was.
    swipe([[4, 0], [20, 0], [20, 0], [20, 0]]);
    lift();
    expect(bots("storefront", "billing")).toEqual(["storefront"]);
    // Past the last hub it gives a little and stays.
    swipe([[-4, 0], [-60, 0], [-60, 0], [-60, 0], [-60, 0]]);
    lift();
    expect(bots("storefront", "billing")).toEqual(["storefront"]);
  } finally {
    done();
  }
});

/**
 * Plays a Mac trackpad's scrolls (hubSwipe.samples.ts) over a row of the list on show, on the clock, the pointer never
 * moving: the wheel events the page gets of them, each cancelable as `mac` says. On a Mac, Chromium makes a touch's
 * first event cancelable, and the rest of it only if the page cancelled that first one (the app is told it is on one);
 * elsewhere every one is. Whether the page let the list scroll with each.
 */
const replay = (scrolls: readonly Scroll[], mac: boolean): boolean[] => {
  const free: boolean[] = [];
  let held = false;
  for (const s of scrolls) {
    act(() => {
      if (s.dx !== 0 || s.dy !== 0) {
        const first = s.phase === FINGERS.began;
        const e = new WheelEvent("wheel", { deltaX: s.dx, deltaY: s.dy, bubbles: true, cancelable: !mac || first || held });
        (host.querySelector("nav[aria-label='Sidebar'] [data-reorder-row] button") ?? host.querySelector("nav"))?.dispatchEvent(e);
        if (first) held = e.defaultPrevented;
        free.push(!e.defaultPrevented);
      }
      vi.advanceTimersByTime(s.wait);
    });
  }
  return free;
};
const threeHubs = async () => {
  await mount([
    { id: "hub", label: "Personal" },
    { id: "a1b2", label: "Acme", color: "amber" },
    { id: "c3d4", label: "Studio", color: "green" },
  ]);
  act(() => {
    for (const [id, machine, bot] of [["hub", "devbox", "storefront"], ["a1b2", "laptop", "billing"], ["c3d4", "studio", "atlas"]] as const) {
      hub(id).send(live());
      hub(id).send(project(machine, bot));
    }
  });
  await settle();
};

describe.each([
  ["on a Mac, where Chromium says where a touch begins", true],
  ["where only the deltas tell", false],
])("a trackpad's swipes %s", (_, mac) => {
  const fleetd = window.fleetd as { shell?: string; platform: string };
  beforeEach(() => {
    if (mac) Object.assign(fleetd, { shell: "desktop", platform: "darwin" });
  });
  afterEach(() => {
    delete fleetd.shell;
    fleetd.platform = "linux";
  });

  it("swipes back at once, while the last swipe's momentum is still arriving, the pointer never moving", async () => {
    await twoHubs();
    const { lift, done } = swiping();
    try {
      // A swipe left: it has landed on Acme while its glide still arrives, until the fingers touch again and swipe right.
      replay(swipe(1, 30), mac);
      expect(marks()).toEqual(["Personal", "[Acme]"]);
      replay(swipe(-1), mac);
      lift();
      expect(marks()).toEqual(["[Personal]", "Acme"]);
      expect(bots("storefront", "billing")).toEqual(["storefront"]);
      inPlace();
    } finally {
      done();
    }
  });

  it("swipes on a touch whose first event already goes far sideways", async () => {
    await threeHubs();
    const { lift, done } = swiping();
    try {
      // Each one a hub, on and back in turn, so a swipe that does nothing shows: first events of 6, 9 and 24 px, a
      // flick from its fastest, and a start handed over as one lump.
      const runs: ReadonlyArray<readonly [1 | -1, readonly number[], readonly string[]]> = [
        [1, [6, 12, 18, 20, 20, 16, 12], ["Personal", "[Acme]", "Studio"]],
        [-1, [9, 12, 18, 20, 20, 16, 12], ["[Personal]", "Acme", "Studio"]],
        [1, [24, 12, 18, 20, 20, 16, 12], ["Personal", "[Acme]", "Studio"]],
        [1, [30, 28, 26, 22, 18, 14], ["Personal", "Acme", "[Studio]"]],
        [-1, [14, 12, 16, 20, 20, 16, 12], ["Personal", "[Acme]", "Studio"]],
      ];
      for (const [side, deltas, then] of runs) {
        replay([...fingers(deltas.map((d) => [d * side, 0] as const)), ...momentum([10 * side, 0])], mac);
        lift();
        expect(marks()).toEqual(then);
      }
      inPlace();
    } finally {
      done();
    }
  });

  it("switches on a flick from rest, and on a flick back while the last glide still arrives", async () => {
    await threeHubs();
    const { lift, done } = swiping();
    try {
      const flick = (side: 1 | -1, count = Infinity) => [...fingers([30, 28, 26, 22, 18, 14].map((d) => [d * side, 0] as const)), ...momentum([10 * side, 0], { count })];
      replay(swipe(1), mac);
      act(() => void vi.advanceTimersByTime(410));
      expect(marks()).toEqual(["Personal", "[Acme]", "Studio"]);
      // Its glide lands the slide while it still arrives; the flick back comes in the middle of it.
      replay(flick(1, 30), mac);
      expect(marks()).toEqual(["Personal", "Acme", "[Studio]"]);
      replay(flick(-1), mac);
      lift();
      expect(marks()).toEqual(["Personal", "[Acme]", "Studio"]);
      // And back again a quarter of a second after the last glide ended.
      replay(swipe(1), mac);
      expect(marks()).toEqual(["Personal", "Acme", "[Studio]"]);
      act(() => void vi.advanceTimersByTime(250));
      replay(flick(-1), mac);
      lift();
      expect(marks()).toEqual(["Personal", "[Acme]", "Studio"]);
      inPlace();
    } finally {
      done();
    }
  });

  it("swipes on at once, mid-glide and mid-settle, one hub a swipe", async () => {
    await threeHubs();
    const { lift, done } = swiping();
    try {
      // The second touch comes while the first is still settling: it lands, and the second goes on from there.
      replay(swipe(1, 6), mac);
      replay(swipe(1), mac);
      lift();
      expect(marks()).toEqual(["Personal", "Acme", "[Studio]"]);
      inPlace();
    } finally {
      done();
    }
  });

  it("never switches a second time on a glide, however long, nor on its glide running on past a pause", async () => {
    await threeHubs();
    const { lift, done } = swiping();
    try {
      replay([...swipeFingers(1), ...momentum([30, 0], { decay: 0.97 })], mac);
      act(() => void vi.advanceTimersByTime(150));
      expect(marks()).toEqual(["Personal", "[Acme]", "Studio"]);
      replay(momentum([20, 0], { decay: 0.97 }), mac);
      lift();
      expect(marks()).toEqual(["Personal", "[Acme]", "Studio"]);
      inPlace();
    } finally {
      done();
    }
  });

  it("never switches on a scroll up, down or across the list, one started mid-glide included, and never swallows it", async () => {
    await twoHubs();
    const { lift, done } = swiping();
    try {
      const diagonal = [...fingers([[2, 2], [5, 4], [9, 8], [12, 11], [10, 10], [6, 6]]), ...momentum([5, 5])];
      expect(replay(scrollDown(), mac).every((f) => f)).toBe(true);
      lift();
      expect(replay(diagonal, mac).every((f) => f)).toBe(true);
      lift();
      expect(marks()).toEqual(["[Personal]", "Acme"]);
      // A swipe, and a scroll down the list while its glide still arrives: the scroll is the list's.
      replay(swipe(1, 30), mac);
      expect(replay(scrollDown(), mac).every((f) => f)).toBe(true);
      lift();
      expect(marks()).toEqual(["Personal", "[Acme]"]);
    } finally {
      done();
    }
  });

  it("lands a slide at once when a scroll begins while it settles, the list in place to scroll", async () => {
    await twoHubs();
    const { lift, done } = swiping();
    try {
      replay(swipe(1, 2), mac);
      expect(host.querySelector("nav[aria-label='Sidebar'] [data-moving]")).not.toBeNull();
      // Its touch's first event, after a pause as a new touch on a trackpad comes.
      act(() => void vi.advanceTimersByTime(120));
      expect(replay(scrollDown().slice(0, 3), mac).every((f) => f)).toBe(true);
      expect(marks()).toEqual(["Personal", "[Acme]"]);
      inPlace();
      lift();
    } finally {
      done();
    }
  });

  it("springs back on a swipe that turns back before it lifts", async () => {
    await twoHubs();
    const { lift, done } = swiping();
    try {
      replay(fingers([2, 6, 12, 16, 16, 12, 8, 4, -4, -10, -16, -16, -10, -6].map((d) => [d, 0] as const)), mac);
      lift();
      expect(marks()).toEqual(["[Personal]", "Acme"]);
      inPlace();
    } finally {
      done();
    }
  });
});

describe.each([
  ["on a Mac", true],
  ["where only the deltas tell", false],
])("a swipe whose events reach the page late and bunched, as a slow machine hands them over, %s", (_, mac) => {
  // On a Mac it switches one hub. With only the deltas, 300 ms between two of a touch's events are a pause like any
  // other, and the pieces between them are no swipe of their own: it springs back. Never two hubs, either way.
  it(mac ? "switches one hub" : "never switches two hubs", async () => {
    const fleetd = window.fleetd as { shell?: string; platform: string };
    if (mac) Object.assign(fleetd, { shell: "desktop", platform: "darwin" });
    await threeHubs();
    const { lift, done } = swiping();
    try {
      let t = 0;
      for (const [at, dx, dy, cancelable] of SLOW_MAC_SWIPE) {
        act(() => {
          vi.advanceTimersByTime(at - t);
          t = at;
          const e = new WheelEvent("wheel", { deltaX: dx, deltaY: dy, bubbles: true, cancelable: !mac || cancelable === 1 });
          (host.querySelector("nav[aria-label='Sidebar'] [data-reorder-row] button") ?? host.querySelector("nav"))?.dispatchEvent(e);
        });
      }
      lift();
      expect(marks()).toEqual(mac ? ["Personal", "[Acme]", "Studio"] : ["[Personal]", "Acme", "Studio"]);
      inPlace();
    } finally {
      done();
      delete fleetd.shell;
      fleetd.platform = "linux";
    }
  });
});

it("switches on a swipe whose events come unevenly late, as a busy Mac hands them over, by their sizes", async () => {
  const fleetd = window.fleetd as { shell?: string; platform: string };
  Object.assign(fleetd, { shell: "desktop", platform: "darwin" });
  await threeHubs();
  const { lift, done } = swiping();
  try {
    act(() => host.querySelector<HTMLElement>("[role='group'][aria-label='Hubs'] button[aria-label='Acme']")?.click());
    lift();
    let t = 0;
    for (const [at, dx, dy, cancelable] of JITTERY_MAC_SWIPE) {
      act(() => {
        vi.advanceTimersByTime(at - t);
        t = at;
        const e = new WheelEvent("wheel", { deltaX: dx, deltaY: dy, bubbles: true, cancelable: cancelable === 1 });
        (host.querySelector("nav[aria-label='Sidebar'] [data-reorder-row] button") ?? host.querySelector("nav"))?.dispatchEvent(e);
      });
    }
    lift();
    expect(marks()).toEqual(["[Personal]", "Acme", "Studio"]);
    inPlace();
  } finally {
    done();
    delete fleetd.shell;
    fleetd.platform = "linux";
  }
});

it("keeps a hub picked in the switcher while a slide is on its way to another", async () => {
  await threeHubs();
  const { lift, done } = swiping();
  try {
    act(() => void runCommand("hub.next"));
    act(() => void vi.advanceTimersByTime(60));
    pickHub("Studio");
    lift();
    expect(marks()).toEqual(["Personal", "Acme", "[Studio]"]);
    inPlace();
  } finally {
    done();
  }
});

it("lands a slide at once on a press over the list, the list back under the pointer", async () => {
  await twoHubs();
  const { done } = swiping();
  try {
    act(() => void runCommand("hub.next"));
    act(() => void vi.advanceTimersByTime(60));
    const frame = host.querySelector<HTMLElement>("nav[aria-label='Sidebar'] [data-moving]");
    expect(frame).not.toBeNull();
    act(() => void frame?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(marks()).toEqual(["Personal", "[Acme]"]);
    inPlace();
  } finally {
    done();
  }
});

it("never switches on a scroll up or down the list, whatever it drifts sideways", async () => {
  await twoHubs();
  const { swipe, lift, done } = swiping();
  try {
    const free = swipe([[1, 6], [3, 12], [14, 10], [30, 8], [40, 4], [20, 1], [10, 0], [6, 0]]);
    lift();
    expect(free.every((f) => f)).toBe(true);
    expect(bots("storefront", "billing")).toEqual(["storefront"]);
    expect(marks()).toEqual(["[Personal]", "Acme"]);
  } finally {
    done();
  }
});

it("switches from the marks at the foot and from ⇧⌘[ / ⇧⌘], and the marks follow", async () => {
  await twoHubs();
  const { lift, done } = swiping();
  try {
    act(() => host.querySelector<HTMLElement>("[role='group'][aria-label='Hubs'] button[aria-label='Acme']")?.click());
    lift();
    expect(bots("storefront", "billing")).toEqual(["billing"]);
    expect(marks()).toEqual(["Personal", "[Acme]"]);
    // Round the end, as ⌘] goes round the bots.
    act(() => void runCommand("hub.next"));
    lift();
    expect(bots("storefront", "billing")).toEqual(["storefront"]);
    act(() => void runCommand("hub.previous"));
    lift();
    expect(marks()).toEqual(["Personal", "[Acme]"]);
    // The hub on show after a swipe still says what is off with it, as after a pick.
    act(() => hub("a1b2").send(offline));
    act(() => void runCommand("hub.next"));
    act(() => void runCommand("hub.next"));
    lift();
    expect(switcher()?.getAttribute("aria-label")).toBe("Acme, another hub needs you, Can't reach Acme");
    inPlace();
    // There and straight back, and the same mark clicked mid-slide: the hub on show never changes, and the list is
    // drawn in place, clickable, with nothing beside it.
    act(() => void runCommand("hub.next"));
    act(() => void vi.advanceTimersByTime(100));
    act(() => void runCommand("hub.previous"));
    lift();
    expect(marks()).toEqual(["Personal", "[Acme]"]);
    inPlace();
    act(() => host.querySelector<HTMLElement>("[role='group'][aria-label='Hubs'] button[aria-label='Personal']")?.click());
    act(() => void vi.advanceTimersByTime(100));
    act(() => host.querySelector<HTMLElement>("[role='group'][aria-label='Hubs'] button[aria-label='Acme']")?.click());
    lift();
    expect(marks()).toEqual(["Personal", "[Acme]"]);
    inPlace();
  } finally {
    done();
  }
});

it("with one hub, a swipe does nothing and there are no marks", async () => {
  await mount([{ id: "hub", label: "devbox" }]);
  act(() => {
    hub("hub").send(live());
    hub("hub").send(project("devbox", "storefront"));
  });
  await settle();
  const { swipe, lift, done } = swiping();
  try {
    expect(marks()).toEqual([]);
    const free = swipe(Array.from({ length: 30 }, () => [14, 0] as const));
    lift();
    expect(free.every((f) => f)).toBe(true);
    expect(bots("storefront")).toEqual(["storefront"]);
    expect(host.querySelector("nav [aria-hidden][inert]")).toBeNull();
  } finally {
    done();
  }
});

it("with reduced motion, switches without the slide once a swipe has gone far enough", async () => {
  await twoHubs();
  const media = vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({ matches: q.includes("reduced-motion"), media: q, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false }));
  const { swipe, lift, done } = swiping();
  try {
    const list = () => host.querySelector<HTMLElement>("nav[aria-label='Sidebar'] [class*='list']");
    swipe([[4, 0], [20, 0], [20, 0]]);
    // Still, with nothing beside it.
    expect(list()?.style.transform).toBe("");
    expect(host.querySelector("nav [aria-hidden][inert]")).toBeNull();
    expect(bots("storefront", "billing")).toEqual(["storefront"]);
    swipe([[20, 0], [20, 0], [20, 0]]);
    expect(bots("storefront", "billing")).toEqual(["billing"]);
    lift();
    expect(marks()).toEqual(["Personal", "[Acme]"]);
  } finally {
    done();
    media.mockRestore();
  }
});
