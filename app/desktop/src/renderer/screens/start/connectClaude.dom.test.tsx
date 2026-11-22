// @vitest-environment happy-dom
// Get started's Connect Claude in the whole app, on a fleetd cloud team in the web app with no computer: boat.dev is
// connected and the hub's runner waits for a Claude account. The Claude step's Subscription, then its button, opens
// Settings › Accounts over Get started
// (it used to change the address and leave the page as it was), the subscription's token is sealed to the runner, and
// once the runner is online Get started has Claude done too.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClaudeAccountsGetOutput, Machine, PersonClaude } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import type { ClaudeAccountRequest } from "../../../shared/ipc";
import { createHubSet } from "../../src/data/hubs";
import { HubsProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { resetServes } from "../admin/role";
import { Shell } from "../shell/Shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The page's bridge, there before the shell's modules read it.
const fake = vi.hoisted(() => {
  const listeners = new Set<(frame: unknown) => void>();
  const sealed: unknown[] = [];
  const answers: { of: (tool: string) => unknown } = { of: () => undefined };
  const done = () => Promise.resolve();
  vi.stubGlobal("fleetd", {
    shell: "web",
    platform: "linux",
    fixture: null,
    vibrancy: false,
    softwareCompositing: false,
    version: "test",
    app: {
      onMenuCommand: () => () => undefined,
      onOpen: () => () => undefined,
      notify: () => Promise.resolve(true),
      setBadge: done,
      setMenuState: done,
      presence: () => Promise.resolve(true),
      linkHandler: () => Promise.resolve({ packaged: false, handler: false }),
      logError: done,
    },
    updates: { state: () => new Promise(() => undefined), subscribe: () => () => undefined },
    hubs: { list: () => Promise.resolve([]), subscribe: () => () => undefined, update: () => Promise.resolve({ ok: true }) },
    hub: {
      subscribe: (_id: string, listener: (frame: unknown) => void) => (listeners.add(listener), () => listeners.delete(listener)),
      call: (_id: string, tool: string) => {
        const output = answers.of(tool);
        return Promise.resolve(output === undefined ? { ok: false, error: { code: "not_found", message: `${tool} isn't faked` } } : { ok: true, output });
      },
      chat: done,
      focus: done,
      watch: done,
      input: done,
      resync: done,
      retryNow: done,
      cache: { read: () => Promise.resolve(null), write: done },
      forget: done,
    },
    secret: {
      claudeAccount: (_hub: string, request: ClaudeAccountRequest) => {
        sealed.push(request);
        return Promise.resolve({ ok: true, output: { me, missingOn: [] } });
      },
    },
    cloud: {
      githubRepos: () => Promise.resolve({ ok: true, truncated: false, repos: [] }),
      connectGithub: () => Promise.resolve({ ok: true }),
    },
    openExternal: () => Promise.resolve({ ok: true }),
    pair: { store: () => Promise.resolve(null), probe: (hub: string) => Promise.resolve({ answers: false, hub }), start: () => new Promise(() => undefined) },
    system: { hostName: () => Promise.resolve("") },
  });
  return { listeners, sealed, answers };
});

const AT = "2026-11-18T00:00:00Z";
const sam = { personId: "p_aaaaaaaa", name: "Sam" };
const me: PersonClaude = {
  person: sam,
  mayUseHubApi: true,
  runsOn: { kind: "refused", message: "Connect your Claude to start this order.", fix: "Connect your subscription in Settings › Accounts › Claude." },
};
const accounts: ClaudeAccountsGetOutput = { settings: { membersUseHubApi: true }, leadsRunOn: { kind: "none" }, me, people: [] } as unknown as ClaudeAccountsGetOutput;

const runner = (status: "degraded" | "online"): Machine => ({
  machineId: "hosted",
  name: "Hosted sandboxes",
  status,
  lastSeenAt: AT,
  nodeVersion: "1.0.0",
  runner: true,
  boxPubKey: "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=",
  ...(status === "degraded" ? { degradedCause: "claude_login" as const, degradedReason: "agents in hosted sandboxes run on a Claude account, and none reaches them." } : {}),
});

const answer = (tool: string): unknown =>
  tool === "hub_info"
    ? { version: "0.9.0", protocol: 1, busy: [], admin: true, leftOut: ["setup_list", "setup_test"] }
    : tool === "sandbox_get"
      ? { boxPubKey: "AAAA", placing: true, providers: [{ provider: "boat", connected: true, limit: 5, check: { at: AT, ok: true } }] }
      : tool === "github_app_get"
        ? { authorizeUrl: "https://github.com/login/oauth/authorize" }
        : tool === "claude_accounts_get"
          ? accounts
          : tool === "orders_board"
            ? { orders: [] }
            : undefined;

fake.answers.of = answer;

const send = (frame: HubFrame) => {
  for (const l of fake.listeners) l(frame);
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetServes();
  fake.listeners.clear();
  fake.sealed.length = 0;
  window.localStorage.clear();
  window.location.hash = "#/start";
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
/** Waits for what the page shows: the shell's screens and Settings load as chunks of their own. */
const until = async (shown: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !shown(); i++) await act(() => new Promise((r) => setTimeout(r, 10)));
  if (!shown()) throw new Error(`never showed ${what}: ${document.body.textContent}`);
};
const snapshot = (cursor: number, machines: Machine[]): HubFrame => ({ t: "snapshot", snapshot: { cursor, attention: [], machines, projects: [] } }) as unknown as HubFrame;
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === name || b.getAttribute("aria-label") === name);
const click = async (name: string) => {
  const b = button(name);
  if (b === undefined) throw new Error(`no button ${name} in: ${document.body.textContent}`);
  await act(async () => {
    b.click();
    await Promise.resolve();
  });
  await settle();
};

