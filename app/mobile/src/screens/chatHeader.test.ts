// The chat's top bar. On iOS the root stack's own bar stays hidden over a chat and its Info, as over the chats list: a
// bar the stack showed over a screen and hid again on the way back stood still over the screen sliding in, then slid
// off after it (UIKit, iOS 26), the "top bar shifts" of going back. The chat draws its bar in the screen; Info, Rename
// and Agent Profiles are a stack of their own, with their own bar. The chat's title, its name and picture, is a button
// to its Info, as in Messages.
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
    expect(app).toMatch(/<RootStack\.Screen name="Home" component=\{Home\} options=\{\{ headerShown: false/u);
    expect(app).toContain("return useBeside() === null ? <ChatsHome /> : <NoChatOpen />;");
    expect(app).toMatch(/<RootStack\.Screen\s+name="Chat"\s+component=\{Chat\}[^]*?options=\{[^]*?\.\.\.chatOptions\(t\)/u);
    expect(chat).toMatch(/export const chatOptions = \(t: Palette\): NativeStackNavigationOptions =>\s*Platform\.OS === "ios" \? \{ headerShown: false \} :/u);
  });

  it("is drawn in the chat on iOS, with Back and Info either side of the title", () => {
    expect(chat).toMatch(/Platform\.OS === "ios" \? \([^]*?<EdgeEffect[^]*?>\s*<ChatBar top=\{barTop\} onBack=\{goBack\} onInfo=\{openInfo\} inStrip=\{inStrip\}>\s*<ChatTitle /u);
    expect(chat).toContain("const goBack = besideList ? undefined : () => navigation.goBack();");
    const bar = fn(chat, "ChatBar");
    expect(bar).toContain('<BarButton label="Info" symbol="info.circle" onPress={onInfo} />');
    // Beside the list (src/split.ts), a chat straight on Home has no Back: its room stays, so the title holds still.
    expect(bar).toContain('{onBack === undefined ? <View style={styles.barButton} /> : <BarButton label="Back" symbol="chevron.left" onPress={onBack} />}');
    // The iPhone Duo unfolded has no top inset: the bar stands where iOS's own bars do there.
    expect(chat).toContain("const barTop = insets.top > 0 ? insets.top : BAR_TOP_BARE;");
  });

  it("puts Back and Info in the iPhone Duo's side strip, and keeps the thread out of it", () => {
    // Where the Duo's controls are a column at the side (src/split.ts sideStrip), as iOS moves its own bars' buttons.
    expect(chat).toContain('const strip = Platform.OS === "ios" ? sideStrip(insets) : undefined;');
    expect(chat).toContain("<View style={[styles.fill, { marginLeft: stripLeft, marginRight: stripRight }]}>");
    expect(fn(chat, "ChatBar")).toMatch(/if \(inStrip\) \{\s*return \(\s*<View style=\{\[styles\.bar, styles\.barAlone, \{ top \}\]\}/u);
    const strip = fn(chat, "StripButtons");
    expect(strip).toContain('{onBack === undefined ? null : <BarButton label="Back" symbol="chevron.left" onPress={onBack} />}');
    expect(strip).toContain('<BarButton label="Info" symbol="info.circle" onPress={onInfo} />');
  });

  it("starts the thread under the bar", () => {
    // The thread starts under it, as it did under the stack's, and under the pins' and a lens's capsules while they show.
    expect(chat).toContain('const barEnd = Platform.OS === "ios" ? barTop + BAR : 0;');
    expect(chat).toContain("const top = barEnd + pinRoom + (lens === null ? 0 : LENS_ROOM);");
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
