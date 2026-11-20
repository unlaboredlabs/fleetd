// @vitest-environment happy-dom
// The app paired with two hubs: one sidebar with every hub's bots in List, one hub's at a time in Hubs, each hub's
// connection on its own row (one offline never blocks the other), the Dock badge over both, and a project opening on
// its own hub, whose calls go to that hub only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import { resetSidebarView, showHub } from "./sidebarLayout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeHub {
  send: (frame: HubFrame) => void;
  calls: Array<{ tool: string; input: unknown }>;
}

const fake = vi.hoisted(() => {
  // `discover`: what project_discover answers, when a test sets it.
  const hubs = new Map<string, { listeners: Set<(frame: unknown) => void>; calls: Array<{ tool: string; input: unknown }>; discover?: unknown }>();
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
/** The sidebar's bots, by name, in order (each named by one of `names`). */
const bots = (...names: string[]) =>
  [...host.querySelectorAll<HTMLElement>("nav[aria-label='Sidebar'] [data-reorder-row] button")].flatMap((b) => names.filter((n) => b.textContent.startsWith(n)).slice(0, 1));
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
  // Personal's chat on screen, Acme on view in the sidebar.
  pickHub("Acme");
  await settle();
  expect(window.location.hash).toBe("#/project/devbox/storefront?at=hub");
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

it("makes the bot on the hub picked in Adds to", async () => {
  fake.of("a1b2").discover = { machines: [{ machineId: "laptop", online: true, cloneRoot: "/home/l/src", projectsRoot: "/home/l/fleetd/projects", repos: [] }], github: { owners: [], repos: [] }, best: "laptop" };
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
