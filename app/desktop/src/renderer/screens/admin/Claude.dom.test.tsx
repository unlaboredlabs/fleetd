// @vitest-environment happy-dom
// Settings › Hub › Setup › Claude: the hub's key pasted goes to main to seal with its endpoint and is tested at once,
// never shown back; the members switch; what leads run on and the owner's subscription they fall back to; each
// person's account, with a usage pause on one and their GitHub, on their People row; and a member who follows the
// link sees none of it. The hub here serves no setup steps (an older one): Setup still lists Claude, and its row, a
// search for one of its options and the old Hub accounts link all reach these controls.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClaudeAccountsGetOutput, HubInfoOutput, PeopleListOutput, Person, PersonClaude, TailnetState, UsageStatusOutput } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import type { ClaudeAccountRequest } from "../../../shared/ipc";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider, HubScope, useDataLayer } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { revealNext } from "../settings/reveal";
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
let testWorks: boolean;
/** The hub's Tailscale: none served unless a test sets it. */
let tailnet: TailnetState | undefined;
let opened: string[];

beforeEach(() => {
  calls = [];
  sealed = [];
  testWorks = true;
  tailnet = undefined;
  opened = [];
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    openExternal: (url: string) => (opened.push(url), Promise.resolve({ ok: true })),
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
  // As a search for the hub's API key, or the Claude step's button in the first run, opens it.
  window.location.hash = "#/settings/hub/setup";
  revealNext("admin.claude");
});
afterEach(() => {
  revealNext(null);
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** The page on a fleetd cloud team, as the web app has it. */
function OnCloud() {
  const layer = useDataLayer();
  return (
    <HubScope hub={{ id: layer.hub, label: "acme", layer, cloud: true }}>
      <SettingsScreen />
    </HubScope>
  );
}

/** `cloud`: a fleetd cloud team with no machine yet, so nothing takes a key. */
const render = async (accounts: ClaudeAccountsGetOutput, info: Partial<HubInfoOutput> = { me: sam, admin: true }, cloud = false) => {
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
                  ? { test: testWorks ? { at: AT, machineId: "devbox", ok: true } : { at: AT, machineId: "devbox", ok: false, error: "the gateway refused it" } }
                  : tool === "claude_settings_set"
                    ? { settings: { membersUseHubApi: false } }
                    : tool === "tailnet_get"
                      ? tailnet
                      : tool === "tailnet_connect" && tailnet !== undefined
                        ? (tailnet = { status: "login", loginUrl: "https://login.tailscale.com/a/standin" })
                        : undefined;
      // Connections' other parts (GitHub) find a hub without them.
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
        <DataProvider layer={createDataLayer(hub)}>{cloud ? <OnCloud /> : <SettingsScreen />}</DataProvider>
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
        machines: cloud
          ? []
          : [
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
const eye = (label: string) => {
  const b = host.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`);
  if (b === null) throw new Error(`no button ${label}`);
  return b;
};
const sent = (tool: string) => calls.filter((c) => c.tool === tool).map((c) => c.input);
const section = (label: string) => {
  const el = host.querySelector<HTMLElement>(`section[aria-label="${label}"]`);
  if (el === null) throw new Error(`no section ${label}`);
  return el;
};

it("saves the hub's key and endpoint sealed through main, tests it at once, and never shows it back", async () => {
  await render(noKey);
  // Claude's own page of Setup, the way back to the list in its place.
  expect(host.querySelector("[data-screen='settings.hub.setup.step'] [data-part='admin.claude']")).not.toBeNull();
  expect(host.querySelector("[data-screen='settings.hub.setup']")).toBeNull();
  // What leads run on is one line under the key, with the owner's subscription they fall back to.
  expect(section("Workspace API key").textContent).toContain("Leads and automations run on the workspace's key, once it has one, else your subscription.");
  expect(section("Workspace API key").textContent).toContain("The workspace owner's subscription (yours) isn't connected.");
  expect(host.querySelector("section[aria-label='Leads and unrequested work']")).toBeNull();
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

it("masks the key while it's typed or pasted, with an eye to show it", async () => {
  await render(noKey);
  const field = host.querySelector<HTMLInputElement>("input[aria-label='API key']");
  if (field === null) throw new Error("no API key field");
  // A password field, so neither the page, a recording nor a browser's text of it shows the key.
  expect(field.type).toBe("password");
  await type("API key", KEY);
  expect(field.value).toBe(KEY);
  await click(eye("Show API key"));
  expect(field.type).toBe("text");
  await click(eye("Hide API key"));
  expect(field.type).toBe("password");
  await click(button("Save and test"));
  expect(sealed.map((r) => (r.account === "hub_api" ? r.key : undefined))).toEqual([KEY]);
});

it("speaks of the team on a fleetd cloud team, and says plainly when it can't take a key yet", async () => {
  await render(noKey, { me: sam, admin: true }, true);
  const key = section("Workspace API key");
  expect(key.textContent).toContain("Leads and automations run on the workspace's key, once it has one, else your subscription.");
  expect(key.textContent).toContain("The workspace owner's subscription (yours) isn't connected.");
  expect(host.textContent).toContain("Members may use the workspace's API key");
  expect(host.textContent).not.toMatch(/the hub|Hub API key|hub owner/u);
  expect(host.querySelector<HTMLInputElement>("input[aria-label='API key']")?.type).toBe("password");
  await type("API key", KEY);
  await click(button("Save and test"));
  expect(sealed).toEqual([]);
  expect(host.textContent).toContain("This workspace can't take a key yet: its computers aren't ready. Try again in a few minutes.");
  expect(host.textContent).not.toContain("box key");
});

it("shows where the key is, the members switch and the owner's subscription; each person's account, with a pause and their GitHub, on People", async () => {
  await render(withKey);
  const key = section("Workspace API key");
  expect(key.textContent).toContain("Sealed on devbox. Through https://gateway.devbox.example.");
  expect(key.textContent).toContain("Not on buildbox: nothing runs on it there.");
  expect(key.textContent).toContain("Worked on devbox");
  expect(key.textContent).toContain("Leads and automations run on this key, else your subscription.");
  expect(key.textContent).not.toContain("The workspace owner's subscription");
  // Everyone's account is on People now.
  expect(host.querySelector("[role='list'][aria-label='Claude accounts']")).toBeNull();
  const toggle = section("Members may use the workspace's API key").querySelector<HTMLElement>("[role='switch']");
  if (toggle === null) throw new Error("no switch");
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await click(toggle);
  expect(sent("claude_settings_set")).toEqual([{ membersUseHubApi: false }]);

  await act(async () => {
    window.location.hash = "#/settings/hub/people";
    await Promise.resolve();
  });
  for (let i = 0; i < 4; i++) await settle();
  // A person's accounts are their row's hint (a tooltip, and words for assistive tech); a pause is a line of its own.
  const line = (name: string) => host.querySelector<HTMLElement>(`[role='listitem'][aria-label='${name}']`)?.textContent ?? "";
  expect(line("Sam Rivera")).toContain("Claude: Own subscription · GitHub: sam-rivera");
  expect(line("Sam Rivera")).not.toContain("Paused");
  expect(line("Alice Chen")).toContain("Claude: Workspace API key · GitHub: not connected");
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

it("drops a failed Test once the setting it tried is changed", async () => {
  await render(withKey);
  testWorks = false;
  await click(button("Test"));
  expect(section("Workspace API key").textContent).toContain("Failed on devbox");
  // Back to Anthropic's own endpoint: the hub forgets the Test, so the screen does too.
  await click(button("Change"));
  await type("Endpoint", "");
  await click(button("Save and test"));
  expect(sealed).toEqual([{ account: "hub_api", boxes: expect.any(Array) as unknown }]);
  expect(section("Workspace API key").textContent).not.toContain("Failed on devbox");
});

it("reaches the same controls from Claude's row on Setup, from the old Hub accounts link, and from a search for the members switch", async () => {
  revealNext(null);
  window.location.hash = "#/settings/hub/accounts";
  await render(withKey);
  // The old link lands on the accounts, on Setup: each account one row, and no control of it beside the row.
  const accounts = host.querySelector<HTMLElement>("[data-screen='settings.hub.setup.error'] [data-screen='settings.hub.accounts']");
  expect(document.activeElement).toBe(accounts);
  expect([...(accounts?.querySelectorAll("[data-step]") ?? [])].map((r) => r.getAttribute("data-step"))).toEqual(["claude", "github"]);
  expect(host.querySelector("section[aria-label='Workspace API key']")).toBeNull();
  await click(button("Claude"));
  expect(section("Workspace API key").textContent).toContain("Sealed on devbox.");
  expect(section("Members may use the workspace's API key").querySelector("[role='switch']")).not.toBeNull();
  // A search for Hub accounts, with an account open, goes back to them all.
  await act(async () => {
    revealNext("hub.accounts");
    await Promise.resolve();
  });
  for (let i = 0; i < 4; i++) await settle();
  expect(host.querySelector("section[aria-label='Workspace API key']")).toBeNull();
  expect(document.activeElement).toBe(host.querySelector("[data-screen='settings.hub.accounts']"));
  // One for the switch opens the account that holds it, with the switch in focus.
  await act(async () => {
    revealNext("admin.claude.members");
    await Promise.resolve();
  });
  for (let i = 0; i < 4; i++) await settle();
  expect(document.activeElement).toBe(section("Members may use the workspace's API key").querySelector("[role='switch']"));
  // And one for the GitHub App, GitHub's.
  await act(async () => {
    revealNext("admin.github");
    await Promise.resolve();
  });
  for (let i = 0; i < 4; i++) await settle();
  expect(host.querySelector("[data-screen='settings.hub.setup.step'] [data-part='admin.github']")).not.toBeNull();
  expect(host.querySelector("section[aria-label='Workspace API key']")).toBeNull();
});

it("shows a member who follows the link none of it, and reads nothing", async () => {
  await render(withKey, { me: bob, admin: false });
  expect(host.querySelector("[data-screen='settings.hub.denied']")).not.toBeNull();
  expect(sent("claude_accounts_get")).toEqual([]);
});

it("prefills Anthropic's endpoint, kept as none, and says beside a tailnet endpoint that Tailscale isn't connected, with Connect", async () => {
  tailnet = { status: "off" };
  await render(noKey);
  const endpoint = host.querySelector<HTMLInputElement>("input[aria-label='Endpoint']");
  expect(endpoint?.value).toBe("https://api.anthropic.com");
  expect(host.querySelector("[data-tailnet-hint]")).toBeNull();
  // The human's own: a gateway on the tailnet.
  await type("Endpoint", "http://100.101.102.103:8317");
  expect(host.querySelector("[data-tailnet-hint]")?.textContent).toContain("This endpoint is on your tailnet. Hosted agents reach it once Tailscale is connected.");
  await click(button("Connect Tailscale"));
  expect(sent("tailnet_connect")).toEqual([{}]);
  expect(opened).toEqual(["https://login.tailscale.com/a/standin"]);
  // Signing in: the line says what is left, and the sign-in page is a click away.
  expect(host.querySelector("[data-tailnet-hint]")?.textContent).toContain("Finish signing in to Tailscale.");
  expect(button("Open sign-in")).not.toBeNull();
  // Back to Anthropic's own: nothing to say, and the save keeps no endpoint.
  await type("Endpoint", "https://api.anthropic.com/");
  expect(host.querySelector("[data-tailnet-hint]")).toBeNull();
  await type("API key", KEY);
  await click(button("Save and test"));
  expect(sealed.map((r) => ("endpoint" in r ? r.endpoint : undefined))).toEqual([undefined]);
});

it("says nothing beside a tailnet endpoint once Tailscale is connected", async () => {
  tailnet = { status: "connected", tailnet: "acme.com" };
  await render(noKey);
  await type("Endpoint", "https://claude.tail1234.ts.net");
  expect(host.querySelector("[data-tailnet-hint]")).toBeNull();
});

it("says nothing beside a tailnet endpoint on a hub that serves no Tailscale", async () => {
  await render(noKey);
  await type("Endpoint", "https://claude.tail1234.ts.net");
  expect(host.querySelector("[data-tailnet-hint]")).toBeNull();
});
