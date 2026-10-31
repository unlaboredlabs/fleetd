import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeHub } from "./hub/fake";
import { addedWords, canAdd, IMPORT_MS, importClient, importedOf, importStep, initialImport, lostAnswer, needsNavi, NO_NAVI_FIX, oldHub, OLD_HUB, type ImportMsg, type ImportState } from "./memoryImport";
import { Session } from "./session";

const run = (...msgs: ImportMsg[]): ImportState => msgs.reduce(importStep, initialImport);
const PROMPT: ImportMsg = { t: "prompt", result: { ok: true, value: "Export all of my stored memories…" } };
const REFUSED = { code: "invalid", message: "Nothing in it to remember." };

describe("Import Memory's prompt", () => {
  it("loads, then shows the hub's prompt", () => {
    expect(initialImport.prompt).toEqual({ t: "loading" });
    expect(run(PROMPT).prompt).toEqual({ t: "ready", text: "Export all of my stored memories…" });
  });

  it("says why it didn't load, and loads again on Try Again", () => {
    const failed = run({ t: "prompt", result: { ok: false, error: REFUSED } });
    expect(failed.prompt).toEqual({ t: "failed", error: REFUSED });
    expect(importStep(failed, { t: "reloadPrompt" }).prompt).toEqual({ t: "loading" });
  });

  it("says Copied once copied, until it has shown a moment; not before it has loaded", () => {
    expect(run({ t: "copied" }).copied).toBe(false);
    expect(run(PROMPT, { t: "copied" }).copied).toBe(true);
    expect(run(PROMPT, { t: "copied" }, { t: "copiedShown" }).copied).toBe(false);
  });
});

describe("Add to Memory", () => {
  it("is greyed while the box is empty or only spaces", () => {
    expect(canAdd(initialImport)).toBe(false);
    expect(canAdd(run({ t: "typed", text: "  \n " }))).toBe(false);
    expect(canAdd(run({ t: "typed", text: "[2026-01-02] - Prefers dark mode." }))).toBe(true);
    // Adding without a paste does nothing.
    expect(run({ t: "add" }).phase).toEqual({ t: "editing" });
  });

  it("works once, and the paste can't change under it", () => {
    const working = run({ t: "typed", text: "Ada, Berlin" }, { t: "add" });
    expect(working.phase).toEqual({ t: "working" });
    expect(canAdd(working)).toBe(false);
    expect(importStep(working, { t: "typed", text: "else" }).text).toBe("Ada, Berlin");
    expect(importStep(working, { t: "add" })).toBe(working);
  });

  it("says how many it added, and clears the paste", () => {
    const done = run({ t: "typed", text: "Ada, Berlin" }, { t: "add" }, { t: "added", result: { ok: true, value: { added: 7, secrets: 0, full: 0 } } });
    expect(done.phase).toEqual({ t: "done", imported: { added: 7, secrets: 0, full: 0 } });
    expect(done.text).toBe("");
  });

  it("keeps the paste after a refusal, to try again", () => {
    const failed = run({ t: "typed", text: "Ada, Berlin" }, { t: "add" }, { t: "added", result: { ok: false, error: REFUSED } });
    expect(failed.phase).toEqual({ t: "failed", error: REFUSED });
    expect(failed.text).toBe("Ada, Berlin");
    expect(canAdd(failed)).toBe(true);
    // Editing clears the error.
    expect(importStep(failed, { t: "typed", text: "Ada, Paris" }).phase).toEqual({ t: "editing" });
  });

  it("ignores an answer it isn't waiting for", () => {
    const s = run({ t: "typed", text: "Ada" });
    expect(importStep(s, { t: "added", result: { ok: true, value: { added: 3, secrets: 0, full: 0 } } })).toBe(s);
  });

  it("says how many it added, and what it left out: secrets and a full memory", () => {
    expect(addedWords({ added: 12, secrets: 0, full: 0 })).toEqual({ title: "Added 12 to Memory", detail: "Your Navis and every lead read them from now on." });
    expect(addedWords({ added: 1, secrets: 2, full: 3 }).detail).toBe(
      "Your Navis and every lead read it from now on. Left out 2 lines that looked like keys or passwords. 3 more didn't fit: your memory is full.",
    );
    expect(addedWords({ added: 0, secrets: 1, full: 0 })).toEqual({ title: "Nothing New", detail: "Your memory already has all of it. Left out 1 line that looked like a key or password." });
    expect(addedWords({ added: 0, secrets: 0, full: 4 }).title).toBe("Memory Full");
  });
});

