// iOS 26's chrome rules, kept: Liquid Glass only on what floats over the content (bars, the composer, floating
// buttons), never on what scrolls in it; glass never faded (UIKit doesn't draw it under an opacity below 1); bar glyphs
// in the label's ink, not the accent; and a change VoiceOver must hear said outright, since iOS has no live regions.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const sources = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx$/u.test(e.name) ? [join(dir, e.name)] : [],
  );
const files = ["App.tsx", ...sources("src")].map((f) => ({ f, src: readFileSync(join(root, f), "utf8") }));
const read = (f: string): string => files.find((x) => x.f === f)?.src ?? "";

describe("iOS 26 chrome", () => {
  it("keeps glass off the content: buttons in cards and forms, and the thread's day labels", () => {
    expect(read("src/ui/Button.tsx")).not.toMatch(/<Glass\b/u);
    const chat = read("src/screens/Chat.tsx");
    const day = chat.slice(chat.indexOf('if (row.t === "day")'), chat.indexOf('if (row.t === "unread")'));
    expect(day).toContain("dayLine(row.at, now)");
    // Just the date: no glass, capsule or rule around it.
    expect(day).not.toMatch(/<Glass\b|backgroundColor/u);
  });

  it("never fades glass in or out", () => {
    for (const { f, src } of files) expect([f, src.match(/(entering|exiting)=\{(Fade|fade)[^>]*>\s*<Glass\b/u)?.[0]]).toEqual([f, undefined]);
  });

  it("draws bar glyphs in the label's ink", () => {
    for (const { f, src } of files) expect([f, src.includes("headerTintColor: t.accent")]).toEqual([f, false]);
  });

  it("blurs the thread under its bars with the system's scroll edge effect", () => {
    const chat = read("src/screens/Chat.tsx");
    expect(chat.match(/<EdgeEffect\b/gu)?.length).toBe(2);
  });

  it("opens the composer's + as iOS's own menu, not a drawn one", () => {
    const composer = read("src/ui/Composer.tsx");
    expect(composer).toMatch(/<MenuButton\s+icon="plus"/u);
    expect(composer).not.toMatch(/<Menu\b/u);
  });
});

describe("VoiceOver on iOS", () => {
  it("hears what a live region says on Android", () => {
    for (const { f, src } of files.filter((x) => x.src.includes("accessibilityLiveRegion"))) expect([f, /useAnnounce(Change)?\(|announce\(/u.test(src)]).toEqual([f, true]);
  });
});
