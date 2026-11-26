// @vitest-environment happy-dom
// Settings › Bot for a member and for an admin: a bot's safety settings (who merges and how, approvals, its card,
// deleting it) are an admin's, so a member sees them off with "Only admins can change this."; an admin changes them.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubRole, ProjectSettings as Settings } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { sectionRead } from "./projectReads.test-util";
import { ProjectSettings } from "./Projects";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-11-26T10:00:00.000Z";
const settings: Settings = {
  machineId: "devbox",
  projectId: "p1",
  title: "storefront",
  workspaceRoot: "/home/w/src/storefront",
  setup: { commands: [], inputs: [] },
  env: [],
  worktrees: { dir: "/home/w/.fleetd/worktrees", worktrees: [] },
  mergeRules: { itself: ["docs"], person: [] },
};

const snapshot: HubFrame = {
  t: "snapshot",
  snapshot: {
    cursor: 1,
    attention: [],
    machines: [{ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [] }],
    projects: [
      {
        machineId: "devbox",
        projectId: "p1",
        title: "storefront",
        workspaceRoot: "/home/w/src/storefront",
        threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
        lastActivityAt: AT,
        merges: "people",
      },
    ],
  },
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  window.location.hash = "#/settings/projects?for=devbox/p1";
  vi.stubGlobal("fleetd", { platform: "linux" });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** `role` null: the workspace hasn't said yet who this app's person is (hub_info still on its way). */
async function render(role: HubRole | null) {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool) => {
      if (tool === "hub_info" && role === null) return new Promise(() => undefined);
      if (tool === "hub_info") {
        return Promise.resolve({ ok: true, output: { admin: role !== "member", me: { personId: "p-bea", name: "Bea", role, createdAt: AT } } });
      }
      if (tool === "mcp_servers_get") return Promise.resolve({ ok: true, output: { global: [], project: [], userServers: true } });
      const section = sectionRead(tool);
      if (section !== undefined) return Promise.resolve(section);
      return Promise.resolve({ ok: true, output: { settings } });
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
          <ProjectSettings route={{ tab: "projects", prompt: null, for: "devbox/p1" }} />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener(snapshot);
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
  await settle();
}

const section = (name: string) => document.querySelector(`section[aria-label="${name}"]`);
const buttons = (group: string) => [...(document.querySelector(`[role="group"][aria-label="${group}"]`)?.querySelectorAll("button") ?? [])];
const radios = () => [...(document.querySelector('[aria-label="Approval mode"]')?.querySelectorAll('[role="radio"]') ?? [])];
const find = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name);

it("a member sees the bot's safety settings off, with one line saying only admins change them", async () => {
  await render("member");
  expect(section("Safety")?.textContent).toContain("Only admins can change this.");
  expect(buttons("Who merges").length).toBeGreaterThan(0);
  expect(buttons("Who merges").every((b) => b.disabled)).toBe(true);
  expect(buttons("How it merges").every((b) => b.disabled)).toBe(true);
  expect(find("Rules")).toBeUndefined();
  expect(radios().length).toBeGreaterThan(0);
  expect(radios().every((r) => r.hasAttribute("data-disabled") || r.getAttribute("aria-disabled") === "true" || (r as HTMLButtonElement).disabled)).toBe(true);
  expect(section("Payments")?.textContent).toContain("No card: the lead can't pay at a checkout. Only admins can change this.");
  expect(find("Pick a card…")).toBeUndefined();
  expect(section("Delete bot")?.textContent).toContain("Only admins can change this.");
  expect(find("Delete bot…")).toBeUndefined();
  // The rest of the bot stays theirs: archiving it, for one.
  expect(find("Archive")?.disabled).toBe(false);
});

it("an admin changes them, with no such line", async () => {
  await render("admin");
  expect(document.body.textContent).not.toContain("Only admins can change this.");
  expect(buttons("Who merges").every((b) => !b.disabled)).toBe(true);
  expect(find("Rules")).toBeDefined();
  expect(find("Pick a card…")?.disabled).toBe(false);
  expect(find("Delete bot…")?.disabled).toBe(false);
});

it("shows them off until the workspace says who this person is, so a member never sees them flash on", async () => {
  await render(null);
  expect(section("Safety")?.textContent).toContain("Only admins can change this.");
  expect(buttons("Who merges").every((b) => b.disabled)).toBe(true);
  expect(find("Delete bot…")).toBeUndefined();
});
