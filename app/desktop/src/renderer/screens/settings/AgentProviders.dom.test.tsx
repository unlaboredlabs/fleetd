// @vitest-environment happy-dom
// Settings › Hub › Providers: a row per provider with how it is connected and the models it offers, no words under a
// row but those; Google's Sign in with Google starts the sign-in on the one machine there is, right in its row's setup;
// a connected Google says how, its setup lists each machine's sign-in and the bots holding a key; a link to Google's
// setup lands with its row open.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AntigravityStatusOutput, ProfileModel } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { ProvidersPage } from "./AgentProviders";
import { GOOGLE_REVEAL } from "./GoogleSignIn";
import { revealNext } from "./reveal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const MODELS: ProfileModel[] = [
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", fast: true },
  { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", fast: false },
  { id: "gemini-4-neon", displayName: "Gemini 4 Neon (Antigravity)", fast: false },
];
const PROJECTS = [
  { machineId: "devbox", projectId: "storefront", title: "storefront", lastActivityAt: "2026-11-22T10:00:00.000Z", threads: {}, workspaceRoot: "/w/s" },
  { machineId: "devbox", projectId: "billing", title: "billing", lastActivityAt: "2026-11-22T10:00:00.000Z", threads: {}, workspaceRoot: "/w/b" },
];

let host: HTMLDivElement;
let root: Root;
let google: AntigravityStatusOutput;
let calls: { tool: string; input: Record<string, unknown> }[];
/** While set, machine_antigravity_login answers only when the test resolves it. */
let loginHeld: Promise<unknown> | undefined;
/** What the page handed main to seal: the team's Gemini key's requests. */
let sealed: unknown[];

beforeEach(() => {
  sealed = [];
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    openExternal: () => undefined,
    secret: {
      claudeAccount: (_hub: string, request: unknown) => {
        sealed.push(request);
        google = { ...google, teamKey: { sealedOn: [{ machineId: "devbox", fingerprint: "ab12cd34" }], updatedAt: "2026-11-22T10:00:00.000Z" } };
        return Promise.resolve({ ok: true, output: {} });
      },
    },
  });
  google = { machines: [{ machineId: "devbox", checked: true }], keyIn: [] };
  calls = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  loginHeld = undefined;
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const render = async () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, raw) => {
      const input = raw as Record<string, unknown>;
      if (tool === "profiles_list") return Promise.resolve({ ok: true, output: { profiles: [], models: MODELS, modelsFrom: "builtin", efforts: ["high"] } });
      if (tool === "claude_accounts_get") return Promise.resolve({ ok: true, output: { hubApi: { sealedOn: [], updatedAt: "2026-11-22T10:00:00.000Z" }, leadsRunOn: { kind: "hub_api" }, settings: { membersUseHubApi: true }, people: [] } });
      if (tool === "antigravity_status") return Promise.resolve({ ok: true, output: google });
      if (tool === "gemini_key_remove") {
        calls.push({ tool, input });
        const { teamKey: _gone, ...rest } = google;
        google = rest;
        return Promise.resolve({ ok: true, output: { ok: true } });
      }
      if (tool === "machine_antigravity_login") {
        calls.push({ tool, input });
        if (loginHeld !== undefined) return loginHeld.then(() => ({ ok: true, output: { machineId: "devbox", message: "sign in", loginUrl: "https://accounts.google.com/o/oauth2/auth?state=g1" } }));
        return Promise.resolve({ ok: true, output: { machineId: "devbox", message: "sign in", loginUrl: "https://accounts.google.com/o/oauth2/auth?state=g1" } });
      }
      return Promise.resolve({ ok: false, error: { code: "not_found", message: `${tool} isn't faked` } });
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
          <ProvidersPage me={undefined} />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: PROJECTS } } as never);
    await Promise.resolve();
  });
  await settle();
};

