// @vitest-environment happy-dom
// Settings › Bots: the bots, then the archived ones in a group of their own, each with Bring back.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { ProjectList } from "./ProjectList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = "2026-11-17T10:00:00.000Z";
const bot = (projectId: string, title: string, archivedAt?: string) => ({
  machineId: "devbox",
  projectId,
  title,
  workspaceRoot: `/home/w/${projectId}`,
  threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
  lastActivityAt: AT,
  ...(archivedAt === undefined ? {} : { archivedAt }),
});

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async (projects: Array<ReturnType<typeof bot>>) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => (calls.push({ tool, input }), Promise.resolve({ ok: true, output: {} })),
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <ProjectList />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects } });
    await new Promise((r) => setTimeout(r, 0));
  });
};

const rows = (list: string) => [...host.querySelectorAll(`[role="list"][aria-label="${list}"] [role="listitem"]`)].map((r) => r.getAttribute("aria-label"));

it("lists the archived bots apart, and Bring back brings one back", async () => {
  await render([bot("a", "Ada"), bot("t", "Taxes", AT), bot("h", "Home")]);
  expect(rows("Bots")).toEqual(["Ada", "Home"]);
  expect(rows("Archived")).toEqual(["Taxes"]);
  const back = [...host.querySelectorAll<HTMLButtonElement>('[role="list"][aria-label="Archived"] button')].find((b) => b.textContent === "Bring back");
  expect(back?.textContent).toBe("Bring back");
  await act(async () => {
    back?.click();
    await Promise.resolve();
  });
  expect(calls.filter((c) => c.tool === "project_archive")).toEqual([{ tool: "project_archive", input: { machineId: "devbox", projectId: "t", archived: false } }]);
});

it("with no archived bot has no Archived group, and with every bot archived says so", async () => {
  await render([bot("a", "Ada")]);
  expect(host.querySelector('[aria-label="Archived"]')).toBeNull();
  act(() => root.unmount());
  root = createRoot(host);
  await render([bot("t", "Taxes", AT)]);
  expect(host.textContent).toContain("Every bot is archived.");
  expect(rows("Archived")).toEqual(["Taxes"]);
});
