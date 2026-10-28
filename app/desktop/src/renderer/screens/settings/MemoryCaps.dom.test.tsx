// @vitest-environment happy-dom
// Settings → Projects → Instructions & memory's caps: the hub's caps in the fields, an edit saved with memory_caps_set, a value out of range
// refused before it goes.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { MemoryCaps } from "./MemoryCaps";

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
  for (let i = 0; i < 3; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
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
const save = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Save caps");

it("shows the hub's caps and saves an edit with memory_caps_set", async () => {
  const call = vi.fn<HubApi["call"]>((_tool, input) => Promise.resolve({ ok: true, output: input }));
  const hub: HubApi = { call, subscribe: () => () => undefined, resync: () => Promise.resolve(), focus: () => Promise.resolve(), chat: () => Promise.resolve() };
  root = createRoot(host);
  act(() => {
    root?.render(
      <DataProvider layer={createDataLayer(hub)}>
        <MemoryCaps caps={{ user: 16000, index: 16000, topic: 32000, project: 128000 }} />
      </DataProvider>,
    );
  });
  expect(field("user.md")?.value).toBe("16000");
  expect(save()?.disabled).toBe(true);
  type(field("Each topic file"), "100001");
  expect(host.textContent).toContain("Each topic file: a whole number of characters from 1,000 to 100,000.");
  expect(save()?.disabled).toBe(true);
  type(field("Each topic file"), "64,000");
  type(field("user.md"), "24000");
  act(() => save()?.click());
  await settle();
  expect(call.mock.calls[0]?.slice(0, 2)).toEqual(["memory_caps_set", { user: 24000, index: 16000, topic: 64000, project: 128000 }]);
  expect(host.textContent).toContain("Saved. Writes past a cap are refused from now.");
});
