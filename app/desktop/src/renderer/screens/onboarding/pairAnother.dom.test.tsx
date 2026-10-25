// @vitest-environment happy-dom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PairOutcome, PairRequest } from "../../../shared/pairing";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { live } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { General } from "../settings/General";
import { OnboardingScreen } from "./OnboardingScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stubbed before the screens load: the shell reads the platform on import.
const { redeem, forget } = vi.hoisted(() => {
  const redeem = vi.fn((_request: PairRequest): Promise<PairOutcome> => Promise.resolve({ ok: true, hubName: "forge" }));
  const forget = vi.fn(() => Promise.resolve());
  vi.stubGlobal("fleetd", {
    platform: "darwin",
    fixture: null,
    app: { presence: () => Promise.resolve(true), linkHandler: () => Promise.resolve(null) },
    hub: { forget },
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
  if (hash.startsWith("#/settings")) return <General />;
  if (hash.startsWith("#/onboarding")) return <OnboardingScreen />;
  return <div data-screen="home" />;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  redeem.mockClear();
  forget.mockClear();
  window.location.hash = "#/settings/general";
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

it("Pair with another hub, while connected, opens the pairing form and stays on it", async () => {
  click("Pair with another hub");
  await settle();
  expect(window.location.hash).toMatch(/^#\/onboarding/);
  expect(screen()).toBe("onboarding");
  expect(host.textContent).toContain("Pair with another hub");
  expect(host.textContent).toContain("Pairing code");
  expect(forget).not.toHaveBeenCalled();
});

it("keeps the current hub until the new one pairs, then goes on to the board", async () => {
  click("Pair with another hub");
  await settle();
  type("Hub address", "http://forge:4790");
  type("Pairing code", "ABCD2345");
  click("Connect");
  await settle();
  await settle();
  expect(redeem).toHaveBeenCalledWith({ hub: "http://forge:4790", code: "ABCD-2345" });
  expect(forget).not.toHaveBeenCalled();
  expect(window.location.hash).toBe("#/");
});

it("Keep this hub goes back to settings", async () => {
  click("Pair with another hub");
  await settle();
  click("Keep this hub");
  await settle();
  expect(screen()).toBe("settings.general");
});
