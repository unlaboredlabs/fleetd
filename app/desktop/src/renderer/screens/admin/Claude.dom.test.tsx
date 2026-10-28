// @vitest-environment happy-dom
// Settings › Hub accounts › Claude: the hub's key pasted goes to main to seal with its endpoint and is tested at once, never
// shown back; the members switch; what leads run on and the owner's subscription they fall back to; each person's
// account, with a usage pause on one and their GitHub, on their People row; and a member who follows the link sees
// none of it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClaudeAccountsGetOutput, HubInfoOutput, PeopleListOutput, Person, PersonClaude, UsageStatusOutput } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import type { ClaudeAccountRequest } from "../../../shared/ipc";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { SettingsScreen } from "../settings/SettingsScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-27T10:00:00.000Z";
const BOX = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";
const KEY = "sk-ant-api03-devbox-key";
const person = (personId: string, name: string, role: Person["role"]): Person => ({ personId, name, role, createdAt: AT });
const sam = person("p_aaaaaaaa", "Sam Rivera", "owner");
const alice = person("p_bbbbbbbb", "Alice Chen", "admin");
const bob = person("p_cccccccc", "Bob Okafor", "member");
const ref = (p: Person) => ({ personId: p.personId, name: p.name });
const sealedOn = [
  { machineId: "buildbox", fingerprint: "ab12cd34" },
  { machineId: "devbox", fingerprint: "ab12cd34" },
];
const own = (p: Person): PersonClaude => ({
  person: ref(p),
  mayUseHubApi: true,
  subscription: { sealedOn, connectedAt: AT },
  runsOn: { kind: "account", account: { kind: "person", personId: p.personId } },
});
const people: PeopleListOutput = { people: [sam, alice, bob], devices: [], invites: [], me: sam.personId };
const withKey: ClaudeAccountsGetOutput = {
  hubApi: { endpoint: "https://gateway.devbox.example", sealedOn: sealedOn.slice(1), updatedAt: AT, lastTest: { at: AT, machineId: "devbox", ok: true } },
  settings: { membersUseHubApi: true },
  leadsRunOn: { kind: "account", account: { kind: "hub" } },
  people: [own(sam), { person: ref(alice), mayUseHubApi: true, runsOn: { kind: "account", account: { kind: "hub" } } }, own(bob)],
};
const noKey: ClaudeAccountsGetOutput = {
  settings: { membersUseHubApi: true },
  leadsRunOn: { kind: "machine_login" },
  people: [{ person: ref(sam), mayUseHubApi: false, runsOn: { kind: "refused", message: "Connect your Claude to start this order.", fix: "Open Settings › Connections › Claude." } }],
};
const usage: UsageStatusOutput = {
  machines: [
    {
      machineId: "devbox",
      login: "subscription",
      breaker: { state: "closed" },
      parked: { leads: 0, tasks: 0 },
      accounts: [{ account: { kind: "person", personId: bob.personId }, breaker: { state: "open", until: "2026-10-27T15:00:00.000Z", message: "Usage limit reached." }, parked: { leads: 0, tasks: 2 } }],
      lastEvents: [],
    },
  ],
};

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let sealed: ClaudeAccountRequest[];

