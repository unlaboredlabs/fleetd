// The link's state never takes room on a screen: it is words in the title's place (and a spinner in the bar), so the
// list or thread under it stays where it is from the first frame, through a reconnect, to the next refresh.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linkStatus } from "./link";

const SRC = import.meta.dirname;

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : []));

describe("linkStatus", () => {
  it("says nothing while live or before pairing", () => {
    expect(linkStatus({ phase: "live", hub: "h", protocol: 1 })).toBeUndefined();
    expect(linkStatus({ phase: "unpaired" })).toBeUndefined();
  });

  it("says Connecting… with a spinner while it dials, the first time or again", () => {
    expect(linkStatus({ phase: "connecting", hub: "h", attempt: 0 })).toEqual({ text: "Connecting…", busy: true });
    expect(linkStatus({ phase: "retrying", hub: "h", reason: "The hub can't be reached", retryAt: 0 })).toEqual({ text: "Connecting…", busy: true });
  });

  it("says Not Connected, still, once the key is refused", () => {
    expect(linkStatus({ phase: "refused", hub: "h", message: "The hub refused the key." })).toEqual({ text: "Not Connected", busy: false });
  });
});

describe("the link's indicator", () => {
  const files = sources(SRC).map((f) => [f.slice(SRC.length + 1), readFileSync(f, "utf8")] as const);

  it("takes no layout space: no screen draws a connection bar or banner in its content", () => {
    for (const [name, text] of files) expect(text, name).not.toMatch(/Connection(Banner|Line)\b|connectionWords/u);
  });

  it("is the header's: the title's words and an item in the bar, set through the screen's options", () => {
    const hook = files.find(([name]) => name === "screens/linkHeader.tsx")?.[1] ?? "";
    expect(hook).toMatch(/navigation\.setOptions\(\{\s*title: text \?\? title,/u);
    expect(hook).toMatch(/unstable_headerLeftItems/u);
    expect(hook).toMatch(/headerLeft: /u);
    // It returns nothing to draw in the screen: a hook, not a view.
    expect(hook).toMatch(/\): void => \{/u);
  });

  it("is the chat list's title", () => {
    const chats = files.find(([name]) => name === "screens/Chats.tsx")?.[1] ?? "";
    expect(chats).toMatch(/useLinkHeader\(navigation, "Chats"\)/u);
  });
});
