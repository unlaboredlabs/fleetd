import { describe, expect, it } from "vitest";
import { SHORTCUTS, accelerator, display, parseChord, shortcutFor, type KeyInput } from "./shortcuts";

const key = (k: string, code: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("shortcut map", () => {
  it("gives every chord to exactly one command", () => {
    const seen = new Map<string, string>();
    for (const [id, s] of Object.entries(SHORTCUTS)) {
      const chord = JSON.stringify(parseChord(s.keys));
      expect(seen.get(chord), `${id} reuses ${s.keys}`).toBeUndefined();
      seen.set(chord, id);
    }
  });

  it("matches ⌘ on macOS and Ctrl elsewhere, never both", () => {
    expect(shortcutFor(key("k", "KeyK", { metaKey: true }), "darwin")).toBe("palette.toggle");
    expect(shortcutFor(key("k", "KeyK", { ctrlKey: true }), "linux")).toBe("palette.toggle");
    expect(shortcutFor(key("k", "KeyK", { ctrlKey: true }), "darwin")).toBeUndefined();
    expect(shortcutFor(key("k", "KeyK", { metaKey: true, ctrlKey: true }), "darwin")).toBeUndefined();
    expect(shortcutFor(key("k", "KeyK"), "darwin")).toBeUndefined();
  });

  it("tells Status (⌘.) from Stop (⌘⇧.) by the physical key, whatever Shift types", () => {
    expect(shortcutFor(key(".", "Period", { metaKey: true }), "darwin")).toBe("status.toggle");
    expect(shortcutFor(key(">", "Period", { metaKey: true, shiftKey: true }), "darwin")).toBe("order.stop");
    expect(shortcutFor(key("1", "Digit1", { ctrlKey: true }), "linux")).toBe("order.open.1");
    expect(shortcutFor(key("0", "Numpad0", { ctrlKey: true }), "linux")).toBe("board.open");
  });

  it("writes keys as each platform reads them, and as Electron's accelerators", () => {
    expect(display("order.stop", "darwin")).toBe("⇧⌘.");
    expect(display("order.stop", "linux")).toBe("Ctrl+Shift+.");
    expect(display("palette.toggle", "darwin")).toBe("⌘K");
    expect(accelerator("order.stop")).toBe("CmdOrCtrl+Shift+.");
    expect(accelerator("settings.open")).toBe("CmdOrCtrl+,");
  });
});
