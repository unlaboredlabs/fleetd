// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { AddProjectScreen } from "./AddProjectScreen";
import { closeAddProject, openAddProject, pickMachine, useAddUi } from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-27T10:00:00.000Z";
const ROOT = "/home/w/fleetd/projects";

const snapshot: HubFrame = {
  t: "snapshot",
  snapshot: {
    cursor: 1,
    attention: [],
    machines: [
      { machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [] },
      { machineId: "buildbox", name: "buildbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [] },
    ],
    // An empty folder that is already a project.
    projects: [{ machineId: "devbox", projectId: "p3", title: "Old notes", workspaceRoot: `${ROOT}/old-notes`, threads: { running: 0, waiting: 0, idle: 0, failed: 0 }, lastActivityAt: AT }],
  },
};

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
/** project_discover's machine: with a projects root, or from a node too old to make a folder. */
let projectsRoot: string | undefined;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  projectsRoot = ROOT;
  window.location.hash = "#/projects/add";
  vi.stubGlobal("fleetd", {
    platform: "linux",
    system: { hostName: () => Promise.resolve("laptop") },
    projects: { pickFolder: () => Promise.resolve(null) },
  });
});
afterEach(() => {
  act(() => closeAddProject());
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

/** The modal while it is open, as ProjectsHost mounts it. */
function Shown() {
  return useAddUi().open ? <AddProjectScreen /> : null;
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const render = async () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "project_discover") {
        const machine = { machineId: "devbox", online: true, cloneRoot: "/home/w/src", repos: [{ path: "/home/w/code/notes-cli", name: "notes-cli" }], ...(projectsRoot ? { projectsRoot } : {}) };
        const other = { machineId: "buildbox", online: true, cloneRoot: "/home/b/src", repos: [], projectsRoot: "/home/b/fleetd/projects" };
        return Promise.resolve({ ok: true, output: { machines: [machine, other], github: { owners: [], repos: [] }, best: "devbox" } });
      }
      if (tool === "project_add") {
        const { path } = input as { path: string };
        if (path === `${ROOT}/old-notes`) {
          return Promise.resolve({ ok: false, error: { code: "invalid", message: `${path} on devbox is already the project Old notes`, fix: "Open that project, or pick another folder for the new one" } });
        }
        return Promise.resolve({ ok: true, output: { machineId: "devbox", path, projectId: "p9", created: true, inspect: { ci: { workflows: [], requiredChecks: [] }, merge: { protected: false, rulesets: [] }, leadNeeds: "a plain folder with no git", notes: [] } } });
      }
      return Promise.resolve({ ok: true, output: {} });
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  openAddProject();
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={layer}>
          <Shown />
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
  return listener;
};

const field = (label: string): HTMLInputElement => {
  const el = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (el === null) throw new Error(`no field ${label}`);
  return el;
};
const type = async (el: HTMLInputElement, text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};
const button = (text: string): HTMLButtonElement | undefined => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
/** A checkbox by its label. */
const check = (label: string) => [...document.querySelectorAll("label")].find((l) => l.textContent.trim() === label)?.querySelector<HTMLButtonElement>('[role="checkbox"]') ?? null;
const options = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
const summary = () => document.querySelector('[data-screen="projects.add.new"]')?.firstElementChild?.textContent ?? "";
const NAME = "New project name, GitHub URL, folder path, or filter";

describe("Add project's new project", () => {
  it("is offered once a name is typed, and says in one line where its folder goes, editable", async () => {
    await render();
    expect(document.activeElement).toBe(field(NAME));
    expect(options()).toEqual([expect.stringContaining("notes-cli")]);
    await type(field(NAME), "Field notes");
    expect(options()).toEqual([expect.stringContaining("New project “Field notes”")]);
    expect(field("Folder").value).toBe(`${ROOT}/field-notes`);
    expect(summary()).toContain("Creates an empty folder");
    expect(summary()).toContain("Only you will see it.");
    expect(button("Create")?.disabled).toBe(false);
    // Edited, it stays as typed; a path that isn't full can't be created, and the line says why.
    await type(field("Folder"), "notes");
    expect(button("Create")?.disabled).toBe(true);
    expect(summary()).toContain("Type the folder's full path, starting with /");
    await type(field("Folder"), "/home/w/notes");
    expect(button("Create")?.disabled).toBe(false);
  });

  it("closes on Esc and on Cancel, and opens afresh", async () => {
    await render();
    await type(field(NAME), "Field notes");
    await act(async () => {
      field(NAME).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector('[data-screen="projects.add"]')).toBeNull();
    act(() => openAddProject());
    await settle();
    expect(field(NAME).value).toBe("");
    await act(async () => {
      button("Cancel")?.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[data-screen="projects.add"]')).toBeNull();
    expect(calls.some((c) => c.tool === "project_add")).toBe(false);
  });

  it("starts Only me on for a new folder, and sends it off when the person turns it off", async () => {
    await render();
    await type(field(NAME), "Field notes");
    const only = check("Only me");
    expect(only?.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      only?.click();
      await Promise.resolve();
    });
    await act(async () => {
      button("Create")?.click();
      await Promise.resolve();
    });
    await settle();
    expect(calls.find((c) => c.tool === "project_add")?.input).toMatchObject({ create: true, onlyMe: false });
  });

  it("creates it where the folder says, git init only when ticked, and opens it once the hub lists it", async () => {
    const send = await render();
    await type(field(NAME), "Field notes");
    await act(async () => {
      check("Start a git repo")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      button("Create")?.click();
      await Promise.resolve();
    });
    await settle();
    const add = calls.find((c) => c.tool === "project_add");
    expect(add?.input).toEqual({ machineId: "devbox", path: `${ROOT}/field-notes`, title: "Field notes", create: true, gitInit: true, onlyMe: true });
    // Not before the hub's snapshot has it, so its chat never shows as missing.
    expect(window.location.hash).toBe("#/projects/add");
    const made = { machineId: "devbox", projectId: "p9", title: "Field notes", workspaceRoot: `${ROOT}/field-notes`, threads: { running: 0, waiting: 0, idle: 0, failed: 0 }, lastActivityAt: AT };
    await act(async () => {
      send({ t: "snapshot", snapshot: { ...snapshot.snapshot, cursor: 2, projects: [made] } });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(window.location.hash).toBe("#/project/devbox/p9");
  });

  it("resets an edited folder to the next machine's default, unless it is outside any home folder", async () => {
    await render();
    await type(field(NAME), "Field notes");
    await type(field("Folder"), "/home/w/notes");
    act(() => pickMachine("buildbox"));
    expect(field("Folder").value).toBe("/home/b/fleetd/projects/field-notes");
    await type(field("Folder"), "/srv/notes");
    act(() => pickMachine("devbox"));
    expect(field("Folder").value).toBe("/srv/notes");
  });

  it("offers to open the project an empty folder already is, never a second one", async () => {
    await render();
    await type(field(NAME), "Old notes");
    await act(async () => {
      button("Create")?.click();
      await Promise.resolve();
    });
    await settle();
    expect(document.body.textContent).toContain(`${ROOT}/old-notes on devbox is already the project Old notes`);
    await act(async () => {
      button("Open project")?.click();
      await Promise.resolve();
    });
    expect(window.location.hash).toBe("#/project/devbox/p3");
  });

  it("says to update a node too old to make the folder, and creates nothing", async () => {
    projectsRoot = undefined;
    await render();
    await type(field(NAME), "Field notes");
    expect(summary()).toContain("Update fleetd on devbox to create a project there, or pick another machine");
    expect(document.querySelector('input[aria-label="Folder"]')).toBeNull();
    expect(button("Create")?.disabled).toBe(true);
  });
});
