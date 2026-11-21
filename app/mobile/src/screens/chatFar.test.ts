// A chat opened at a message far back (a search hit on Info, a pin): the screen draws a window only once its page has
// come, and its landing waits for that page before anything else, so it never lands on an empty window at its newest
// end (around.ts shownWindow, farStep).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const chat = readFileSync(join(import.meta.dirname, "Chat.tsx"), "utf8");

describe("a chat opened far back", () => {
  it("draws the window only once it holds messages", () => {
    expect(chat).toContain("const win = shownWindow(opening);");
    expect(chat).toContain("const items = useMemo(() => (win === undefined ? chatItems(chat, sends ?? []) : chatItems(windowChat(win), [])), [chat, sends, win]);");
  });

  it("waits for the page around a hit before the empty thread's shortcut, then lands by farStep", () => {
    const wait = chat.indexOf('if (messageId !== undefined && opening?.anchor === messageId && opening.loading === "around") return;');
    const empty = chat.indexOf("if (newestFirst.length === 0) {");
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThan(empty);
    expect(chat).toContain("farStep(chat, opening, found,");
  });
});