beforeEach(() => {
  calls = [];
  sealed = [];
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    openExternal: () => Promise.resolve({ ok: true }),
    secret: {
      claudeAccount: (_hub: string, request: ClaudeAccountRequest) => {
        sealed.push(request);
        return Promise.resolve({ ok: true, output: { hubApi: withKey.hubApi, missingOn: ["buildbox"] } });
      },
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  window.location.hash = "#/settings/hub/accounts";
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const render = async (accounts: ClaudeAccountsGetOutput, info: Partial<HubInfoOutput> = { me: sam, admin: true }) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      const output =
        tool === "hub_info"
          ? { version: "0.0.0", protocol: 1, busy: [], ...info }
          : tool === "claude_accounts_get"
            ? accounts
            : tool === "people_list"
              ? people
              : tool === "usage_status"
                ? usage
                : tool === "github_app_get"
                  ? {
                      app: { appId: 1, clientId: "Iv1.abc", createdAt: AT, htmlUrl: "https://github.com/apps/fleetd-devbox", name: "fleetd on devbox", slug: "fleetd-devbox", owner: "acme" },
                      permissions: [],
                      authorizeUrl: "https://github.com/login/oauth/authorize",
                      people: [
                        { person: { personId: sam.personId, name: sam.name }, account: { login: "sam-rivera", userId: 1, connectedAt: AT } },
                        { person: { personId: "p_bbbbbbbb", name: "Alice Chen" } },
                      ],
                    }
                : tool === "claude_account_test"
                  ? { test: { at: AT, machineId: "devbox", ok: true } }
                  : tool === "claude_settings_set"
                    ? { settings: { membersUseHubApi: false } }
                    : undefined;
      // Connections' other parts (GitHub, Google) find a hub without them.
      return Promise.resolve(output === undefined ? { ok: false, error: { code: "not_found", message: `${tool} isn't faked` } } : { ok: true, output });
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
          <SettingsScreen />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4790", protocol: 1 } });
    listener({
      t: "snapshot",
      snapshot: {
        cursor: 1,
        attention: [],
        projects: [],
        machines: [
          { machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [], boxPubKey: BOX },
          { machineId: "buildbox", name: "buildbox", nodeVersion: "1", status: "offline", lastSeenAt: AT, tags: [], boxPubKey: BOX },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let i = 0; i < 4; i++) await settle();
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
  await settle();
};
const type = async (label: string, value: string) => {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label='${label}']`);
  if (input === null) throw new Error(`no input ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};
const sent = (tool: string) => calls.filter((c) => c.tool === tool).map((c) => c.input);
const section = (label: string) => {
  const el = host.querySelector<HTMLElement>(`section[aria-label='${label}']`);
  if (el === null) throw new Error(`no section ${label}`);
  return el;
};

it("saves the hub's key and endpoint sealed through main, tests it at once, and never shows it back", async () => {
  await render(noKey);
  expect(host.querySelector("[data-screen='settings.hub.accounts']")).not.toBeNull();
  expect(section("Leads and unrequested work").textContent).toContain("Each machine's own Claude login.");
  expect(section("Leads and unrequested work").textContent).toContain("The hub owner's subscription (yours) isn't connected.");
  await type("API key", KEY);
  await type("Endpoint", "https://gateway.devbox.example");
  await click(button("Save and test"));
  expect(sealed).toEqual([
    {
      account: "hub_api",
      key: KEY,
      endpoint: "https://gateway.devbox.example",
      boxes: [
        { machineId: "buildbox", boxPubKey: BOX },
        { machineId: "devbox", boxPubKey: BOX },
      ],
    },
  ]);
  expect(sent("claude_account_test")).toEqual([{ account: "hub_api" }]);
  expect(host.textContent).not.toContain(KEY);
});

it("shows where the key is, the members switch and the owner's subscription; each person's account, with a pause and their GitHub, on People", async () => {
  await render(withKey);
  const key = section("Hub API key");
  expect(key.textContent).toContain("Saved. Sealed on devbox. Through https://gateway.devbox.example.");
  expect(key.textContent).toContain("Not on buildbox: nothing runs on it there.");
  expect(key.textContent).toContain("Worked on devbox");
  expect(section("Leads and unrequested work").textContent).toContain("The hub's API key.");
  expect(section("Leads and unrequested work").textContent).toContain("The hub owner's subscription (yours) is connected. Sealed on buildbox and devbox.");
  // Everyone's account is on People now.
  expect(host.querySelector("[role='list'][aria-label='Claude accounts']")).toBeNull();
  const toggle = section("Members").querySelector<HTMLElement>("[role='switch']");
  if (toggle === null) throw new Error("no switch");
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await click(toggle);
  expect(sent("claude_settings_set")).toEqual([{ membersUseHubApi: false }]);

  await act(async () => {
    window.location.hash = "#/settings/hub/people";
    await Promise.resolve();
  });
  for (let i = 0; i < 4; i++) await settle();
  const line = (name: string) => host.querySelector<HTMLElement>(`[role='listitem'][aria-label='${name}'] [data-accounts]`)?.parentElement?.textContent ?? "";
  expect(line("Sam Rivera")).toContain("Claude: Own subscription · GitHub: sam-rivera");
  expect(line("Sam Rivera")).not.toContain("Paused");
  expect(line("Alice Chen")).toContain("Claude: Hub API key · GitHub: not connected");
  expect(line("Bob Okafor")).toContain("Claude: Own subscription");
  expect(line("Bob Okafor")).toContain("Paused on devbox until");
});

it("changes the endpoint alone, keeping the saved key, and removes the key once confirmed", async () => {
  await render(withKey);
  await click(button("Change"));
  await type("Endpoint", "https://gateway.devbox.example/v2");
  await click(button("Save and test"));
  expect(sealed).toEqual([{ account: "hub_api", endpoint: "https://gateway.devbox.example/v2", boxes: expect.any(Array) as unknown }]);
  await click(button("Remove"));
  const confirm = [...document.querySelectorAll("[role='dialog'] button")].find((b) => b.textContent.trim() === "Remove");
  if (!(confirm instanceof HTMLElement)) throw new Error("no confirm");
  await click(confirm);
  expect(sent("claude_hub_api_remove")).toEqual([{}]);
});

it("shows a member who follows the link none of it, and reads nothing", async () => {
  await render(withKey, { me: bob, admin: false });
  expect(host.querySelector("[data-screen='settings.hub.denied']")).not.toBeNull();
  expect(sent("claude_accounts_get")).toEqual([]);
});
