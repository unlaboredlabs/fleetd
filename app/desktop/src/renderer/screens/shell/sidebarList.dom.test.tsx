// @vitest-environment happy-dom
// The sidebar's one list of chats (W530): every project in the order it is given (activity's, pins on top), no label,
// each row its picture, name, time and newest line, numbered while ⌘ is held; nothing yet says so with New; a
// project's right-click menu pins it, renames it (after a small dialog) or archives it at once, with Undo.
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
  line: "",
  at: "2026-10-26T09:00:00.000Z",
  pinned: false,
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
  it("has every project in one unlabelled list, in its order, each row its name, time and line, numbered while ⌘ is held", () => {
    mount([{ ...ADA, line: "You: ship it" }, HOME, STOREFRONT]);
    expect(host.querySelector("[class*=sidebarSectionHead]")).toBeNull();
    expect(host.textContent).not.toMatch(/Projects|Navi/u);
    const names = [...host.querySelectorAll("[data-reorder-row] [class*=name]")].map((n) => n.textContent);
    expect(names).toEqual(["Ada", "Home", "storefront"]);
    expect(button("Ada").querySelector("[class*=line]")?.textContent).toBe("You: ship it");
    // A chat with nothing in it yet says so.
    expect(button("Home").querySelector("[class*=line]")?.textContent).toBe("No messages yet");
    expect(button("Ada").querySelector("[class*=when]")?.textContent).not.toBe("");
    act(() => button("Ada").click());
    expect(went).toEqual([{ id: "project", project: { machineId: "devbox", projectId: "ada" }, message: null }]);

    mount([ADA, HOME, STOREFRONT], true);
    expect([...host.querySelectorAll("[class*=jump]")].map((j) => j.textContent)).toEqual(["1", "2", "3"]);
  });

  it("marks a chat that wants you or has a new message with a dot alone, why in its description", () => {
    const want = { word: "approve" as const, count: 2, label: "2 commands to approve" };
    mount([{ ...ADA, want, line: "Ship it?" }, { ...HOME, unread: true }, STOREFRONT]);
    expect(button("Ada").querySelector("[class*=dot]")?.getAttribute("data-want")).toBe("approve");
    expect(button("Ada").querySelector("[class*=mark]")?.textContent).toBe("");
    expect(button("Ada").getAttribute("aria-description")).toBe("2 commands to approve");
    expect(button("Home").querySelector("[class*=dot]")?.hasAttribute("data-want")).toBe(false);
    expect(button("Home").getAttribute("aria-description")).toBe("New message from the lead");
    expect(button("storefront").querySelector("[class*=dot]")).toBeNull();
  });

  it("says there are no chats yet, with New project, and nothing while they load", () => {
    mount([]);
    expect(host.textContent).toContain("No chats yet");
    act(() => button("New project").click());
    expect(went).toEqual([{ id: "projects.add" }]);
    const quiet: HubApi = { call: () => Promise.resolve({ ok: true, output: {} }), subscribe: () => () => undefined, resync: () => Promise.resolve(), focus: () => Promise.resolve(), chat: () => Promise.resolve() };
    act(() =>
      root.render(
        <UiProvider>
          <DataProvider layer={createDataLayer(quiet)}>
            <Sidebar projects={undefined} screen={{ id: "home", at: "hub" }} jumpHints={false} collapsed={new Set()} onToggleHub={() => undefined} factory={false} go={() => undefined} />
          </DataProvider>
        </UiProvider>,
      ),
    );
    expect(host.querySelector("[aria-label='Loading projects']")).not.toBeNull();
    expect(host.textContent).not.toContain("No chats yet");
  });

  it("pins a chat from its menu, and unpins a pinned one", async () => {
    mount([ADA, { ...HOME, pinned: true }, STOREFRONT]);
    rightClick(button("storefront"));
    await choose("Pin to top");
    expect(calls).toContainEqual({ tool: "chat_pins_set", input: { pins: [{ machineId: "devbox", projectId: "home" }, { machineId: "devbox", projectId: "storefront" }] } });
    rightClick(button("Home"));
    await choose("Unpin");
    expect(calls.filter((c) => c.tool === "chat_pins_set").at(-1)).toEqual({ tool: "chat_pins_set", input: { pins: [] } });
  });

  it("a project's menu renames it after asking for the name, and archives it at once with Undo", async () => {
    mount([ADA, HOME, STOREFRONT]);
    rightClick(button("storefront"));
    expect(items()).toEqual(["Open", "Pin to top", "Rename…", "Open settings", "Copy path", "Archive", "Delete project…"]);
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
  it("is a circle of its bot, its picture once it has one, read once for that row alone", async () => {
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
    const avatars = [...host.querySelectorAll<HTMLElement>("[data-reorder-row] [data-avatar]")];
    expect(avatars.map((a) => [a.dataset.avatar, a.dataset.letters])).toEqual([
      ["bot", ""],
      ["picture", "H"],
      ["bot", ""],
    ]);
    // The avatar adds no text: the row's text starts with its name.
    expect(button("Ada").querySelector("[class*=name]")?.textContent).toBe("Ada");
    expect(avatars[1]?.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/AA==");
    expect(calls.filter((c) => c.tool === "project_avatar_get").map((c) => c.input)).toEqual([{ machineId: "devbox", projectId: "home" }]);
  });
});
