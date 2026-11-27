// @vitest-environment happy-dom
// Settings in one window (D211), its sidebar one flat list: You (General, Your accounts, Your memory, Hubs & devices) and Projects (the list
// of projects, each opening its Project, Agents, Instructions & memory and Automations under tabs, all of that one
// project, and its built-in prompts from the foot of its Instructions) for everyone; the Hub group for owners and admins only (admin/Admin.dom.test.tsx). Old links land on the
// page that has their option now: a page that became a part of another (route.ts) opens that page at the part. General's Version & updates says which fleetd this app,
// the hub and each machine run, with Check for updates for everyone and Hub › Machines › Updates for an owner or admin only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider, HubScope, useDataLayer } from "../../src/data/react";
import { AppFrame, TopBar, UiProvider } from "../../ui";
import { SETTINGS_TABS } from "../shell/routes";
import { SettingsSheet } from "./SettingsSheet";

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
/** An admin's role, when it isn't the owner's. */
let adminRole: "owner" | "admin" = "owner";

beforeEach(() => {
  calls = [];
  adminRole = "owner";
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
      check: () => Promise.resolve(),
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

/** The sheet on a fleetd cloud team, as the web app and a signed-in desktop app have it. */
function OnCloud() {
  const layer = useDataLayer();
  return (
    <HubScope hub={{ id: layer.hub, label: "acme", layer, cloud: true }}>
      <SettingsSheet onClose={() => undefined} />
    </HubScope>
  );
}

const render = async (hash: string, admin: boolean, live = true, features: ReadonlyArray<string> = [], cloud = false) => {
  window.location.hash = hash;
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input: input as Record<string, unknown> });
      const output =
        tool === "hub_info"
          ? { version: "0.9.0", protocol: 1, busy: [], admin, me: { personId: "p_aaaaaaaa", name: "Sam", role: admin ? adminRole : "member", createdAt: AT } }
          : tool === "people_list"
            ? { people: [{ personId: "p_bbbbbbbb", name: "Ana", role: "owner", createdAt: AT }], devices: [], invites: [] }
            : tool === "setup_list"
              ? { steps: [], requiredLeft: 0 }
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
          <AppFrame topBar={<TopBar />}>
    {cloud ? <OnCloud /> : <SettingsSheet onClose={() => undefined} />}
  </AppFrame>
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    if (!live) return;
    listener({ t: "state", state: { phase: "live", hub: "devbox:4790", protocol: 1, version: "0.9.0", features } });
    listener(snapshot);
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let i = 0; i < 3; i++) await settle();
};

