// The chat's top bar. On iOS the root stack's own bar stays hidden over a chat and its Info, as over the chats list: a
// bar the stack showed over a screen and hid again on the way back stood still over the screen sliding in, then slid
// off after it (UIKit, iOS 26), the "top bar shifts" of going back. The chat draws its bar in the screen; Info, Rename
// and Agent Profiles are a stack of their own, with their own bar. The chat's title, its name and picture, is a button
// to its Info, as in Messages and Telegram.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const chat = readFileSync(join(import.meta.dirname, "Chat.tsx"), "utf8");
const app = readFileSync(join(import.meta.dirname, "../../App.tsx"), "utf8");
const manage = readFileSync(join(import.meta.dirname, "manage/index.tsx"), "utf8");
const fn = (src: string, name: string): string => {
  const at = src.indexOf(`function ${name}(`);
  return at < 0 ? "" : src.slice(at, src.indexOf("\n}\n", at));
};

describe("the chat's top bar", () => {
  it("is never the stack's on iOS, over a chat as over the chats list", () => {
    expect(app).toMatch(/<RootStack\.Screen name="Home" component=\{Tabs\} options=\{\{ headerShown: false/u);
    expect(app).toMatch(/<RootStack\.Screen name="Chat" component=\{Chat\} options=\{[^\n]*\.\.\.chatOptions\(t\)/u);
    expect(chat).toMatch(/export const chatOptions = \(t: Palette\): NativeStackNavigationOptions =>\s*Platform\.OS === "ios" \? \{ headerShown: false \} :/u);
  });

  it("is drawn in the chat on iOS, with Back and Info either side of the title", () => {
    expect(chat).toMatch(/Platform\.OS === "ios" \? \(\s*<ChatBar top=\{insets\.top\} onBack=\{\(\) => navigation\.goBack\(\)\} onInfo=\{openInfo\}>\s*<ChatTitle /u);
    const bar = fn(chat, "ChatBar");
    expect(bar).toContain('button("Back", "chevron.left", onBack)');
    expect(bar).toContain('button("Info", "info.circle", onInfo)');
    // The thread starts under it, as it did under the stack's.
    expect(chat).toContain('const top = Platform.OS === "ios" ? insets.top + BAR : 0;');
    expect(chat).not.toContain("useHeaderHeight");
  });

  it("never shows or hides the root stack's bar between the chat and its Info", () => {
    expect(manage).toContain('<Stack.Screen name="ChatInfo" component={ChatInfo} options={{ headerShown: false }} />');
    expect(manage).not.toMatch(/<Stack\.Screen name="(Info|Rename|Profiles)"/u);
    const stack = fn(manage, "ChatInfo");
    for (const name of ["Info", "Rename", "Profiles"]) expect(stack).toContain(`<InfoStack.Screen name="${name}" component={${name}}`);
    // First in its stack, Info has its own way back to the chat.
    expect(stack).toContain("...backTo(t, () => root.goBack())");
  });

  it("opens the chat's Info when its name or picture is tapped", () => {
    expect(chat).toContain('const openInfo = useCallback(() => navigation.navigate("ChatInfo", { screen: "Info", params: { key: chatKey } }), [navigation, chatKey]);');
    expect((chat.match(/<ChatTitle [^>]*onPress=\{openInfo\} \/>/gu) ?? []).length).toBe(2);
    const title = fn(chat, "ChatTitle");
    expect(title).toMatch(/^\s*<Pressable onPress=\{onPress\} accessibilityRole="button"/mu);
    expect(title).toContain("<Avatar ");
  });
});
