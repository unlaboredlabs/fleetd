// @vitest-environment happy-dom
// useServes: only a hub_info answer with leftOut (fleetd cloud) hides a control. A hub not heard from yet, or one
// whose hub_info keeps failing, keeps its last answer, and a hub never seen serves everything; one hub's answer never
// carries over to another.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { resetServes, useServes } from "./role";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const CLOUD = { version: "0.9.0", protocol: 1, busy: [], admin: true, leftOut: ["hub_update", "hub_restart"] };
const SELF_RUN = { version: "0.9.0", protocol: 1, busy: [], admin: true };
const NEVER = new Promise<CallOutcome>(() => undefined);
const failing = (): Promise<CallOutcome> => Promise.resolve({ ok: false, error: { code: "timeout", message: "The hub didn't answer in time." } });
const answering = (output: object) => (): Promise<CallOutcome> => Promise.resolve({ ok: true, output });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetServes();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function Probe() {
  return <span data-serves={String(useServes("hub_restart"))} />;
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** The probe on hub `id`, whose hub_info answers with `info`, in a fresh data layer (a remount, or the app's next start). */
const render = async (id: string, info: () => Promise<CallOutcome>) => {
  act(() => root.unmount());
  root = createRoot(host);
  let send: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool) => (tool === "hub_info" ? info() : Promise.resolve({ ok: true, output: {} })),
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <DataProvider layer={createDataLayer(hub, Date.now, id)}>
        <Probe />
      </DataProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    send({ t: "state", state: { phase: "live", hub: `http://${id}:4790`, protocol: 1 } });
    send({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
};
const said = () => host.querySelector("[data-serves]")?.getAttribute("data-serves");

it("serves everything on a hub never seen while hub_info hasn't answered, or keeps failing", async () => {
  await render("devbox", () => NEVER);
  expect(said()).toBe("true");
  await render("devbox", failing);
  expect(said()).toBe("true");
});

it("hides a control only once hub_info says leftOut, and keeps that while hub_info is asked again or fails", async () => {
  await render("acme", answering(CLOUD));
  expect(said()).toBe("false");
  await render("acme", () => NEVER);
  expect(said()).toBe("false");
  await render("acme", failing);
  expect(said()).toBe("false");
});

it("keeps a self-run hub's controls while its hub_info fails, and never carries one hub's answer to another", async () => {
  await render("devbox", answering(SELF_RUN));
  expect(said()).toBe("true");
  await render("devbox", failing);
  expect(said()).toBe("true");
  await render("acme", answering(CLOUD));
  expect(said()).toBe("false");
  // Back on devbox, not answering yet: its own last answer, not acme's.
  await render("devbox", () => NEVER);
  expect(said()).toBe("true");
});
