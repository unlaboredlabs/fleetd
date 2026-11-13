// @vitest-environment happy-dom
// Settings › Projects › Trial › Tagged chat over a fake hub: off while the hub's summary says nothing; a flip saves
// chatTags with project_settings_set and shows at once; the switch follows the summary; a refusal says why and goes back.
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
};

const snapshot = (chatTags: boolean | undefined, cursor = 1): HubFrame => ({
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
        ...(chatTags === undefined ? {} : { chatTags }),
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

const render = async (chatTags: boolean | undefined) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "project_settings_set" && refuse) {
        return Promise.resolve({ ok: false, error: { code: "forbidden", message: "Only its owner changes it." } });
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
    listener(snapshot(chatTags));
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

const toggle = () => {
  const label = [...document.querySelectorAll("label")].find((l) => l.textContent === "Tagged chat");
  const sw = label ? document.getElementById(label.htmlFor) : null;
  if (!sw) throw new Error("no Tagged chat switch");
  return sw;
};
const on = () => toggle().getAttribute("aria-checked") === "true";
const sets = () => calls.filter((c) => c.tool === "project_settings_set").map((c) => c.input);

it("is off while the hub says nothing, saves a flip at once, and follows the hub", async () => {
  const next = await render(undefined);
  expect(on()).toBe(false);
  await act(async () => {
    toggle().click();
    await Promise.resolve();
  });
  expect(on()).toBe(true);
  await settle();
  expect(sets()).toEqual([{ machineId: "devbox", projectId: "p1", chatTags: true }]);
  await next(snapshot(true, 2));
  expect(on()).toBe(true);
});

it("says why when the hub refuses, and shows the saved state again", async () => {
  refuse = true;
  await render(true);
  await act(async () => {
    toggle().click();
    await Promise.resolve();
  });
  await settle();
  expect(on()).toBe(true);
  expect(document.body.textContent).toContain("Only its owner changes it.");
});
