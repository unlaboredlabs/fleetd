// @vitest-environment happy-dom
// Settings in one window (D211), its sidebar one flat list: You (General, Your accounts, Hubs) and Projects (the list
// of projects, each opening its Project, Agents, Instructions & memory, Automations and Prompts under tabs, all of that
// one project) for everyone; the Hub group for owners and admins only (admin/Admin.dom.test.tsx). Old links land on the
// page that has their option now. General's Version & updates says which fleetd this app,
// the hub and each machine run, with Check for updates for everyone and the updates sheet for an owner or admin only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { useUpdatesOpen } from "../updates/state";
import { SettingsScreen, SettingsSidebar } from "./SettingsScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-19T10:00:00.000Z";
const project = (projectId: string, title: string) => ({
  machineId: "devbox",
  projectId,
  title,
  workspaceRoot: `/home/w/src/${projectId}`,
  threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
  lastActivityAt: AT,
});

const snapshot: HubFrame = {
  t: "snapshot",
  snapshot: {
    cursor: 1,
    attention: [],
    machines: [{ machineId: "devbox", name: "devbox", status: "online", nodeVersion: "0.9.0", lastSeenAt: AT }],
    projects: [project("storefront", "storefront"), project("docs", "docs")],
  },
} as unknown as HubFrame;

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: Record<string, unknown> }>;
let checks: number;

beforeEach(() => {
  calls = [];
  checks = 0;
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    app: { presence: () => Promise.resolve(true), notify: () => Promise.resolve(true) },
    pair: { store: () => new Promise(() => undefined) },
    system: { hostName: () => Promise.resolve("devbox") },
    // Add machine, on Hub › Machines: this computer isn't one of the hub's, and nothing is joining.
    machines: { thisComputer: () => new Promise(() => undefined), joinHereState: () => new Promise(() => undefined), onJoinHere: () => () => undefined },
    updates: {
      subscribe: () => () => undefined,
      state: () => Promise.resolve({ current: "0.9.0", app: { kind: "idle" }, release: null }),
      check: () => {
        checks++;
        return Promise.resolve();
      },
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** Whether the updates sheet was asked to open. */
function Sheet() {
  return useUpdatesOpen() ? <div data-sheet /> : null;
}

const render = async (hash: string, admin: boolean, live = true) => {
  window.location.hash = hash;
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input: input as Record<string, unknown> });
      const output =
        tool === "hub_info"
          ? { version: "0.9.0", protocol: 1, busy: [], admin, me: { personId: "p_aaaaaaaa", name: "Sam", role: admin ? "owner" : "member", createdAt: AT } }
          : tool === "people_list"
            ? { people: [{ personId: "p_bbbbbbbb", name: "Ana", role: "owner", createdAt: AT }] }
            : undefined;
      return Promise.resolve(output === undefined ? { ok: false, error: { code: "not_found", message: `${tool} isn't faked` } } : { ok: true, output });
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <SettingsSidebar onBack={() => undefined} />
          <SettingsScreen />
          <Sheet />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    if (!live) return;
    listener({ t: "state", state: { phase: "live", hub: "devbox:4790", protocol: 1, version: "0.9.0" } });
    listener(snapshot);
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let i = 0; i < 3; i++) await settle();
};

