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

  it("matches punctuation and digits by the physical key, whatever Shift types", () => {
    expect(shortcutFor(key(".", "Period", { metaKey: true }), "darwin")).toBe("status.toggle");
    expect(shortcutFor(key(">", "Period", { metaKey: true, shiftKey: true }), "darwin")).toBeUndefined();
    expect(shortcutFor(key("[", "BracketLeft", { metaKey: true }), "darwin")).toBe("project.previous");
    expect(shortcutFor(key("1", "Digit1", { ctrlKey: true }), "linux")).toBe("project.open.1");
    expect(shortcutFor(key("1", "Numpad1", { ctrlKey: true }), "linux")).toBe("project.open.1");
  });

  it("hands a page back on ⌘⇧↩ (Ctrl+Shift+Enter), the keypad's Enter too, and never on Enter alone", () => {
    expect(shortcutFor(key("Enter", "Enter", { metaKey: true, shiftKey: true }), "darwin")).toBe("session.handBack");
    expect(shortcutFor(key("Enter", "NumpadEnter", { ctrlKey: true, shiftKey: true }), "linux")).toBe("session.handBack");
    expect(shortcutFor(key("Enter", "Enter", { ctrlKey: true }), "linux")).toBeUndefined();
    expect(shortcutFor(key("Enter", "Enter", { shiftKey: true }), "linux")).toBeUndefined();
    expect(display("session.handBack", "darwin")).toBe("⇧⌘↩");
    expect(display("session.handBack", "linux")).toBe("Ctrl+Shift+Enter");
    expect(accelerator("session.handBack")).toBe("CmdOrCtrl+Shift+Enter");
  });

  it("matches ⌥⌘A though Option types another letter on macOS", () => {
    expect(shortcutFor(key("å", "KeyA", { metaKey: true, altKey: true }), "darwin")).toBe("project.nextNeedsYou");
    expect(shortcutFor(key("a", "KeyA", { ctrlKey: true, altKey: true }), "linux")).toBe("project.nextNeedsYou");
    expect(shortcutFor(key("å", "KeyA", { metaKey: true }), "darwin")).toBeUndefined();
    expect(display("project.nextNeedsYou", "darwin")).toBe("⌥⌘A");
  });

  it("writes keys as each platform reads them, and as Electron's accelerators", () => {
    expect(display("composer.attach", "darwin")).toBe("⇧⌘A");
    expect(display("composer.attach", "linux")).toBe("Ctrl+Shift+A");
    expect(display("palette.toggle", "darwin")).toBe("⌘K");
    expect(accelerator("project.next")).toBe("CmdOrCtrl+]");
    expect(accelerator("settings.open")).toBe("CmdOrCtrl+,");
  });
});
