// @vitest-environment happy-dom
// Settings in one window (D211): You (General, Your accounts, Hubs) and Projects (the project picker and the picked
// project's Project, Agents, Instructions & memory, Automations and Prompts, each a click away and all of that one
// project) for everyone; the Hub group for owners and admins only (admin/Admin.dom.test.tsx). Old links land on the
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

const render = async (hash: string, admin: boolean) => {
  window.location.hash = hash;
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input: input as Record<string, unknown> });
      const output =
        tool === "hub_info"
          ? { version: "0.9.0", protocol: 1, busy: [], admin, me: { personId: "p_aaaaaaaa", name: "Sam", role: admin ? "owner" : "member", createdAt: AT } }
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

it("has You and Projects for a member, with the picked project's five pages, and no Hub group", async () => {
  await render("#/settings/general", false);
  expect(rows()).toEqual(["Back", "General", "Your accounts", "Your memory", "Your devices", "Hubs", "docs", "Project", "Agents", "Instructions & memory", "Automations", "Prompts"]);
  expect(nav()?.querySelector("section[aria-label='Hub']")).toBeNull();
  expect([...(nav()?.querySelectorAll("section") ?? [])].map((x) => x.querySelector("span")?.textContent ?? "")).toEqual(expect.arrayContaining(["You", "Projects"]));

  const group = nav()?.querySelector<HTMLElement>("[role='group'][aria-label='Project']");
  await click(button("Project", group ?? document));
  expect(screen()).toBe("settings.projects");
  // The first project (by title), named in the route so a reload or a copied link lands on it.
  expect(window.location.hash).toBe("#/settings/projects?for=devbox/docs");
  expect(group?.querySelector("#settings-project")?.textContent).toContain("docs");

  // Each of the project's pages is one click from there, on the same project.
  for (const [row, tab, data] of [
    ["Agents", "agents", "settings.agents"],
    ["Instructions & memory", "instructions", "settings.instructions"],
    ["Automations", "automations", "settings.automations"],
    ["Prompts", "prompts", "settings.prompts"],
    ["Project", "projects", "settings.projects"],
  ]) {
    await click(button(row ?? "", group ?? document));
    expect(screen(), row).toBe(data);
    expect(window.location.hash, row).toMatch(new RegExp(`^#/settings/${tab ?? ""}\\?(.*&)?for=devbox/docs`, "u"));
  }
});

it("keeps the picked project across a project's pages, and an older link on the page that has it now", async () => {
  await render("#/settings/memory?for=devbox/storefront", false);
  expect(screen()).toBe("settings.instructions");
  expect(window.location.hash).toBe("#/settings/instructions?for=devbox/storefront");
  const group = nav()?.querySelector<HTMLElement>("[role='group'][aria-label='Project']");
  await click(button("Agents", group ?? document));
  expect(window.location.hash).toBe("#/settings/agents?for=devbox/storefront");
  // Leaving the project's pages and coming back finds the same project.
  await click(button("General", nav() ?? document));
  await click(button("Project", nav() ?? document));
  expect(window.location.hash).toBe("#/settings/projects?for=devbox/storefront");
});

it("puts your Claude, GitHub, 1Password and Navi's Google on Your accounts, and the paired hubs and hub links on Hubs, from old Connections links too", async () => {
  const parts = () => [...host.querySelectorAll<HTMLElement>("[data-part]")].map((p) => p.dataset["part"]);
  for (const hash of ["#/settings/claude", "#/settings/connections", "#/settings/accounts"]) {
    await render(hash, false);
    expect(screen(), hash).toBe("settings.accounts");
    expect(parts()).toEqual(["claude", "github", "onepassword", "accounts.google"]);
    act(() => root.unmount());
    root = createRoot(host);
  }
  await render("#/settings/hubs", false);
  expect(screen()).toBe("settings.hubs");
  expect(parts()).toEqual(["hubs.add", "hubs.hub-links"]);
});

it("shows a project's prompts under its Prompts, with no picker of its own", async () => {
  await render("#/settings/prompts?for=devbox/storefront", false);
  expect(screen()).toBe("settings.prompts");
  expect(host.querySelector("#prompts-scope")).toBeNull();
  const group = nav()?.querySelector<HTMLElement>("[role='group'][aria-label='Project']");
  expect(button("Prompts", group ?? document).getAttribute("aria-current")).toBe("page");
  expect(group?.querySelector("#settings-project")?.textContent).toContain("storefront");
});

it("says which fleetd this app runs, with Check for updates, and the hub's standing in one read-only line; the update itself is on Hub › Machines", async () => {
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
  expect([...host.querySelectorAll("[data-part]")].map((p) => p.getAttribute("data-part"))).toContain("notifications");

  act(() => root.unmount());
  root = createRoot(host);
  await render("#/settings/general", true);
  const mine = host.querySelector<HTMLElement>("[data-part='general.updates']");
  expect(mine?.textContent).not.toContain("Open updates…");
  await click(button("Updates in Hub › Machines", mine ?? document));
  expect(window.location.hash).toBe("#/settings/hub/machines");
  const updates = host.querySelector<HTMLElement>("[data-part='hub.updates']");
  expect(updates?.querySelector("[data-updates-row='devbox']")).not.toBeNull();
  await click(button("Open updates…", updates ?? document));
  expect(host.querySelector("[data-sheet]")).not.toBeNull();
});
