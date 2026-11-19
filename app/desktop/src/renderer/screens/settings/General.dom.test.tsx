// @vitest-environment happy-dom
// Settings › You › General, the see-through sidebar: the switch shows only where the sidebar can be see-through (the
// Mac desktop app, preload's vibrancy), never on the web, Linux or Windows; it is on by default, titled with no line
// under it; turning it off makes the sidebar solid at once (data-solid-sidebar) and the choice holds the next time the
// app opens.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applySeeThrough, UiProvider } from "../../ui";
import { General } from "./General";

vi.mock("./Name", () => ({ YourName: () => null }));
vi.mock("./Notifications", () => ({ Notifications: () => null }));
vi.mock("../updates/hooks", () => ({ useUpdateStatus: () => null }));
vi.mock("../updates/UpdateStatus", () => ({ UpdateStatus: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

let host: HTMLDivElement;
let root: Root;

const app = { presence: () => Promise.resolve(true) };
const MAC = { shell: "desktop", platform: "darwin", vibrancy: true, fixture: null, app };

/** What main.tsx marks <html> with as the page starts, from preload's vibrancy. */
const stub = (fleetd: { vibrancy: boolean }) => {
  vi.stubGlobal("fleetd", fleetd);
  if (fleetd.vibrancy) document.documentElement.dataset["vibrancy"] = "";
  else delete document.documentElement.dataset["vibrancy"];
};

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset["solidSidebar"];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  delete document.documentElement.dataset["vibrancy"];
  vi.unstubAllGlobals();
});

const render = async () => {
  await act(async () => {
    root.render(
      <UiProvider>
        <General />
      </UiProvider>,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
};

/** The switch, by its title; it fails the test where there is none. */
const toggle = (): HTMLElement => {
  const label = [...host.querySelectorAll("label")].find((l) => l.textContent === "See-through sidebar");
  const el = label === undefined ? null : host.querySelector<HTMLElement>(`#${CSS.escape(label.htmlFor)}`);
  if (el === null) throw new Error("no See-through sidebar switch");
  return el;
};
const isOn = () => toggle().getAttribute("aria-checked") === "true";
const click = () => act(() => toggle().click());

it("shows the switch on the Mac desktop app, on by default and with no line under it", async () => {
  stub(MAC);
  await render();
  expect(isOn()).toBe(true);
  expect(toggle().getAttribute("aria-describedby")).toBeNull();
  expect(document.documentElement.dataset["solidSidebar"]).toBeUndefined();
});

it("turns the sidebar solid at once, and back, and keeps the choice for the next start", async () => {
  stub(MAC);
  await render();
  click();
  expect(isOn()).toBe(false);
  expect(document.documentElement.dataset["solidSidebar"]).toBe("");

  // A restart: a fresh page, which applies the kept choice before its first render (main.tsx).
  act(() => root.unmount());
  delete document.documentElement.dataset["solidSidebar"];
  applySeeThrough();
  expect(document.documentElement.dataset["solidSidebar"]).toBe("");
  root = createRoot(host);
  await render();
  expect(isOn()).toBe(false);

  click();
  expect(isOn()).toBe(true);
  expect(document.documentElement.dataset["solidSidebar"]).toBeUndefined();
  applySeeThrough();
  expect(document.documentElement.dataset["solidSidebar"]).toBeUndefined();
});

it.each([
  ["the web app", { shell: "web", platform: "other", vibrancy: false, fixture: null, app }],
  ["the Linux desktop app", { shell: "desktop", platform: "linux", vibrancy: false, fixture: null, app }],
  ["the Windows desktop app", { shell: "desktop", platform: "win32", vibrancy: false, fixture: null, app }],
])("leaves the switch out in %s", async (_where, fleetd) => {
  stub(fleetd);
  await render();
  expect(host.querySelector("[data-screen='settings.general']")).not.toBeNull();
  expect(toggle).toThrow();
  expect(host.textContent).not.toContain("See-through");
});
