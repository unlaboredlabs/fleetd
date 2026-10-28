// @vitest-environment happy-dom
// Settings › Your accounts › Claude: someone with nothing to run on is told to connect; a token pasted goes to main to seal (to
// every machine with a box key) and is tested at once, and the page never shows it again; the choice between their
// subscription and the hub's API key is offered only when the admin lets them; Test says what claude said.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClaudeAccountsGetOutput, PersonClaude } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import type { ClaudeAccountRequest } from "../../../shared/ipc";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { ClaudeSettings } from "./Claude";
import { CONNECT } from "./claudeModel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-27T10:00:00.000Z";
const BOX = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";
const TOKEN = "sk-ant-oat01-devbox-token";
const bob = { personId: "p_cccccccc", name: "Bob Okafor" };
const sealedOn = [{ machineId: "devbox", fingerprint: "ab12cd34" }];

const refused: PersonClaude = {
  person: bob,
  mayUseHubApi: false,
  runsOn: { kind: "refused", message: "Connect your Claude to start this order.", fix: "Members may not use the hub's API on this hub: connect your subscription in Settings › Connections › Claude." },
};
const connected: PersonClaude = {
  person: bob,
  mayUseHubApi: true,
  subscription: { sealedOn, connectedAt: AT, lastTest: { at: AT, machineId: "devbox", ok: true } },
  runsOn: { kind: "account", account: { kind: "person", personId: bob.personId } },
};
const answer = (me: PersonClaude | undefined): ClaudeAccountsGetOutput => ({
  hubApi: { sealedOn, updatedAt: AT },
  settings: { membersUseHubApi: me?.mayUseHubApi ?? true },
  leadsRunOn: { kind: "account", account: { kind: "hub" } },
  ...(me === undefined ? {} : { me }),
  people: [],
});

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let sealed: ClaudeAccountRequest[];
let current: ClaudeAccountsGetOutput;
let testAnswer: unknown;

beforeEach(() => {
  calls = [];
  sealed = [];
  testAnswer = { test: { at: AT, machineId: "devbox", ok: true } };
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    secret: {
      claudeAccount: (_hub: string, request: ClaudeAccountRequest) => {
        sealed.push(request);
        current = answer(connected);
        return Promise.resolve({ ok: true, output: { me: connected, missingOn: [] } });
      },
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const render = async (output: ClaudeAccountsGetOutput) => {
  current = output;
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      const out = tool === "claude_accounts_get" ? current : tool === "claude_account_test" ? testAnswer : tool === "claude_choice_set" ? { me: connected } : {};
      return Promise.resolve({ ok: true, output: out });
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
          <ClaudeSettings />
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
          // A node too old for box keys: nothing is sealed to it.
          { machineId: "oldbox", name: "oldbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [] },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let i = 0; i < 3; i++) await settle();
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

it("asks someone with nothing to run on to connect, seals the pasted token through main, tests it, and never shows it again", async () => {
  await render(answer(refused));
  expect(host.textContent).toContain(CONNECT);
  expect(host.textContent).toContain("Members may not use the hub's API on this hub");
  // The hub's API isn't theirs to pick.
  expect(host.querySelector("[role='radio']")).toBeNull();
  expect(host.textContent).toContain("claude setup-token");
  await type("Token", TOKEN);
  await click(button("Connect and test"));
  expect(sealed).toEqual([{ account: "mine", token: TOKEN, boxes: [{ machineId: "devbox", boxPubKey: BOX }] }]);
  expect(sent("claude_account_test")).toEqual([{ account: "mine" }]);
  for (let i = 0; i < 2; i++) await settle();
  expect(host.textContent).toContain("Connected. Sealed on devbox.");
  expect(host.textContent).toContain("Worked on devbox");
  expect(host.textContent).not.toContain(TOKEN);
  expect([...host.querySelectorAll("input")].map((i) => i.value)).not.toContain(TOKEN);
});

it("switches between the subscription and the hub's key, and says what a failed Test said", async () => {
  await render(answer(connected));
  expect(host.textContent).toContain("Your subscription.");
  const radios = [...host.querySelectorAll<HTMLElement>("[role='radio']")];
  expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  await click(radios[1] as HTMLElement);
  expect(sent("claude_choice_set")).toEqual([{ choice: "hub_api" }]);
  testAnswer = { test: { at: AT, machineId: "devbox", ok: false, error: "OAuth token has expired." } };
  await click(button("Test"));
  expect(host.querySelector("[role='alert']")?.textContent).toContain("Failed on devbox");
  expect(host.querySelector("[role='alert']")?.textContent).toContain("OAuth token has expired.");
});

it("disconnects the subscription once confirmed", async () => {
  await render(answer(connected));
  await click(button("Disconnect"));
  expect(document.body.textContent).toContain("Each machine forgets the token.");
  const confirm = [...document.querySelectorAll("[role='dialog'] button")].find((b) => b.textContent.trim() === "Disconnect");
  if (!(confirm instanceof HTMLElement)) throw new Error("no confirm");
  await click(confirm);
  expect(sent("claude_subscription_remove")).toEqual([{}]);
});

it("says a device key with no person has no account of its own", async () => {
  await render(answer(undefined));
  expect(host.textContent).toContain("belongs to no person");
  expect(host.querySelector("input")).toBeNull();
});
