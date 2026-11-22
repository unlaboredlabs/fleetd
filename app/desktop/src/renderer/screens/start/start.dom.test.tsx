// @vitest-environment happy-dom
// Get started on a fleetd cloud team in the web app, from the team's own state: where a fresh team lands, each step as
// the hub's state moves it on (a computer, Tailscale's Connect or Skip, Claude's login or the hub's key with its
// endpoint, GitHub in one trip, a repository), GitHub's way back, a teammate's page, and that nothing of it shows on the
// desktop.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Machine, ProjectSummary, TailnetState } from "../../../shared/contracts";
import type { ClaudeAccountRequest } from "../../../shared/ipc";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { HubScope } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { resetServes } from "../admin/role";
import { FirstRun } from "../setup/FirstRun";
import { readKept, resetReturn, takeGithubReturn } from "./kept";
import { StartScreen } from "./StartScreen";
import { HOSTED_WAIT } from "../setup/hostedWait";
import { BILLING_SAMPLES } from "../../../shared/billing.samples";
import type { BillingState } from "../../../shared/billing";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let send: (frame: HubFrame) => void = () => undefined;
let calls: Array<{ tool: string; input: unknown }> = [];
/** While set, machine_join answers only once it resolves (a line still being made). */
let joinHeld: Promise<void> | null = null;
/** What the app sealed for the hub's key, and whether the hub has one since. */
let sealed: ClaudeAccountRequest[] = [];
let hubKey = false;
/** The team's billing as GET /billing/v1 answers: before the switch to fleetd's computers unless a test says. */
let billing: BillingState = BILLING_SAMPLES.off;

const machine = (over: Partial<Machine> = {}): Machine => ({
  machineId: "devbox",
  name: "devbox",
  status: "online",
  lastSeenAt: "2026-11-18T00:00:00Z",
  nodeVersion: "1.0.0",
  ...over,
});
const bot = (projectId: string, title: string): ProjectSummary =>
  ({
    machineId: "devbox",
    projectId,
    title,
    lastActivityAt: "2026-11-16T10:00:00Z",
    workspaceRoot: `/home/sam/src/${projectId}`,
    threads: {},
  }) as unknown as ProjectSummary;

interface Team {
  readonly machines?: Machine[];
  readonly projects?: ProjectSummary[];
  readonly admin?: boolean;
  readonly me?: { login: string; lapsed?: boolean };
  readonly installations?: number;
  /** The team's hosted providers as sandbox_get answers: connected ones and their last check. */
  readonly sandbox?: { provider: string; connected: boolean; ok?: boolean }[];
  /** The hub's Tailscale device; absent, a hub that serves none. */
  tailnet?: TailnetState;
}

const shell = {
  githubRepos: vi.fn(() =>
    Promise.resolve({
      ok: true as const,
      truncated: false,
      repos: [
        {
          owner: "sam-dev",
          name: "notes-api",
          fullName: "sam-dev/notes-api",
          private: true,
          pushedAt: "2026-11-18T09:00:00Z",
          cloneUrl: "https://github.com/sam-dev/notes-api.git",
        },
        {
          owner: "sam-dev",
          name: "website",
          fullName: "sam-dev/website",
          private: false,
          cloneUrl: "https://github.com/sam-dev/website.git",
        },
      ],
    }),
  ),
  connectGithub: vi.fn(() => Promise.resolve({ ok: true as const })),
  openExternal: vi.fn(() => Promise.resolve({ ok: true as const })),
  billing: vi.fn(() => Promise.resolve({ ok: true as const, billing })),
  startLater: vi.fn(() => Promise.resolve()),
};

