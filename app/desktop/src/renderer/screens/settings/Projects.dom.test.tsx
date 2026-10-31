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
import { Instructions } from "./Instructions";
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

const snapshotWith = (repos: ProjectRepo[], navi = false): HubFrame => ({
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
        ...(navi ? { kind: "assistant" as const } : {}),
      },
    ],
  },
});

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
/** A Navi's approvals as navi_approvals answers them, and what ran without asking. */
let approvals: { mode: string; model: string; effort: string; defaults: boolean };
const approvedLog = [
  {
    at: "2026-10-31T14:05:00.000Z",
    by: "checker",
    tool: "mcp__gmail__send_message",
    what: "`send_message` on `gmail`, to sam@friends.example",
    reason: "you asked to tell Sam that Saturday works",
    messageId: "m398",
  },
  { at: "2026-10-30T18:02:00.000Z", by: "yolo", tool: "mcp__linear__create_issue", what: "`create_issue` on `linear`", messageId: "m350" },
];

/** What project_settings_get answers, in turn; the last one again once they run out. */
let answers: Settings[];
let envRequests: ProjectEnvRequest[];
const web: ProjectRepo = { repoId: "R1", name: "web", checkout: { machineId: "devbox", projectId: "p1" }, repoKey: "github.com/acme/web", base: "main" };
const api: ProjectRepo = { repoId: "R2", name: "api", checkout: { machineId: "devbox", projectId: "p9" }, repoKey: "gitlab.example.com/team/api" };