describe("when the hub can't import", () => {
  const NO_NAVI = { code: "invalid", message: "Import memory runs in your own Navi, so nobody else can read what you paste, and you have no Navi yet.", fix: NO_NAVI_FIX };

  it("offers New Navi without one, and keeps the paste for after", () => {
    const s = run({ t: "typed", text: "Ada, Berlin" }, { t: "add" }, { t: "added", result: { ok: false, error: NO_NAVI } });
    expect(s.phase.t === "failed" && needsNavi(s.phase.error)).toBe(true);
    expect(s.text).toBe("Ada, Berlin");
    expect(canAdd(s)).toBe(true);
    // Another refusal, or a Navi's machine offline, is said as it is.
    expect(needsNavi({ code: "invalid", message: "Too long." })).toBe(false);
    expect(needsNavi({ code: "machine_offline", message: "devbox is offline." })).toBe(false);
  });

  it("says a hub from before memory_import needs an update, and adds nothing until it is", () => {
    const s = run({ t: "prompt", result: { ok: false, error: OLD_HUB } }, { t: "typed", text: "Ada" });
    expect(oldHub(s)).toBe(true);
    expect(canAdd(s)).toBe(false);
    expect(oldHub(run({ t: "prompt", result: { ok: false, error: { code: "timeout", message: "slow" } } }))).toBe(false);
  });

  it("doesn't call an answer that never came a failure: the hub may have added it", () => {
    expect(lostAnswer({ code: "disconnected", message: "The connection to the hub dropped before it answered." })).toBe(true);
    expect(lostAnswer({ code: "timeout", message: "The hub didn't answer memory_import within 300 s." })).toBe(true);
    // Never sent: nothing happened.
    expect(lostAnswer({ code: "offline", message: "Not connected to the hub." })).toBe(false);
  });

  it("waits at least as long as the hub lets the model turn run (240 s), as the desktop does", () => {
    expect(IMPORT_MS).toBeGreaterThanOrEqual(300_000);
  });
});

describe("memory_import", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const hub = fakeHub();
    const session = new Session({ hub: "http://devbox:4791", key: "key_abc", transport: hub.transport });
    session.start();
    hub.ready();
    const calls = () => hub.sentOf("call").filter((c) => c.tool === "memory_import");
    return { hub, client: importClient(session), calls };
  };
  const OUT = { prompt: "Export all of my stored memories…", added: [], skipped: [], chars: 0, cap: 4000 };

  it("asks for the prompt alone, without text", async () => {
    const { hub, client, calls } = setup();
    const prompt = client.prompt();
    expect(calls().at(-1)?.input).toEqual({});
    hub.answer("memory_import", OUT);
    await expect(prompt).resolves.toEqual({ ok: true, value: "Export all of my stored memories…" });
  });

  it("sends the paste and counts what was added and left out", async () => {
    const { hub, client, calls } = setup();
    const added = client.add("[2026-01-02] - Prefers dark mode.");
    expect(calls().at(-1)?.input).toEqual({ text: "[2026-01-02] - Prefers dark mode." });
    hub.answer("memory_import", {
      ...OUT,
      added: [{ text: "Prefers dark mode." }, { text: "Lives in Berlin.", replaced: "Lives in Paris." }],
      skipped: [
        { text: "sk-…", why: "secret" },
        { text: "Likes tea.", why: "duplicate" },
        { text: "Plays chess.", why: "full" },
      ],
    });
    await expect(added).resolves.toEqual({ ok: true, value: { added: 2, secrets: 1, full: 1 } });
  });

  it("words a hub without memory_import in the person's terms", async () => {
    const { hub, client } = setup();
    const prompt = client.prompt();
    hub.fail("memory_import", "not_found", "No tool memory_import.");
    await expect(prompt).resolves.toEqual({ ok: false, error: OLD_HUB });
  });

  it("says the hub's refusal, its fix with it", async () => {
    const { hub, client } = setup();
    const added = client.add("Ada");
    hub.fail("memory_import", "failed_precondition", "Connect your Claude account first.");
    await expect(added).resolves.toMatchObject({ ok: false, error: { message: "Connect your Claude account first." } });
  });

  it("counts an answer with nothing in it", () => {
    expect(importedOf({ added: [], skipped: [] })).toEqual({ added: 0, secrets: 0, full: 0 });
  });
});

describe("the screen", () => {
  const src = (f: string) => readFileSync(join(import.meta.dirname, f), "utf8");
  const screen = src("screens/ImportMemory.tsx");

  it("is pushed from Settings, with a small title over the Settings stack", () => {
    expect(src("screens/Settings.tsx")).toMatch(/<ListRow icon="import"[^\n]*title="Import Memory" onPress=\{\(\) => navigation\.navigate\("ImportMemory"\)\}/u);
    expect(src("../App.tsx")).toMatch(/<SettingsStack\.Screen name="ImportMemory" component=\{ImportMemory\} options=\{\{ \.\.\.pushed\(t, "Import Memory"\), headerLargeTitleEnabled: false \}\}/u);
  });

  it("keeps the paste box and Add to Memory clear of the keyboard", () => {
    expect(screen).toContain("<KeyboardAwareScrollView");
    expect(screen).toMatch(/<KeyboardStickyView offset=\{\{ closed: 0, opened: lift \}\}/u);
    expect(screen).toMatch(/bottomOffset=\{dock - lift \+ space\.lg\}/u);
  });

  it("buzzes on Copy Prompt and on the outcome", () => {
    expect(screen).toMatch(/setStringAsync\(s\.prompt\.text\);\s*haptics\.success\(\);\s*send\(\{ t: "copied" \}\)/u);
    expect(screen).toMatch(/if \(result\.ok\) haptics\.success\(\);\s*else haptics\.warning\(\);/u);
  });

  it("greys Add to Memory until something is pasted, and spins while it works", () => {
    expect(screen).toContain('label: "Add to Memory", onPress: () => void add(), disabled: !canAdd(s)');
    expect(screen).toMatch(/<Button size="large"[^\n]*busy=\{working\}/u);
  });
});
