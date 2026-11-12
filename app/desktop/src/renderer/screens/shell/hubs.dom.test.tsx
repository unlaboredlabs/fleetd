// @vitest-environment happy-dom
// The app paired with two hubs: one sidebar with each hub's projects under its name, each hub's
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
import { onItsHub } from "./effects";
import { currentRoute } from "./navigation";
import { Shell } from "./Shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeHub {
  send: (frame: HubFrame) => void;
  calls: Array<{ tool: string; input: unknown }>;
}

const fake = vi.hoisted(() => {
  const hubs = new Map<string, { listeners: Set<(frame: unknown) => void>; calls: Array<{ tool: string; input: unknown }> }>();
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
        // The board, which the sidebar's counts read; nothing else is answered.
        if (tool === "orders_board") return Promise.resolve({ ok: true, output: { orders: [] } });
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
const groups = () => [...host.querySelectorAll<HTMLElement>("[data-hub-group]")].map((g) => g.textContent);
/** The foot's name, as a screen reader hears it: your name, and what is off. */
const you = () => host.querySelector<HTMLElement>("[data-opens='you']")?.getAttribute("aria-label");
/** The card under your name: each hub's section, by its name. */
const hubCards = () => {
  act(() => host.querySelector<HTMLElement>("[data-opens='you']")?.click());
  const cards = [...document.querySelectorAll<HTMLElement>("[aria-label='You'] [data-hub-card]")].map((c) => [c.getAttribute("aria-label"), c.dataset["hubCard"]]);
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  return cards;
};
const rowNamed = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("nav button, aside button, button")].find((b) => b.textContent.startsWith(name));

beforeEach(() => {
  window.location.hash = "#/";
  window.localStorage.clear();
  fake.hubs.clear();
  fake.badge.length = 0;
  fake.chats.length = 0;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("shows both hubs in one sidebar under their names, each with its own connection, one offline beside one live", async () => {
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
  expect(groups()).toEqual(["Personal", expect.stringContaining("Acme")]);
  expect(rowNamed("storefront")).toBeDefined();
  // The offline hub's group waits without claiming to load; the live one's rows are there regardless.
  const acme = host.querySelector('section[aria-label="Acme"]');
  expect(acme?.querySelector('[aria-label="Loading projects"]')?.getAttribute("aria-busy")).toBe("false");
  // One offline marks your name, saying which; the card has both.
  expect(you()).toBe("You, Can't reach Acme");
  expect(hubCards()).toEqual([
    ["Personal", "live"],
    ["Acme", "retrying"],
  ]);

  // Acme comes back: its project shows under its name, and the badge counts both hubs' projects that need you.
  act(() => {
    hub("a1b2").send(live());
    hub("a1b2").send(project("laptop", "billing"));
  });
  await settle();
  expect(acme?.textContent).toContain("billing");
  expect(you()).toBe("You");
  expect(fake.badge.at(-1)).toBe(2);
});

it("opens a project on its own hub, and that hub alone gets its calls", async () => {
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

it("⌘1–9 open the rows on show, as the sidebar numbers them, a collapsed hub's left out", async () => {
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
  act(() => {
    runCommand("project.open.1");
  });
  expect(window.location.hash).toBe("#/project/devbox/storefront?at=hub");
  act(() => host.querySelector<HTMLButtonElement>('[data-hub-group="hub"]')?.click());
  await settle();
  act(() => {
    runCommand("project.open.1");
  });
  expect(window.location.hash).toBe("#/project/laptop/billing?at=a1b2");
});

it("keeps each hub's projects in its own group, newest first, and numbers the rows on show", async () => {
  await mount([
    { id: "hub", label: "Personal" },
    { id: "a1b2", label: "Acme" },
  ]);
  act(() => {
    hub("hub").send(live());
    hub("hub").send(withTwo("devbox", "storefront", "Ada"));
    hub("a1b2").send(live());
    hub("a1b2").send(withTwo("laptop", "billing", "Bee"));
  });
  await settle();
  const group = (label: string) => host.querySelector(`section[aria-label="${label}"]`)?.textContent ?? "";
  expect(host.textContent).not.toMatch(/Navi/u);
  expect(group("Personal")).toMatch(/Ada.*storefront/u);
  expect(group("Acme")).toMatch(/Bee.*billing/u);
  expect(group("Personal")).not.toContain("Bee");
  // ⌘1 and ⌘2 are the first hub's rows, then the next hub's.
  act(() => {
    runCommand("project.open.3");
  });
  expect(window.location.hash).toBe("#/project/laptop/Bee?at=a1b2");
  act(() => host.querySelector<HTMLButtonElement>('[data-hub-group="a1b2"]')?.click());
  await settle();
  expect(group("Acme")).not.toContain("Bee");
  act(() => {
    runCommand("project.open.1");
  });
  expect(window.location.hash).toBe("#/project/devbox/Ada?at=hub");
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

it("opens `#/`'s last project on its own hub, the chat streaming from there, even if the redirect is never read", async () => {
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
  expect(groups()).toEqual([]);
  expect(host.textContent).not.toContain("Projects");
  expect(you()).toBe("You");
  expect(hubCards()).toEqual([["Hub", "live"]]);
  act(() => rowNamed("storefront")?.click());
  expect(window.location.hash).toBe("#/project/devbox/storefront");
});

it("says which hub a new project goes to with several hubs, the hub on screen first, and nothing with one", async () => {
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
