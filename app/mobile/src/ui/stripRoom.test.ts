// Every screen keeps out of the iPhone Duo's side strip (StripRoom.tsx), not only the chat and the chats list: folded,
// a bot's Info ran under the status column with iOS's Back and search over its rows (the real Duo's F1153). Each
// navigator lays its screens out in StripRoom, so a screen added later keeps out too; a screen holding a stack of its
// own, or the chat, which keeps out itself, opts out.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(join(import.meta.dirname, path), "utf8");
const app = read("../../App.tsx");
const manage = read("../screens/manage/index.tsx");
const room = read("StripRoom.tsx");

describe("the room every screen keeps out of the Duo's side strip", () => {
  it("is every navigator's layout for its screens", () => {
    const navigators = [...app.matchAll(/<(\w+)\.Navigator\b[^>]*>/gu), ...manage.matchAll(/<(\w+)\.Navigator\b[^>]*>/gu)];
    expect(navigators.map((m) => m[1])).toEqual(["PairStack", "RootStack", "ChatsStack", "SettingsStack", "InfoStack"]);
    for (const m of navigators) expect(m[0]).toContain("screenLayout={stripRoom}");
  });

  it("is left to the screens that hold a stack of their own, and to the chat, which keeps out itself", () => {
    const own = [...app.matchAll(/<RootStack\.Screen\s+name="(\w+)"[^>]*?layout=\{ownRoom\}/gu), ...manage.matchAll(/<Stack\.Screen name="(\w+)"[^>]*?layout=\{ownRoom\}/gu)].map((m) => m[1]);
    expect(own).toEqual(["Home", "Settings", "Chat", "ChatInfo"]);
  });

  it("pads the content by the strip the pane touches, its ground still under the strip", () => {
    expect(room).toContain("const strip = useStrip();");
    expect(room).toContain("<View style={[styles.fill, { paddingLeft: strip.left, paddingRight: strip.right }]}>{children}</View>");
  });
});
