// @vitest-environment happy-dom
// A sidebar project's right-click menu: open it or its settings, copy its path, or remove it after the dialog asks.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import type { SidebarProject } from "./model";
import type { Screen } from "./routes";
import { Sidebar } from "./Sidebar";

const copy = vi.hoisted(() => {
  const c = vi.fn((_text: string) => Promise.resolve());
  (window as unknown as { fleetd: object }).fleetd = {
    platform: "linux",
    fixture: null,
    copy: c,
    updates: { subscribe: () => () => undefined, state: () => new Promise(() => undefined) },
  };
  return c;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT: SidebarProject = {
  key: "devbox/storefront",
  project: {
    machineId: "devbox",
    projectId: "storefront",
    title: "storefront",
    workspaceRoot: "/home/dev/src/storefront",
    lastActivityAt: "2026-10-26T09:00:00.000Z",
    threads: { failed: 0, idle: 0, running: 0, waiting: 0 },
  },
  needsYou: false,
  state: "idle",
  working: false,
  running: 0,
  want: undefined,
  unread: false,
};

let host: HTMLDivElement;
let root: Root;
let went: Screen[];
let calls: string[];

beforeEach(() => {
  copy.mockClear();
  went = [];
  calls = [];
  const hub: HubApi = {
    call: (tool) => (calls.push(tool), Promise.resolve({ ok: true, output: {} })),
    subscribe: () => () => undefined,
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <DataProvider layer={createDataLayer(hub)}>
        <TooltipProvider>
          <Sidebar
            projects={[{ ...PROJECT, hub: "hub" }]}
            screen={{ id: "status", at: "hub" }}
            jumpHints={false}
            collapsed={new Set()}
            onToggleHub={() => undefined}
            factory={false}
            admin={false}
            go={(s) => went.push(s)}
          />
        </TooltipProvider>
      </DataProvider>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const row = (): HTMLElement => {
  const found = [...host.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent.startsWith("storefront"));
  if (found === undefined) throw new Error("no project row");
  return found;
};
const items = () => [...document.querySelectorAll("[role='menuitem']")].map((i) => i.textContent);
const choose = async (label: string) => {
  const found = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((i) => i.textContent === label);
  if (found === undefined) throw new Error(`no ${label}`);
  act(() => found.click());
  await act(() => Promise.resolve());
};
const rightClick = () => {
  act(() => {
    row().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
};

it("opens the project or its settings, and copies its path", async () => {
  rightClick();
  expect(items()).toEqual(["Open", "Open settings", "Copy path", "Remove project…"]);
  await choose("Open");
  rightClick();
  await choose("Open settings");
  expect(went).toEqual([
    { id: "project", project: { machineId: "devbox", projectId: "storefront" }, message: null },
    { id: "settings", tab: "projects", for: "devbox/storefront" },
  ]);
  rightClick();
  await choose("Copy path");
  expect(copy).toHaveBeenCalledWith("/home/dev/src/storefront");
});

it("Remove project… asks first, and removes nothing until confirmed", async () => {
  row().focus();
  act(() => {
    row().dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
  });
  await choose("Remove project…");
  const dialog = document.querySelector("[role='dialog']");
  expect(dialog?.textContent).toContain("Remove storefront from devbox?");
  expect(calls).not.toContain("project_remove");
  const remove = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === "Remove project");
  act(() => remove?.click());
  await act(() => new Promise((done) => setTimeout(done, 0)));
  expect(calls).toContain("project_remove");
});
