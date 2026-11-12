// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallGithubOutcome } from "../../../shared/cloud";
import type { GithubAccount, GithubApp } from "../../../shared/contracts";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import type { GithubAppRequest } from "../../../shared/ipc";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider, HubScope, useDataLayer } from "../../src/data/react";
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

// fleetd's one App on a cloud team (fleetd-cloud's github_app_get): its public page, installed nowhere yet.
const fleetdApp: GithubApp = {
  appId: 5736169,
  slug: "fleetd-cloud",
  name: "fleetd-cloud",
  clientId: "Iv23liCLOUD",
  owner: "fleetd",
  htmlUrl: "https://github.com/apps/fleetd-cloud",
  settingsUrl: "https://github.com/apps/fleetd-cloud",
  createdAt: "1970-01-01T00:00:00.000Z",
  installations: [],
};
const sam: GithubAccount = { login: "sam", userId: 77, connectedAt: AT };
const ACME_INSTALL = "https://github.com/organizations/acme/settings/installations/7";

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let app: GithubApp | undefined;
let creates: GithubAppRequest[];
let createAnswer: CallOutcome;
let opened: string[];
let hang: boolean;
let cancelled: number;
let cloud: boolean;
let me: GithubAccount | undefined;
let installs: string[];
let installAnswer: InstallGithubOutcome;
let connects: string[];

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
  cloud = false;
  me = undefined;
  installs = [];
  installAnswer = { ok: true };
  connects = [];
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
      connect: (hub: string): Promise<CallOutcome> => {
        connects.push(hub);
        me = sam;
        return Promise.resolve({ ok: true, output: { me: sam } });
      },
    },
    cloud: {
      installGithub: (hub: string): Promise<InstallGithubOutcome> => {
        installs.push(hub);
        return Promise.resolve(installAnswer);
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
      return { ok: true, output: { ...(app === undefined ? {} : { app }), ...(me === undefined ? {} : { me }), permissions: PERMISSIONS } };
    case "hub_info":
      // fleetd cloud's hub_info names what it leaves out, the hub's own App among them.
      return { ok: true, output: { version: "0.9.0", protocol: 1, busy: [], ...(cloud ? { leftOut: ["github_app_manifest", "github_app_create", "setup_list"] } : {}) } };
    case "github_app_test":
      app = installed;
      return { ok: true, output: { app } };
    case "github_app_remove":
      if (cloud) {
        app = fleetdApp;
        return { ok: true, output: { settingsUrl: ACME_INSTALL } };
      }
      app = undefined;
      return { ok: true, output: { settingsUrl: made.settingsUrl } };
    default:
      return { ok: true, output: {} };
  }
};

/** The one hub: a team of fleetd cloud's (one that came with the account) while `cloud`, else a self-hosted one. */
function Hub() {
  const layer = useDataLayer();
  return (
    <HubScope hub={{ id: layer.hub, label: cloud ? "acme" : "", layer, ...(cloud ? { cloud: true as const } : {}) }}>
      <AdminGithub />
    </HubScope>
  );
}

const reads = () => calls.filter((c) => c.tool === "github_app_get").length;

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
          <Hub />
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

describe("Hub › Setup › GitHub", () => {
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
    // A self-hosted hub's App: the link is the App's own, and the cloud is never asked.
    expect(installs).toEqual([]);
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

  it("says when its last Test failed, beside the App", async () => {
    const at = new Date();
    const hm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    app = { ...installed, lastTest: { at: at.toISOString(), ok: false, said: "GitHub can't be reached: connection refused." } };
    await render();
    const section = document.querySelector('[aria-label="GitHub App"]');
    expect(section?.querySelector('[role="alert"]')?.textContent).toBe(`Failed today ${hm}: GitHub can't be reached: connection refused.`);
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

describe("Hub › Setup › GitHub on a fleetd cloud team", () => {
  beforeEach(() => {
    cloud = true;
    app = fleetdApp;
    me = sam;
  });

  it("installs fleetd's App by the page the team answers, with nothing to create", async () => {
    await render();
    expect(document.body.textContent).not.toContain("Create GitHub App");
    expect(document.body.textContent).not.toContain("Its settings on GitHub");
    expect(document.body.textContent).not.toContain("Remove");
    await click(button("Install it on repositories"));
    expect(installs).toHaveLength(1);
    // main opens the team's page itself; the app builds no link.
    expect(opened).toEqual([]);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("asks for the person's own GitHub first when the team answers 409, then Install", async () => {
    installAnswer = {
      ok: false,
      connectFirst: true,
      failure: {
        code: "failed",
        message: "Connect your own GitHub first: fleetd asks GitHub, as you, that you administer the account you install it on.",
        fix: "Connect GitHub in Settings › Your accounts › GitHub, then install again.",
      },
    };
    await render();
    await click(button("Install it on repositories"));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Connect your own GitHub first: fleetd asks GitHub, as you, that you administer the account you install it on.");
    await click(button("Connect GitHub"));
    expect(connects).toHaveLength(1);
    installAnswer = { ok: true };
    await click(button("Install it on repositories"));
    expect(installs).toHaveLength(2);
  });

  it("offers Connect GitHub before Install while the person's own isn't connected", async () => {
    me = undefined;
    await render();
    expect(document.body.textContent).not.toContain("Install it on repositories");
    await click(button("Connect GitHub"));
    expect(connects).toHaveLength(1);
    await click(button("Install it on repositories"));
    expect(installs).toHaveLength(1);
  });

  it("reads the App again when the window gets focus back from GitHub", async () => {
    await render();
    await click(button("Install it on repositories"));
    const before = reads();
    app = { ...fleetdApp, installations: [{ installationId: 7, account: "acme", allRepositories: true, repositoryCount: 12 }] };
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await settle();
    await settle();
    expect(reads()).toBeGreaterThan(before);
    expect(document.body.textContent).toContain("acme: all 12 repositories");
    expect(button("Install on more repositories")).toBeDefined();
  });

  it("Remove takes it off the team and points at its installation on GitHub", async () => {
    app = { ...fleetdApp, installations: [{ installationId: 7, account: "acme", allRepositories: true, repositoryCount: 12 }] };
    await render();
    await click(button("Remove"));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Take GitHub off this team?");
    expect(dialog?.textContent).toContain("It stays installed on GitHub until you uninstall it there.");
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent.trim() === "Remove");
    if (confirm === undefined) throw new Error("no confirm");
    await click(confirm);
    expect(calls.some((c) => c.tool === "github_app_remove")).toBe(true);
    expect(document.body.textContent).toContain("Taken off this team.");
    expect(document.body.textContent).not.toContain("Delete it on GitHub");
    expect(document.body.textContent).not.toContain("No App yet");
    await click(button("Uninstall on GitHub"));
    expect(opened).toEqual([ACME_INSTALL]);
  });

  it("says GitHub isn't set up when the service has no App", async () => {
    app = undefined;
    await render();
    expect(document.body.textContent).toContain("GitHub isn't set up on this service.");
    expect(document.body.textContent).not.toContain("No App yet");
    expect(document.body.textContent).not.toContain("Create GitHub App");
  });
});
