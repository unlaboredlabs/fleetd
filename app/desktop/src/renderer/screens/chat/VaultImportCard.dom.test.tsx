// @vitest-environment happy-dom
// A lead's import card: each item ticked, an untick leaves it out, Import sends only the ticked ones with the
// proposal (the one confirm in the vault), Dismiss turns it down; then one quiet line says how it went.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VaultImportCard } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { VaultImportCardView } from "./VaultImportCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const card: VaultImportCard = {
  proposalId: "VI1",
  state: "open",
  scope: "person",
  why: "To sign in to Amazon for the order.",
  items: [
    { ref: "op://fleetd/Amazon", kind: "login", title: "Amazon", site: "amazon.com" },
    { ref: "op://fleetd/Visa", kind: "card", title: "Visa" },
  ],
};

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;

beforeEach(() => {
  calls = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async () => {
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      return Promise.resolve({ ok: true, output: (input as { dismiss?: boolean }).dismiss === true ? { items: [], errors: [] } : { items: [{ itemId: "V1" }], errors: [] } });
    },
    subscribe: () => () => undefined,
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <VaultImportCardView card={card} at="14:02" />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
};
const click = async (el: Element | null | undefined) => {
  if (!(el instanceof HTMLElement)) throw new Error("nothing to click");
  await act(async () => {
    el.click();
    await new Promise((r) => setTimeout(r, 0));
  });
};
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === text);

it("imports only the ticked items, with the proposal, then says how it went", async () => {
  await render();
  expect(host.textContent).toContain("To sign in to Amazon for the order.");
  expect(host.textContent).toContain("Login · amazon.com");
  await click(host.querySelectorAll("[role='checkbox']")[1]);
  await click(button("Import 1"));
  expect(calls).toEqual([{ tool: "vault_import", input: { proposalId: "VI1", refs: ["op://fleetd/Amazon"], scope: "person" } }]);
  expect(host.textContent).toContain("Imported 1 item into your vault");
});

it("turns it down with Dismiss, reading nothing from 1Password", async () => {
  await render();
  await click(button("Dismiss"));
  expect(calls).toEqual([{ tool: "vault_import", input: { proposalId: "VI1", dismiss: true } }]);
  expect(host.textContent).toContain("Not imported");
});
