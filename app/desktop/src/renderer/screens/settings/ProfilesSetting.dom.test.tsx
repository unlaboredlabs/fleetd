// @vitest-environment happy-dom
// The task profiles' settings: what new agents run on, a refused model's alert, an edit saved with profiles_set at
// the project, and a key without admin kept from the fleet's.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProfilesGetOutput } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { ProfilesSetting } from "./ProfilesSetting";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal("fleetd", { platform: "darwin", fixture: null });
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};
const field = (label: string) => {
  const l = [...host.querySelectorAll("label")].find((x) => x.textContent === label);
  return host.querySelector<HTMLInputElement>(`#${CSS.escape(l?.getAttribute("for") ?? "")}`);
};
const type = (input: HTMLInputElement | null, value: string) =>
  act(() => {
    if (input === null) throw new Error("no field");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text);

const view: ProfilesGetOutput = {
  fleet: { high: { model: "claude-nope", effort: "max", refused: "claude on devbox refused claude-nope at 2026-10-27T10:00:00.000Z: agents run on claude-opus-5-5 instead until you set this again." }, medium: {} },
  project: { high: {}, medium: {} },
  runs: { high: { model: "claude-opus-5-5", effort: "max" }, medium: { model: "claude-opus-5-5", effort: "medium" } },
  defaults: { high: { model: "claude-opus-5-5", effort: "high" }, medium: { model: "claude-opus-5-5", effort: "medium" } },
};
const ref = { machineId: "devbox", projectId: "storefront" };

const mount = async (node: React.ReactNode) => {
  const call = vi.fn<HubApi["call"]>((tool) =>
    Promise.resolve(tool === "profiles_get" ? { ok: true, output: view } : { ok: true, output: { ...view, next: "New agents of the project's profiles run on this." } }),
  );
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = { call, subscribe: (l) => ((listener = l), () => undefined), resync: () => Promise.resolve(), focus: () => Promise.resolve(), chat: () => Promise.resolve() };
  root = createRoot(host);
  act(() => root?.render(<DataProvider layer={createDataLayer(hub)}>{node}</DataProvider>));
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  return call;
};

it("shows what runs, flags a refused model and saves a project's override", async () => {
  const call = await mount(<ProfilesSetting projectRef={ref} />);
  await settle();
  expect(host.textContent).toContain("New agents run on claude-opus-5-5 at max effort.");
  // The fleet's refused model never shows as what a project follows.
  expect(field("High model")?.placeholder).toBe("claude-opus-5-5");
  expect(button("Default (max)")).toBeDefined();
  type(field("Medium model"), "claude sonnet");
  expect(host.textContent).toContain("A model is one word as claude takes it");
  expect(button("Save medium")?.disabled).toBe(true);
  type(field("Medium model"), "claude-sonnet-5-5");
  const mediumEffort = host.querySelector('[role="group"][aria-label="Medium effort"]');
  act(() => [...(mediumEffort?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Low")?.click());
  act(() => button("Save medium")?.click());
  await settle();
  const set = call.mock.calls.find(([tool]) => tool === "profiles_set");
  expect(set?.[1]).toEqual({ projectRef: ref, medium: { model: "claude-sonnet-5-5", effort: "low" } });
  expect(host.textContent).toContain("Saved. New agents of the project's profiles run on this.");
});

it("shows the fleet's refusal as an alert and keeps a key without admin from changing it", async () => {
  await mount(<ProfilesSetting blocked="This key can't change it: that needs an admin key." />);
  await settle();
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("claude-nope isn't used: claude on devbox refused claude-nope");
  expect(field("High model")?.value).toBe("claude-nope");
  expect(field("High model")?.disabled).toBe(true);
  expect(button("Save high")?.disabled).toBe(true);
  expect(host.textContent).toContain("that needs an admin key");
});
