// Making and managing projects and Navis from the phone: their screens in the root stack (New Navi and New Project as
// sheets; a project's or Navi's screen, Rename and Agent Profiles pushed over its chat), and the two ways in: the
// Chats list's + menu and the info button in a chat's header. App.tsx adds these to its navigators.
import type { createNativeStackNavigator, NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { Alert, Platform, Pressable } from "react-native";
import type { RootParams } from "../../hubContext";
import type { Palette } from "../../theme";
import { haptics } from "../../ui/haptics";
import { Info } from "./Info";
import { NewNavi } from "./NewNavi";
import { NewProject } from "./NewProject";
import { Profiles } from "./Profiles";
import { Rename } from "./Rename";
import { Symbol } from "./parts";

type RootStack = ReturnType<typeof createNativeStackNavigator<RootParams>>;

const sheet = (t: Palette, title: string): NativeStackNavigationOptions => ({
  title,
  presentation: "modal",
  headerTintColor: t.accent,
  headerTitleStyle: { color: t.label },
  headerShadowVisible: false,
  headerStyle: { backgroundColor: t.grouped },
  contentStyle: { backgroundColor: t.grouped },
});

const pushed = (t: Palette, title: string): NativeStackNavigationOptions => ({
  title,
  headerBackButtonDisplayMode: "minimal",
  headerTintColor: t.accent,
  headerTitleStyle: { color: t.label },
  headerShadowVisible: false,
  headerStyle: { backgroundColor: t.grouped },
  contentStyle: { backgroundColor: t.grouped },
});

/** The root stack's screens for these. */
export const manageScreens = (Stack: RootStack, t: Palette) => (
  <Stack.Group>
    <Stack.Screen name="NewNavi" component={NewNavi} options={sheet(t, "New Navi")} />
    <Stack.Screen name="NewProject" component={NewProject} options={sheet(t, "New Project")} />
    <Stack.Screen name="Info" component={Info} options={pushed(t, "Info")} />
    <Stack.Screen name="Rename" component={Rename} options={pushed(t, "Name")} />
    <Stack.Screen name="Profiles" component={Profiles} options={pushed(t, "Agent Profiles")} />
  </Stack.Group>
);

/** The Chats list's +: New Navi or New Project, in iOS's own pull-down menu (an alert's choices on Android). */
export const newChatOptions = (t: Palette, navigate: (name: "NewNavi" | "NewProject") => void): NativeStackNavigationOptions => {
  const open = (name: "NewNavi" | "NewProject") => () => navigate(name);
  if (Platform.OS === "ios") {
    return {
      unstable_headerRightItems: () => [
        {
          type: "menu",
          label: "New",
          icon: { type: "sfSymbol", name: "plus" },
          accessibilityLabel: "New Navi or project",
          menu: {
            items: [
              { type: "action", label: "New Navi", description: "A personal assistant", icon: { type: "sfSymbol", name: "sparkles" }, onPress: open("NewNavi") },
              { type: "action", label: "New Project", description: "A repo or a folder", icon: { type: "sfSymbol", name: "folder.badge.plus" }, onPress: open("NewProject") },
            ],
          },
        },
      ],
    };
  }
  return {
    headerRight: () => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New Navi or project"
        hitSlop={12}
        onPress={() => {
          haptics.tap();
          Alert.alert("New", undefined, [
            { text: "New Navi", onPress: open("NewNavi") },
            { text: "New Project", onPress: open("NewProject") },
            { text: "Cancel", style: "cancel" },
          ]);
        }}
      >
        <Symbol ios="plus" android="add" size={24} color={t.accent} />
      </Pressable>
    ),
  };
};

/** A chat's ⓘ, which opens its project's or Navi's screen. */
export const infoOptions = (t: Palette, onPress: () => void): NativeStackNavigationOptions =>
  Platform.OS === "ios"
    ? { unstable_headerRightItems: () => [{ type: "button", label: "Info", icon: { type: "sfSymbol", name: "info.circle" }, accessibilityLabel: "Info", onPress }] }
    : {
        headerRight: () => (
          <Pressable accessibilityRole="button" accessibilityLabel="Info" hitSlop={12} onPress={onPress}>
            <Symbol ios="info.circle" android="info" size={24} color={t.accent} />
          </Pressable>
        ),
      };