const nav = () => host.querySelector<HTMLElement>("nav[aria-label='Settings']");
const rows = () => [...(nav()?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()).filter((t) => t !== "");
/** The index's groups, by their labels. */
const groups = () => [...(nav()?.querySelectorAll("[role='group']") ?? [])].map((g) => document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent);
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

it("has You and Bots for a member as one flat list, Bots listing the bots, each opening its four pages under tabs", async () => {
  await render("#/settings/general", false);
  // You, then Bots: All bots and each bot by name. No Hub group for a member.
  expect(rows()).toEqual(["General", "Accounts", "Memory", "Workspaces & devices", "All bots", "docs", "storefront"]);
  expect(groups()).toEqual(["You", "Bots"]);
  // Nothing to pick in the index.
  expect(nav()?.querySelector("[role='combobox'], select")).toBeNull();

  await click(button("All bots", nav() ?? document));
  expect(window.location.hash).toBe("#/settings/projects");
  expect(screen()).toBe("settings.projects.list");
  const list = host.querySelector<HTMLElement>("[role='list'][aria-label='Bots']");
  expect([...(list?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual(["docs", "storefront"]);

  await click(button("docs", list ?? document));
  expect(screen()).toBe("settings.projects");
  // Named in the route so a reload or a copied link lands on it.
  expect(window.location.hash).toBe("#/settings/projects?for=devbox/docs");
  expect(button("docs", nav() ?? document).getAttribute("aria-current")).toBe("page");

  // Each of the project's pages is one tab from there, on the same project.
  const tabs = host.querySelector<HTMLElement>("[role='tablist'][aria-label='Bot']");
  expect([...(tabs?.querySelectorAll("[role='tab']") ?? [])].map((t) => t.textContent)).toEqual(["Bot", "Agents", "Instructions & memory", "Automations"]);
  for (const [name, tab, data] of [
    ["Agents", "agents", "settings.agents"],
    ["Instructions & memory", "instructions", "settings.instructions"],
    ["Automations", "automations", "settings.automations"],
    ["Bot", "projects", "settings.projects"],
  ]) {
    await pickTab("Bot", name ?? "");
    expect(screen(), name).toBe(data);
    expect(window.location.hash, name).toMatch(new RegExp(`^#/settings/${tab ?? ""}\\?(.*&)?for=devbox/docs`, "u"));
  }
});

it("walks the index with the arrow keys, Home and End, and back up into the search", async () => {
  await render("#/settings/general", false);
  const index = nav();
  if (index === null) throw new Error("no index");
  const search = index.querySelector<HTMLInputElement>("input[type='search']");
  const press = (key: string) =>
    act(() => {
      (document.activeElement ?? index).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  const focused = () => document.activeElement?.textContent.trim();
  search?.focus();
  press("ArrowDown");
  expect(focused()).toBe("General");
  press("ArrowDown");
  press("ArrowDown");
  expect(focused()).toBe("Memory");
  press("End");
  expect(focused()).toBe("storefront");
  press("Home");
  expect(focused()).toBe("General");
  press("ArrowUp");
  expect(document.activeElement).toBe(search);
});

it("says Bots isn't connected while the hub isn't live, rather than loading for good", async () => {
  await render("#/settings/projects", false, false);
  expect(screen()).toBe("settings.projects.list");
  expect(host.textContent).toContain("Not connected. Connect to a workspace to change its bots' settings.");
  expect(host.textContent).not.toContain("Loading…");
});

it("keeps the opened bot across its tabs, and Bots goes back to the list", async () => {
  await render("#/settings/instructions?for=devbox/storefront", false);
  expect(screen()).toBe("settings.instructions");
  expect(window.location.hash).toBe("#/settings/instructions?for=devbox/storefront");
  await pickTab("Bot", "Agents");
  expect(window.location.hash).toBe("#/settings/agents?for=devbox/storefront");
  await click(button("All bots", nav() ?? document));
  expect(screen()).toBe("settings.projects.list");
  expect(window.location.hash).toBe("#/settings/projects");
});

it("opens a bot's built-in prompts from the one row at the foot of its Instructions, a page of its own with the way back", async () => {
  await render("#/settings/instructions?for=devbox/storefront", false);
  const row = host.querySelector<HTMLAnchorElement>("[data-part='builtin-prompts'] a");
  expect(row?.textContent).toBe("Built-in prompts");
  expect(host.querySelector("[data-part='builtin-prompts']")?.textContent).toContain("Most changes belong in the instructions above.");
  // Quiet until something is edited.
  expect(host.querySelector("[data-part='builtin-prompts']")?.textContent).not.toContain("edited");
  expect(row?.getAttribute("href")).toBe("#/settings/prompts?for=devbox/storefront");
  window.location.hash = row?.getAttribute("href") ?? "";
  for (let i = 0; i < 3; i++) await settle();
  expect(screen()).toBe("settings.prompts");
  // No tab of the project's, and no picker: the page is the project's, and goes back to its Instructions.
  expect(host.querySelector("[role='tablist']")).toBeNull();
  expect(host.querySelector("#prompts-scope")).toBeNull();
  expect(button("storefront", nav() ?? document).getAttribute("aria-current")).toBe("page");
  await click(button("‹ Instructions"));
  expect(window.location.hash).toBe("#/settings/instructions?for=devbox/storefront");
  expect(screen()).toBe("settings.instructions");
});

it("puts your Claude, GitHub and 1Password on Your accounts, and the paired hubs and your devices on Hubs & devices", async () => {
  const parts = () => [...host.querySelectorAll<HTMLElement>("[data-part]")].map((p) => p.dataset["part"]);
  await render("#/settings/accounts", false);
  expect(screen()).toBe("settings.accounts");
  // One group, an account a row.
  expect([...host.querySelectorAll("[data-screen='settings.accounts'] section section[aria-label]")].map((r) => r.getAttribute("aria-label"))).toEqual(["Claude", "GitHub", "1Password"]);
  act(() => root.unmount());
  root = createRoot(host);
  await render("#/settings/hubs", false);
  expect(screen()).toBe("settings.hubs");
  expect(parts()).toEqual(["hubs.add", "devices.pair"]);
  // Your devices keeps its own name inside the page, so its screenshots and tests still find it.
  expect(host.querySelector("[data-screen='settings.hubs'] [data-screen='settings.devices']")).not.toBeNull();
});

const current = () => [...(nav()?.querySelectorAll("button[aria-current='page']") ?? [])].map((b) => b.textContent.trim());

it("has the Hub group for an admin only, and Vault only on a hub with the vault", async () => {
  const bots = ["All bots", "docs", "storefront"];
  await render("#/settings/general", true);
  expect(rows()).toEqual(["General", "Accounts", "Memory", "Workspaces & devices", ...bots, "People", "Usage", "Machines", "Providers", "Audit log", "Share links", "Bot defaults", "Setup"]);
  expect(groups()).toEqual(["You", "Bots", "Workspace"]);
  act(() => root.unmount());
  root = createRoot(host);
  await render("#/settings/general", true, true, ["vault"]);
  expect(rows()).toEqual(["General", "Accounts", "Vault", "Memory", "Workspaces & devices", ...bots, "People", "Usage", "Machines", "Providers", "Audit log", "Share links", "Bot defaults", "Setup"]);
  act(() => root.unmount());
  root = createRoot(host);
  await render("#/settings/general", false, true, ["vault"]);
  expect(rows()).toEqual(["General", "Accounts", "Vault", "Memory", "Workspaces & devices", ...bots]);
});

it("names the admin group Team on a fleetd cloud team, never Hub", async () => {
  await render("#/settings/general", true, true, ["vault"], true);
  expect(groups()).toEqual(["You", "Bots", "Workspace"]);
});

it("ends a fleetd cloud team's Team group with its owner's Delete team: one confirm, the name typed, the team's refusal shown", async () => {
  const deleteTeam = vi.fn((_hub: string, _name: string) =>
    Promise.resolve(
      deleteTeam.mock.calls.length === 1
        ? { ok: false, failure: { code: "running", message: "An agent is running in this workspace.", fix: "Stop them, then delete the workspace." } }
        : { ok: true },
    ),
  );
  (window.fleetd as unknown as { cloud: unknown }).cloud = { deleteTeam, billing: () => new Promise(() => undefined) };
  await render("#/settings/general", true, true, [], true);
  expect(rows().slice(-2)).toEqual(["Setup", "Delete workspace"]);
  await click(button("Delete workspace", nav() as HTMLElement));
  // The confirm opens over the sheet, itself a dialog.
  const dialog = () => [...document.querySelectorAll<HTMLElement>("[role='dialog']")].find((d) => d.textContent.includes("Type acme to confirm")) ?? null;
  expect(dialog()?.textContent).toContain("Delete acme?");
  const go = () => button("Delete workspace", dialog() as HTMLElement);
  // Nothing is asked of the team until a name is typed; the team, not this app, says whether it is its name.
  expect(go().disabled).toBe(true);
  const type = async (text: string) => {
    const input = dialog()?.querySelector("input") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
  };
  await type("  ");
  expect(go().disabled).toBe(true);
  // Its name for everyone, which this computer's own label (acme) needn't be.
  await type(" Acme Inc ");
  expect(go().disabled).toBe(false);
  await click(go());
  // The team's refusal, in its words, and the dialog stays.
  expect(dialog()?.querySelector("[role='alert']")?.textContent).toBe("An agent is running in this workspace.Stop them, then delete the workspace.");
  await click(go());
  expect(deleteTeam.mock.calls.map((c) => c[1])).toEqual([" Acme Inc ", " Acme Inc "]);
  expect(dialog()).toBeNull();
});

it("has no Delete team for an admin who isn't the owner, nor on a self-hosted hub", async () => {
  adminRole = "admin";
  await render("#/settings/general", true, true, [], true);
  expect(rows()).not.toContain("Delete workspace");
  act(() => root.unmount());
  root = createRoot(host);
  adminRole = "owner";
  await render("#/settings/general", true);
  expect(rows()).not.toContain("Delete workspace");
});

// Every link Settings ever had (the palette's, a chat's, a notification's, a bookmark): the page it opens, the part of
// that page it lands on when its own page is gone, and the sidebar row shown as current.
const OLD_LINKS: ReadonlyArray<readonly [hash: string, page: string, part: string | null, row: string]> = [
  ["#/settings", "settings.general", null, "General"],
  ["#/settings/general", "settings.general", null, "General"],
  ["#/settings/accounts", "settings.accounts", null, "Accounts"],
  ["#/settings/vault", "settings.vault", null, "Vault"],
  ["#/settings/your-memory", "settings.your-memory", null, "Memory"],
  ["#/settings/devices", "settings.hubs", "settings.devices", "Workspaces & devices"],
  ["#/settings/hubs", "settings.hubs", null, "Workspaces & devices"],
  ["#/settings/projects", "settings.projects.list", null, "All bots"],
  ["#/settings/agents?for=devbox/docs", "settings.agents", null, "docs"],
  ["#/settings/instructions?for=devbox/docs", "settings.instructions", null, "docs"],
  ["#/settings/automations?for=devbox/docs", "settings.automations", null, "docs"],
  ["#/settings/project-vault?for=devbox/docs", "settings.project-vault", null, "docs"],
  ["#/settings/prompts?for=devbox/docs", "settings.prompts", null, "docs"],
  ["#/settings/hub/people", "settings.hub.people", null, "People"],
  ["#/settings/hub/usage", "settings.hub.usage", null, "Usage"],
  ["#/settings/hub/machines", "settings.hub.machines", null, "Machines"],
  ["#/settings/hub/providers", "settings.hub.providers", null, "Providers"],
  ["#/settings/hub/audit", "settings.hub.audit", null, "Audit log"],
  ["#/settings/hub/share", "settings.hub.share", null, "Share links"],
  ["#/settings/hub/updates", "settings.hub.machines", "settings.hub.updates", "Machines"],
  ["#/settings/hub/profiles", "settings.hub.providers", null, "Providers"],
  ["#/settings/hub/agents", "settings.hub.agents", null, "Bot defaults"],
  ["#/settings/hub/tools", "settings.hub.agents", "settings.hub.tools", "Bot defaults"],
  ["#/settings/hub/instructions", "settings.hub.instructions", null, "Bot defaults"],
  ["#/settings/hub/vault", "settings.hub.vault", null, "Bot defaults"],
  ["#/settings/hub/prompts", "settings.hub.prompts", null, "Bot defaults"],
  ["#/settings/hub/accounts", "settings.hub.setup", "settings.hub.accounts", "Setup"],
  ["#/settings/hub/setup", "settings.hub.setup", null, "Setup"],
];

it.each(OLD_LINKS)("opens %s on %s, at %s, with %s current in the sidebar", async (hash, page, part, row) => {
  await render(hash, true, true, ["vault"]);
  expect(screen()).toBe(page);
  expect(current()).toEqual([row]);
  if (part === null) return;
  // The part is inside the page, and the one the arrival goes to: it holds the focus, never one of its buttons.
  const el = host.querySelector<HTMLElement>(`[data-screen='${page}'] [data-screen='${part}']`);
  expect(el).not.toBeNull();
  expect(document.activeElement).toBe(el);
});

// Billing is a fleetd cloud team's alone: on this self-hosted hub its link lands on People, with no page that only says
// it isn't here, and no row of the sidebar names it (the cloud's page is shot in QA, settings.hub.billing).
it("lands a Billing link on a self-hosted hub on People, and lists no Billing row", async () => {
  await render("#/settings/hub/billing", true, true, ["vault"]);
  expect(screen()).toBe("settings.hub.people");
  expect(window.location.hash).toBe("#/settings/hub/people");
  expect(host.textContent).not.toContain("Billing is for fleetd cloud workspaces.");
  expect([...host.querySelectorAll("nav button")].some((b) => b.textContent === "Billing")).toBe(false);
});

it("covers every tab the routes know with a link that still opens", () => {
  const path = (tab: string) => `#/settings/${tab.startsWith("hub.") ? `hub/${tab.slice(4)}` : tab}`;
  const covered = new Set([...OLD_LINKS.map(([hash]) => hash.split("?")[0]), "#/settings/hub/billing", "#/settings/hub/signin"]);
  expect(SETTINGS_TABS.map(path).filter((h) => !covered.has(h))).toEqual([]);
});

it("keeps a member out of every Hub link, whichever page holds it now", async () => {
  for (const [hash] of OLD_LINKS.filter(([h]) => h.startsWith("#/settings/hub/"))) {
    await render(hash, false);
    expect(screen(), hash).toBe("settings.hub.denied");
    expect(current(), hash).toEqual([]);
    act(() => root.unmount());
    root = createRoot(host);
  }
});

const STATUS = "Up to datefleetd 0.9.0";

it("says in General's Version the one status Hub › Machines › Updates shows; a member gets no machines and no switch", async () => {
  await render("#/settings/general", false);
  const part = host.querySelector<HTMLElement>("[data-part='general.updates']");
  expect(part?.querySelector("[data-update-status]")?.textContent).toBe(STATUS);
  expect(part?.querySelector("[data-update-machine]")).toBeNull();
  expect(part?.querySelector("[data-auto-updates]")).toBeNull();
  expect([...host.querySelectorAll("[data-part]")].map((p) => p.getAttribute("data-part"))).toContain("notifications");

  act(() => root.unmount());
  root = createRoot(host);
  await render("#/settings/hub/updates", true);
  const updates = host.querySelector<HTMLElement>("[data-screen='settings.hub.updates']");
  expect(updates?.querySelector("[data-update-status]")?.textContent).toBe(STATUS);
});
