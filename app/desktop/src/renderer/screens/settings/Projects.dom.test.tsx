// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSettings as Settings } from "../../../shared/contracts";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import type { ProjectEnvRequest } from "../../../shared/ipc";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { ProjectSettings } from "./Projects";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Settings search reads the platform when it loads, before any test runs.
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-19T10:00:00.000Z";
const KEY = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";
const SECRET = "sk_live_never_shown";

const settings: Settings = {
  machineId: "devbox",
  projectId: "p1",
  title: "storefront",
  workspaceRoot: "/home/w/src/storefront",
  keepWorktrees: false,
  env: [
    { name: "API_URL", kind: "plain", value: "https://staging.example", updatedAt: AT },
    { name: "STRIPE_KEY", kind: "secret", fingerprint: "5ec2e7a1", updatedAt: AT },
  ],
  worktrees: {
    dir: "/home/w/.fleetd/node/worktrees/p1",
    baseBranch: "main",
    worktrees: [
      { sessionId: "t1", path: "/home/w/.fleetd/node/worktrees/p1/t1", branch: "fleetd/T1-cart", uncommitted: true },
      { sessionId: "t2", path: "/home/w/.fleetd/node/worktrees/p1/t2", branch: "fleetd/T2-tax", uncommitted: false },
    ],
  },
};

const snapshot: HubFrame = {
  t: "snapshot",
  snapshot: {
    cursor: 1,
    attention: [],
    machines: [{ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [], boxPubKey: KEY }],
    projects: [
      {
        machineId: "devbox",
        projectId: "p1",
        title: "storefront",
        workspaceRoot: "/home/w/src/storefront",
        threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
        lastActivityAt: AT,
      },
    ],
  },
};

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let envRequests: ProjectEnvRequest[];

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  envRequests = [];
  window.location.hash = "#/settings/projects?for=devbox/p1";
  vi.stubGlobal("fleetd", {
    platform: "linux",
    secret: {
      projectEnv: (request: ProjectEnvRequest): Promise<CallOutcome> => {
        envRequests.push(request);
        return Promise.resolve({ ok: true, output: { env: [] } });
      },
    },
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const render = async () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      return Promise.resolve({ ok: true, output: tool === "project_settings_get" || tool === "project_settings_set" ? { settings } : { ok: true } });
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={layer}>
          <ProjectSettings route={{ tab: "projects", prompt: null, for: "devbox/p1", view: "edit" }} />
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
  // project_settings_get's answer.
  await settle();
};


const button = (text: string) => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
  if (b === undefined) throw new Error(`no button ${text}`);
  return b;
};

const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
};

const type = async (field: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

const dialog = () => {
  const d = document.querySelector<HTMLElement>('[role="dialog"]');
  if (d === null) throw new Error("no dialog");
  return d;
};

describe("Settings → Projects", () => {
  it("shows a secret by its fingerprint only, and where worktrees go", async () => {
    await render();
    const text = document.body.textContent;
    expect(text).toContain("https://staging.example");
    expect(text).toContain("secret · 5ec2e7a1");
    expect(text).toContain("/home/w/.fleetd/node/worktrees/p1");
    expect(text).toContain("2 there now, 1 with uncommitted changes");
  });

  it("sends a new secret only through main's sealing, never as a hub call", async () => {
    await render();
    await click(button("Add variable"));
    const [name, value] = [...dialog().querySelectorAll("input")];
    if (name === undefined || value === undefined) throw new Error("no fields");
    await type(name, "DB_PASSWORD");
    const secret = [...dialog().querySelectorAll('[role="radio"]')].find((r) => r.textContent === "" && r.getAttribute("value") === "secret");
    await click(secret as HTMLElement);
    const field = dialog().querySelector<HTMLInputElement>('input[type="password"]');
    if (field === null) throw new Error("the secret's value isn't a password field");
    await type(field, SECRET);
    await click(button("Save"));
    await settle();
    expect(envRequests).toEqual([
      { machineId: "devbox", projectId: "p1", boxPubKey: KEY, set: [{ kind: "secret", name: "DB_PASSWORD", value: SECRET }], remove: [] },
    ]);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  });

  it("turns keep finished worktrees on", async () => {
    await render();
    const toggle = document.querySelector<HTMLElement>('[role="switch"]');
    if (toggle === null) throw new Error("no switch");
    await click(toggle);
    await settle();
    expect(calls.find((c) => c.tool === "project_settings_set")?.input).toEqual({ machineId: "devbox", projectId: "p1", keepWorktrees: true });
  });

  it("deletes only once the name is typed, names the worktree with uncommitted changes, and removes the worktrees", async () => {
    await render();
    await click(button("Delete project…"));
    expect(dialog().textContent).toContain("fleetd/T1-cart");
    expect(dialog().textContent).not.toContain("fleetd/T2-tax");
    expect(dialog().textContent).toContain("Its checkout at /home/w/src/storefront");
    const confirm = button("Delete project");
    expect(confirm.disabled).toBe(true);
    const field = dialog().querySelector("input");
    if (field === null) throw new Error("no confirm field");
    await type(field, "storefron");
    expect(button("Delete project").disabled).toBe(true);
    await type(field, "storefront");
    expect(button("Delete project").disabled).toBe(false);
    await click(button("Delete project"));
    await settle();
    expect(calls.find((c) => c.tool === "project_remove")?.input).toEqual({ machineId: "devbox", projectId: "p1", removeWorktrees: true });
  });
});
