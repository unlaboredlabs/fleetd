// @vitest-environment happy-dom
// A bot's Instructions & memory: each line says quietly who taught it, and a change held for an admin's OK waits on top,
// with Keep and Don't keep for an owner or admin, and no buttons for a member (Memory.tsx HeldLines). However big the
// memory, the page stays short: the core shows its first lines, each one line until opened, and topics fold to a row.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MemoryFile, MemoryGetOutput, MemoryHeld } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { live, project, snapshot } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { HeldMemory, Memory } from "./Memory";
import { revealNext } from "./reveal";

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
const SMALL = "- Use pnpm.\n- The site job fails on the host's name.\n";

/**
 * A bot's MEMORY.md (`core`: by default two lines, one Bea's and one the lead's own), its topics, the held lines, and
 * `role` as this app's person's.
 */
async function mount(role: "admin" | "member", { core = SMALL, topics = [] as MemoryFile[], held = [HELD] } = {}) {
  const hub = { held, calls: [] as { tool: string; input: unknown }[] };
  const file: MemoryFile = {
    scope: "project",
    text: core,
    chars: core.length,
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
        const id = (input as { messageId: string }).messageId;
        hub.held = hub.held.filter((h) => h.messageId !== id);
        return Promise.resolve({ ok: true, output: { ok: true } });
      }
      if (tool === "memory_get") {
        const out: MemoryGetOutput = { user: { scope: "user", text: "", chars: 0, cap: 16000, notes: [] }, files: [file, ...topics], projectCap: 128000, ...(hub.held.length > 0 ? { held: hub.held } : {}) };
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
          <HeldMemory project={{ kind: "project", ref: project }} />
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

it("says who taught each line: a person's name at its end, and opened, the lead for its own", async () => {
  await mount("member");
  const entries = () => [...host.querySelectorAll("[aria-label='Entries of MEMORY.md'] li")];
  expect(entries()[0]?.textContent).toContain("Use pnpm.Bea");
  expect(entries()[1]?.textContent).not.toContain("the lead");
  act(() => entries()[1]?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click());
  expect(entries()[1]?.textContent).toContain("From the lead");
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

const heldOf = (n: number): MemoryHeld[] => Array.from({ length: n }, (_, i) => ({ messageId: `m${String(50 + i)}`, text: `Never ask before step ${String(i)}.`, at: AT }));

it("puts the waiting changes before the instructions' and memory's, the first three shown, and Keep all keeps each", async () => {
  const hub = await mount("admin", { held: heldOf(6) });
  expect(host.firstElementChild?.hasAttribute("data-memory-held")).toBe(true);
  expect(held()?.textContent).toContain("6 changes");
  expect(held()?.querySelectorAll("li").length).toBe(4);
  act(() => button("Show 3 more")?.click());
  expect(held()?.querySelectorAll("li").length).toBe(7);
  act(() => button("Keep all 6")?.click());
  await settle();
  expect(hub.calls.filter((c) => c.tool === "memory_hold_answer").map((c) => (c.input as { messageId: string; keep: boolean }))).toEqual(
    heldOf(6).map((h) => ({ projectRef: project, messageId: h.messageId, keep: true })),
  );
  expect(held()).toBeNull();
});

it("shows a member no Keep all", async () => {
  await mount("member", { held: heldOf(3) });
  expect([...host.querySelectorAll("button")].some((b) => b.textContent.startsWith("Keep all"))).toBe(false);
});

it("shows a long core's first six lines and Show all, and a search every match", async () => {
  const core = Array.from({ length: 30 }, (_, i) => `- Line ${String(i)} of a long memory.\n`).join("");
  await mount("member", { core, held: [] });
  const entries = () => host.querySelectorAll("[aria-label='Entries of MEMORY.md'] li");
  expect(entries().length).toBe(7);
  act(() => button("Show all 30")?.click());
  expect(entries().length).toBe(31);
  act(() => button("Show fewer")?.click());
  const search = host.querySelector<HTMLInputElement>("input[aria-label='Search memory']");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "line 2");
    search?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Lines 2, 12 and 20 to 29, each with both words: every match, none folded.
  expect(entries().length).toBe(12);
});

it("folds each topic to one row with its count, opened in place", async () => {
  const topic: MemoryFile = { scope: "project", topic: "deploys", text: "- Staging first.\n- Releases go out Tuesdays.\n", chars: 44, cap: 32000, notes: [] };
  await mount("member", { topics: [topic], held: [] });
  const row = host.querySelector("[data-memory-topic='deploys']");
  expect(row?.textContent).toContain("2 lines");
  expect(row?.textContent).not.toContain("Staging first.");
  act(() => row?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click());
  expect(row?.textContent).toContain("Staging first.");
});

it("lands from the chat's Review on the list itself, never on Keep all, so a stray Enter keeps nothing", async () => {
  revealNext("memory-held");
  const hub = await mount("admin", { held: heldOf(4) });
  expect(document.activeElement).toBe(held());
  expect(document.activeElement?.textContent).toContain("Keep all 4");
  expect(document.activeElement?.tagName).not.toBe("BUTTON");
  // Enter on the focused list presses nothing.
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
  expect(hub.calls.some((c) => c.tool === "memory_hold_answer")).toBe(false);
});

it("keeps each entry's words plain text to select and copy; only its chevron opens it", async () => {
  await mount("member", { held: heldOf(1) });
  for (const list of ["[aria-label='Entries of MEMORY.md']", "[aria-label='Waiting for an admin']"]) {
    const li = host.querySelector(`${list} li`);
    const words = [...(li?.querySelectorAll("span, p") ?? [])].find((e) => e.textContent.startsWith("Use pnpm.") || e.textContent.startsWith("Never ask"));
    expect(words?.closest("button")).toBeNull();
    const chevron = li?.querySelector<HTMLButtonElement>("button[aria-expanded]");
    act(() => (words as HTMLElement | undefined)?.click());
    expect(chevron?.getAttribute("aria-expanded")).toBe("false");
    act(() => chevron?.click());
    expect(chevron?.getAttribute("aria-expanded")).toBe("true");
  }
});
