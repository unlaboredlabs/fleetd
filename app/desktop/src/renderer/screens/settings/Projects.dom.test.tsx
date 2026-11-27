// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRepo, ProjectSettings as Settings, ProjectSummary } from "../../../shared/contracts";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import type { ProjectEnvRequest } from "../../../shared/ipc";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { Instructions } from "./Instructions";
import { ProjectSettings } from "./Projects";
import { sectionRead } from "./projectReads.test-util";
import { chooseFromAdd } from "./rowMenu.testing";
import { PROJECT_TOOLS } from "../projects/model";

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
  setup: { commands: [], inputs: [] },
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

const snapshotWith = (repos: ProjectRepo[], extra: Record<string, unknown> = {}): HubFrame => ({
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
        ...extra,
      },
      ...others,
    ],
  },
});
/** Other projects in the snapshot: a repo's checkout is a project of its own, as the hub lists it. */
let others: ProjectSummary[] = [];
/** The project the page opens for. */
let routeFor = "devbox/p1";

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
/** A project's approvals as its approvals read answers them, and what ran without asking. */
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
/** The approvals read fails this many more times. */
let approvalsFail: number;
/** The hub's app features: "vault" moves the variables into the project's Vault tab. */
let features: string[];
/** A frame from the hub, once rendered. */
let send: (frame: HubFrame) => void;
/** How long the hub takes over a call that ends the list above. */
let readMs: number;
/** What the snapshot adds to the project's summary. */
let summaryExtra: Record<string, unknown>;

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
  approvalsFail = 0;
  readMs = 0;
  summaryExtra = {};
  others = [];
  routeFor = "devbox/p1";
  features = [];
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
  vi.useRealTimers();
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
        return Promise.resolve(own ? { ok: true, output: { settings: own } } : { ok: false, error: { code: "not_found", message: `Bot p1 on devbox has no repo ${repo}.` } });
      }
      const now = (tool === "project_settings_get" && answers.length > 1 ? answers.shift() : answers[0]) ?? settings;
      if (tool === "mcp_servers_get") return Promise.resolve({ ok: true, output: { global: [], project: [] } });
      if (tool === "automation_list") return Promise.resolve({ ok: true, output: { automations: [], memoryRefresh: { on: true, at: "04:00", tz: "Europe/Berlin", lastRun: { at: AT, trigger: "schedule", state: "done", added: 2, replaced: 0, removed: 1 } } } });
      if (tool === "memory_refresh_run") return Promise.resolve({ ok: true, output: { memoryRefresh: { on: true, at: "04:00", tz: "Europe/Berlin" }, why: "Nothing new since the last refresh." } });
      if (tool === PROJECT_TOOLS.approvals && approvalsFail > 0) {
        approvalsFail -= 1;
        return Promise.resolve({ ok: false, error: { code: "not_found", message: `${PROJECT_TOOLS.approvals}: no approvals row for bot p1 on devbox` } });
      }
      if (tool === PROJECT_TOOLS.approvals) return Promise.resolve({ ok: true, output: { approvals, log: approvedLog } });
      if (tool === PROJECT_TOOLS.approvalsSet) {
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
        const { url, useExisting, copy } = input as { url?: string; useExisting?: boolean; copy?: boolean };
        if (url === "acme/shop" && useExisting !== true && copy !== true) {
          return Promise.resolve({
            ok: false,
            error: { code: "invalid", reason: "same_repo_there", message: "devbox already has a copy of acme/shop at /home/w/src/shop", fix: "Use the same copy, or make a separate one" },
          });
        }
        if (url === "acme/shop" && copy === true) return Promise.resolve({ ok: true, output: { path: "/home/w/src/shop-2", addId: "a2", separateFrom: "/home/w/src/shop" } });
        if (url === "acme/shop") return Promise.resolve({ ok: true, output: { path: "/home/w/src/shop", next: "shop is a repo of the bot now, at /home/w/src/shop on devbox." } });
        return Promise.resolve({
          ok: true,
          output: url ? { path: "/home/w/src/web", addId: "a1" } : { path: "/home/w/src/api", next: "api is a repo of the bot now, at /home/w/src/api on devbox." },
        });
      }
      if (tool === "project_image_rebuild") {
        const was = answers[0]?.image ?? { state: "none" };
        return Promise.resolve({ ok: true, output: { image: { builtAt: was.builtAt, bytes: was.bytes, state: "building", startedAt: AT } } });
      }
      if (tool === "project_repo_remove") {
        return Promise.resolve({ ok: true, output: { removed: api, cancelled: [], next: "Its checkout stays at /home/w/src/api on devbox, files and all." } });
      }
      const section = sectionRead(tool);
      if (section !== undefined) return Promise.resolve(section);
      const outcome: CallOutcome = { ok: true, output: tool === "project_settings_get" || tool === "project_settings_set" ? { settings: now } : { ok: true } };
      return readMs === 0 ? Promise.resolve(outcome) : new Promise((r) => setTimeout(() => r(outcome), readMs));
    },
    subscribe: (l) => ((listener = l), () => undefined),
    // As main's hub client: a resync asks for a snapshot, which comes on the same link.
    resync: () => {
      setTimeout(() => listener(snapshotWith(repos, summaryExtra)), 0);
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
            <ProjectSettings route={{ tab: "projects", prompt: null, for: routeFor }} />
          ) : (
            <Instructions route={{ tab: "instructions", prompt: null, for: "devbox/p1" }} />
          )}
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1, features } });
    listener(snapshotWith(repos, summaryExtra));
    await new Promise((r) => setTimeout(r, 0));
  });
  // project_settings_get's answer.
  await settle();
};