const nav = () => host.querySelector<HTMLElement>("[aria-label='Settings']");
const rows = () => [...(nav()?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()).filter((t) => t !== "");
const button = (text: string, within: ParentNode = document) => {
  const b = [...within.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
  if (b === undefined) throw new Error(`no button ${text} in ${[...within.querySelectorAll("button")].map((x) => x.textContent.trim()).join(" | ")}`);
  return b;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  for (let i = 0; i < 3; i++) await settle();
};
const screen = () => host.querySelector("[data-screen]")?.getAttribute("data-screen");
/** Picks a tab of a set's pages: Radix's tabs open on a pointer press, not a click. */
const pickTab = async (set: string, name: string) => {
  const tabs = host.querySelector<HTMLElement>(`[role='tablist'][aria-label='${set}']`);
  const t = [...(tabs?.querySelectorAll<HTMLElement>("[role='tab']") ?? [])].find((x) => x.textContent === name);
  if (t === undefined) throw new Error(`no tab ${name}`);
  await act(async () => {
    t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    await Promise.resolve();
  });
  for (let i = 0; i < 3; i++) await settle();
};

it("has You and Projects for a member as one flat list, Projects listing the projects, each opening its five pages under tabs", async () => {
  await render("#/settings/general", false);
  expect(rows()).toEqual(["Back", "General", "Your accounts", "Your memory", "Your devices", "Hubs", "Projects"]);
  expect(nav()?.querySelector("section[aria-label='Hub']")).toBeNull();
  // Nothing to pick and nothing nested in the sidebar.
  expect(nav()?.querySelector("[role='combobox'], [role='group'], select")).toBeNull();

  await click(button("Projects", nav() ?? document));
  expect(window.location.hash).toBe("#/settings/projects");
  expect(screen()).toBe("settings.projects.list");
  const list = host.querySelector<HTMLElement>("[role='list'][aria-label='Projects']");
  expect([...(list?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual(["docsdevbox", "storefrontdevbox"]);

  await click(button("docsdevbox", list ?? document));
  expect(screen()).toBe("settings.projects");
  // Named in the route so a reload or a copied link lands on it.
  expect(window.location.hash).toBe("#/settings/projects?for=devbox/docs");
  expect(button("Projects", nav() ?? document).getAttribute("aria-current")).toBe("page");

  // Each of the project's pages is one tab from there, on the same project.
  for (const [name, tab, data] of [
    ["Agents", "agents", "settings.agents"],
    ["Instructions & memory", "instructions", "settings.instructions"],
    ["Automations", "automations", "settings.automations"],
    ["Prompts", "prompts", "settings.prompts"],
    ["Project", "projects", "settings.projects"],
  ]) {
    await pickTab("Project", name ?? "");
    expect(screen(), name).toBe(data);
    expect(window.location.hash, name).toMatch(new RegExp(`^#/settings/${tab ?? ""}\\?(.*&)?for=devbox/docs`, "u"));
  }
});

it("says Projects isn't connected while the hub isn't live, rather than loading for good", async () => {
  await render("#/settings/projects", false, false);
  expect(screen()).toBe("settings.projects.list");
  expect(host.textContent).toContain("Not connected. Connect to a hub to change its projects' settings.");
  expect(host.textContent).not.toContain("Loading…");
});

it("keeps the opened project across its tabs, and Projects goes back to the list", async () => {
  await render("#/settings/instructions?for=devbox/storefront", false);
  expect(screen()).toBe("settings.instructions");
  expect(window.location.hash).toBe("#/settings/instructions?for=devbox/storefront");
  await pickTab("Project", "Agents");
  expect(window.location.hash).toBe("#/settings/agents?for=devbox/storefront");
  await click(button("Projects", nav() ?? document));
  expect(screen()).toBe("settings.projects.list");
  expect(window.location.hash).toBe("#/settings/projects");
});

it("shows a project's prompts on its Prompts tab, with no picker of its own", async () => {
  await render("#/settings/prompts?for=devbox/storefront", false);
  expect(screen()).toBe("settings.prompts");
  expect(host.querySelector("#prompts-scope")).toBeNull();
  const tabs = host.querySelector<HTMLElement>("[role='tablist'][aria-label='Project']");
  expect(tabs?.querySelector("[role='tab'][data-state='active']")?.textContent).toBe("Prompts");
});

it("puts your Claude, GitHub and 1Password on Your accounts, and the paired hubs and hub links on Hubs", async () => {
  const parts = () => [...host.querySelectorAll<HTMLElement>("[data-part]")].map((p) => p.dataset["part"]);
  await render("#/settings/accounts", false);
  expect(screen()).toBe("settings.accounts");
  expect(parts()).toEqual(["claude", "github", "onepassword"]);
  act(() => root.unmount());
  root = createRoot(host);
  await render("#/settings/hubs", false);
  expect(screen()).toBe("settings.hubs");
  expect(parts()).toEqual(["hubs.add", "hubs.hub-links"]);
});

it("says which fleetd this app runs, with Check for updates, and the hub's standing in one read-only line; the update itself is on Hub › Updates", async () => {
  await render("#/settings/general", false);
  const part = host.querySelector<HTMLElement>("[data-part='general.updates']");
  expect(part).not.toBeNull();
  expect(part?.textContent).toContain("Stable channel");
  expect(part?.querySelector("[data-updates-part='app']")?.textContent).toContain("fleetd 0.9.0");
  expect(part?.querySelector("[data-hub-standing]")?.textContent).toBe("The hub and its machines are up to date.");
  await click(button("Check for updates", part ?? document));
  expect(checks).toBe(1);
  // A member updates no hub: no machine rows, no sheet and no way to one.
  expect(part?.querySelector("[data-updates-row='devbox']")).toBeNull();
  expect(part?.textContent).not.toContain("Update…");
  expect(part?.textContent).not.toContain("Open updates…");
  // …and is told whom to ask.
  expect(part?.querySelector("[data-auto-updates='member']")?.textContent).toContain("ask Ana.");
  expect([...host.querySelectorAll("[data-part]")].map((p) => p.getAttribute("data-part"))).toContain("notifications");

  act(() => root.unmount());
  root = createRoot(host);
  await render("#/settings/general", true);
  const mine = host.querySelector<HTMLElement>("[data-part='general.updates']");
  expect(mine?.textContent).not.toContain("Open updates…");
  expect(mine?.querySelector("[data-auto-updates]")).toBeNull();
  await click(button("Open Hub › Updates", mine ?? document));
  expect(window.location.hash).toBe("#/settings/hub/updates");
  const updates = host.querySelector<HTMLElement>("[data-screen='settings.hub.updates']");
  expect(updates?.querySelector("[data-updates-row='devbox']")).not.toBeNull();
  await click(button("Open updates…", updates ?? document));
  expect(host.querySelector("[data-sheet]")).not.toBeNull();
});
