// @vitest-environment happy-dom
// Settings › Bot › Who merges over a fake hub: an older hub's silence reads fleetd; a pick saves merges with
// project_settings_set and shows at once; while You, Rules opens the risk rules, saved one a line; a refusal says why.
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

const snapshot = (merges: "people" | "fleetd" | undefined, cursor = 1): HubFrame => ({
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
        ...(merges === undefined ? {} : { merges }),
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

const render = async (merges: "people" | "fleetd" | undefined) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "project_settings_set" && refuse) {
        return Promise.resolve({ ok: false, error: { code: "forbidden", message: "Only a person picks who merges a bot's PRs." } });
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
    listener(snapshot(merges));
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

const group = () => document.querySelector('[role="group"][aria-label="Who merges"]');
const pressed = () => [...(group()?.querySelectorAll("button") ?? [])].find((b) => b.getAttribute("aria-pressed") === "true")?.textContent;
const button = (name: string) => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent === name);
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

it("reads fleetd while the hub says nothing, saves a pick at once, and follows the hub", async () => {
  const next = await render(undefined);
  expect(pressed()).toBe("fleetd");
  // Rules are for a bot whose people merge.
  expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Rules")).toBe(false);
  await click(button("You"));
  expect(pressed()).toBe("You");
  expect(sets()).toEqual([{ machineId: "devbox", projectId: "p1", merges: "people" }]);
  await next(snapshot("people", 2));
  expect(pressed()).toBe("You");
});

it("opens the rules while You, and saves them one a line", async () => {
  await render("people");
  await click(button("Rules"));
  const itself = document.querySelector('textarea[aria-label="Merges itself"]') as HTMLTextAreaElement;
  expect(itself.value).toBe("docs\ntests");
  expect((document.querySelector('textarea[aria-label="Always a person"]') as HTMLTextAreaElement).value).toBe("migrations");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(itself, "docs\n\n  site/**  ");
    itself.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await click(button("Save rules"));
  expect(sets()).toEqual([{ machineId: "devbox", projectId: "p1", mergeRules: { itself: ["docs", "site/**"], person: ["migrations"] } }]);
});

it("says why when the hub refuses, and shows the saved pick again", async () => {
  refuse = true;
  await render("people");
  await click(button("fleetd"));
  expect(pressed()).toBe("You");
  expect(document.body.textContent).toContain("Only a person picks who merges a bot's PRs.");
});