const button = (text: string) => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === text || x.getAttribute("aria-label") === text);
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

describe("Settings → Bots", () => {
  // W791 (fleetd cloud): a checkout's settings, reached by its id, offered Who merges for a repo that isn't a bot.
  it("opens the bot's settings for a repo checkout it holds, never the checkout's own page", async () => {
    repos = [web, api];
    others = [{ machineId: "devbox", projectId: "p9", title: "api", workspaceRoot: "/home/w/src/api", threads: { running: 0, waiting: 0, idle: 0, failed: 0 }, lastActivityAt: AT }];
    routeFor = "devbox/p9";
    window.location.hash = "#/settings/projects?for=devbox/p9";
    await render();
    for (let i = 0; i < 20 && !window.location.hash.endsWith("for=devbox/p1"); i++) await act(() => new Promise((r) => setTimeout(r, 5)));
    expect(window.location.hash).toBe("#/settings/projects?for=devbox/p1");
  });

  it("shows a secret by its fingerprint only, and no read-only Worktrees row", async () => {
    await render();
    const text = document.body.textContent;
    expect(text).toContain("https://staging.example");
    expect(text).toContain("secret · 5ec2e7a1");
    expect(text).not.toContain("2 there now");
    expect(document.querySelector('[aria-label="Worktrees"]')).toBeNull();
  });

  it("on a hub with a vault, says how many variables there are and opens the bot's Vault instead", async () => {
    features = ["vault"];
    await render();
    const env = document.querySelector<HTMLElement>("section[aria-label='Environment variables']");
    expect(env?.textContent).toContain("2 variables.");
    expect(document.body.textContent).not.toContain("secret · 5ec2e7a1");
    await click(button("Open Vault"));
    expect(window.location.hash).toBe("#/settings/project-vault?for=devbox/p1");
  });

  it("sends a new secret only through main's sealing, never as a hub call", async () => {
    await render();
    await chooseFromAdd("Add variable", "New variable…");
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

  it("shows the page at once while the hub's read is slow, each row it needs filling in its own place", async () => {
    // A hub asking GitHub for a bot's merge rules took 1-5 s over this read (W842).
    readMs = 300;
    features = ["vault"];
    repos = [web, api];
    repoAnswers = { api: { ...settings, projectId: "p9", repo: "api", setup: { commands: ["pnpm install"], inputs: [] } } };
    await render();
    const page = document.querySelector<HTMLElement>('[data-screen="settings.projects"]');
    if (page === null) throw new Error("no page");
    expect(page.textContent).not.toContain("Loading…");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Bot name"]')?.value).toBe("storefront");
    expect(page.textContent).toContain("/home/w/src/storefront");
    expect(page.textContent).toContain("acme/web");
    expect(page.textContent).toContain("kept in the bot's vault.…Open Vault");
    // Its own computer holds its place, off; Delete waits for the worktrees, and for the workspace to say this person
    // is an admin.
    const setups = [...document.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Setup commands"]')];
    expect(setups.map((t) => [t.disabled, t.value])).toEqual([
      [true, ""],
      [false, "pnpm install"],
    ]);
    expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Delete bot…")).toBe(false);
    const sections = [...page.querySelectorAll("section")].length;
    await act(async () => new Promise((r) => setTimeout(r, 400)));
    expect(page.textContent).toContain("2 variables.");
    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Setup commands"]')?.disabled).toBe(false);
    expect(button("Delete bot…").disabled).toBe(false);
    expect([...page.querySelectorAll("section")].length).toBe(sections);
    expect(document.querySelector('[data-screen="settings.projects"]')).toBe(page);
  });

  it("holds each computer at the height it last had, and the merge line it last showed, until the hub answers", async () => {
    readMs = 300;
    repos = [web];
    summaryExtra = { mergeMode: "verify_after" };
    const rule = { repo: "acme/web", base: "main", line: "acme/web's main requires branches to be up to date, so PRs still land one at a time.", canTurnOff: true };
    window.localStorage.setItem("fleetd.settings.kept", JSON.stringify({ "computer:devbox/p1/": 412, "upToDate:devbox/p1": rule }));
    answers = [{ ...settings, upToDate: [rule] }];
    await render();
    const page = document.querySelector<HTMLElement>('[data-screen="settings.projects"]');
    if (page === null) throw new Error("no page");
    const computer = [...page.querySelectorAll("section")].find((x) => x.getAttribute("aria-label") === "Computer");
    expect(computer?.parentElement?.style.minHeight).toBe("412px");
    expect(page.textContent).toContain("PRs still land one at a time");
    await act(async () => new Promise((r) => setTimeout(r, 400)));
    expect(computer?.parentElement?.style.minHeight ?? "").toBe("");
    expect(page.textContent).toContain("PRs still land one at a time");
    window.localStorage.removeItem("fleetd.settings.kept");
  });

  it("keeps the page on screen through the resync a saved setting brings, never Loading… or a remount", async () => {
    await render();
    const page = document.querySelector('[data-screen="settings.projects"]');
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Bot name"]');
    if (page === null || name === null) throw new Error("no page");
    answers = [{ ...settings, title: "shop" }];
    await type(name, "shop");
    await click(button("Rename"));
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
    expect(document.querySelector('input[aria-label="Bot name"]')).toBe(name);
    await act(async () => new Promise((r) => setTimeout(r, 100)));
    expect(document.querySelector('input[aria-label="Bot name"]')).toBe(name);
    expect(name.value).toBe("shop");
  });

  it("refreshes memory every night with no switch, and runs it now beside the bot's memory", async () => {
    await render();
    expect(document.body.textContent).not.toContain("Refresh now");
    act(() => root.unmount());
    root = createRoot(host);
    await render("instructions");
    const section = [...document.querySelectorAll<HTMLElement>("section")].find((x) => x.textContent.includes("Refresh now"));
    if (section === undefined) throw new Error("no memory refresh");
    expect(section.querySelector('[role="switch"]')).toBeNull();
    // Its hour and last run, and Run now, are here too: Automations no longer lists it.
    expect(section.textContent).toContain("Every night at 04:00 (Europe/Berlin) with chat or orders");
    expect(section.textContent).toContain("done, 2 added, 1 removed");
    await click(button("Run now"));
    expect(calls.find((c) => c.tool === "memory_refresh_run")?.input).toEqual({ projectRef: { machineId: "devbox", projectId: "p1" } });
    expect(document.body.textContent).toContain("Not run: Nothing new since the last refresh.");
    expect(calls.some((c) => c.tool === "project_settings_set")).toBe(false);
  });

  it("Runs on is one pick, each a real machine with its exact size; a pick that can't be had says why; none when nothing to pick", async () => {
    const boat = { kind: "boat", cpu: 4, memGb: 8 };
    answers = [
      {
        ...settings,
        computer: boat,
        computers: [
          { kind: "boat", cpu: 2, memGb: 4, label: "fleetd's computers · 2 vCPU / 4 GB" },
          { ...boat, label: "fleetd's computers · 4 vCPU / 8 GB", unavailable: "fleetd's computers aren't connected: an admin connects them in Settings › Workspace › Machines" },
        ],
      },
    ];
    await render();
    const row = document.querySelector<HTMLElement>('section[aria-label="Runs on"]');
    if (row === null) throw new Error("no Runs on row");
    expect(row.dataset.computer).toBe("boat:4:8");
    expect(row.querySelector('[role="combobox"]')?.textContent).toContain("fleetd's computers · 4 vCPU / 8 GB");
    // Its agents wait for it, and the row says why; no small/medium/large anywhere.
    expect(row.textContent).toContain("Its agents wait: fleetd's computers aren't connected: an admin connects them in Settings › Workspace › Machines.");
    expect(row.textContent).not.toMatch(/small|medium|large/i);
  });

  it("has no Runs on row when there is nothing to pick, or the hub doesn't say", async () => {
    answers = [{ ...settings, computers: [] }];
    await render();
    expect(document.querySelector('section[aria-label="Runs on"]')).toBeNull();
  });

  it("saves the setup, under the repos, in order, with its inputs, and no limit or start-anyway to pick", async () => {
    await render();
    // Computer is a section of its own, under Code's repos: its setup, and no image row while it has no commands.
    const section = document.querySelector<HTMLElement>('section[data-part="projects.computer"]');
    if (section === null) throw new Error("no computer section");
    expect(section.querySelector("h2")?.textContent).toBe("Computer");
    expect(section.querySelector("[data-image-state]")).toBeNull();
    expect(section.querySelector("input")).toBeNull();
    expect(section.querySelector('[role="switch"]')).toBeNull();
    expect(section.textContent).toContain("up to 10 minutes");
    expect(section.textContent).toContain("the agent starts anyway, told what failed");
    const [commands, inputs] = [...section.querySelectorAll("textarea")];
    if (commands === undefined || inputs === undefined) throw new Error("no setup fields");
    // Save shows once there is something to save.
    expect(() => button("Save setup")).toThrow();
    await type(commands, "pnpm install --frozen-lockfile\n\npnpm codegen\n");
    await type(inputs, "/etc/passwd");
    expect(button("Save setup").disabled).toBe(true);
    await type(inputs, "pnpm-lock.yaml");
    await click(button("Save setup"));
    await settle();
    expect(calls.find((c) => c.tool === "project_settings_set")?.input).toEqual({
      machineId: "devbox",
      projectId: "p1",
      setup: { commands: ["pnpm install --frozen-lockfile", "pnpm codegen"], inputs: ["pnpm-lock.yaml"] },
    });
    expect(section.textContent).toContain("Saved.");
  });

  it("shows the computer's image: a failed build with its log behind Log, the older one still built, and Rebuild", async () => {
    // The clock, held on a whole minute, as the page reads it.
    const NOW = Date.parse("2026-11-18T12:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const ago = (ms: number) => new Date(NOW - ms).toISOString();
    answers = [
      {
        ...settings,
        setup: { commands: ["pnpm install", "cargo fetch"], inputs: [] },
        image: { state: "failed", failedAt: ago(12 * 60_000), log: "$ cargo fetch\nerror: failed to fetch `https://index.crates.io/`", builtAt: ago(3 * 3_600_000), bytes: 1_181_116_006, where: "boat" },
      },
    ];
    await render();
    const row = () => {
      const el = document.querySelector<HTMLElement>('section[data-part="projects.computer"] [data-image-state]');
      if (el === null) throw new Error("no image row");
      return el;
    };
    expect(row().getAttribute("data-image-state")).toBe("failed");
    expect(row().textContent).toContain("Failed 12m ago · last built 3h ago");
    expect(row().textContent).toContain("Kept as a snapshot at fleetd's computers.");
    // Its log only behind Log.
    expect(row().querySelector("pre")).toBeNull();
    await click(button("Log"));
    expect(row().querySelector("pre")?.textContent).toContain("error: failed to fetch");
    await click(button("Hide log"));
    expect(row().querySelector("pre")).toBeNull();
    // Rebuild: the hub answers building, and the row says so with no Rebuild while it builds.
    await click(button("Rebuild"));
    await settle();
    expect(calls.find((c) => c.tool === "project_image_rebuild")?.input).toEqual({ machineId: "devbox", projectId: "p1" });
    expect(row().getAttribute("data-image-state")).toBe("building");
    expect(row().textContent).toContain("Building… · last built 3h ago");
    expect(() => button("Rebuild")).toThrow();
    expect(() => button("Log")).toThrow();
  });

  it("shows only the setup on a machine that builds no images: no image row, no Rebuild", async () => {
    answers = [{ ...settings, setup: { commands: ["pnpm install"], inputs: [] }, image: { state: "none" } }];
    await render();
    const section = document.querySelector<HTMLElement>('section[data-part="projects.computer"]');
    expect(section?.querySelector("textarea")?.value).toBe("pnpm install");
    expect(section?.querySelector("[data-image-state]")).toBeNull();
    expect(() => button("Rebuild")).toThrow();
  });

  it("deletes only once the name is typed, names the worktree with uncommitted changes, and removes the worktrees", async () => {
    repos = [web];
    await render();
    expect(document.body.textContent).toContain("Its checkout stays unless you tick it when you delete; its branches and pull requests stay either way.");
    await click(button("Delete bot…"));
    expect(dialog().textContent).toContain("fleetd/T1-cart");
    expect(dialog().textContent).not.toContain("fleetd/T2-tax");
    expect(dialog().textContent).toContain("storefront stops now, and everything fleetd keeps for it is erased from fleetd and devbox");
    expect(dialog().textContent).toContain("its branches and pull requests stay.");
    expect(dialog().textContent).toContain("Also delete its folder, ~/src/storefront");
    const confirm = button("Delete bot");
    expect(confirm.disabled).toBe(true);
    const field = dialog().querySelector("input");
    if (field === null) throw new Error("no confirm field");
    await type(field, "storefron");
    expect(button("Delete bot").disabled).toBe(true);
    await type(field, "storefront");
    expect(button("Delete bot").disabled).toBe(false);
    await click(button("Delete bot"));
    await settle();
    expect(calls.find((c) => c.tool === "project_remove")?.input).toEqual({ machineId: "devbox", projectId: "p1", removeWorktrees: true });
  });

  it("says a plain folder's delete keeps its folder unless ticked, with no branches or pull requests", async () => {
    // No repo of its own: a folder, not a git repo.
    const folder = "/home/w/.fleetd/node/projects/adri";
    answers = [{ ...settings, title: "Adri", workspaceRoot: folder, worktrees: { dir: "/home/w/.fleetd/node/worktrees/p1", worktrees: [] } }];
    await render();
    expect(document.body.textContent).toContain("Its folder stays unless you tick it when you delete.");
    await click(button("Delete bot…"));
    const text = dialog().textContent;
    expect(text).toContain("Delete Adri?");
    expect(text).toContain("Adri stops now, and everything fleetd keeps for it is erased");
    expect(text).not.toMatch(/branch|pull request|worktrees its agents/i);
    const field = dialog().querySelector("input");
    if (field === null) throw new Error("no confirm field");
    await type(field, "Adri");
    await click(button("Delete bot"));
    await settle();
    expect(calls.find((c) => c.tool === "project_remove")?.input).toEqual({ machineId: "devbox", projectId: "p1", removeWorktrees: true });
  });

  it("erases a bot with no repo as any other, saying what goes, and deletes its folder only when that is ticked", async () => {
    const folder = "/home/w/.fleetd/node/projects/adri";
    answers = [{ ...settings, title: "Adri", workspaceRoot: folder, worktrees: { dir: "/home/w/.fleetd/node/worktrees/p1", worktrees: [] } }];
    await render();
    await click(button("Delete bot…"));
    const text = dialog().textContent;
    expect(text).toContain("Delete Adri?");
    expect(text).toContain("Adri stops now, and everything fleetd keeps for it is erased from fleetd and devbox: its chat, memory, skills, approvals, purchases, automations and sign-ins");
    expect(text).toContain("Also delete its folder, ~/.fleetd/node/projects/adri");
    const field = dialog().querySelector("input");
    if (field === null) throw new Error("no confirm field");
    await type(field, "Adri");
    const tick = dialog().querySelector<HTMLElement>('[role="checkbox"]');
    if (tick === null) throw new Error("no folder tickbox");
    expect(tick.getAttribute("aria-checked")).toBe("false");
    await click(tick);
    await click(button("Delete bot"));
    await settle();
    expect(calls.find((c) => c.tool === "project_remove")?.input).toEqual({ machineId: "devbox", projectId: "p1", removeWorktrees: true, removeFolder: true });
  });

  it("offers no Forget sign-ins where its machine keeps none", async () => {
    answers = [{ ...settings, signinsKept: false }];
    await render();
    expect(document.body.textContent).toContain("None kept yet.");
    expect([...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Forget sign-ins…")).toBe(false);
  });

  it("forgets a bot's sign-ins after asking, a bot of code's too", async () => {
    repos = [web];
    answers = [{ ...settings, signinsKept: true }];
    await render();
    expect(document.body.textContent).toContain("stays signed in to the sites it signed into");
    await click(button("Forget sign-ins…"));
    expect(dialog().textContent).toContain("its browser profile is deleted from devbox");
    await click(button("Cancel"));
    expect(calls.some((c) => c.tool === PROJECT_TOOLS.signinsForget)).toBe(false);
    await click(button("Forget sign-ins…"));
    await click(button("Forget sign-ins"));
    await settle();
    expect(calls.find((c) => c.tool === PROJECT_TOOLS.signinsForget)?.input).toEqual({ machineId: "devbox", projectId: "p1" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain("Forgotten. Its next browser session starts signed out.");
  });

  it("opens a bot's skills on its Agents page, where the one list of them is", async () => {
    await render();
    await click(button("Open its skills"));
    expect(window.location.hash).toBe("#/settings/agents?for=devbox/p1");
  });

  it("sets a bot's approval mode and lists what ran without asking, each with its chat line", async () => {
    answers = [{ ...settings, title: "Adri", workspaceRoot: "/home/w/.fleetd/node/projects/adri", worktrees: { dir: "/home/w/.fleetd/node/worktrees/p1", worktrees: [] } }];
    await render();
    await settle();
    const part = document.querySelector('section[aria-label="Approvals"]');
    expect(part?.textContent).toContain("Checker decides");
    // The checker runs on the hub's default: no model or effort to pick here.
    expect(part?.querySelector('[aria-label="Checker model"]')).toBeNull();
    expect(part?.textContent).not.toContain("effort");
    expect(part?.textContent).toContain("It sees the action, never the mail or pages the lead read.");
    expect(part?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.closest("label")?.textContent).toContain("Checker decides");
    const log = document.querySelector('[role="list"][aria-label="Ran without asking"]');
    expect(log?.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    expect(log?.textContent).toContain("Checker: you asked to tell Sam that Saturday works");
    expect(log?.textContent).toContain("YOLO: nothing asks");
    const yoloChoice = [...(part?.querySelectorAll<HTMLElement>("label") ?? [])].find((l) => l.textContent.startsWith("YOLO"));
    // The row's hint says YOLO is what a new project starts in; the choice itself is only its name.
    expect(yoloChoice?.textContent).toBe("YOLO");
    expect(part?.querySelector("[data-hint]")?.textContent).toContain("Nothing asks, and each action shows in the log. A new bot starts in this mode.");
    const yolo = yoloChoice?.querySelector<HTMLElement>('[role="radio"]');
    if (!yolo) throw new Error("no YOLO choice");
    await click(yolo);
    await settle();
    expect(calls.find((c) => c.tool === PROJECT_TOOLS.approvalsSet)?.input).toEqual({ machineId: "devbox", projectId: "p1", mode: "yolo" });
  });

  it("says plainly when a bot's approvals can't be read, never the lookup's error, and tries again", async () => {
    approvalsFail = 1;
    answers = [{ ...settings, title: "Adri", workspaceRoot: "/home/w/.fleetd/node/projects/adri", worktrees: { dir: "/home/w/.fleetd/node/worktrees/p1", worktrees: [] } }];
    await render();
    await settle();
    const part = () => document.querySelector('section[aria-label="Approvals"]');
    expect(part()?.textContent).toContain("The approval settings couldn't be loaded.");
    expect(part()?.textContent).not.toContain(PROJECT_TOOLS.approvals);
    expect(part()?.textContent).not.toContain("p1");
    await click(button("Try again"));
    await settle();
    expect(part()?.textContent).toContain("Checker decides");
    expect(part()?.textContent).not.toContain("couldn't be loaded");
  });

  it("archives a bot, and brings an archived one back", async () => {
    await render();
    await click(button("Archive"));
    await settle();
    expect(calls.find((c) => c.tool === PROJECT_TOOLS.archive)?.input).toEqual({ machineId: "devbox", projectId: "p1", archived: true });
    const archived = snapshotWith(repos, summaryExtra);
    if (archived.t !== "snapshot") throw new Error("not a snapshot");
    await act(async () => {
      send({ ...archived, snapshot: { ...archived.snapshot, projects: archived.snapshot.projects.map((p) => ({ ...p, archivedAt: AT })) } });
      await Promise.resolve();
    });
    await settle();
    expect(document.querySelector('section[aria-label="Archive"]')?.textContent).toContain("Archived ");
    await click(button("Bring back"));
    await settle();
    expect(calls.filter((c) => c.tool === PROJECT_TOOLS.archive).at(-1)?.input).toEqual({ machineId: "devbox", projectId: "p1", archived: false });
  });

  it("keeps Delete off while the machine can't list the worktrees, and refuses when a fresh listing fails", async () => {
    const { worktrees: _, ...offline } = settings;
    answers = [{ ...offline, worktreesUnknown: "devbox is offline." }];
    await render();
    expect(button("Delete bot…").disabled).toBe(true);
    expect(document.body.textContent).toContain("devbox is offline.");
    act(() => root.unmount());
    root = createRoot(host);

    // Listed when the page loaded, gone by the time Delete is clicked: no dialog, and why.
    answers = [settings, { ...offline, worktreesUnknown: "devbox's node did not answer." }];
    await render();
    await click(button("Delete bot…"));
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain("devbox's node did not answer.");
    expect(calls.some((c) => c.tool === "project_remove")).toBe(false);
  });

  it("deletes a bot whose machine was removed: it is only forgotten in fleetd", async () => {
    const { worktrees: _, ...gone } = settings;
    answers = [{ ...gone, worktreesUnknown: "devbox was removed from this workspace." }];
    await render();
    // The hub's snapshot no longer lists devbox, only its project.
    const left = snapshotWith([]);
    await act(async () => {
      if (left.t === "snapshot") send({ ...left, snapshot: { ...left.snapshot, cursor: 2, machines: [] } });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(button("Delete bot…").disabled).toBe(false);
    expect(document.body.textContent).toContain("devbox was removed from this workspace, so no machine holds its files");
    expect(document.body.textContent).not.toContain("offline");
    await click(button("Delete bot…"));
    await settle();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Forget storefront?");
    await click(button("Forget bot"));
    await settle();
    expect(calls.filter((c) => c.tool === "project_remove").map((c) => c.input)).toEqual([{ machineId: "devbox", projectId: "p1" }]);
  });
});

describe("Settings → Bots → Repos", () => {
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
  /** Computer's own section, under Code. */
  const setupTitle = () => document.querySelector('section[data-part="projects.computer"] h2')?.textContent;
  const row = (name: string) => {
    const el = section().querySelector<HTMLElement>(`[role="listitem"][aria-label="${name}"]`);
    if (el === null) throw new Error(`no repo ${name}`);
    return el.textContent;
  };

  it("says a plain folder has no repo, in one line", async () => {
    await renderRepos();
    expect(section().textContent).toContain("No repo, a plain folder");
    expect(section().querySelector('[role="list"]')).toBeNull();
    expect(calls.some((c) => c.tool === "project_settings_get" && (c.input as { repo?: string }).repo !== undefined)).toBe(false);
  });

  it("shows one repo's remote, base and checkout, and its setup as the bot's", async () => {
    repos = [web];
    answers = [{ ...settings, setup: { ...settings.setup, commands: ["pnpm install"] } }];
    await renderRepos();
    const text = row("web");
    expect(text).toContain("acme/web");
    expect(text).not.toContain("github.com");
    expect(text).toContain("main");
    expect(text).toContain("/home/w/src/storefront on devbox");
    // The project's own directory's setup is the project's, shown once, below: the row doesn't repeat it.
    expect(text).not.toContain("pnpm install");
    expect(setupTitle()).toBe("Computer");
    expect(calls.some((c) => c.tool === "project_settings_get" && (c.input as { repo?: string }).repo !== undefined)).toBe(false);
  });

  it("shows two repos, each with a computer section of its own, and saves another repo's with its name", async () => {
    repos = [web, api];
    answers = [{ ...settings, setup: { ...settings.setup, commands: ["pnpm install"] } }];
    repoAnswers = {
      web: answers[0] as Settings,
      api: { ...settings, repo: "api", setup: { ...settings.setup, commands: ["go mod download", "make gen"] } },
    };
    await renderRepos();
    expect([...section().querySelectorAll('[role="listitem"]')].map((x) => x.getAttribute("aria-label"))).toEqual(["web", "api"]);
    expect(row("web")).not.toContain("pnpm install");
    const text = row("api");
    expect(text).toContain("team/api on gitlab.example.com");
    expect(text).toContain("Not known yet");
    // Its checkout isn't a listed project: shown by its id, on its machine.
    expect(text).toContain("p9 on devbox");
    expect(text).not.toContain("go mod download");
    // No default: the project's own directory's setup, then api's.
    expect(setupTitle()).toBe("Computer: web");
    expect(document.body.textContent).not.toContain("Default setup");
    const apiSetup = [...document.querySelectorAll<HTMLElement>("section")].find((x) => x.querySelector("h2")?.textContent === "Computer: api");
    if (apiSetup === undefined) throw new Error("no computer for api");
    const commands = apiSetup.querySelector("textarea");
    if (commands === null) throw new Error("no api commands");
    expect(commands.value).toBe("go mod download\nmake gen");
    await type(commands, "go mod download");
    await click(button("Save setup"));
    await settle();
    expect(calls.find((c) => c.tool === "project_settings_set")?.input).toEqual({
      machineId: "devbox",
      projectId: "p1",
      repo: "api",
      setup: { commands: ["go mod download"], inputs: [] },
    });
  });

  it("adds a repo by its path on the machine, or clones one from GitHub", async () => {
    await renderRepos();
    await click(button("Add a repo"));
    const field = section().querySelector<HTMLInputElement>('input[aria-label="Repo to add"]');
    const name = section().querySelector<HTMLInputElement>('input[aria-label="Repo name"]');
    if (field === null || name === null) throw new Error("no add form");
    expect(button("Add repo").disabled).toBe(true);
    await type(field, " /home/w/src/api ");
    await click(button("Add repo"));
    await settle();
    expect(calls).toContainEqual({ tool: "project_repo_add", input: { machineId: "devbox", projectId: "p1", path: "/home/w/src/api" } });
    expect(section().textContent).toContain("api is a repo of the bot now");
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

  it("offers to use a copy already there or make a separate one, never the hub's own words", async () => {
    await renderRepos();
    await click(button("Add a repo"));
    const field = section().querySelector<HTMLInputElement>('input[aria-label="Repo to add"]');
    if (field === null) throw new Error("no add form");
    await type(field, "acme/shop");
    await click(button("Add repo"));
    await settle();
    expect(section().textContent).toContain("There's already a copy at ~/src/shop.");
    expect(section().textContent).not.toMatch(/useExisting|copy\)|dest/u);
    expect(section().querySelector('[role="alert"]')).toBeNull();
    await click(button("Make a separate copy"));
    await settle();
    expect(calls).toContainEqual({ tool: "project_repo_add", input: { machineId: "devbox", projectId: "p1", url: "acme/shop", copy: true } });
    expect(section().textContent).toContain("Cloning a separate copy into /home/w/src/shop-2 on devbox");
    await type(field, "acme/shop");
    await click(button("Add repo"));
    await settle();
    await click(button("Use the same copy"));
    await settle();
    expect(calls).toContainEqual({ tool: "project_repo_add", input: { machineId: "devbox", projectId: "p1", url: "acme/shop", useExisting: true } });
    expect(section().textContent).toContain("shop is a repo of the bot now");
  });

  it("removes a repo once asked, never the bot's own directory", async () => {
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
