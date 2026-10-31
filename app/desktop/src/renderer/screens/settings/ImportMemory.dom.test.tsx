// @vitest-environment happy-dom
// You › Your memory › Import memory against a hub that has memory_import: the hub's export prompt in a card with Copy
// prompt, a paste box, and Add to Memory, off while the box is empty, "Adding to Memory…" while the hub reads it, then
// how many went in and what didn't fit. A hub without the call shows no section.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MemoryImportInput, MemoryImportOutput } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { live, snapshot } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { ImportMemory } from "./ImportMemory";
import { YourMemory } from "./Memory";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const copied: string[] = [];
vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "linux", fixture: null, copy: (text: string) => (copied.push(text), Promise.resolve()) }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  copied.length = 0;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const PROMPT = "Export everything you have stored about me in memory.\n\n## Categories (in this order)\n1. **Instructions**";

const ADDED: MemoryImportOutput = {
  prompt: PROMPT,
  added: [{ text: "Keep answers short." }, { text: "Prefers TypeScript over JavaScript." }, { text: "Staff engineer at Acme.", replaced: "Senior engineer at Acme." }],
  skipped: [
    { text: "Speaks English.", why: "duplicate" },
    { text: "Deploy notes: the staging key is [secret]", why: "secret" },
    { text: "Ledgerline: a bookkeeping API in Rust.", why: "full" },
  ],
  chars: 3990,
  cap: 4000,
};

/** Your memory above it, as on the page, and a hub whose memory_import answers the prompt at once and an import when `finish` is called; every call kept. */
async function mount(missing?: HubError) {
  const hub = {
    imports: [] as { input: MemoryImportInput; timeoutMs: number | undefined }[],
    gets: 0,
    finish: (_: MemoryImportOutput): void => undefined,
  };
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const api: HubApi = {
    call: (tool, input, options) => {
      if (tool === "memory_import") {
        if (missing) return Promise.resolve({ ok: false, error: missing });
        const i = input as MemoryImportInput;
        if (!i.text) return Promise.resolve({ ok: true, output: { prompt: PROMPT, added: [], skipped: [], chars: 0, cap: 4000 } });
        hub.imports.push({ input: i, timeoutMs: options?.timeoutMs });
        return new Promise((done) => {
          hub.finish = (output) => done({ ok: true, output });
        });
      }
      if (tool === "memory_get") {
        hub.gets++;
        return Promise.resolve({ ok: true, output: { user: { scope: "user", text: "", chars: 0, cap: 4000, notes: [] } } });
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
          <YourMemory />
          <ImportMemory />
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

const button = (name: string): HTMLButtonElement => {
  const found = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
};

const paste = (value: string) => {
  const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="The other assistant\'s answer"]');
  if (!box) throw new Error("no paste box");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return box;
};

const status = () => document.querySelector('section[aria-label="Import memory"] [role="status"]')?.textContent ?? "";

it("shows the two steps with the hub's prompt, and copies it whole", async () => {
  await mount();
  const text = host.textContent;
  expect(text).toContain("1. Copy this prompt into a chat with your other AI assistant");
  expect(text).toContain("2. Paste the answer below to add it to your memory");
  expect(text).toContain("Export everything you have stored about me in memory.");
  await act(async () => {
    button("Copy prompt").click();
    await Promise.resolve();
  });
  expect(copied).toEqual([PROMPT]);
  expect(button("Copied")).toBeTruthy();
});

it("adds a pasted answer to your memory and says how many went in and what didn't fit", async () => {
  const hub = await mount();
  expect(button("Add to Memory").disabled).toBe(true);
  paste("   ");
  expect(button("Add to Memory").disabled).toBe(true);
  const box = paste("```\n## Instructions\n[2024-03-02] - Keep answers short.\n```");
  expect(button("Add to Memory").disabled).toBe(false);

  await act(async () => {
    button("Add to Memory").click();
    await Promise.resolve();
  });
  // Working: the button says so and stays off, and the box can't change under it.
  expect(button("Adding to Memory…").disabled).toBe(true);
  expect(box.disabled).toBe(true);
  expect(hub.imports).toHaveLength(1);
  expect(hub.imports[0]?.input.text).toContain("Keep answers short.");
  expect(hub.imports[0]?.timeoutMs).toBe(300_000);

  const gets = hub.gets;
  act(() => hub.finish(ADDED));
  await settle();
  expect(status()).toContain("Added 3 entries to your memory. Skipped 1 already there, 1 holding a secret.");
  expect(status()).toContain("1 entry didn't fit under your memory's cap of 4,000 characters");
  const left = Array.from(document.querySelectorAll('ul[aria-label="Left out"] li')).map((li) => li.textContent);
  expect(left).toEqual(["Ledgerline: a bookkeeping API in Rust."]);
  expect(status()).not.toContain("[secret]");
  // The box is cleared for the next one, and the memory list reads again.
  expect(box.value).toBe("");
  expect(button("Add to Memory").disabled).toBe(true);
  expect(hub.gets).toBeGreaterThan(gets);
});

it("says so when nothing was new", async () => {
  const hub = await mount();
  paste("[2024-03-02] - Keep answers short.");
  await act(async () => {
    button("Add to Memory").click();
    await Promise.resolve();
  });
  act(() => hub.finish({ prompt: PROMPT, added: [], skipped: [{ text: "Keep answers short.", why: "duplicate" }], chars: 20, cap: 4000 }));
  await settle();
  expect(status()).toBe("Nothing new to add: your memory already says it. Skipped 1 already there.");
});

it("shows nothing on a hub from before Import memory", async () => {
  await mount({ code: "not_found", message: "Unknown tool memory_import." });
  expect(document.querySelector('section[aria-label="Import memory"]')).toBeNull();
});