const render = async (team: Team, at: "start" | "first-run" = "start") => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      const output =
        tool === "hub_info"
          ? {
              version: "0.9.0",
              protocol: 1,
              busy: [],
              admin: team.admin ?? true,
              leftOut: ["setup_list", "setup_test"],
            }
          : tool === "machine_join"
            ? {
                hubUrl: "https://sam.fleetd.dev",
                code: "fje_x",
                expiresAt: "2099-01-01T00:00:00Z",
                line: "curl -fsSL https://fleetd.sh | sh -s -- --join https://sam.fleetd.dev --code 7QK4-M2XD",
              }
            : tool === "github_app_get"
              ? {
                  authorizeUrl: "https://github.com/login/oauth/authorize",
                  app: {
                    appId: 1,
                    clientId: "Iv1",
                    createdAt: "2026-11-12T00:00:00Z",
                    htmlUrl: "",
                    name: "fleetd-cloud",
                    owner: "unlaboredlabs",
                    settingsUrl: "",
                    slug: "fleetd-cloud",
                    installations: Array.from({ length: team.installations ?? 0 }, (_, i) => ({
                      account: "sam-dev",
                      allRepositories: true,
                      installationId: i + 1,
                      repositoryCount: 2,
                    })),
                  },
                  ...(team.me === undefined
                    ? {}
                    : {
                        me: {
                          connectedAt: "2026-11-18T00:00:00Z",
                          userId: 7,
                          ...team.me,
                        },
                      }),
                }
              : tool === "sandbox_get"
                ? {
                    boxPubKey: "AAAA",
                    placing: true,
                    providers: (team.sandbox ?? [{ provider: "boat", connected: false }]).map((p) => ({
                      provider: p.provider,
                      connected: p.connected,
                      limit: p.connected ? 5 : 0,
                      ...(p.ok === undefined ? {} : { check: { at: "2026-11-18T00:00:00Z", ok: p.ok } }),
                    })),
                  }
              : tool === "machine_claude_login"
                ? (input as { code?: string }).code === undefined
                  ? {
                      machineId: "devbox",
                      loginUrl: "https://claude.ai/oauth/authorize?x=1",
                      message: "sign in",
                    }
                  : {
                      machineId: "devbox",
                      loggedIn: true,
                      message: "logged in",
                    }
                : tool === "claude_accounts_get"
                  ? { settings: { membersUseHubApi: true }, leadsRunOn: { kind: "machine_login" }, people: [], ...(hubKey ? { hubApi: { sealedOn: [], updatedAt: "2026-11-18T00:00:00Z" } } : {}) }
                  : tool === "tailnet_connect"
                    ? (team.tailnet = { status: "login", loginUrl: "https://login.tailscale.com/a/standin" })
                    : tool === "tailnet_get"
                      ? team.tailnet
                      : {};
      if (output === undefined) return Promise.resolve({ ok: false, error: { code: "not_found", message: `${tool} isn't served` } } as never);
      if (tool === "machine_join" && joinHeld !== null) return joinHeld.then(() => ({ ok: true, output }) as never);
      return Promise.resolve({ ok: true, output } as never);
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  const stop = layer.start();
  await act(async () => {
    root.render(
      <UiProvider>
        <HubScope hub={{ id: "sam", label: "sam", layer, cloud: true }}>{at === "start" ? <StartScreen sample={null} /> : <FirstRun onAddProject={() => undefined} />}</HubScope>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    send({
      t: "state",
      state: { phase: "live", hub: "https://sam.fleetd.dev", protocol: 1 },
    });
    send({
      t: "snapshot",
      snapshot: {
        cursor: 1,
        attention: [],
        machines: team.machines ?? [],
        projects: team.projects ?? [],
      },
    });
    await new Promise((r) => setTimeout(r, 0));
  });
  // Billing answers first (fleetd's computers or not), then the providers, then the join line step 1 asks the hub for.
  for (let i = 0; i < 4; i++) await settle();
  return stop;
};

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const screen = () => host.querySelector("[data-screen]")?.getAttribute("data-screen");
/** Waits for the screen the hub's answers lead to: the Tailscale and Claude reads come after the page. */
const until = async (shown: string) => {
  for (let i = 0; i < 100 && screen() !== shown; i++) await act(() => new Promise((r) => setTimeout(r, 10)));
  expect(screen()).toBe(shown);
};
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === name);
const click = async (name: string) => {
  const b = button(name);
  if (b === undefined) throw new Error(`no button ${name} in: ${host.textContent}`);
  await act(async () => {
    b.click();
    await Promise.resolve();
  });
  await settle();
};

