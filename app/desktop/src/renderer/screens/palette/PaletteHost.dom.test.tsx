// @vitest-environment happy-dom
// On the web the New screen picker's host mounts once the app has shown, which a page with no chat never says: the
// Screens page of a workspace with no bots. A press of New screen there still opens it at once.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { live, snapshot } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { openNewScreen } from "../sessions/NewScreen";
import { PaletteHost } from "./PaletteHost";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal("fleetd", { shell: "web", platform: "darwin", fixture: null, system: { hostName: () => Promise.resolve("devbox") } });
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

it("opens New screen at once on the web, on a page that shows no chat", async () => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const layer = createDataLayer({
    call: () => Promise.resolve({ ok: true, output: {} }),
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  });
  root = createRoot(host);
  act(() =>
    root?.render(
      <DataProvider layer={layer}>
        <UiProvider>
          <PaletteHost />
        </UiProvider>
      </DataProvider>,
    ),
  );
  const bare = snapshot(1);
  act(() => {
    send(live(["screen_open"]));
    send(bare.t === "snapshot" ? { ...bare, snapshot: { ...bare.snapshot, projects: [] } } : bare);
  });
  await settle();
  act(() => openNewScreen());
  await settle();
  expect(document.querySelector("[data-screen='sessions.new.nobot']")?.textContent).toContain("this workspace has none yet");
});
