// The chats list's bars, as Messages' on iOS 26: the avatar at the top left opens Settings and shows the link to the
// hub as a dot, and the round button at the bottom left opens the filters as iOS's own menu, beside the search field,
// in the place of the chips over the list. A build without the bottom bar keeps search on top and the filters' menu
// in the header, so the JavaScript runs on any build.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filterChoices, filterLabel, linkTone, meAvatar } from "./chatsBar";

const read = (path: string): string => readFileSync(join(import.meta.dirname, path), "utf8");
const chats = read("screens/Chats.tsx");
const app = read("../App.tsx");
const toolbar = read("ui/Toolbar.tsx");
const swift = read("../modules/toolbar/ios/ToolbarModule.swift");

describe("the filters menu", () => {
  it("lists every filter in order, Unread and Needs You saying how many chats want you", () => {
    const menu = filterChoices({ unread: 3, needsYou: 1 });
    expect(menu.map((c) => [c.id, c.title, c.subtitle])).toEqual([
      ["all", "All Chats", undefined],
      ["unread", "Unread", "3 chats"],
      ["needsYou", "Needs You", "1 chat"],
      ["pinned", "Pinned", undefined],
      ["navis", "Navis", undefined],
      ["projects", "Projects", undefined],
    ]);
    expect(filterChoices({ unread: 0, needsYou: 0 }).every((c) => c.subtitle === undefined)).toBe(true);
    expect(new Set(menu.map((c) => c.symbol)).size).toBe(menu.length);
  });

  it("names the button for VoiceOver with the filter that's on", () => {
    expect(filterLabel("all")).toBe("Filter Chats");
    expect(filterLabel("pinned")).toBe("Filter Chats, Pinned");
  });

  it("is iOS's own menu in the bottom toolbar, ticking the filter that's on, the button tinted while one is", () => {
    expect(chats).toContain("<Toolbar filters={choices} selected={filter} label={filterLabel(filter)} onSelect={pick} />");
    expect(toolbar).toContain("filtered={selected !== filters[0]?.id}");
    expect(swift).toContain("UIMenu(options: .singleSelection, children: actions)");
    expect(swift).toContain("state: f.id == selected ? .on : .off");
    expect(swift).toContain("button.style = filtered ? .prominent : .plain");
    // The search field sits beside it, iOS's own (react-native-screens' UISearchController), placed in the toolbar.
    expect(swift).toContain("vc.toolbarItems = [button, .flexibleSpace(), vc.navigationItem.searchBarPlacementBarButtonItem]");
    expect(chats).toMatch(/placement: "integrated", allowToolbarIntegration: true/u);
  });

  it("closes an open swiped row as a filter is picked, and replaces the chips on iOS", () => {
    expect(chats).toMatch(/const pick = \(f: Filter\) => \{\s*\/\/[^\n]*\n\s*swiped\.close\(\);/u);
    expect(chats).toContain('Platform.OS === "android" && query === ""');
  });

  it("falls back to search on top and the filters' menu in the header on a build without the bottom bar", () => {
    expect(toolbar).toContain('requireOptionalNativeModule<{ supported?: boolean }>("FleetdToolbar")');
    expect(toolbar).toContain("export const bottomBar = native?.supported === true;");
    expect(chats).toContain('({ placeholder: "Search", placement: "stacked", hideWhenScrolling: false } as const)');
    expect(chats).toContain("unstable_headerRightItems: () => (bottomBar ? [add] : [add, filters])");
  });
});

describe("the avatar that opens Settings", () => {
  it("shows the person's initial, the hub's before the hub says who they are", () => {
    expect(meAvatar("sam rivera", "devbox", "live").initial).toBe("S");
    expect(meAvatar(undefined, "devbox", "live").initial).toBe("D");
    expect(meAvatar("  ", "devbox", "live").initial).toBe("D");
    expect(meAvatar("Émile", "devbox", "live").initial).toBe("É");
  });

  it("carries the link as a dot: live, dialling, or down, and says so to VoiceOver", () => {
    expect([linkTone("live"), linkTone("connecting"), linkTone("retrying"), linkTone("refused"), linkTone("unpaired")]).toEqual(["live", "busy", "busy", "down", "down"]);
    expect(meAvatar("Sam", "devbox", "live").label).toBe("Settings, Connected");
    expect(meAvatar("Sam", "devbox", "retrying").label).toBe("Settings, Reconnecting…");
  });

  it("sits at the top left and pushes Settings, which has a way back and no tab bar under it", () => {
    expect(chats).toContain('unstable_headerLeftItems: () => [{ type: "custom", element: avatar }]');
    expect(chats).toMatch(/const openSettings = \(\) => \{\s*swiped\.close\(\);\s*root\.navigate\("Settings"\);\s*\};\s*const avatar = <MeButton [^>]*onPress=\{openSettings\} \/>;/u);
    expect(app).toContain('<RootStack.Screen name="Settings" component={SettingsScreens} options={{ headerShown: false }} />');
    expect(app).toContain("options={backTo(t, () => root.goBack())}");
    expect(app).not.toMatch(/TabBar|bottom-tabs/u);
  });
});
