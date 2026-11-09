import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// What VoiceOver was told, as iOS would say it.
const said: string[] = [];
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AccessibilityInfo: { announceForAccessibilityWithOptions: (text: string) => said.push(text) },
}));
// One mounted view's hooks, outside React: its refs live until the next mount, and each effect runs as it renders.
let refs: Array<{ current: unknown }> = [];
let slot = 0;
vi.mock("react", () => ({
  useRef: (value: unknown) => (refs[slot] ??= { current: value }),
  useEffect: (effect: () => void) => effect(),
}));
const { changeToSay, useAnnounceChange } = await import("./announce");

const mount = () => {
  refs = [];
};
const render = (text: string | undefined, sayFirst?: boolean) => {
  slot = 0;
  useAnnounceChange(text, sayFirst);
};

describe("announcing a change", () => {
  beforeEach(() => {
    said.length = 0;
    mount();
  });

  it("says nothing as a view mounts on what was already so: a chat opened on past approvals, a row scrolled back", () => {
    render("Approved by ada");
    render("Approved by ada");
    mount();
    render("Denied by ada");
    expect(said).toEqual([]);
  });

  it("says each change while the view is shown, once", () => {
    render("Thinking");
    render("Working");
    render("Working");
    render("Thinking");
    expect(said).toEqual(["Working", "Thinking"]);
  });

  it("says the first text too for a view that shows because of what the person just did", () => {
    render(undefined, true);
    render("Approved by ada", true);
    expect(said).toEqual(["Approved by ada"]);
    mount();
    render("Denied by ada", true);
    expect(said).toEqual(["Approved by ada", "Denied by ada"]);
  });

  it("is quiet while there is nothing to say", () => {
    expect(changeToSay("Working", undefined)).toBeUndefined();
    expect(changeToSay("Working", "Working")).toBeUndefined();
    expect(changeToSay(undefined, "Working")).toBe("Working");
  });
});

describe("what announces only on a change", () => {
  const read = (f: string) => readFileSync(join(import.meta.dirname, "..", f), "utf8");

  it("an approval's outcome line: said as it shows only when its card was just answered here", () => {
    const card = read("screens/ApprovalCard.tsx");
    const line = card.slice(card.indexOf("export function ApprovalOutcomeLine"));
    expect(line).toMatch(/useAnnounceChange\(outcome\.tone === "waiting" \? undefined : outcome\.text, justAnswered\)/u);
    expect(line).not.toMatch(/\bannounce\(/u);
    expect(read("screens/Chat.tsx")).toMatch(/<ApprovalOutcomeLine [^>]*justAnswered=\{hadCard\.current\}/u);
  });

  it("the turn line: thinking and working, not as the chat opens", () => {
    expect(read("screens/TurnLine.tsx")).toMatch(/useAnnounceChange\(cur === undefined/u);
  });
});
