// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRepo, ProjectSettings as Settings } from "../../../shared/contracts";
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
/** A secret of several lines, as a certificate chain or a key file is. */
const CHAIN = `-----BEGIN PRIVATE KEY-----\n${SECRET}\nMIIEvgIBADANBgkqhkiG9w0BAQEF\n-----END PRIVATE KEY-----\n`;

const settings: Settings = {
  machineId: "devbox",
  projectId: "p1",
  title: "storefront",
  workspaceRoot: "/home/w/src/storefront",
  keepWorktrees: false,
  setup: { commands: [], timeoutSec: 600, runAnyway: false, inputs: [] },
  env: [
    { name: "API_URL", kind: "plain", value: "https://staging.example", bytes: 23, updatedAt: AT },
    { name: "STRIPE_KEY", kind: "secret", fingerprint: "5ec2e7a1", bytes: 20, updatedAt: AT },
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

const snapshotWith = (repos: ProjectRepo[]): HubFrame => ({
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
        ...(repos.length > 0 ? { repos } : {}),
      },
    ],
  },
});

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
/** What project_settings_get answers, in turn; the last one again once they run out. */
let answers: Settings[];
let envRequests: ProjectEnvRequest[];
const web: ProjectRepo = { repoId: "R1", name: "web", checkout: { machineId: "devbox", projectId: "p1" }, repoKey: "github.com/acme/web", base: "main" };
const api: ProjectRepo = { repoId: "R2", name: "api", checkout: { machineId: "devbox", projectId: "p9" }, repoKey: "gitlab.example.com/team/api" };

/** The project's repos in the snapshot. */
let repos: ProjectRepo[];
/** What project_settings_get answers for a repo; a repo not here is refused, as a hub before per-repo settings does. */
let repoAnswers: Record<string, Settings>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  answers = [settings];
  envRequests = [];
  repos = [];
  repoAnswers = {};
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
      const repo = tool === "project_settings_get" ? (input as { repo?: string }).repo : undefined;
      if (repo !== undefined) {
        const own = repoAnswers[repo];
        return Promise.resolve(own ? { ok: true, output: { settings: own } } : { ok: false, error: { code: "not_found", message: `Project p1 on devbox has no repo ${repo}.` } });
      }
      const now = (tool === "project_settings_get" && answers.length > 1 ? answers.shift() : answers[0]) ?? settings;
      if (tool === "mcp_servers_get") return Promise.resolve({ ok: true, output: { global: [], project: [], userServers: true } });
      if (tool === "project_repo_add") {
        const url = (input as { url?: string }).url;
        return Promise.resolve({
          ok: true,
          output: url ? { path: "/home/w/src/web", addId: "a1" } : { path: "/home/w/src/api", next: "api is a repo of the project now, at /home/w/src/api on devbox." },
        });
      }
      if (tool === "project_repo_remove") {
        return Promise.resolve({ ok: true, output: { removed: api, cancelled: [], next: "Its checkout stays at /home/w/src/api on devbox, files and all." } });
      }
      return Promise.resolve({ ok: true, output: tool === "project_settings_get" || tool === "project_settings_set" ? { settings: now } : { ok: true } });
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
    listener(snapshotWith(repos));
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

