// @vitest-environment happy-dom
// Settings › Bot › How it merges over a fake hub: an older hub's silence reads "Test, then merge"; a pick saves
// mergeMode with project_settings_set and shows at once; a main that requires branches up to date says so in one line,
// with Turn off for an admin where fleetd may, and who to ask otherwise.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectSettings as Settings } from "../../../shared/contracts";
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

const AT = "2026-11-09T10:00:00.000Z";
const settings: Settings = {
  machineId: "devbox",
  projectId: "p1",
  title: "storefront",
  workspaceRoot: "/home/w/src/storefront",
  setup: { commands: [], inputs: [] },
  env: [],
  mergeRules: { itself: ["docs", "tests"], person: ["migrations"] },
};
const RULE = {
  repo: "acme/storefront",
  base: "main",
  line: "acme/storefront's main requires branches to be up to date, so PRs still land one at a time.",
  canTurnOff: true,
};
let upToDate: (typeof RULE)[] | undefined;
let admin: boolean;

const snapshot = (mergeMode: "test_first" | "verify_after" | undefined, cursor = 1): HubFrame => ({
  t: "snapshot",
  snapshot: {
    cursor,
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
        merges: "fleetd",
        ...(mergeMode === undefined ? {} : { mergeMode }),
      },
    ],
  },
});

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let refuse: boolean;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  refuse = false;
  upToDate = undefined;
  admin = true;
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

const render = async (mode: "test_first" | "verify_after" | undefined) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "project_settings_set" && refuse) {
        return Promise.resolve({ ok: false, error: { code: "forbidden", message: "Only a person picks how a bot's PRs merge." } });
      }
      if (tool === "hub_info" && !admin) return Promise.resolve({ ok: true, output: { admin: false } });
      if (tool === "mcp_servers_get") return Promise.resolve({ ok: true, output: { global: [], project: [], userServers: true } });
      const section = sectionRead(tool);
      if (section !== undefined) return Promise.resolve(section);
      return Promise.resolve({ ok: true, output: { settings: upToDate === undefined ? settings : { ...settings, upToDate } } });
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
    listener(snapshot(mode));
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
  await settle();
  return async (frame: HubFrame) => {
    await act(async () => {
      listener(frame);
      await new Promise((r) => setTimeout(r, 0));
    });
    await settle();
  };
};

const group = () => document.querySelector('[role="group"][aria-label="How it merges"]');
const pressed = () => [...(group()?.querySelectorAll("button") ?? [])].find((b) => b.getAttribute("aria-pressed") === "true")?.textContent;
const find = (name: string) => [...document.querySelectorAll("button")].find((x) => x.textContent === name);
const button = (name: string) => {
  const b = find(name);
  if (!b) throw new Error(`no ${name} button`);
  return b;
};
const sets = () => calls.filter((c) => c.tool === "project_settings_set").map((c) => c.input);
const click = async (b: HTMLElement) => {
  await act(async () => {
    b.click();
    await Promise.resolve();
  });
  await settle();
};

it("reads Test, then merge while the hub says nothing, saves a pick at once, and follows the hub", async () => {
  const next = await render(undefined);
  expect(pressed()).toBe("Test, then merge");
  await click(button("Merge, then verify"));
  expect(pressed()).toBe("Merge, then verify");
  expect(sets()).toEqual([{ machineId: "devbox", projectId: "p1", mergeMode: "verify_after" }]);
  await next(snapshot("verify_after", 2));
  expect(pressed()).toBe("Merge, then verify");
});

it("says in one line when main requires branches up to date, and an admin turns that one setting off", async () => {
  upToDate = [RULE];
  await render("verify_after");
  expect(document.body.textContent).toContain("so PRs still land one at a time");
  await click(button("Turn off"));
  expect(sets()).toEqual([{ machineId: "devbox", projectId: "p1", upToDateOff: "acme/storefront" }]);
});

it("says who to ask where fleetd can't turn it off, or the person isn't an admin", async () => {
  upToDate = [{ ...RULE, canTurnOff: false }];
  await render("verify_after");
  expect(find("Turn off")).toBeUndefined();
  expect(document.body.textContent).toContain('An admin of the repo turns off "Require branches to be up to date" on GitHub.');
  act(() => root.unmount());
  root = createRoot(host);
  upToDate = [RULE];
  admin = false;
  await render("verify_after");
  expect(find("Turn off")).toBeUndefined();
  expect(document.body.textContent).toContain("Ask a hub admin to turn it off.");
});

it("shows no line while the bot tests, then merges", async () => {
  upToDate = [RULE];
  await render("test_first");
  expect(document.body.textContent).not.toContain("so PRs still land one at a time");
});

it("says why when the hub refuses, and shows the saved pick again", async () => {
  refuse = true;
  await render("test_first");
  await click(button("Merge, then verify"));
  expect(pressed()).toBe("Test, then merge");
  expect(document.body.textContent).toContain("Only a person picks how a bot's PRs merge.");
});
