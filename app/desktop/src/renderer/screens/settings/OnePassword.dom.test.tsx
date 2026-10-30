// @vitest-environment happy-dom
// Settings › Your accounts › 1Password: the guided steps link to 1Password's service accounts; a token pasted goes to
// main to seal (to every machine with a box key) and is tested at once, Test lists the vaults it reads (or 1Password's
// words), the page never shows the token again, and Remove asks first.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OnePasswordGetOutput, OnePasswordToken } from "../../../shared/contracts";
import type { HubError, HubFrame } from "../../../shared/hub";
import type { OnePasswordRequest } from "../../../shared/ipc";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { OnePasswordSettings, SERVICE_ACCOUNTS } from "./OnePassword";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-30T10:00:00.000Z";
const BOX = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";
const TOKEN = "ops_devbox-service-account";
const saved: OnePasswordToken = { sealedOn: [{ machineId: "devbox", fingerprint: "0b5e55ed" }], savedAt: AT };

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let sealed: OnePasswordRequest[];
let opened: string[];
let current: OnePasswordGetOutput | HubError;
let testAnswer: unknown;

beforeEach(() => {
  calls = [];
  sealed = [];
  opened = [];
  testAnswer = { test: { at: AT, machineId: "devbox", ok: true, vaults: ["Agents", "Shared"] } };
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    openExternal: (url: string) => (opened.push(url), Promise.resolve({ ok: true })),
    secret: {
      onePassword: (_hub: string, request: OnePasswordRequest) => {
        sealed.push(request);
        current = { token: saved };
        return Promise.resolve({ ok: true, output: { token: saved } });
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

const render = async (output: OnePasswordGetOutput | HubError) => {
  current = output;
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "onepassword_get") return Promise.resolve("code" in current ? { ok: false, error: current } : { ok: true, output: current });
      if (tool === "onepassword_remove") current = {};
      return Promise.resolve({ ok: true, output: tool === "onepassword_test" ? testAnswer : { ok: true } });
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
          <OnePasswordSettings />
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

const button = (text: string, within: ParentNode = document) => {
  const b = [...within.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
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

it("guides a person to a service account, seals the pasted token through main, lists its vaults, and never shows it again", async () => {
  await render({});
  expect(host.textContent).toContain("make a service account");
  await click(button("1Password › Service accounts"));
  expect(opened).toEqual([SERVICE_ACCOUNTS]);
  await type("Token", TOKEN);
  await click(button("Save and test"));
  expect(sealed).toEqual([{ token: TOKEN, boxes: [{ machineId: "devbox", boxPubKey: BOX }] }]);
  expect(sent("onepassword_test")).toEqual([{}]);
  for (let i = 0; i < 2; i++) await settle();
  expect(host.textContent).toContain("Saved. Sealed on devbox.");
  expect(host.textContent).toContain("Reads Agents and Shared (on devbox");
  // oldbox has no box key, so it doesn't hold it.
  expect(host.textContent).toContain("Not on oldbox: agents there fill no logins with it.");
  expect(host.textContent).not.toContain(TOKEN);
  expect([...host.querySelectorAll("input")].map((i) => i.value)).not.toContain(TOKEN);
});

it("says what 1Password said when a Test fails, and removes the token once confirmed", async () => {
  await render({ token: saved });
  testAnswer = { test: { at: AT, machineId: "devbox", ok: false, error: "1Password: invalid service account token ***OP_SERVICE_ACCOUNT_TOKEN***" } };
  await click(button("Test"));
  expect(host.querySelector("[role='alert']")?.textContent).toContain("Failed on devbox");
  expect(host.querySelector("[role='alert']")?.textContent).toContain("invalid service account token");
  await click(button("Remove", host));
  expect(document.body.textContent).toContain("Each machine forgets it.");
  const dialog = document.querySelector("[role='dialog']");
  if (dialog === null) throw new Error("no dialog");
  await click(button("Remove", dialog));
  expect(sent("onepassword_remove")).toEqual([{}]);
  for (let i = 0; i < 2; i++) await settle();
  expect(host.querySelector("input[aria-label='Token']")).not.toBeNull();
});

it("says a device key with no person has no 1Password of its own", async () => {
  await render({ code: "forbidden", message: "Only a person keeps a 1Password token, from one of their own devices." });
  expect(host.textContent).toContain("belongs to no person");
  expect(host.querySelector("input")).toBeNull();
});
