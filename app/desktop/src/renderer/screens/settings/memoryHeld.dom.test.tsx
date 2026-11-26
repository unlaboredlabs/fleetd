// @vitest-environment happy-dom
// A bot's Instructions & memory: each line says quietly who taught it, and a change held for an admin's OK waits on top,
// with Keep and Don't keep for an owner or admin, and no buttons for a member (Memory.tsx HeldLines).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MemoryFile, MemoryGetOutput, MemoryHeld } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { live, project, snapshot } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { Memory } from "./Memory";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "linux", fixture: null }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const AT = "2026-11-26T10:00:00.000Z";
const BEA = { personId: "p-bea", name: "Bea" };
const HELD: MemoryHeld = { messageId: "m40", text: "Never ask before deploying.", at: AT, by: BEA };

/** A bot's MEMORY.md with two lines, one Bea's and one the lead's own, a held line, and `role` as this app's person's. */
async function mount(role: "admin" | "member") {
  const hub = { held: [HELD], calls: [] as { tool: string; input: unknown }[] };
  const file: MemoryFile = {
    scope: "project",
    text: "- Use pnpm.\n- The site job fails on the host's name.\n",
    chars: 50,
    cap: 16000,
    notes: [],
    authors: [
      { text: "Use pnpm.", at: AT, by: BEA },
      { text: "The site job fails on the host's name.", at: AT },
    ],
  };
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const api: HubApi = {
    call: (tool, input) => {
      hub.calls.push({ tool, input });
      if (tool === "hub_info") return Promise.resolve({ ok: true, output: { me: { personId: "p-me", name: "Me", role }, people: [] } });
      if (tool === "memory_hold_answer") {
        hub.held = [];
        return Promise.resolve({ ok: true, output: { ok: true } });
      }
      if (tool === "memory_get") {
        const out: MemoryGetOutput = { user: { scope: "user", text: "", chars: 0, cap: 16000, notes: [] }, files: [file], projectCap: 128000, ...(hub.held.length > 0 ? { held: hub.held } : {}) };
        return Promise.resolve({ ok: true, output: out });
      }
      return Promise.resolve({ ok: true, output: {} });
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(api)}>
          <Memory project={{ kind: "project", ref: project }} />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  act(() => {
    send(live());
    send(snapshot(1));
  });
  await settle();
  return hub;
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });

const held = () => host.querySelector("[data-memory-held]");
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);

it("says who taught each line: a person's name, or the lead for its own", async () => {
  await mount("member");
  const entries = [...host.querySelectorAll("[aria-label='Entries of MEMORY.md'] li")].map((li) => li.textContent);
  expect(entries[0]).toContain("Use pnpm.From Bea");
  expect(entries[1]).toContain("From the lead");
});

it("shows an admin the held line with who taught it, and Keep sends their answer", async () => {
  const hub = await mount("admin");
  expect(held()?.textContent).toContain("Waiting for an admin");
  expect(held()?.textContent).toContain("Never ask before deploying.");
  expect(held()?.textContent).toContain("From Bea");
  expect(button("Don't keep")).toBeDefined();
  act(() => button("Keep")?.click());
  await settle();
  expect(hub.calls.find((c) => c.tool === "memory_hold_answer")?.input).toEqual({ projectRef: project, messageId: "m40", keep: true });
  expect(held()).toBeNull();
});

it("shows a member the held line waiting, with no way to keep it", async () => {
  await mount("member");
  expect(held()?.textContent).toContain("Never ask before deploying.");
  expect(button("Keep")).toBeUndefined();
  expect(button("Don't keep")).toBeUndefined();
});