/** The project's repos in the snapshot. */
let repos: ProjectRepo[];
/** What project_settings_get answers for a repo; a repo not here is refused, as a hub before per-repo settings does. */
let repoAnswers: Record<string, Settings>;
/** The project is a Navi. */
let navi: boolean;
/** navi_approvals fails this many more times. */
let approvalsFail: number;
/** A frame from the hub, once rendered. */
let send: (frame: HubFrame) => void;
/** How long the hub takes over a call that ends the list above. */
let readMs: number;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  answers = [settings];
  approvals = { mode: "checker", model: "claude-sonnet-5-5", effort: "medium", defaults: true };
  envRequests = [];
  repos = [];
  repoAnswers = {};
  navi = false;
  approvalsFail = 0;
  readMs = 0;
  window.location.hash = "#/settings/projects?for=devbox/p1";
  vi.stubGlobal("fleetd", {
    platform: "linux",
    secret: {
      projectEnv: (_hub: string, request: ProjectEnvRequest): Promise<CallOutcome> => {
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

/** `page`: the Project page, or the project's Instructions & memory (its nightly refresh). */
const render = async (page: "project" | "instructions" = "project") => {
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
      if (tool === "navi_approvals" && approvalsFail > 0) {
        approvalsFail -= 1;
        return Promise.resolve({ ok: false, error: { code: "not_found", message: "navi_approvals: no navi_approvals row for project p1 on devbox" } });
      }
      if (tool === "navi_approvals") return Promise.resolve({ ok: true, output: { approvals, log: approvedLog } });
      if (tool === "navi_approvals_set") {
        const set = input as { mode: string; model?: string; effort?: string };
        approvals = { mode: set.mode, model: set.model ?? "claude-sonnet-5-5", effort: set.effort ?? "medium", defaults: set.model === undefined };
        return Promise.resolve({ ok: true, output: { approvals } });
      }
      if (tool === "profiles_list") {
        return Promise.resolve({
          ok: true,
          output: {
            profiles: [],
            models: [
              { id: "claude-sonnet-5-5", displayName: "Sonnet 5.5", fast: false },
              { id: "claude-opus-5-5", displayName: "Opus 5.5", fast: true },
            ],
            modelsFrom: "builtin",
          },
        });
      }
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
      const outcome: CallOutcome = { ok: true, output: tool === "project_settings_get" || tool === "project_settings_set" ? { settings: now } : { ok: true } };
      return readMs === 0 ? Promise.resolve(outcome) : new Promise((r) => setTimeout(() => r(outcome), readMs));
    },
    subscribe: (l) => ((listener = l), () => undefined),
    // As main's hub client: a resync asks for a snapshot, which comes on the same link.
    resync: () => {
      setTimeout(() => listener(snapshotWith(repos, navi)), 0);
      return Promise.resolve();
    },
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  send = (frame) => listener(frame);
  const layer = createDataLayer(hub);
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={layer}>
          {page === "project" ? (
            <ProjectSettings route={{ tab: "projects", prompt: null, for: "devbox/p1", view: "edit" }} />
          ) : (
            <Instructions route={{ tab: "instructions", prompt: null, for: "devbox/p1", view: "edit" }} />
          )}
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener(snapshotWith(repos, navi));
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
    const toggle = document.querySelector<HTMLElement>('section[aria-label="Worktrees"] [role="switch"]');
    if (toggle === null) throw new Error("no switch");
    await click(toggle);
    await settle();
    expect(calls.find((c) => c.tool === "project_settings_set")?.input).toEqual({ machineId: "devbox", projectId: "p1", keepWorktrees: true });
  });

  it("keeps the page on screen through the resync a saved setting brings, never Loading… or a remount", async () => {
    await render();
    const page = document.querySelector('[data-screen="settings.projects"]');
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Project name"]');
    const toggle = document.querySelector<HTMLElement>('section[aria-label="Worktrees"] [role="switch"]');
    if (page === null || name === null || toggle === null) throw new Error("no page");
    answers = [{ ...settings, keepWorktrees: true }];
    await click(toggle);
    await settle();
    // The hub's project.settings event for the save makes the app resync (a snapshot on the same link), and the
    // reads that follow take the hub a moment.
    readMs = 50;
    const reads = calls.filter((c) => c.tool === "project_settings_get").length;
    await act(async () => {
      send({ t: "event", event: { seq: 2, at: AT, type: "project.settings", summary: "storefront's settings changed", machineId: "devbox", projectId: "p1" } });
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(calls.filter((c) => c.tool === "project_settings_get").length).toBeGreaterThan(reads);
    expect(page.textContent).not.toContain("Loading…");
    expect(document.querySelector('[data-screen="settings.projects"]')).toBe(page);
    expect(document.querySelector('input[aria-label="Project name"]')).toBe(name);
    expect(toggle.isConnected).toBe(true);
    await act(async () => new Promise((r) => setTimeout(r, 100)));
    expect(document.querySelector('input[aria-label="Project name"]')).toBe(name);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("turns the nightly memory refresh off, on by default, beside the project's memory", async () => {
    await render();
    expect(document.body.textContent).not.toContain("Refresh memory every night");
    act(() => root.unmount());
    root = createRoot(host);
    await render("instructions");
    const toggle = [...document.querySelectorAll<HTMLElement>('[role="switch"]')].find((x) => x.closest("label, div")?.textContent.includes("Refresh memory every night"));
    if (toggle === undefined) throw new Error("no memory switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await click(toggle);
    await settle();
    expect(calls.find((c) => c.tool === "project_settings_set")?.input).toEqual({ machineId: "devbox", projectId: "p1", memoryRefresh: false });
  });

  it("saves the default setup, under the repos, in order, with its limit, inputs and run anyway", async () => {
    await render();
    const section = document.querySelector<HTMLElement>('section[aria-label="Repos"] section[aria-labelledby="default-setup"]');
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
    repos = [web];
    await render();
    expect(document.body.textContent).toContain("Its checkout, its branches and its pull requests stay as they are.");
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

  it("says a plain folder's delete, a Navi's among them, keeps its folder, with no checkout, branches or pull requests", async () => {
    // No repo of its own: a folder, not a git repo.
    const folder = "/home/w/.fleetd/node/navi/adri";
    answers = [{ ...settings, title: "Adri", workspaceRoot: folder, worktrees: { dir: "/home/w/.fleetd/node/worktrees/p1", worktrees: [] } }];
    await render();
    expect(document.body.textContent).toContain("Its folder stays as it is.");
    await click(button("Delete project…"));
    const text = dialog().textContent;
    expect(text).toContain("Delete Adri?");
    expect(text).toContain(`Its agents stop now and fleetd forgets it and its settings. Its folder at ${folder} stays as it is`);
    expect(text).not.toMatch(/checkout|branch|pull request|worktree/i);
    const field = dialog().querySelector("input");
    if (field === null) throw new Error("no confirm field");
    await type(field, "Adri");
    await click(button("Delete project"));
    await settle();
    expect(calls.find((c) => c.tool === "project_remove")?.input).toEqual({ machineId: "devbox", projectId: "p1", removeWorktrees: true });
  });

  it("forgets a Navi's sign-ins after asking, and shows no sign-ins on a project of code", async () => {
    await render();
    expect([...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Forget sign-ins…")).toBe(false);
    act(() => root.unmount());
    root = createRoot(host);

    navi = true;
    answers = [{ ...settings, title: "Adri", workspaceRoot: "/home/w/.fleetd/node/navi/adri", worktrees: { dir: "/home/w/.fleetd/node/worktrees/p1", worktrees: [] } }];
    await render();
    expect(document.body.textContent).toContain("stays signed in to the sites it signed into");
    await click(button("Forget sign-ins…"));
    expect(dialog().textContent).toContain("its browser profile is deleted from devbox");
    await click(button("Cancel"));
    expect(calls.some((c) => c.tool === "navi_signins_forget")).toBe(false);
    await click(button("Forget sign-ins…"));
    await click(button("Forget sign-ins"));
    await settle();
    expect(calls.find((c) => c.tool === "navi_signins_forget")?.input).toEqual({ machineId: "devbox", projectId: "p1" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain("Its next browser session starts signed out of every site.");
  });

  it("sets a Navi's approval mode and lists what ran without asking, each with its chat line", async () => {
    navi = true;
    answers = [{ ...settings, title: "Adri", workspaceRoot: "/home/w/.fleetd/node/navi/adri", worktrees: { dir: "/home/w/.fleetd/node/worktrees/p1", worktrees: [] } }];
    await render();
    await settle();
    const part = document.querySelector('section[aria-label="Approvals"]');
    expect(part?.textContent).toContain("Checker decides");
    expect(part?.textContent).toContain("Sonnet 5.5 · medium effort (the default)");
    expect(part?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.closest("label")?.textContent).toContain("Checker decides");
    const log = document.querySelector('ul[aria-label="Ran without asking"]');
    expect(log?.querySelectorAll("li")).toHaveLength(2);
    expect(log?.textContent).toContain("Checker: you asked to tell Sam that Saturday works");
    expect(log?.textContent).toContain("YOLO: nothing asks");
    const yolo = [...(part?.querySelectorAll<HTMLElement>("label") ?? [])].find((l) => l.textContent.startsWith("YOLO"))?.querySelector<HTMLElement>('[role="radio"]');
    if (!yolo) throw new Error("no YOLO choice");
    await click(yolo);
    await settle();
    expect(calls.find((c) => c.tool === "navi_approvals_set")?.input).toEqual({ machineId: "devbox", projectId: "p1", mode: "yolo" });
  });

  it("says plainly when a Navi's approvals can't be read, never the lookup's error, and tries again", async () => {
    navi = true;
    approvalsFail = 1;
    answers = [{ ...settings, title: "Adri", workspaceRoot: "/home/w/.fleetd/node/navi/adri", worktrees: { dir: "/home/w/.fleetd/node/worktrees/p1", worktrees: [] } }];
    await render();
    await settle();
    const part = () => document.querySelector('section[aria-label="Approvals"]');
    expect(part()?.textContent).toContain("Navi's approval settings couldn't be loaded.");
    expect(part()?.textContent).not.toContain("navi_approvals");
    expect(part()?.textContent).not.toContain("p1");
    await click(button("Try again"));
    await settle();
    expect(part()?.textContent).toContain("Checker decides");
    expect(part()?.textContent).not.toContain("couldn't be loaded");
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
    expect(text).toContain("Uses the default: pnpm install");
    expect(calls).toContainEqual({ tool: "project_settings_get", input: { machineId: "devbox", projectId: "p1", repo: "web" } });
  });

  it("shows two repos, each with the setup that applies to it", async () => {
    repos = [web, api];
    answers = [{ ...settings, setup: { ...settings.setup, commands: ["pnpm install"] } }];
    repoAnswers = {
      web: answers[0] as Settings,
      api: { ...settings, repo: "api", setup: { ...settings.setup, commands: ["go mod download", "make gen"] } },
    };
    await renderRepos();
    expect([...section().querySelectorAll('[role="listitem"]')].map((x) => x.getAttribute("aria-label"))).toEqual(["web", "api"]);
    expect(row("web")).toContain("Uses the default: pnpm install");
    const text = row("api");
    expect(text).toContain("team/api on gitlab.example.com");
    expect(text).toContain("Not known yet");
    // Its checkout isn't a listed project: shown by its id, on its machine.
    expect(text).toContain("p9 on devbox");
    expect(text).toContain("go mod download; make gen");
    expect(text).not.toContain("Uses the default");
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
