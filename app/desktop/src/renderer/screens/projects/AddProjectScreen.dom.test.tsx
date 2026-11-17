// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { AddProjectScreen } from "./AddProjectScreen";
import { closeAddProject, openAddProject, useAddUi } from "./store";

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
        const { title, path } = input as { title: string; path?: string };
        if (title === "Old notes") {
          return Promise.resolve({ ok: false, error: { code: "invalid", message: `${ROOT}/old-notes on devbox already holds files`, fix: "Give the bot another name" } });
        }
        const at = path ?? `${ROOT}/${title.toLowerCase()}`;
        return Promise.resolve({ ok: true, output: { machineId: "devbox", path: at, projectId: "p9", created: true, inspect: { ci: { workflows: [], requiredChecks: [] }, merge: { protected: false, rulesets: [] }, leadNeeds: "a plain folder with no git", notes: [] } } });
      }
      if (tool === "project_repo_add") {
        const { url } = input as { url?: string };
        if (url === "acme/broken") return Promise.resolve({ ok: false, error: { code: "not_found", message: "gh on the hub can't see acme/broken", fix: "Run gh auth login with an account that can read it" } });
        return Promise.resolve({ ok: true, output: { path: `/home/w/src/${url?.split("/")[1] ?? "x"}`, addId: "a1" } });
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
const press = async (el: Element | undefined | null) => {
  if (el === undefined || el === null) throw new Error("nothing to press");
  await act(async () => {
    (el as HTMLElement).click();
    await Promise.resolve();
  });
  await settle();
};
const key = async (el: HTMLElement, k: string) => {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  await settle();
};
/** + then a repo typed into its field and added with Enter. */
const addRepo = async (text: string) => {
  await press(document.querySelector('button[aria-label="Add a repo"]'));
  await type(field("Repo to add"), text);
  await key(field("Repo to add"), "Enter");
};
const listed = () => [...document.querySelectorAll('ul[aria-labelledby="new-bot-repos"] li')].map((li) => li.textContent);
const options = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
const madeWith = () => calls.filter((c) => c.tool === "project_add" || c.tool === "project_repo_add").map((c) => [c.tool, c.input]);

describe("New bot", () => {
  it("makes a bot with no repo from just a name, in a folder the hub makes", async () => {
    await render();
    expect(document.body.textContent).toContain("None. It works in a folder of its own.");
    await type(field("Name"), "Field notes");
    await key(field("Name"), "Enter");
    expect(madeWith()).toEqual([["project_add", { machineId: "devbox", create: true, title: "Field notes" }]]);
  });

  it("asks for a name only when there is none and no repo to take one from", async () => {
    await render();
    await press(button("Create"));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Name it, or add a repo.");
    expect(madeWith()).toEqual([]);
  });

  it("lists several repos, each removable before creating, and adds them to the bot once made", async () => {
    const hub = await render();
    await addRepo("https://github.com/acme/shop");
    await addRepo("/home/w/src/docs");
    await addRepo("acme/api");
    expect(listed()).toEqual(["acme/shop", "~/src/docs", "acme/api"]);
    await press(document.querySelector('button[aria-label="Remove acme/api"]'));
    expect(listed()).toEqual(["acme/shop", "~/src/docs"]);
    // No name: the first repo's, shown as the field's placeholder.
    expect(field("Name").placeholder).toBe("shop");
    await press(button("Create"));
    expect(madeWith()).toEqual([
      ["project_add", { machineId: "devbox", path: "/home/w/src/docs", title: "shop" }],
      ["project_repo_add", { machineId: "devbox", projectId: "p9", url: "acme/shop" }],
    ]);
    expect(document.querySelector('[data-screen="projects.add.cloning"]')).not.toBeNull();
    expect(button("Hide")).toBeDefined();
    // The clone ends: every repo is in, and Done closes it.
    await act(async () => {
      hub({ t: "event", event: { seq: 2, at: AT, type: "project.added", machineId: "devbox", projectId: "p9", summary: "", data: { addId: "a1", created: true, path: "/home/w/src/shop", title: "shop", inspect: { ci: { workflows: [], requiredChecks: [] }, merge: { protected: false, rulesets: [] }, leadNeeds: "", notes: [] } } } });
      await Promise.resolve();
    });
    await settle();
    expect(document.querySelector("h2")?.textContent).toBe("shop is ready");
    await press(button("Done"));
    expect(document.querySelector('[data-screen="projects.add"]')).toBeNull();
  });

  it("offers what the hub found on the bot's machine as you type, and Esc closes only the field", async () => {
    await render();
    await press(document.querySelector('button[aria-label="Add a repo"]'));
    await type(field("Repo to add"), "notes");
    expect(options()).toEqual(["notes-cli~/code/notes-cli"]);
    await key(field("Repo to add"), "Escape");
    expect(document.querySelector('input[aria-label="Repo to add"]')).toBeNull();
    expect(document.querySelector('[data-screen="projects.add"]')).not.toBeNull();
  });

  it("won't take a folder that is a bot already, and says which", async () => {
    await render();
    await addRepo(`${ROOT}/old-notes`);
    expect(listed()).toEqual([]);
    expect(document.body.textContent).toContain("is already the bot Old notes");
  });

  it("shows a repo that fails plainly, with Retry, while the bot is made", async () => {
    await render();
    await type(field("Name"), "Shop");
    await addRepo("acme/broken");
    await press(button("Create"));
    const row = document.querySelector('[data-state="failed"]');
    expect(row?.textContent).toContain("gh on the hub can't see acme/broken. Run gh auth login with an account that can read it.");
    expect(button("Retry")).toBeDefined();
    expect(button("Done")).toBeDefined();
  });

  it("says why a bot wasn't made, and Back keeps the form as it was", async () => {
    await render();
    await type(field("Name"), "Old notes");
    await key(field("Name"), "Enter");
    expect(document.querySelector('[data-screen="projects.add.error"]')?.textContent).toContain("already holds files.");
    await press(button("Back"));
    expect(field("Name").value).toBe("Old notes");
  });

  it("on a machine too old to make a bot's folder, says to update it", async () => {
    projectsRoot = undefined;
    await render();
    expect(document.body.textContent).toContain("Update fleetd on devbox to make a bot there, or add a folder that's already on it.");
  });

  it("takes a dropped folder as a repo", async () => {
    await render();
    act(() => openAddProject({ text: "/home/w/src/shop" }));
    await settle();
    expect(listed()).toEqual(["~/src/shop"]);
  });
});
