// @vitest-environment happy-dom
// "Sign in with boat" in the cloud step's key setting (W448): the email goes to the hub's cloud_sign_in, the link shows
// first and the code only once the person says they are signed in, Cancel stops it on the hub, and what the hub said
// shows when it ends. Pasting a key stays behind "Paste a key instead".
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import type { CloudView } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { CloudSettings } from "./Cloud";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

/** cloud_get's pool with no key yet, as fixtures/kit/cloud.ts has it. */
const cloudNew = (over: Partial<CloudView> = {}): CloudView => ({
  hasKey: false,
  enabled: false,
  poolSize: 3,
  machineType: "large",
  dayBudget: 3,
  monthBudget: 20,
  monthIsPlan: true,
  projects: [],
  today: 0,
  month: 0,
  machines: [],
  sizes: [{ kind: "large", perHour: 0.072 }],
  boxPubKey: "Qm9hdERldkZpeHR1cmVCb3hQdWJsaWNLZXkwMDAwMDA=",
  environmentDefault: "fleetd-devbox",
  writers: false,
  ...over,
});
const waiting: CloudView["signIn"] = {
  state: "waiting",
  email: "person@example.com",
  verificationUri: "https://boat.dev/api/box/agent/identity/claim?claim_attempt_token=fixture",
  userCode: "151323",
  expiresAtMs: Date.parse("2026-11-04T19:50:00.000Z"),
};

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let view: CloudView;
let opened: string[];

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  opened = [];
  view = cloudNew();
  vi.stubGlobal("fleetd", { platform: "linux", openExternal: (url: string) => (opened.push(url), Promise.resolve({ ok: true })) });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const answer = (tool: string, input: unknown): CallOutcome => {
  if (tool === "cloud_sign_in") {
    const email = (input as { email?: string }).email;
    view = email === undefined ? cloudNew() : cloudNew({ signIn: waiting });
  }
  return { ok: true, output: tool === "hub_info" ? { version: "0.9.0", protocol: 1, busy: [], admin: true } : { cloud: view } };
};

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const render = async () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      return Promise.resolve(answer(tool, input));
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  const Panel = () => <CloudSettings cloud={view} />;
  const draw = () =>
    root.render(
      <UiProvider>
        <DataProvider layer={layer}>
          <Panel />
        </DataProvider>
      </UiProvider>,
    );
  await act(async () => {
    draw();
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4790", protocol: 1 } });
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
  return async () => {
    await act(async () => {
      draw();
      await Promise.resolve();
    });
    await settle();
  };
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
};
const type = async (label: string, text: string) => {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (input === null) throw new Error(`no input ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

describe("sign in with boat", () => {
  it("starts on the hub with the email, shows the link, then the code once signed in, and Cancel stops it", async () => {
    const redraw = await render();
    // Sign in comes first; the key field waits behind its link.
    expect(document.querySelector('input[aria-label="boat.dev API key"]')).toBeNull();
    await type("boat.dev email", "person@example.com");
    await click(button("Sign in with boat"));
    expect(calls.filter((c) => c.tool === "cloud_sign_in")).toEqual([{ tool: "cloud_sign_in", input: { email: "person@example.com" } }]);
    await redraw();
    expect(document.querySelector("[data-sign-in='waiting']")?.textContent).toContain("sign in as person@example.com");
    expect(document.querySelector("[data-sign-in-code]")).toBeNull();

    await click(button("Open boat.dev"));
    expect(opened).toEqual(["https://boat.dev/api/box/agent/identity/claim?claim_attempt_token=fixture"]);
    expect(document.querySelector("[data-sign-in-code]")?.textContent).toBe("151323");

    await click(button("Cancel"));
    expect(calls.filter((c) => c.tool === "cloud_sign_in").at(-1)).toEqual({ tool: "cloud_sign_in", input: {} });
  });

  it("shows what the hub said when it ends, and keeps pasting a key as the fallback", async () => {
    view = cloudNew({ signIn: { state: "failed", email: "person@example.com", said: "boat.dev has no environment named fleetd-devbox: make it, with Safe for third parties on, then sign in again." } });
    await render();
    expect(document.querySelector("[data-sign-in='failed']")?.textContent).toContain("no environment named fleetd-devbox");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="boat.dev email"]')?.value).toBe("person@example.com");
    await click(button("Paste a key instead"));
    expect(document.querySelector('input[aria-label="boat.dev API key"]')).not.toBeNull();
    expect(button("Save and test")).toBeDefined();
    // While pasting, the sign-in's form steps aside.
    expect(document.querySelector('input[aria-label="boat.dev email"]')).toBeNull();
  });

  it("after a sign-in is done, Change offers signing in again", async () => {
    view = cloudNew({ hasKey: true, signIn: { state: "done", email: "person@example.com", said: "Signed in as person@example.com: the hub's key fleetd-devbox is sealed." } });
    await render();
    expect(document.querySelector('input[aria-label="boat.dev email"]')).toBeNull();
    await click(button("Change"));
    expect(document.querySelector('input[aria-label="boat.dev email"]')).not.toBeNull();
    expect(button("Sign in with boat")).toBeDefined();
  });
});
