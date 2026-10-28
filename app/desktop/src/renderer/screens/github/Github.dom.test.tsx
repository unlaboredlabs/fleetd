// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubApp } from "../../../shared/contracts";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import type { GithubAppRequest } from "../../../shared/ipc";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { AdminGithub, appName, reachWords } from "./AdminGithub";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-27T10:00:00.000Z";
const PERMISSIONS = [
  ["contents", "write"],
  ["pull_requests", "write"],
  ["statuses", "write"],
  ["checks", "read"],
];
const made: GithubApp = {
  appId: 4242,
  slug: "fleetd-on-devbox-2",
  name: "fleetd on devbox 2",
  clientId: "Iv23liTEST",
  owner: "sam",
  htmlUrl: "https://github.com/apps/fleetd-on-devbox-2",
  settingsUrl: "https://github.com/settings/apps/fleetd-on-devbox-2",
  createdAt: AT,
};
const installed: GithubApp = {
  ...made,
  installations: [{ installationId: 7, account: "acme", allRepositories: false, repositoryCount: 2, repositories: ["acme/web", "acme/api"] }],
  lastTest: { at: AT, ok: true, said: '"fleetd on devbox 2" is installed on acme (2 repositories), and its tokens work.' },
};

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let app: GithubApp | undefined;
let creates: GithubAppRequest[];
let createAnswer: CallOutcome;
let opened: string[];
let hang: boolean;
let cancelled: number;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  app = undefined;
  creates = [];
  opened = [];
  hang = false;
  cancelled = 0;
  createAnswer = { ok: true, output: { app: made } };
  vi.stubGlobal("fleetd", {
    platform: "linux",
    openExternal: (url: string) => {
      opened.push(url);
      return Promise.resolve({ ok: true });
    },
    github: {
      createApp: (_hub: string, request: GithubAppRequest): Promise<CallOutcome> => {
        creates.push(request);
        if (hang) return new Promise<CallOutcome>(() => undefined);
        if (createAnswer.ok) app = made;
        return Promise.resolve(createAnswer);
      },
      cancel: () => {
        cancelled += 1;
        return Promise.resolve();
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

const answer = (tool: string): CallOutcome => {
  switch (tool) {
    case "github_app_get":
      return { ok: true, output: { ...(app === undefined ? {} : { app }), permissions: PERMISSIONS } };
    case "github_app_test":
      app = installed;
      return { ok: true, output: { app } };
    case "github_app_remove":
      app = undefined;
      return { ok: true, output: { settingsUrl: made.settingsUrl } };
    default:
      return { ok: true, output: {} };
  }
};

const render = async () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      return Promise.resolve(answer(tool));
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
          <AdminGithub />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox.example.ts.net:4790", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
  await settle();
};

const button = (text: string) => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
  if (b === undefined) throw new Error(`no button ${text} in: ${document.body.textContent}`);
  return b;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await settle();
  await settle();
};
const type = async (label: string, value: string) => {
  const field = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
  if (field === null) throw new Error(`no field ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

describe("Hub accounts › GitHub", () => {
  it("names the App after the hub, and says where it reaches", () => {
    expect(appName("devbox", "")).toBe("fleetd on devbox");
    expect(appName("", "http://devbox.example.ts.net:4790")).toBe("fleetd on devbox");
    expect(appName("", "100.64.0.7:4790")).toBe("fleetd on my hub");
    expect(appName("a hub with a very long label indeed", "")).toHaveLength(34);
    expect(reachWords({ installationId: 1, account: "acme", allRepositories: false, repositoryCount: 2, repositories: ["acme/web", "acme/api"] })).toBe("acme: acme/web and acme/api");
    expect(reachWords({ installationId: 1, account: "sam", allRepositories: true, repositoryCount: 31 })).toBe("sam: all 31 repositories");
    expect(reachWords({ installationId: 1, account: "big", allRepositories: false, repositoryCount: 140, repositories: ["big/a"] })).toBe("big: 140 chosen repositories");
  });

  it("creates the App on the admin's account through main, with nothing to paste", async () => {
    await render();
    expect(document.body.textContent).toContain("No App yet");
    expect(document.body.textContent).toContain("Commit statuses: post fleetd/train (write)");
    expect(document.body.textContent).toContain("Webhooks: off");
    expect(document.querySelector<HTMLInputElement>('[aria-label="Name"]')?.value).toBe("fleetd on devbox");
    await click(button("Create GitHub App"));
    expect(creates).toEqual([{ name: "fleetd on devbox" }]);
    expect(document.body.textContent).toContain("Created. Now install it");
    expect(document.body.textContent).toContain("fleetd on devbox 2");
    expect(document.body.textContent).toContain("Not installed yet");
    await click(button("Install it on repositories"));
    expect(opened).toEqual(["https://github.com/apps/fleetd-on-devbox-2/installations/new"]);
  });

  it("creates it in an organization, and stops waiting on Cancel", async () => {
    hang = true;
    await render();
    await click(button("An organization"));
    await type("Organization", "acme");
    await type("Name", "fleetd for acme");
    await click(button("Create GitHub App"));
    expect(creates).toEqual([{ name: "fleetd for acme", organization: "acme" }]);
    expect(button("Waiting for GitHub…").disabled).toBe(true);
    await click(button("Cancel"));
    expect(cancelled).toBe(1);
  });

  it("says what went wrong, but not a cancel", async () => {
    createAnswer = { ok: false, error: { code: "failed", message: "GitHub doesn't know that code.", fix: "Create the App again." } };
    await render();
    await click(button("Create GitHub App"));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("GitHub doesn't know that code.");
    createAnswer = { ok: false, error: { code: "cancelled", message: "Creating the App was cancelled." } };
    await click(button("Create GitHub App"));
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("tests the App and shows where it is installed; Remove forgets it", async () => {
    app = made;
    await render();
    await click(button("Test"));
    expect(calls.some((c) => c.tool === "github_app_test")).toBe(true);
    expect(document.body.textContent).toContain("acme: acme/web and acme/api");
    expect(document.querySelector('[role="status"]')?.textContent).toContain("its tokens work");
    await click(button("Remove"));
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent.trim() === "Remove");
    if (confirm === undefined) throw new Error("no confirm");
    await click(confirm);
    expect(calls.some((c) => c.tool === "github_app_remove")).toBe(true);
    expect(document.body.textContent).toContain("No App yet");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(`${made.settingsUrl}/advanced`);
  });
});
