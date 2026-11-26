// @vitest-environment happy-dom
// New workspace's dialog: a name (or none), the cloud's refusal shown as written with what to do, and once made the
// app on the new workspace's Get started. And which workspace it is asked on.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NewWorkspaceOutcome } from "../../../shared/cloud";
import { UiProvider } from "../../ui";
import { askedOn, NewWorkspaceDialog } from "./NewWorkspace";

// The window's workspaces, which main's list adds the new one to after its answer.
const known = vi.hoisted(() => ({ hubs: [{ id: "acme" }, { id: "own" }] as Array<{ id: string }>, listeners: new Set<() => void>() }));
vi.mock("../../src/data/react", () => {
  const set = {
    getState: () => ({ hubs: known.hubs }),
    subscribe: (l: (s: { hubs: Array<{ id: string }> }) => void) => {
      const each = () => l({ hubs: known.hubs });
      known.listeners.add(each);
      return () => void known.listeners.delete(each);
    },
  };
  return { useHubSet: () => set };
});
const listed = (ids: string[]) =>
  act(() => {
    known.hubs = ids.map((id) => ({ id }));
    for (const l of known.listeners) l();
  });

const asked: Array<[string, string]> = [];
let answer: NewWorkspaceOutcome = { ok: true, hub: "side" };
vi.stubGlobal("fleetd", {
  platform: "linux",
  cloud: {
    newWorkspace: (from: string, name: string) => {
      asked.push([from, name]);
      return Promise.resolve(answer);
    },
  },
});

let host: HTMLDivElement;
let root: Root;
let closed = 0;

beforeEach(() => {
  asked.length = 0;
  closed = 0;
  known.hubs = [{ id: "acme" }, { id: "own" }];
  window.location.hash = "#/";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <UiProvider>
        <NewWorkspaceDialog from="acme" open onClose={() => closed++} />
      </UiProvider>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const field = () => document.querySelector<HTMLInputElement>("[role='dialog'] input");
const type = (value: string) =>
  act(() => {
    const input = field();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].find((b) => b.textContent === name);
const create = () =>
  act(async () => {
    button("Create")?.click();
    await Promise.resolve();
  });

it("makes the workspace named, asked on the one given, then opens on its Get started once the window lists it", async () => {
  type("Side project");
  await create();
  expect(asked).toEqual([["acme", "Side project"]]);
  expect(closed).toBe(1);
  expect(window.location.hash).toBe("#/");
  listed(["acme", "own", "side"]);
  expect(window.location.hash).toBe("#/start?at=side");
});

it("shows the cloud's refusal and what to do, and stays open", async () => {
  answer = { ok: false, failure: { code: "workspace_cap", message: "You've made 10 workspaces, the most one person can have.", fix: "Delete one you don't use in Settings › Workspace, then make a new one." } };
  await create();
  expect(asked).toEqual([["acme", ""]]);
  expect(closed).toBe(0);
  expect(document.querySelector("[role='alert']")?.textContent).toBe("You've made 10 workspaces, the most one person can have.Delete one you don't use in Settings › Workspace, then make a new one.");
  answer = { ok: true, hub: "side" };
});

it("takes 60 characters at most before it asks", () => {
  type("x".repeat(61));
  expect(button("Create")?.disabled).toBe(true);
  expect(document.querySelector("[role='dialog']")?.textContent).toContain("60 characters at most.");
});

it("is asked on the workspace on show when it is one of the account's, else the first of them; never a self-hosted one", () => {
  const hubs = [{ id: "own" }, { id: "acme", cloud: true as const }, { id: "side", cloud: true as const }, { id: "coded", cloud: true as const, codePaired: true as const }];
  expect(askedOn(hubs, "side")).toBe("side");
  expect(askedOn(hubs, "own")).toBe("acme");
  expect(askedOn(hubs, "coded")).toBe("acme");
  expect(askedOn([{ id: "own" }], "own")).toBeNull();
});