beforeEach(() => {
  resetServes();
  resetReturn();
  joinHeld = null;
  sealed = [];
  hubKey = false;
  billing = BILLING_SAMPLES.off;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("fleetd", {
    shell: "web",
    platform: "linux",
    cloud: shell,
    openExternal: shell.openExternal,
    system: { hostName: () => Promise.resolve("") },
    secret: {
      claudeAccount: (_hub: string, request: ClaudeAccountRequest) => {
        sealed.push(request);
        hubKey = true;
        return Promise.resolve({ ok: true, output: { hubApi: { sealedOn: [], updatedAt: "2026-11-18T00:00:00Z" }, missingOn: [] } });
      },
    },
  });
  for (const f of Object.values(shell)) f.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("a fresh team's first run in the web app opens Get started, and Skip for now leaves it for the app", async () => {
  const stop = await render({}, "first-run");
  // With one team the hash names no hub (navigation.ts).
  expect(window.location.hash).toBe("#/start");
  stop();
  act(() => root.unmount());
  host.remove();
  window.localStorage.setItem("fleetd.start.sam", JSON.stringify({ later: true }));
  const again = await render({}, "first-run");
  expect(screen()).not.toBe("setup.machine");
  again();
});

it("a fresh team's first run opened at Settings (Stripe's way back to Billing) stays there, Get started behind it", async () => {
  window.history.replaceState(null, "", "/?billing=paid#/settings/hub/billing");
  const stop = await render({}, "first-run");
  expect(window.location.hash).toBe("#/settings/hub/billing");
  stop();
});

it("where agents run never asks a cloud team for a sandbox key of its own: before fleetd's computers, a computer's line alone", async () => {
  const stop = await render({});
  expect(host.textContent).toContain("Where agents run");
  expect(host.textContent).toContain("--code 7QK4-M2XD");
  expect(host.textContent).not.toContain("Hosted sandboxes");
  expect(host.querySelectorAll("[data-sandbox]").length).toBe(0);
  stop();
});

it("with fleetd's computers on, step 1 is done on them: no join line made, no provider asked, Claude next", async () => {
  billing = { ...BILLING_SAMPLES.plan, providedOn: true };
  const stop = await render({});
  expect(screen()).toBe("start.claude");
  expect(host.textContent).toContain("fleetd's computers");
  expect(host.textContent).not.toContain("--code 7QK4-M2XD");
  expect(calls.some((c) => c.tool === "machine_join" || c.tool === "sandbox_get")).toBe(false);
  stop();
});

it("fleetd's computers held for no plan: step 1 says so in Billing's words, and Pick a plan opens Billing", async () => {
  billing = BILLING_SAMPLES.none;
  const stop = await render({});
  expect(screen()).toBe("start.computer");
  expect(host.textContent).toContain("This team has no plan and no credits");
  expect(calls.some((c) => c.tool === "machine_join")).toBe(false);
  await click("Pick a plan");
  expect(window.location.hash).toBe("#/settings/hub/billing");
  stop();
});

it("a provider connected and no computer: step 1 is done on it, and Claude takes the hub's key or your subscription while its sandboxes have no account", async () => {
  const runner = machine({ machineId: "hosted", name: "Hosted sandboxes", runner: true, status: "degraded", degradedCause: "claude_login", degradedReason: "agents in hosted sandboxes run on a Claude account, and none reaches them." });
  const sandbox = [{ provider: "boat", connected: true, ok: true }];
  let stop = await render({ machines: [runner], sandbox });
  expect(screen()).toBe("start.claude");
  expect(host.querySelector('[data-step="computer"]')?.textContent).toContain("fleetd's computers");
  // The key first, Anthropic's endpoint prefilled; the subscription one click over.
  expect(host.querySelector<HTMLInputElement>("input[aria-label='Endpoint']")?.value).toBe("https://api.anthropic.com");
  await click("Subscription");
  expect(button("Connect Claude")).toBeDefined();
  expect(calls.some((c) => c.tool === "machine_join")).toBe(false);
  stop();
  act(() => root.unmount());
  host.remove();
  const { degradedReason: _was, degradedCause: _cause, ...online } = runner;
  stop = await render({ machines: [{ ...online, status: "online" }], sandbox });
  expect(screen()).toBe("start.github");
  expect(host.querySelector('[data-step="computer"]')?.textContent).toContain("fleetd's computers");
  stop();
}, 20_000);

it("a provider whose sandboxes don't get ready within the wait says why, the fix and Try again, which tests the key and waits again", async () => {
  const was = HOSTED_WAIT.ms;
  HOSTED_WAIT.ms = 50;
  try {
    const runner = machine({ machineId: "hosted", name: "Hosted sandboxes", runner: true, status: "degraded", degradedReason: "checking the node's runner" });
    const stop = await render({ machines: [runner], sandbox: [{ provider: "boat", connected: true, ok: true }] });
    expect(screen()).toBe("start.computer");
    expect(host.textContent).toContain("Getting fleetd's computers ready");
    await act(() => new Promise((r) => setTimeout(r, 120)));
    const step = host.querySelector('[data-step="computer"]');
    expect(step?.querySelector("[role=alert]")?.textContent).toBe("fleetd's computers didn't get ready.");
    expect(step?.textContent).toContain("If it keeps failing, check fleetd's computers in Settings › Team › Machines.");
    expect(step?.textContent).not.toContain("runner");
    expect(step?.textContent).not.toContain("Getting fleetd's computers ready");
    await click("Try again");
    expect(calls.some((c) => c.tool === "sandbox_test" && (c.input as { provider: string }).provider === "boat")).toBe(true);
    expect(host.textContent).toContain("Getting fleetd's computers ready");
    stop();
  } finally {
    HOSTED_WAIT.ms = was;
  }
}, 20_000);

it("with no computer, step 1 is open on the team's join line, ready to copy", async () => {
  const stop = await render({});
  expect(screen()).toBe("start.computer");
  expect(calls.some((c) => c.tool === "machine_join")).toBe(true);
  expect(host.textContent).toContain("--code 7QK4-M2XD");
  expect(host.textContent).toContain("Waiting for it to connect");
  stop();
});

it("a computer whose claude isn't logged in: Log in to Claude opens its page, and the code finishes it", async () => {
  const stop = await render({
    machines: [
      machine({
        status: "degraded",
        degradedReason: "claude is not logged in. Fix: run `claude` on this machine and log in",
      }),
    ],
  });
  // Step 1 is done on it; Claude is open on its own login.
  expect(screen()).toBe("start.claude");
  expect(host.querySelector('[data-step="computer"]')?.textContent).toContain("devbox");
  await click("Log in to Claude");
  expect(calls.find((c) => c.tool === "machine_claude_login")?.input).toEqual({
    machineId: "devbox",
  });
  expect(shell.openExternal).toHaveBeenCalledWith("https://claude.ai/oauth/authorize?x=1");
  const field = host.querySelector<HTMLInputElement>("input[aria-label='Code from Claude']");
  expect(field).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, " abc-123 ");
    field?.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await click("Log in");
  expect(calls.filter((c) => c.tool === "machine_claude_login").at(-1)?.input).toEqual({ machineId: "devbox", code: "abc-123" });
  expect(screen()).toBe("start.github");
  stop();
});

it("a line still being made when the computer joins makes no next one", async () => {
  let release: () => void = () => undefined;
  joinHeld = new Promise<void>((r) => (release = r));
  const stop = await render({});
  await act(async () => {
    send({ t: "snapshot", snapshot: { cursor: 2, attention: [], machines: [machine()], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  const timers = vi.spyOn(window, "setTimeout");
  await act(async () => {
    release();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(timers.mock.calls.filter(([, ms]) => (ms ?? 0) >= 5_000)).toHaveLength(0);
  expect(calls.filter((c) => c.tool === "machine_join")).toHaveLength(1);
  timers.mockRestore();
  stop();
});

it("a computer that joined and is offline now: step 1 says so and waits, never done", async () => {
  const stop = await render({ machines: [machine({ status: "offline" })] });
  expect(screen()).toBe("start.computer");
  expect(host.textContent).toContain("devbox is offline");
  expect(host.textContent).not.toContain("Waiting for it to connect");
  stop();
});

it("GitHub's way back to another screen (Settings) is cleaned from the address, and never Get started's to show", () => {
  window.history.replaceState(null, "", "/?github=failed&why=no#/settings/github");
  expect(takeGithubReturn()).toBeNull();
  expect(window.location.search).toBe("");
  expect(window.location.hash).toBe("#/settings/github");
});

it("a computer whose claude didn't open its page: the step says so, and the link opens it from the click", async () => {
  shell.openExternal.mockResolvedValueOnce({ ok: false, message: "The browser blocked the new tab." } as never);
  const stop = await render({ machines: [machine({ status: "degraded", degradedReason: "claude is not logged in." })] });
  await click("Log in to Claude");
  expect(host.textContent).toContain("The browser didn't open Claude's sign-in page");
  await click("Open the sign-in page");
  expect(shell.openExternal).toHaveBeenLastCalledWith("https://claude.ai/oauth/authorize?x=1");
  expect(host.textContent).toContain("Sign in on the page that opened");
  stop();
});

it("a computer that joined but can't run agents for another reason: it says so, in the hub's words with their fix", async () => {
  const stop = await render({ machines: [machine({ status: "degraded", degradedReason: "claude is not installed (claude not found). Fix: install Claude Code on devbox." })] });
  expect(screen()).toBe("start.computer");
  expect(host.textContent).toContain("devbox is connected");
  expect(host.textContent).toContain("claude is not installed (claude not found). Fix: install Claude Code on devbox.");
  expect(host.textContent).not.toContain("Waiting for it to connect");
  expect(host.textContent).not.toContain("Making a line");
  stop();
});

it("Connect GitHub sends this tab on GitHub's one trip, back to this page; Skip goes on to an empty bot", async () => {
  const stop = await render({ machines: [machine()] });
  expect(screen()).toBe("start.github");
  await click("Connect GitHub");
  expect(shell.connectGithub).toHaveBeenCalledWith("sam", {
    back: "/#/start?at=sam",
  });
  expect(button("Opening GitHub…")).toBeDefined();
  stop();
  act(() => root.unmount());
  host.remove();
  const again = await render({ machines: [machine()] });
  await click("Skip");
  expect(readKept("sam").github).toBe("skipped");
  expect(screen()).toBe("start.project");
  expect(host.textContent).toContain("Empty bot");
  expect(shell.githubRepos).not.toHaveBeenCalled();
  again();
});

it("GitHub's way back: a failure says why on the step, and the address loses GitHub's words", async () => {
  window.history.replaceState(null, "", "/?github=failed&why=GitHub%20said%20no#/start?at=sam");
  const stop = await render({ machines: [machine()] });
  expect(host.querySelector("[role=alert]")?.textContent).toBe("GitHub said no");
  expect(window.location.search).toBe("");
  expect(window.location.hash).toBe("#/start?at=sam");
  stop();
});

it("connected and installed: the repositories, newest first, and one starts a bot on the computer", async () => {
  const stop = await render({
    machines: [machine()],
    me: { login: "sam-dev" },
    installations: 1,
  });
  expect(screen()).toBe("start.project");
  expect(host.textContent).toContain("sam-dev");
  expect(shell.githubRepos).toHaveBeenCalledWith("sam");
  const rows = [...host.querySelectorAll("li button")].map((b) => b.textContent);
  expect(rows[0]).toContain("notes-api");
  expect(rows[1]).toContain("website");
  expect(host.textContent).not.toContain("Only your most recently pushed repositories");
  await act(async () => {
    [...host.querySelectorAll<HTMLButtonElement>("li button")][0]?.click();
    await Promise.resolve();
  });
  await settle();
  // New bot's own flow: the bot named from the repository on the computer, then its clone; the page waits meanwhile.
  expect(calls.find((c) => c.tool === "project_add")?.input).toMatchObject({
    machineId: "devbox",
    title: "notes-api",
  });
  stop();
});

it("a list the cloud cut short says so", async () => {
  shell.githubRepos.mockResolvedValueOnce({ ok: true, truncated: true, repos: [{ owner: "sam-dev", name: "notes-api", fullName: "sam-dev/notes-api", private: true, cloneUrl: "x" }] } as never);
  const stop = await render({ machines: [machine()], me: { login: "sam-dev" }, installations: 1 });
  expect(host.textContent).toContain("Only your most recently pushed repositories are listed");
  stop();
});

it("connected but the App reaches nothing: the line says so, and Choose repositories goes back to GitHub's install page", async () => {
  shell.githubRepos.mockResolvedValueOnce({
    ok: false,
    none: true,
    failure: { code: "not_found", message: "No installation." },
  } as never);
  const stop = await render({
    machines: [machine()],
    me: { login: "sam-dev" },
    installations: 1,
  });
  expect(host.textContent).toContain("reaches no repositories yet");
  await click("Choose repositories");
  expect(shell.connectGithub).toHaveBeenCalledWith("sam", {
    back: "/#/start?at=sam",
    install: true,
  });
  stop();
});

it("a teammate's page: the team's bots first, their own GitHub one row under them", async () => {
  const stop = await render({
    admin: false,
    machines: [machine()],
    projects: [bot("web", "website"), bot("bill", "billing")],
  });
  expect(host.querySelector("h1")?.textContent).toBe("Welcome to sam");
  const names = [...host.querySelectorAll("li button")].map((b) => b.textContent);
  expect(names[0]).toContain("billing");
  expect(names[1]).toContain("website");
  expect(button("Connect")).toBeDefined();
  expect(button("Skip for now")).toBeDefined();
  await act(async () => {
    [...host.querySelectorAll<HTMLButtonElement>("li button")][0]?.click();
    await Promise.resolve();
  });
  expect(window.location.hash).toContain("devbox");
  expect(window.location.hash).toContain("bill");
  stop();
});

it("Skip for now is kept in this browser and with the person, for their other devices", async () => {
  const stop = await render({});
  await click("Skip for now");
  expect(readKept("sam").later).toBe(true);
  expect(shell.startLater).toHaveBeenCalledWith("sam");
  stop();
});

it("never on the desktop: the page goes home", async () => {
  vi.stubGlobal("fleetd", {
    shell: "desktop",
    platform: "linux",
    cloud: shell,
    openExternal: shell.openExternal,
    system: { hostName: () => Promise.resolve("") },
  });
  window.location.hash = "#/start?at=sam";
  const stop = await render({});
  expect(host.querySelector("[data-screen^='start.']")).toBeNull();
  expect(window.location.hash).not.toContain("start");
  stop();
});

it("Tailscale, right before Claude: Connect opens Tailscale's sign-in, and Skip goes on and never asks again", async () => {
  const stop = await render({ machines: [machine()], tailnet: { status: "off" } });
  await until("start.tailscale");
  expect([...host.querySelectorAll("[data-step]")].map((s) => s.getAttribute("data-step"))).toEqual(["computer", "tailscale", "claude", "github", "project"]);
  await click("Connect Tailscale");
  expect(calls.filter((c) => c.tool === "tailnet_connect")).toHaveLength(1);
  expect(shell.openExternal).toHaveBeenCalledWith("https://login.tailscale.com/a/standin");
  expect(host.textContent).toContain("Waiting for you to sign in to Tailscale");
  // Skip, even half way through the sign-in, goes on: devbox's claude is logged in, so Claude is done and GitHub is
  // next. The step keeps a quiet Connect.
  await click("Skip");
  expect(readKept("sam").tailscale).toBe("skipped");
  expect(screen()).toBe("start.github");
  expect(host.querySelector('[data-step="tailscale"]')?.textContent).toContain("Connect");
  stop();
});

it("a hub with no Tailscale device leaves the step out", async () => {
  const stop = await render({ machines: [machine()] });
  expect(host.querySelector('[data-step="tailscale"]')).toBeNull();
  expect(screen()).toBe("start.github");
  stop();
});

it("the hub's key with a tailnet endpoint: says so while Tailscale is off, with Connect, then seals the key with the endpoint", async () => {
  window.localStorage.setItem("fleetd.start.sam", JSON.stringify({ tailscale: "skipped" }));
  const runner = machine({ machineId: "hosted", name: "Hosted sandboxes", runner: true, status: "degraded", degradedCause: "claude_login", degradedReason: "agents in hosted sandboxes run on a Claude account, and none reaches them.", boxPubKey: "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=" });
  const sandbox = [{ provider: "boat", connected: true, ok: true }];
  const stop = await render({ machines: [runner], sandbox, tailnet: { status: "off" } });
  await until("start.claude");
  const type = async (label: string, value: string) => {
    const field = host.querySelector<HTMLInputElement>(`input[aria-label='${label}']`);
    if (field === null) throw new Error(`no field ${label}`);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
  };
  // Saved with nothing pasted: it says what to paste.
  await click("Save");
  expect(host.querySelector("[role=alert]")?.textContent).toBe("Paste the API key from the Claude Console.");
  await type("Endpoint", "http://100.104.249.49:8317");
  expect(host.querySelector("[data-tailnet-hint]")?.textContent).toContain("This endpoint is on your tailnet. Hosted agents reach it once Tailscale is connected.");
  await click("Connect Tailscale");
  expect(calls.filter((c) => c.tool === "tailnet_connect")).toHaveLength(1);
  // Signing in reopens Tailscale's step, where the sign-in page is a click away.
  expect(screen()).toBe("start.tailscale");
  stop();
  act(() => root.unmount());
  host.remove();
  const again = await render({ machines: [runner], sandbox, tailnet: { status: "connected", tailnet: "sam-dev.github" } });
  await until("start.claude");
  await type("Endpoint", "http://100.104.249.49:8317/");
  expect(host.querySelector("[data-tailnet-hint]")).toBeNull();
  await type("API key", "sk-ant-api03-standin");
  await click("Save");
  expect(sealed).toEqual([
    { account: "hub_api", key: "sk-ant-api03-standin", endpoint: "http://100.104.249.49:8317", boxes: [{ machineId: "hosted", boxPubKey: "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=" }] },
  ]);
  // The hub has the key: Claude is done with it, GitHub is next.
  await settle();
  expect(host.querySelector('[data-step="claude"]')?.textContent).toContain("API key");
  expect(screen()).toBe("start.github");
  again();
}, 20_000);