it("a cloud team with only a hosted provider: Connect Claude opens Settings over Get started, and step 1 is done once the runner has the account", async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <HubsProvider hubs={createHubSet(window.fleetd, [{ id: "sam", label: "sam", cloud: true }])}>
        <UiProvider>
          <Shell />
        </UiProvider>
      </HubsProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    send({ t: "state", state: { phase: "live", hub: "https://sam.fleetd.dev", protocol: 1 } });
    send(snapshot(1, [runner("degraded")]));
    await new Promise((r) => setTimeout(r, 0));
  });
  await until(() => button("Subscription") !== undefined, "Get started's Claude step");
  expect(document.querySelector('[data-step="computer"]')?.textContent).toContain("fleetd's computers");
  await click("Subscription");
  await click("Connect Claude");
  expect(window.location.hash).toBe("#/settings/accounts");
  // The sheet is on show over Get started, Claude's row offering the subscription.
  await until(() => button("Connect subscription") !== undefined, "Settings › Accounts › Claude");
  expect(document.querySelector('[data-sheet="settings"]')).not.toBeNull();
  await click("Connect subscription");
  const field = document.querySelector<HTMLInputElement>("input[aria-label='Token']");
  if (field === null) throw new Error("no token field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "sk-ant-oat01-standin");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await click("Connect and test");
  // Sealed to the hub's runner, where the hosted agents run.
  expect(fake.sealed).toEqual([expect.objectContaining({ account: "mine", boxes: [expect.objectContaining({ machineId: "hosted" })] })]);

  // The runner's next check finds the account: online. Closing Settings is back on Get started, step 1 done.
  await act(async () => {
    send(snapshot(2, [runner("online")]));
    await new Promise((r) => setTimeout(r, 0));
  });
  await click("Close settings");
  expect(window.location.hash).toBe("#/start");
  await until(() => document.querySelector('[data-sheet="settings"]') === null, "Get started without the sheet");
  expect(document.querySelector("[data-screen^='start.']")?.getAttribute("data-screen")).toBe("start.github");
  expect(document.querySelector('[data-step="computer"]')?.textContent).toContain("fleetd's computers");
}, 20_000);
