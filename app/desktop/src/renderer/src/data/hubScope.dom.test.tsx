// @vitest-environment happy-dom
// A hub's scope says it is a fleetd cloud team by its hub_info's word, however this app paired with it: one paired with
// a code (Pair a phone, a device on the team) is a team too, with Team, Billing and fleetd's computers, while the hubs
// kept stay as they are. A self-run hub, which leaves nothing out, is never one.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "./queries";
import { HubScope, resetLeftOut, useHub } from "./react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const Said = () => {
  const hub = useHub();
  return <p>{`${hub.cloud === true ? "team" : "hub"}${hub.codePaired === true ? " by code" : ""}`}</p>;
};

const render = async (entry: { cloud?: true }, leftOut: string[] | undefined) => {
  let send: (frame: HubFrame) => void = () => undefined;
  const api: HubApi = {
    call: (tool) =>
      Promise.resolve({ ok: true, output: tool === "hub_info" ? { version: "0.9.0", protocol: 1, busy: [], admin: false, ...(leftOut === undefined ? {} : { leftOut }) } : {} }),
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(api);
  const stop = layer.start();
  act(() => root.unmount());
  root = createRoot(host);
  await act(async () => {
    root.render(
      <HubScope hub={{ id: "hub", label: "acme", layer, ...entry }}>
        <Said />
      </HubScope>,
    );
    await Promise.resolve();
  });
  const said = host.textContent;
  await act(async () => {
    send({ t: "state", state: { phase: "live", hub: "https://acme.fleetd.dev", protocol: 1 } });
    send({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
  stop();
  return { before: said, after: host.textContent };
};

beforeEach(() => {
  resetLeftOut();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("makes a hub paired with a code a team once its hub_info leaves tools out, as only fleetd cloud does", async () => {
  expect(await render({}, ["hub_update", "hub_restart"])).toEqual({ before: "hub", after: "team by code" });
});

it("keeps a team the account brought as it is, and a self-run hub a hub", async () => {
  expect(await render({ cloud: true }, ["hub_update", "hub_restart"])).toEqual({ before: "team", after: "team" });
  // Another hub under the same id: what the last one said is forgotten with it.
  resetLeftOut();
  expect(await render({}, undefined)).toEqual({ before: "hub", after: "hub" });
});
