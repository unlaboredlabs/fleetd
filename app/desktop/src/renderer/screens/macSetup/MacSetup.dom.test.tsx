// @vitest-environment happy-dom
// Set up this Mac for agents' window: the code traded, then the join's steps as main reports each, every report heard
// for as long as the join runs, and again after Try again.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JoinStep } from "../../../shared/joinHere";
import type { MacJoin, MacRedeemOutcome } from "../../../shared/macSetup";
import { UiProvider } from "../../ui";
import { MacSetup } from "./MacSetup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { listeners, joins } = vi.hoisted(() => {
  const listeners = new Set<(join: MacJoin) => void>();
  const joins: Array<(join: MacJoin) => void> = [];
  const found: MacRedeemOutcome = {
    ok: true,
    found: { hubUrl: "http://devbox.example.ts.net:4790", hubName: "devbox", machineId: "mac", existing: false, here: { kind: "none" } },
  };
  vi.stubGlobal("fleetd", {
    platform: "darwin",
    macSetup: {
      redeem: () => Promise.resolve(found),
      join: () => new Promise<MacJoin>((done) => joins.push(done)),
      onJoin: (listener: (join: MacJoin) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      health: () => Promise.resolve({ health: null, writtenAt: null, checkedAt: null, now: Date.now(), hubAnswers: true }),
      openPane: () => Promise.resolve(),
      restart: () => Promise.resolve({ ok: true }),
    },
  });
  return { listeners, joins };
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  listeners.clear();
  joins.length = 0;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const titles = ["download fleetd 0.9.0, the hub's own", "check it against the release's checksums", "put it in place", "join the hub and start the node in this login"];
const steps = (at: number, last: JoinStep["state"] = "running"): JoinStep[] =>
  titles.map((title, i) => ({ title, state: i < at ? "done" : i === at ? last : "planned" }));
const report = (join: MacJoin) =>
  act(async () => {
    for (const listener of listeners) listener(join);
    await Promise.resolve();
  });
const shown = () => [...host.querySelectorAll("li[data-state]")].filter((li) => li.closest("ol")?.getAttribute("aria-label") !== "Steps").map((li) => li.getAttribute("data-state"));

const typeCode = async () => {
  const input = host.querySelector<HTMLInputElement>("#mac-code");
  if (input === null) throw new Error(host.textContent);
  await act(async () => {
    // React tracks the value it set; the prototype's setter is what typing goes through.
    Reflect.set(HTMLInputElement.prototype, "value", "482913", input);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
};

it("shows every step of the join as main reports it, not only the first", async () => {
  await act(async () => {
    root.render(
      <UiProvider>
        <MacSetup />
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await typeCode();
  expect(host.textContent).toContain("Joining devbox");
  expect(joins).toHaveLength(1);
  await report({ state: "running", steps: steps(0) });
  expect(shown()).toEqual(["running", "planned", "planned", "planned"]);
  await report({ state: "running", steps: steps(1) });
  expect(shown()).toEqual(["done", "running", "planned", "planned"]);
  await report({ state: "running", steps: steps(3) });
  expect(shown()).toEqual(["done", "done", "done", "running"]);
  expect(joins).toHaveLength(1);

  // A download that failed tries the same code again, and its steps are heard again too.
  const failed: MacJoin = { state: "failed", steps: steps(0, "failed"), failure: { message: "Couldn't download fleetd." }, retry: true };
  await report(failed);
  await act(async () => {
    joins[0]?.(failed);
    await Promise.resolve();
  });
  await settle();
  const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Try again");
  await act(async () => {
    retry?.click();
    await Promise.resolve();
  });
  await settle();
  expect(joins).toHaveLength(2);
  await report({ state: "running", steps: steps(0) });
  await report({ state: "running", steps: steps(2) });
  expect(shown()).toEqual(["done", "done", "running", "planned"]);
});
