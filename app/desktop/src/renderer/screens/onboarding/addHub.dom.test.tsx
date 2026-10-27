// @vitest-environment happy-dom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PairOutcome, PairRequest } from "../../../shared/pairing";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { live } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { HubsSettings } from "../settings/Hubs";
import { OnboardingScreen } from "./OnboardingScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stubbed before the screens load: the shell reads the platform on import.
const { redeem, forget } = vi.hoisted(() => {
  const redeem = vi.fn((_request: PairRequest): Promise<PairOutcome> => Promise.resolve({ ok: true, hubName: "devbox" }));
  const forget = vi.fn(() => Promise.resolve());
  vi.stubGlobal("fleetd", {
    platform: "darwin",
    fixture: null,
    app: { presence: () => Promise.resolve(true), linkHandler: () => Promise.resolve(null) },
    hub: { forget },
    hubs: { update: () => Promise.resolve({ ok: true }) },
    pair: {
      start: () => Promise.resolve({ appPair: null, problem: null, probe: { answers: false, hub: "http://127.0.0.1:4790" } }),
      store: () => Promise.resolve(null),
      probe: (hub: string) => Promise.resolve({ answers: false, hub }),
      redeem,
    },
  });
  return { redeem, forget };
});

const subscribeHash = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

/** The two screens this goes between, routed on the hash as the shell does. */
function Screens() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  if (hash.startsWith("#/settings")) return <HubsSettings />;
  if (hash.startsWith("#/onboarding")) return <OnboardingScreen />;
  return <div data-screen="home" />;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  redeem.mockClear();
  forget.mockClear();
  window.location.hash = "#/settings/hubs";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const hub: HubApi = {
    call: () => Promise.resolve({ ok: true, output: {} }),
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  act(() => {
    root.render(
      <DataProvider layer={layer}>
        <UiProvider>
          <Screens />
        </UiProvider>
      </DataProvider>,
    );
  });
  await act(async () => {
    send(live());
    await new Promise((r) => setTimeout(r, 0));
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const click = (name: string) => {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === name);
  if (!found) throw new Error(`no ${name} button`);
  act(() => found.click());
};
const screen = () => host.querySelector("[data-screen]")?.getAttribute("data-screen");

const type = (label: string, value: string) => {
  const field = [...host.querySelectorAll("label")].find((l) => l.textContent === label);
  const input = field ? host.querySelector<HTMLInputElement>(`#${CSS.escape(field.htmlFor)}`) : null;
  if (!input) throw new Error(`no ${label} field`);
  act(() => {
    // React tracks the value it set; the prototype's setter is what makes it see a change.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

it("Add a hub, while connected, opens the pairing form with a name and colour, and stays on it", async () => {
  click("Add a hub");
  await settle();
  expect(window.location.hash).toBe("#/onboarding?add");
  expect(screen()).toBe("onboarding");
  expect(host.querySelector("h1")?.textContent).toBe("Add a hub");
  expect(host.textContent).toContain("Pairing code");
  expect(host.querySelector('[role="radiogroup"][aria-label="Colour"]')).not.toBeNull();
  expect(forget).not.toHaveBeenCalled();
});

it("pairs the new hub under the name and colour picked, keeping the one it has, then lists them", async () => {
  click("Add a hub");
  await settle();
  type("Name", "  Acme  ");
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="amber"]')?.click());
  type("Hub address", "http://acme-hub:4790");
  type("Pairing code", "ABCD2345");
  click("Connect");
  await settle();
  await settle();
  expect(redeem).toHaveBeenCalledWith({ hub: "http://acme-hub:4790", code: "ABCD-2345", target: { label: "Acme", color: "amber" } });
  expect(forget).not.toHaveBeenCalled();
  expect(window.location.hash).toBe("#/settings/hubs");
});

it("asks for a name before it pairs: the label is the person's own, never a fixed choice", async () => {
  click("Add a hub");
  await settle();
  type("Hub address", "http://acme-hub:4790");
  type("Pairing code", "ABCD2345");
  click("Connect");
  await settle();
  expect(redeem).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Name the hub");
});

it("Back to settings goes back to the hubs", async () => {
  click("Add a hub");
  await settle();
  click("Back to settings");
  await settle();
  expect(screen()).toBe("settings.hubs");
});
