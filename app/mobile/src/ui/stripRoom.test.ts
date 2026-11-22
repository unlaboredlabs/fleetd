// Every screen, sheet and overlay keeps out of the iPhone Duo's side strip (StripRoom.tsx), not only the chat and the
// chats list: folded, a bot's Info ran under the status column with iOS's Back and search over its rows (the real
// Duo's F1153). Each navigator lays its screens out in StripRoom, so a screen added later keeps out too; a screen
// holding a stack of its own, or the chat, which keeps out itself, opts out. A sheet, a navigator's or a Modal's,
// keeps out by its own safe area (SheetRoom), and an overlay over the whole window by the window's strip (useStrip).
// The tags are read whole, however many lines they take, from every source file.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".tsx") && !e.name.includes(".test.") ? [join(dir, e.name)] : []));
const sources = [join(ROOT, "App.tsx"), ...files(join(ROOT, "src"))].map((path) => ({ path: relative(ROOT, path), src: readFileSync(path, "utf8") }));
const room = readFileSync(join(import.meta.dirname, "StripRoom.tsx"), "utf8");

/** Each opening tag `<name …>` in `src`, whole: its braces matched, so a `>` inside `{…}` doesn't end it. */
const tags = (src: string, name: RegExp): string[] => {
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp(`<(${name.source})\\b`, "gu"))) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
};
const all = (name: RegExp) => sources.flatMap((s) => tags(s.src, name).map((tag) => ({ path: s.path, tag })));
const named = (tag: string) => /name="(\w+)"/u.exec(tag)?.[1];

describe("the room every screen keeps out of the Duo's side strip", () => {
  it("is every navigator's layout for its screens", () => {
    const navigators = all(/\w+\.Navigator/u);
    expect(navigators.map((n) => /<(\w+)\.Navigator/u.exec(n.tag)?.[1])).toEqual(["PairStack", "RootStack", "ChatsStack", "SettingsStack", "InfoStack"]);
    for (const n of navigators) expect(n.tag).toContain("screenLayout={stripRoom}");
  });

  it("is left to the screens that hold a stack of their own, and to the chat, which keeps out itself", () => {
    const own = all(/\w+\.Screen/u).filter((s) => s.tag.includes("layout={ownRoom}"));
    expect(own.map((s) => named(s.tag))).toEqual(["Home", "Settings", "Chat", "ChatInfo"]);
  });

  it("is a sheet's own safe area for every sheet screen, so a card centred on the unfolded Duo stays centred", () => {
    const sheets = all(/\w+\.Screen/u).filter((s) => /sheet\(t|presentation: "(modal|formSheet|pageSheet)"/u.test(s.tag));
    expect(sheets.map((s) => named(s.tag))).toEqual(["VaultEdit", "VaultImport", "VaultMove", "NewProject", "NewScreen", "Icon", "SkillEdit", "VaultEdit", "VaultImport", "VaultMove"]);
    for (const s of sheets) expect(s.tag, s.path).toContain("layout={sheetRoom}");
  });

  it("is a sheet's own safe area for every Modal sheet, and the window's strip for every overlay over the whole window", () => {
    const modals = all(/Modal/u);
    const sheets = modals.filter((m) => /presentationStyle="(pageSheet|formSheet)"/u.test(m.tag));
    expect(sheets.map((m) => m.path).sort()).toEqual(["src/screens/Chat.tsx", "src/screens/PinnedMessages.tsx", "src/screens/manage/ChatFind.tsx", "src/screens/manage/TypedDelete.tsx"]);
    const overlays = modals.filter((m) => !sheets.includes(m));
    expect(overlays.map((m) => m.path).sort()).toEqual(["src/screens/Sections.tsx", "src/ui/Media.tsx", "src/ui/Menu.tsx"]);
    for (const { path } of sheets) {
      const src = sources.find((s) => s.path === path)?.src ?? "";
      // Each sheet's first view is its SheetRoom, as many as it has Modal sheets.
      expect(tags(src, /SheetRoom/u).length, path).toBe(tags(src, /Modal/u).length);
    }
    for (const { path } of overlays) expect(sources.find((s) => s.path === path)?.src, path).toContain("const strip = useStrip();");
  });

  it("pads the content by the strip the pane touches, its ground still under the strip", () => {
    expect(room).toContain("const strip = useStrip();");
    expect(room).toContain("<View style={[styles.fill, { paddingLeft: strip.left, paddingRight: strip.right }]}>{children}</View>");
    expect(room).toMatch(/export function SheetRoom\(props: ViewProps\) \{\s*return <SafeAreaView edges=\{SIDES\} \{\.\.\.props\} \/>;/u);
    expect(room).toContain('const SIDES = ["left", "right"] as const;');
  });
});
