import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addedWords, canAdd, importStep, initialImport, unsupported, type ImportMsg, type ImportState } from "./memoryImport";

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

  it("says so on a hub without the import calls", async () => {
    await expect(unsupported.prompt()).resolves.toMatchObject({ ok: false, error: { message: "This hub can't import memory yet." } });
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
    const done = run({ t: "typed", text: "Ada, Berlin" }, { t: "add" }, { t: "added", result: { ok: true, value: { added: 7 } } });
    expect(done.phase).toEqual({ t: "done", added: 7 });
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
    expect(importStep(s, { t: "added", result: { ok: true, value: { added: 3 } } })).toBe(s);
  });

  it("words the count, none and one included", () => {
    expect(addedWords(0)).toEqual({ title: "Nothing New", detail: "Your memory already has all of it." });
    expect(addedWords(1).title).toBe("Added 1 Entry");
    expect(addedWords(12).title).toBe("Added 12 Entries");
  });
});

describe("the screen", () => {
  const src = (f: string) => readFileSync(join(import.meta.dirname, f), "utf8");
  const screen = src("screens/ImportMemory.tsx");

  it("is pushed from Settings, with a small title over the Settings stack", () => {
    expect(src("screens/Settings.tsx")).toMatch(/<ListRow icon="import"[^\n]*title="Import Memory" onPress=\{\(\) => navigation\.navigate\("ImportMemory"\)\}/u);
    expect(src("../App.tsx")).toMatch(/<SettingsStack\.Screen name="ImportMemory" component=\{ImportMemory\} options=\{\{ title: "Import Memory", headerLargeTitleEnabled: false/u);
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
