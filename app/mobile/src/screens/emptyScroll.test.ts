// An empty screen stops scrolling at its content. Under iOS's automatic insets a scroll view's frame runs under the
// header and the tab bar, and their heights are added around its content: content stretched to the frame's height
// (flexGrow, minHeight: "100%", a flex: 1 empty state) is then taller than what shows by exactly those bars, and an
// empty list scrolls that far for nothing. So no list under those insets stretches its content, and the empty state
// is only as tall as itself.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : []));

const STRETCH = /flexGrow:\s*1|minHeight:\s*"100%"/u;

describe("empty screens", () => {
  const screens = sources(join(SRC, "screens")).filter((f) => readFileSync(f, "utf8").includes('contentInsetAdjustmentBehavior="automatic"'));

  it("finds the screens that scroll under the bars", () => {
    expect(screens.map((f) => f.slice(SRC.length + 1)).sort()).toEqual(expect.arrayContaining(["screens/Chats.tsx", "screens/Settings.tsx"]));
  });

  it.each(screens.map((f) => [f.slice(SRC.length + 1), f]))("%s doesn't stretch its content to the screen", (_, file) => {
    expect(readFileSync(file, "utf8")).not.toMatch(STRETCH);
  });

  it("keeps the empty state to its own height", () => {
    const states = readFileSync(join(SRC, "ui/States.tsx"), "utf8");
    const style = /\bempty:\s*\{([^}]*)\}/u.exec(states)?.[1];
    expect(style).toBeDefined();
    expect(style).not.toMatch(/\bflex:\s*1|flexGrow|minHeight|height:/u);
  });
});
