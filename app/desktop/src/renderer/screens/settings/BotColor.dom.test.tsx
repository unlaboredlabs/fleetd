// @vitest-environment happy-dom
// Settings › Projects › Color over a fake hub: slate is picked while the hub names no color; a swatch picks its color at
// once and saves it with project_settings_set; the Icon's bot wears the color the hub's summary names; the arrow keys
// move the pick; a refusal says why and goes back to the saved color.
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

const snapshot = (avatarColor: string | undefined, cursor = 1): HubFrame => ({
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
        ...(avatarColor === undefined ? {} : { avatarColor }),
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

const render = async (avatarColor: string | undefined) => {
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
          <ProjectSettings route={{ tab: "projects", prompt: null, for: "devbox/p1", view: "edit" }} />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener(snapshot(avatarColor));
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

const row = () => {
  const el = document.querySelector<HTMLElement>('section[aria-label="Color"]');
  if (el === null) throw new Error("no Color setting");
  return el;
};
const swatch = (name: string) => {
  const el = row().querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${name}"]`);
  if (el === null) throw new Error(`no ${name} swatch`);
  return el;
};
const checked = () => [...row().querySelectorAll('[role="radio"][aria-checked="true"]')].map((el) => el.getAttribute("aria-label"));
const iconBot = () => document.querySelector('section[aria-label="Icon"] [data-bot][data-color]')?.getAttribute("data-color");
const sets = () => calls.filter((c) => c.tool === "project_settings_set").map((c) => c.input);

it("offers the palette, slate picked while the hub names none, and the Icon's bot in it", async () => {
  await render(undefined);
  expect([...row().querySelectorAll('[role="radio"]')].map((el) => el.getAttribute("aria-label"))).toEqual(["Slate", "Mono", "Blue", "Lilac", "Coral", "Amber", "Sage", "Teal"]);
  expect(checked()).toEqual(["Slate"]);
  expect(swatch("Slate").tabIndex).toBe(0);
  expect(swatch("Sage").tabIndex).toBe(-1);
  expect(iconBot()).toBe("slate");
});

it("picks a color at once, saves it, and the bot wears what the hub's summary names", async () => {
  const next = await render(undefined);
  await act(async () => {
    swatch("Sage").click();
    await Promise.resolve();
  });
  expect(checked()).toEqual(["Sage"]);
  await settle();
  expect(sets()).toEqual([{ machineId: "devbox", projectId: "p1", avatarColor: "sage" }]);
  await next(snapshot("sage", 2));
  expect(checked()).toEqual(["Sage"]);
  expect(iconBot()).toBe("sage");
  // The one picked again sends nothing.
  await act(async () => {
    swatch("Sage").click();
    await Promise.resolve();
  });
  expect(sets()).toHaveLength(1);
});

it("moves the pick with the arrow keys, round the ends", async () => {
  await render("teal");
  await act(async () => {
    swatch("Teal").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await Promise.resolve();
  });
  await settle();
  expect(sets().at(-1)).toEqual({ machineId: "devbox", projectId: "p1", avatarColor: "slate" });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Slate");
});

it("says why when the hub refuses, and shows the saved color again", async () => {
  refuse = true;
  await render("blue");
  await act(async () => {
    swatch("Coral").click();
    await Promise.resolve();
  });
  await settle();
  expect(checked()).toEqual(["Blue"]);
  expect(row().querySelector('[role="alert"]')?.textContent).toContain("Only its owner changes it.");
});