const settle = async () => {
  for (let i = 0; i < 4; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await settle();
};
const button = (text: string) => {
  const b = [...host.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
  if (b === undefined) throw new Error(`no button ${text}`);
  return b;
};
/** Each provider's row as shown: its hover left out. */
const rows = () =>
  [...host.querySelectorAll("[data-provider]")].map((r) => {
    const shown = r.cloneNode(true) as HTMLElement;
    shown.querySelectorAll("[data-hint]").forEach((h) => h.remove());
    return shown.textContent;
  });

it("lists each provider with how it is connected, never its models, Google's Sign in with Google at its end", async () => {
  await render();
  expect(rows()).toEqual(["AnthropicAPI key", "GoogleNot connectedSign in with Google"]);
  // The models are a profile's editor's alone: nowhere on a row, nor in its hover.
  expect(host.querySelector("[data-provider] [data-hint]")).toBeNull();
  expect(host.textContent).not.toContain("Claude Sonnet 5.5");
  // No profile yet under either: each says so, and the row's plus is the one way to add one.
  for (const g of host.querySelectorAll("[data-provider-group]")) {
    expect(g.textContent).toContain("No profiles yet");
    expect([...g.querySelectorAll("button")].filter((b) => /add/iu.test(b.getAttribute("aria-label") ?? b.textContent))).toHaveLength(1);
  }
  // The setup shows only once a row opens.
  expect(host.querySelector("[data-provider-setup]")).toBeNull();
});

it("signs Google in on the one machine right from its row", async () => {
  await render();
  await click(button("Sign in with Google"));
  expect(calls).toEqual([{ tool: "machine_antigravity_login", input: { machineId: "devbox" } }]);
  const setup = host.querySelector("[data-provider-setup='google']");
  expect(setup?.textContent).toContain("Open this page and sign in with the Google account devbox's agents on Antigravity should use.");
  expect(setup?.querySelector("form[aria-label='Sign in']")).not.toBeNull();
});

it("says in words that a sign-in is starting, never a bare disabled button, until Google's link is there", async () => {
  let answer!: () => void;
  loginHeld = new Promise<void>((done) => (answer = done));
  await render();
  await click(button("Sign in with Google"));
  const row = () => host.querySelector("[data-provider-setup='google'] [data-machine='devbox']");
  expect(row()?.querySelector("[role='status']")?.textContent).toBe("Starting a sign-in… Google's sign-in link shows here once it's ready.");
  expect([...(row()?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([]);
  expect(host.textContent).not.toContain("Checking");
  act(() => answer());
  await settle();
  expect(row()?.querySelector("[role='status']")).toBeNull();
  expect(row()?.querySelector("form[aria-label='Sign in']")).not.toBeNull();
});

it("says how a connected Google is, and its setup lists each machine's sign-in and the bots holding a key", async () => {
  google = { machines: [{ machineId: "devbox", checked: true, signedIn: "Google AI Pro" }], keyIn: [{ machineId: "devbox", projectId: "storefront" }] };
  await render();
  expect(rows()[1]).toBe("GoogleSigned in · Google AI Pro · API key in 1 bot");
  await click(button("Google"));
  const setup = host.querySelector("[data-provider-setup='google']");
  expect(setup?.querySelector("[data-machine='devbox']")?.textContent).toContain("Signed in · Google AI Pro");
  expect(setup?.querySelector("[data-row='gemini-bots']")?.textContent).toContain("storefront");
  // Nothing was asked of the machine: what antigravity_status said is shown.
  expect(calls).toEqual([]);
});

it("opens Google's row when a link to its setup lands", async () => {
  revealNext(GOOGLE_REVEAL);
  await render();
  expect(host.querySelector("[data-provider-setup='google']")).not.toBeNull();
});

it("saves the team's Gemini key, sealed by main, and Google reads connected with it; Remove forgets it", async () => {
  revealNext(GOOGLE_REVEAL);
  await render();
  await click(button("Add key…"));
  const field = host.querySelector<HTMLInputElement>("input[aria-label='Gemini API key']");
  if (field === null) throw new Error("no key field");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "AIzaSy-team");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Save"));
  expect(sealed).toEqual([{ account: "gemini", key: "AIzaSy-team", boxes: [] }]);
  // Never through the hub's own calls in the clear.
  expect(JSON.stringify(calls)).not.toContain("AIzaSy-team");
  expect(rows()[1]).toMatch(/^GoogleAPI key/u);
  expect(host.querySelector("[data-row='gemini-key']")?.textContent).toContain("Change");
  await click(button("Remove"));
  const confirm = [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].find((b) => b.textContent.trim() === "Remove");
  if (confirm === undefined) throw new Error("no confirm");
  await click(confirm);
  expect(calls).toEqual([{ tool: "gemini_key_remove", input: {} }]);
  expect(rows()[1]).toMatch(/^GoogleNot connected/u);
});