const type = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
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
    const name = dialog().querySelector("input");
    if (name === null) throw new Error("no name field");
    await type(name, "DB_PASSWORD");
    const secret = [...dialog().querySelectorAll('[role="radio"]')].find((r) => r.textContent === "" && r.getAttribute("value") === "secret");
    await click(secret as HTMLElement);
    // A field of several lines, so a certificate chain pastes as it is, whose characters show as dots.
    const field = dialog().querySelector<HTMLTextAreaElement>("textarea[data-secret]");
    if (field === null) throw new Error("the secret's value isn't a masked field");
    await type(field, CHAIN);
    await click(button("Save"));
    await settle();
    expect(envRequests).toEqual([
      { machineId: "devbox", projectId: "p1", boxPubKey: KEY, set: [{ kind: "secret", name: "DB_PASSWORD", value: CHAIN }], remove: [] },
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

  it("turns the nightly memory refresh off, on by default", async () => {
    await render();
    const toggle = [...document.querySelectorAll<HTMLElement>('[role="switch"]')].find((x) => x.closest("label, div")?.textContent.includes("Refresh memory every night"));
    if (toggle === undefined) throw new Error("no memory switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await click(toggle);
    await settle();
    expect(calls.find((c) => c.tool === "project_settings_set")?.input).toEqual({ machineId: "devbox", projectId: "p1", memoryRefresh: false });
  });

  it("saves setup commands in order, with their limit, inputs and run anyway", async () => {
    await render();
    const section = document.querySelector<HTMLElement>('section[aria-label="Setup commands"]');
    if (section === null) throw new Error("no setup section");
    const [commands, inputs] = [...section.querySelectorAll("textarea")];
    const limit = section.querySelector("input");
    if (commands === undefined || inputs === undefined || limit === null) throw new Error("no setup fields");
    expect(button("Save setup").disabled).toBe(true);
    await type(commands, "pnpm install --frozen-lockfile\n\npnpm codegen\n");
    await type(limit, "0");
    expect(section.textContent).toContain("1 to 3600");
    expect(button("Save setup").disabled).toBe(true);
    await type(limit, "900");
    await type(inputs, "pnpm-lock.yaml");
    const anyway = section.querySelector<HTMLElement>('[role="switch"]');
    if (anyway === null) throw new Error("no run anyway switch");
    await click(anyway);
    await click(button("Save setup"));
    await settle();
    expect(calls.find((c) => c.tool === "project_settings_set")?.input).toEqual({
      machineId: "devbox",
      projectId: "p1",
      setup: { commands: ["pnpm install --frozen-lockfile", "pnpm codegen"], timeoutSec: 900, runAnyway: true, inputs: ["pnpm-lock.yaml"] },
    });
    expect(section.textContent).toContain("Saved.");
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

  it("keeps Delete off while the machine can't list the worktrees, and refuses when a fresh listing fails", async () => {
    const { worktrees: _, ...offline } = settings;
    answers = [{ ...offline, worktreesUnknown: "devbox is offline." }];
    await render();
    expect(button("Delete project…").disabled).toBe(true);
    expect(document.body.textContent).toContain("devbox is offline.");
    act(() => root.unmount());
    root = createRoot(host);

    // Listed when the page loaded, gone by the time Delete is clicked: no dialog, and why.
    answers = [settings, { ...offline, worktreesUnknown: "devbox's node did not answer." }];
    await render();
    await click(button("Delete project…"));
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain("devbox's node did not answer.");
    expect(calls.some((c) => c.tool === "project_remove")).toBe(false);
  });
});

describe("Settings → Projects → Repos", () => {
  /** The page, then each repo's read, which starts once the project's settings are in. */
  const renderRepos = async () => {
    await render();
    await settle();
  };
  const section = () => {
    const el = document.querySelector<HTMLElement>('section[aria-label="Repos"]');
    if (el === null) throw new Error("no repos section");
    return el;
  };
  const row = (name: string) => {
    const el = section().querySelector<HTMLElement>(`[role="listitem"][aria-label="${name}"]`);
    if (el === null) throw new Error(`no repo ${name}`);
    return el.textContent;
  };

  it("says a plain folder has no repo, in one line", async () => {
    await renderRepos();
    expect(section().textContent).toContain("No repo, a plain folder.");
    expect(section().querySelector('[role="list"]')).toBeNull();
    expect(calls.some((c) => c.tool === "project_settings_get" && (c.input as { repo?: string }).repo !== undefined)).toBe(false);
  });

  it("shows one repo's remote, base and checkout, and the project's setup on a hub that has none of its own", async () => {
    repos = [web];
    answers = [{ ...settings, setup: { ...settings.setup, commands: ["pnpm install"] } }];
    await renderRepos();
    const text = row("web");
    expect(text).toContain("acme/web");
    expect(text).not.toContain("github.com");
    expect(text).toContain("main");
    expect(text).toContain("/home/w/src/storefront on devbox");
    expect(text).toContain("Uses the project's: pnpm install");
    expect(text).toContain("Uses the project's: none");
    expect(calls).toContainEqual({ tool: "project_settings_get", input: { machineId: "devbox", projectId: "p1", repo: "web" } });
  });

  it("shows two repos, each with the setup and preview that apply to it", async () => {
    repos = [web, api];
    answers = [{ ...settings, setup: { ...settings.setup, commands: ["pnpm install"] } }];
    repoAnswers = {
      web: answers[0] as Settings,
      api: { ...settings, repo: "api", setup: { ...settings.setup, commands: ["go mod download", "make gen"] }, preview: { web: { start: "make serve" } } },
    };
    await renderRepos();
    expect([...section().querySelectorAll('[role="listitem"]')].map((x) => x.getAttribute("aria-label"))).toEqual(["web", "api"]);
    expect(row("web")).toContain("Uses the project's: pnpm install");
    const text = row("api");
    expect(text).toContain("team/api on gitlab.example.com");
    expect(text).toContain("Not known yet");
    // Its checkout isn't a listed project: shown by its id, on its machine.
    expect(text).toContain("p9 on devbox");
    expect(text).toContain("go mod download; make gen");
    expect(text).toContain("make serve");
    expect(text).not.toContain("Uses the project's");
  });

  it("adds a repo by its path on the machine, or clones one from GitHub", async () => {
    await renderRepos();
    const field = section().querySelector<HTMLInputElement>('input[aria-label="Repo to add"]');
    const name = section().querySelector<HTMLInputElement>('input[aria-label="Repo name"]');
    if (field === null || name === null) throw new Error("no add form");
    expect(button("Add repo").disabled).toBe(true);
    await type(field, " /home/w/src/api ");
    await click(button("Add repo"));
    await settle();
    expect(calls).toContainEqual({ tool: "project_repo_add", input: { machineId: "devbox", projectId: "p1", path: "/home/w/src/api" } });
    expect(section().textContent).toContain("api is a repo of the project now");
    await type(field, "acme/web");
    await type(name, "front");
    await click(button("Add repo"));
    await settle();
    expect(calls).toContainEqual({ tool: "project_repo_add", input: { machineId: "devbox", projectId: "p1", name: "front", url: "acme/web" } });
    expect(section().textContent).toContain("Cloning into /home/w/src/web on devbox");
    // A name that isn't a repo name adds nothing.
    await type(name, "Front End");
    expect(button("Add repo").disabled).toBe(true);
  });

  it("removes a repo once asked, never the project's own directory", async () => {
    repos = [web, api];
    await renderRepos();
    const removeIn = (n: string) => section().querySelector(`[role="listitem"][aria-label="${n}"] button`);
    expect(removeIn("web")).toBeNull();
    await click(removeIn("api") as HTMLElement);
    expect(dialog().textContent).toContain("Remove api from storefront?");
    expect(dialog().textContent).toContain("Its checkout stays at p9, files and all.");
    expect(calls.some((c) => c.tool === "project_repo_remove")).toBe(false);
    await click(button("Remove repo"));
    await settle();
    expect(calls).toContainEqual({ tool: "project_repo_remove", input: { machineId: "devbox", projectId: "p1", name: "api" } });
    expect(section().textContent).toContain("api removed. Its checkout stays at /home/w/src/api on devbox");
  });
});
