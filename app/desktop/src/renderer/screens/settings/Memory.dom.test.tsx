// @vitest-environment happy-dom
// You › Your memory against a hub that keeps the person's memory: a person edits an entry, deletes one and undoes the
// delete from its toast, and edits the whole file as text, past the cap too; topics open in place, and the last tidy's
// line sits on top with its Undo. The same cards serve a
// project's files and the hub's Shared memory (Memory.tsx).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessage, MemoryFile, MemoryGetOutput, MemorySetInput } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { live, project, snapshot } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { YourMemory } from "./Memory";

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

const AT = "2026-10-19T10:21:00.000Z";

/** A hub with user.md as `text`, a note for the line the lead wrote, and every memory_set kept. */
async function mount(text: string, refuse?: HubError, extra: Partial<MemoryGetOutput> = {}) {
  const hub = { text, sets: [] as MemorySetInput[], calls: [] as { tool: string; input: unknown }[] };
  const user = (): MemoryFile => ({
    scope: "user",
    text: hub.text,
    chars: Array.from(hub.text).length,
    cap: 4000,
    notes: [{ text: "Concise. State first.", at: AT, projectRef: project, messageId: "m12" }],
  });
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const api: HubApi = {
    call: (tool, input) => {
      hub.calls.push({ tool, input });
      if (tool === "memory_set") {
        if (refuse) return Promise.resolve({ ok: false, error: refuse });
        const set = input as MemorySetInput;
        // Written a moment later, as over the link: a second click lands while the first write is out.
        return new Promise((done) =>
          setTimeout(() => {
            hub.sets.push(set);
            hub.text = set.text;
            done({ ok: true, output: { file: user() } });
          }, 0),
        );
      }
      if (tool === "memory_get") return Promise.resolve({ ok: true, output: { user: user(), ...extra } });
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
          <YourMemory />
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

/** Lets the queries, calls and refetches finish. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });

const cards = () => Array.from(document.querySelectorAll('ul[aria-label="Entries of your memory"] > li')).map((li) => li.textContent);

const button = (name: string): HTMLButtonElement => {
  const found = Array.from(document.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === name || b.textContent.trim() === name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
};

const click = async (name: string) => {
  act(() => {
    button(name).click();
  });
  await settle();
};

const type = (field: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  act(() => {
    const proto = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const textarea = (label: string): HTMLTextAreaElement => {
  const found = Array.from(document.querySelectorAll("textarea")).find(
    (t) => t.getAttribute("aria-label") === label || (t.id !== "" && document.querySelector(`label[for="${t.id}"]`)?.textContent === label),
  );
  if (!found) throw new Error(`no textarea ${label}`);
  return found;
};

const FILE = "# Style\n- Concise. State first.\n- No npm.\n- Never estimate time.\n";

it("lists your memory as one card per entry, with the lead's source and time only where the hub knows it", async () => {
  await mount(FILE);
  const list = cards();
  expect(list).toHaveLength(4);
  expect(list[0]).toBe("Style");
  expect(list[1]).toContain("Concise. State first.");
  // Where it came from is the entry's chat mark, named for assistive tech and in its tooltip.
  const sources = Array.from(document.querySelectorAll('ul[aria-label="Entries of your memory"] > li')).map((li) => li.querySelector("a")?.getAttribute("aria-label") ?? "");
  expect(sources[1]).toContain("Remembered by the lead");
  // An entry with no note says nothing about where it came from.
  expect(sources[2]).toBe("");
  const link = document.querySelector<HTMLAnchorElement>('ul[aria-label="Entries of your memory"] a');
  expect(link?.getAttribute("href")).toContain("m12");
  expect(document.querySelector('[role="meter"]')?.getAttribute("aria-valuetext")).toBe(`${String(FILE.length)} of 4,000 characters`);
});

it("has no caps to set", async () => {
  await mount(FILE);
  expect(document.body.textContent).not.toContain("Memory caps");
  expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Save caps")).toBe(false);
});

it("edits one entry in place", async () => {
  const hub = await mount(FILE);
  await click("Edit “No npm.”");
  type(textarea("Edit the entry in your memory"), "No npm: use pnpm.");
  await click("Save");
  expect(hub.sets).toEqual([{ scope: "user", text: "# Style\n- Concise. State first.\n- No npm: use pnpm.\n- Never estimate time.\n" }]);
  expect(cards()[2]).toContain("No npm: use pnpm.");
});

it("deletes an entry without a confirm, and Undo in the toast puts it back where it was", async () => {
  const hub = await mount(FILE);
  await click("Delete “No npm.”");
  expect(hub.text).toBe("# Style\n- Concise. State first.\n- Never estimate time.\n");
  expect(cards().join("|")).not.toContain("No npm.");
  expect(document.body.textContent).toContain("Deleted from your memory");
  // The lead remembers something meanwhile; undo keeps it.
  hub.text += "- Plain words.\n";
  await click("Undo");
  expect(hub.text).toBe(`${FILE}- Plain words.\n`);
  expect(document.body.textContent).toContain("Put back in your memory");
});

it("an entry's right-click menu edits or deletes it", async () => {
  const hub = await mount(FILE);
  const menu = async (entry: string, label: string) => {
    const card = Array.from(document.querySelectorAll('ul[aria-label="Entries of your memory"] > li > div')).find((d) => d.textContent.startsWith(entry));
    act(() => {
      card?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    const items = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']"));
    expect(items.map((i) => i.textContent)).toEqual(["Edit", "Delete"]);
    act(() => items.find((i) => i.textContent === label)?.click());
    await settle();
  };
  await menu("No npm.", "Edit");
  expect(textarea("Edit the entry in your memory").value).toBe("No npm.");
  await click("Cancel");
  await menu("Never estimate time.", "Delete");
  expect(hub.text).toBe("# Style\n- Concise. State first.\n- No npm.\n");
  // Its toast's Undo, as the button's delete has.
  await click("Undo");
  expect(hub.text).toBe(FILE);
});

it("edits the whole file as text, and past the cap it still saves: the hub tidies it", async () => {
  const hub = await mount(FILE);
  await click("Edit as text");
  const field = textarea("All of your memory");
  expect(field.value).toBe(FILE);
  type(field, `- ${"x".repeat(4001)}\n`);
  expect(document.body.textContent).not.toContain("Past the cap");
  await click("Save");
  expect(hub.sets.map((x) => x.text.length)).toEqual([4004]);
});

it("shows the hub's refusal of a save, and why", async () => {
  const hub = await mount(FILE, { code: "invalid", message: "That looks like a secret, and memory never holds one." });
  await click("Edit as text");
  type(textarea("All of your memory"), "- Short.\n");
  await click("Save");
  expect(hub.sets).toEqual([]);
  expect(document.body.textContent).toContain("That looks like a secret");
});

it("shows the entry again after Undo, when the file reads exactly as it did before the delete", async () => {
  const hub = await mount(FILE);
  await click("Delete “No npm.”");
  expect(cards()).toHaveLength(3);
  await click("Undo");
  expect(hub.text).toBe(FILE);
  expect(cards()).toHaveLength(4);
  expect(cards()[2]).toContain("No npm.");
});

it("applies two quick deletes one after the other, so the second never puts the first back", async () => {
  const hub = await mount(FILE);
  act(() => {
    button("Delete “No npm.”").click();
    button("Delete “Never estimate time.”").click();
  });
  await settle();
  expect(hub.sets.map((x) => x.text)).toEqual(["# Style\n- Concise. State first.\n- Never estimate time.\n", "# Style\n- Concise. State first.\n"]);
  expect(hub.text).toBe("# Style\n- Concise. State first.\n");
});

it("builds an edit from the file as the hub has it now, keeping what the lead wrote since the page read it", async () => {
  const hub = await mount(FILE);
  hub.text = `- Plain words.\n${FILE}`;
  await click("Edit “No npm.”");
  type(textarea("Edit the entry in your memory"), "No npm: use pnpm.");
  await click("Save");
  expect(hub.text).toBe("- Plain words.\n# Style\n- Concise. State first.\n- No npm: use pnpm.\n- Never estimate time.\n");
});

it("keeps a file's section and its Edit as text when a search matches none of its entries", async () => {
  await mount(FILE);
  const search = document.querySelector<HTMLInputElement>('input[aria-label="Search your memory"]');
  if (!search) throw new Error("no search");
  type(search, "zebra");
  expect(cards()).toEqual([]);
  expect(document.body.textContent).toContain("No entry here matches.");
  expect(button("Edit as text").disabled).toBe(false);
  type(search, "npm");
  expect(cards()).toHaveLength(1);
});

it("lists your topics as rows that open in place, and edits one as its own file", async () => {
  const topic: MemoryFile = { scope: "user", topic: "phone", text: "- Judge it on a real simulator.\n", chars: 32, cap: 32000, notes: [] };
  const hub = await mount(`${FILE}- [phone](phone.md)\n`, undefined, { userFiles: [topic] });
  // The core's topic line is the row, not a card.
  expect(cards()).toHaveLength(4);
  expect(document.body.textContent).not.toContain("Judge it on a real simulator.");
  await click("phone");
  expect(document.body.textContent).toContain("Judge it on a real simulator.");
  await click("Delete “Judge it on a real simulator.”");
  expect(hub.sets).toEqual([{ scope: "user", topic: "phone", text: "" }]);
});

it("puts the last tidy's line on top, with Undo all", async () => {
  const tidied = {
    messageId: "m40",
    projectRef: project,
    author: "system",
    text: "Memory refreshed: +1 ~1 −1",
    createdAt: AT,
    memoryRefreshed: {
      items: [
        { scope: "user", text: "pnpm only.", replaced: "Use npm." },
        { scope: "user", topic: "release", text: "Tag from main." },
        { scope: "user", text: "Tag from main.", forgotten: true },
      ],
    },
  } as unknown as ChatMessage;
  const hub = await mount(FILE, undefined, { tidied });
  const top = document.querySelector("[data-memory-tidied]");
  expect(top?.textContent).toContain("Memory tidied: 1 added, 1 updated, 1 removed");
  await click("Undo all");
  expect(hub.calls.find((c) => c.tool === "memory_undo")?.input).toEqual({ projectRef: project, messageId: "m40" });
});

it("says why your memory's last tidy didn't run", async () => {
  await mount(FILE, undefined, { tidyRun: { state: "failed", trigger: "schedule", at: AT, added: 0, replaced: 0, removed: 0, why: "No bot's machine can run it now." } });
  expect(document.querySelector("[data-memory-tidy-failed]")?.textContent).toBe("Your memory's last tidy didn't run: No bot's machine can run it now.");
});
