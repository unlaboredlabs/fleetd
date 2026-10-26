// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubState } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { HubStatus } from "./HubStatus";
import { parseHash } from "./routes";

const fleetd = vi.hoisted(() => {
  const f = { fixture: null as string | null, platform: "linux" };
  (window as unknown as { fleetd: typeof f }).fleetd = f;
  return f;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HUB = "http://devbox.example.ts.net:4790";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fleetd.fixture = null;
  window.location.hash = "#/status";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const hubApi: HubApi = {
  call: () => Promise.resolve({ ok: true, output: {} }),
  subscribe: () => () => undefined,
  resync: () => Promise.resolve(),
  focus: () => Promise.resolve(),
  chat: () => Promise.resolve(),
};

/** A fresh chip for `state`, its popover opened; returns the popover's buttons, by their words. */
const open = (state: HubState): string[] => {
  act(() => {
    root.render(
      <DataProvider layer={createDataLayer(hubApi)}>
        <TooltipProvider>
          <HubStatus key={JSON.stringify(state)} hub={state} />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  const chip = host.querySelector<HTMLButtonElement>("[data-hub-status]");
  if (chip === null) throw new Error("no hub chip");
  act(() => chip.click());
  const pop = document.querySelector("[aria-label='Hub'][role='dialog']");
  if (pop === null) throw new Error("the popover didn't open");
  return [...pop.querySelectorAll("button")].map((b) => b.textContent);
};

const popover = () => document.querySelector("[aria-label='Hub'][role='dialog']")?.textContent ?? "";

it("shows only the actions that apply to each state", () => {
  expect(open({ phase: "live", hub: HUB, protocol: 1, version: "0.9.2" })).toEqual(["Hub settings", "Disconnect…"]);
  expect(open({ phase: "connecting", hub: HUB, attempt: 1 })).toEqual(["Hub settings", "Disconnect…"]);
  expect(open({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", retryAt: 0 })).toEqual([
    "Retry now",
    "Hub settings",
    "Disconnect…",
  ]);
  expect(open({ phase: "unpaired" })).toEqual(["Pair with a hub"]);
});

it("offers nothing to do on sample data", () => {
  fleetd.fixture = "status-rows";
  expect(open({ phase: "live", hub: HUB, protocol: 1 })).toEqual([]);
  expect(host.querySelector("[data-hub-status]")?.textContent).toBe("Sample data");
});

it("names a live hub by its short name, with the address, protocol and version in the popover", () => {
  open({ phase: "live", hub: HUB, protocol: 1, version: "0.9.2" });
  expect(host.querySelector("[data-hub-status]")?.textContent).toBe("devbox");
  expect(popover()).toContain(HUB);
  expect(popover()).toContain("v1 · fleetd 0.9.2");
});

it("says why it is offline and what to do about it", () => {
  open({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", fix: "Run `fleetd doctor` on devbox", retryAt: 0 });
  expect(popover()).toContain("Nothing is listening at devbox:4790");
  expect(popover()).toContain("Run fleetd doctor on devbox");
  expect(document.querySelector("[aria-label='Hub'][role='dialog'] code")?.textContent).toBe("fleetd doctor");
});

it("switches hub from Settings' Hub section, never #/onboarding, which a connected app leaves at once", () => {
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("[aria-label='Hub'][role='dialog'] button")];
  open({ phase: "live", hub: HUB, protocol: 1 });
  act(() => buttons().find((b) => b.textContent === "Hub settings")?.click());
  expect(parseHash(window.location.hash)).toMatchObject({ id: "settings", tab: "general" });

  open({ phase: "unpaired" });
  act(() => buttons().find((b) => b.textContent === "Pair with a hub")?.click());
  expect(window.location.hash).toBe("#/onboarding");
});
