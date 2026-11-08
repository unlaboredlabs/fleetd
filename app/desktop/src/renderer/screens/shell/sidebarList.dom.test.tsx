// @vitest-environment happy-dom
// The sidebar's one Projects list: every project in the order it is given, numbered in it, with New; a project's
// right-click menu renames it (after a small dialog) or archives it at once, with Undo.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummary } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { PROJECT_TOOLS } from "../projects/model";
import type { SidebarProject } from "./model";
import type { Screen } from "./routes";
import { Sidebar } from "./Sidebar";

vi.hoisted(() => {
  (window as unknown as { fleetd: object }).fleetd = {
    platform: "linux",
    fixture: null,
    copy: () => Promise.resolve(),
    updates: { subscribe: () => () => undefined, state: () => new Promise(() => undefined) },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (title: string, extra: Partial<ProjectSummary> = {}): SidebarProject => ({
  key: `devbox/${title.toLowerCase()}`,
  project: {
    machineId: "devbox",
    projectId: title.toLowerCase(),
    title,
    workspaceRoot: `/home/dev/projects/${title.toLowerCase()}`,
    lastActivityAt: "2026-10-26T09:00:00.000Z",
    threads: { failed: 0, idle: 0, running: 0, waiting: 0 },
    ...extra,
  },
  needsYou: false,
  state: "idle",
  working: false,
  running: 0,
  want: undefined,
  unread: false,
});

const ADA = row("Ada", { onlyMe: true });
const HOME = row("Home", { onlyMe: true });
const STOREFRONT = row("storefront");

let host: HTMLDivElement;
let root: Root;
let went: Screen[];
let calls: { tool: string; input: unknown }[];

const mount = (projects: SidebarProject[], jumpHints = false) => {
  const hub: HubApi = {
    call: (tool, input) => (calls.push({ tool, input }), Promise.resolve({ ok: true, output: {} })),
    subscribe: () => () => undefined,
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  act(() =>
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <Sidebar
            projects={projects.map((p) => ({ ...p, hub: "hub" }))}
            screen={{ id: "home", at: "hub" }}
            jumpHints={jumpHints}
            collapsed={new Set()}
            onToggleHub={() => undefined}
            factory={false}
            admin={false}
            go={(s) => went.push(s)}
          />
        </DataProvider>
      </UiProvider>,
    ),
  );
};

beforeEach(() => {
  went = [];
  calls = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = async () => {
  for (let i = 0; i < 4; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};
const button = (starts: string): HTMLElement => {
  const found = [...host.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent.startsWith(starts));
  if (found === undefined) throw new Error(`no ${starts} in: ${host.textContent}`);
  return found;
};
const sections = () => [...host.querySelectorAll("section")].map((s) => s.querySelector("[class*=sidebarSectionHead]")?.textContent ?? "");
const items = () => [...document.querySelectorAll("[role='menuitem']")].map((i) => i.textContent);
const choose = async (label: string) => {
  const found = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((i) => i.textContent === label);
  if (found === undefined) throw new Error(`no ${label} in ${items().join(", ")}`);
  act(() => found.click());
  await settle();
};
const rightClick = (el: HTMLElement) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });

describe("one list", () => {
  it("has every project in one Projects section, in its order, numbered in it, and no other section above", () => {
    mount([ADA, HOME, STOREFRONT], true);
    expect(sections()[0]).toBe("ProjectsNew");
    expect(host.textContent).not.toMatch(/Navi/u);
    const labels = [...host.querySelectorAll("button")].map((b) => b.textContent);
    const at = (t: string) => labels.findIndex((l) => l.startsWith(t));
    expect(at("Ada")).toBeLessThan(at("Home"));
    expect(at("Home")).toBeLessThan(at("storefront"));
    expect(button("Ada").textContent).toBe("Ada1");
    expect(button("storefront").textContent).toBe("storefront3");
    act(() => button("Ada").click());
    expect(went).toEqual([{ id: "project", project: { machineId: "devbox", projectId: "ada" }, message: null }]);
    act(() => host.querySelector<HTMLElement>("[aria-label='New project']")?.click());
    expect(went.at(-1)).toEqual({ id: "projects.add" });
  });

  it("a project's menu renames it after asking for the name, and archives it at once with Undo", async () => {
    mount([ADA, HOME, STOREFRONT]);
    rightClick(button("storefront"));
    expect(items()).toEqual(["Open", "Rename…", "Open settings", "Copy path", "Archive", "Delete project…"]);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    rightClick(button("Ada"));
    await choose("Rename…");
    const dialog = document.querySelector("[role='dialog']");
    expect(dialog?.textContent).toContain("Rename Ada");
    const input = dialog?.querySelector("input");
    if (!input) throw new Error("no name box");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Ada Lovelace");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const rename = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === "Rename");
    act(() => rename?.click());
    await settle();
    expect(calls).toContainEqual({ tool: "project_settings_set", input: { machineId: "devbox", projectId: "ada", title: "Ada Lovelace" } });

    rightClick(button("Home"));
    await choose("Archive");
    expect(calls).toContainEqual({ tool: PROJECT_TOOLS.archive, input: { machineId: "devbox", projectId: "home", archived: true } });
    expect(document.body.textContent).toContain("Home archived");
    const undo = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Undo");
    act(() => undo?.click());
    await settle();
    expect(calls).toContainEqual({ tool: PROJECT_TOOLS.archive, input: { machineId: "devbox", projectId: "home", archived: false } });
  });
});

describe("each row's avatar", () => {
  it("is a circle of its letters, its picture once it has one, read once for that row alone", async () => {
    const pictured = row("Home", { onlyMe: true, avatar: "a1b2c3d4e5f60718" });
    let listener: (frame: HubFrame) => void = () => undefined;
    const hub: HubApi = {
      call: (tool, input) => {
        calls.push({ tool, input });
        const output = tool === "project_avatar_get" ? { avatar: "a1b2c3d4e5f60718", mime: "image/jpeg", dataB64: "/9j/AA==" } : {};
        return Promise.resolve({ ok: true, output });
      },
      subscribe: (l) => ((listener = l), () => undefined),
      resync: () => Promise.resolve(),
      focus: () => Promise.resolve(),
      chat: () => Promise.resolve(),
    };
    act(() =>
      root.render(
        <UiProvider>
          <DataProvider layer={createDataLayer(hub)}>
            <Sidebar
              projects={[ADA, pictured, STOREFRONT].map((p) => ({ ...p, hub: "hub" }))}
              screen={{ id: "home", at: "hub" }}
              jumpHints={false}
              collapsed={new Set()}
              onToggleHub={() => undefined}
              factory={false}
              admin={false}
              go={(s) => went.push(s)}
            />
          </DataProvider>
        </UiProvider>,
      ),
    );
    act(() => {
      listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
      listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [ADA.project, pictured.project, STOREFRONT.project] } });
    });
    await settle();
    const avatars = [...host.querySelectorAll<HTMLElement>("[data-avatar]")];
    expect(avatars.map((a) => [a.dataset.avatar, a.dataset.letters])).toEqual([
      ["letters", "A"],
      ["picture", "H"],
      ["letters", "S"],
    ]);
    // The letters are the avatar's CSS: the row's text is its name.
    expect(button("Ada").textContent).toBe("Ada");
    expect(avatars[1]?.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/AA==");
    expect(calls.filter((c) => c.tool === "project_avatar_get").map((c) => c.input)).toEqual([{ machineId: "devbox", projectId: "home" }]);
  });
});
