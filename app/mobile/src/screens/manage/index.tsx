// Making and managing projects and Navis from the phone: their screens in the root stack (New Navi and New Project as
// sheets; a project's or Navi's screen, Rename, Agent Profiles and a Navi's skills pushed over its chat, in a stack of
// their own, its icon as a sheet, and Move and Scale for its picture over everything), and the two ways in: the Chats
// list's + menu and a chat's bar. App.tsx adds these to its navigators.
import { useNavigation } from "@react-navigation/native";
import { createNativeStackNavigator, type NativeStackHeaderItemMenu, type NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { Alert, Platform, Pressable } from "react-native";
import type { ChatInfoParams, RootParams } from "../../hubContext";
import { useTheme, type Palette } from "../../theme";
import { haptics } from "../../ui/haptics";
import { IconPicker } from "./IconPicker";
import { Info } from "./Info";
import { NewNavi } from "./NewNavi";
import { NewProject } from "./NewProject";
import { Photo } from "./Photo";
import { Profiles } from "./Profiles";
import { Rename } from "./Rename";
import { Skill } from "./Skill";
import { SkillEdit } from "./SkillEdit";
import { SkillHistory } from "./SkillHistory";
import { Skills } from "./Skills";
import { SkillVersion } from "./SkillVersion";
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
    <Stack.Screen name="ChatInfo" component={ChatInfo} options={{ headerShown: false }} />
    <Stack.Screen name="Icon" component={IconPicker} options={sheet(t, "Icon")} />
    <Stack.Screen name="Photo" component={Photo} options={{ presentation: "fullScreenModal", animation: "fade", headerShown: false, gestureEnabled: false, contentStyle: { backgroundColor: "#000000" } }} />
  </Stack.Group>
);

/** The Chats list's + on iOS: New Navi or New Project, in iOS's own pull-down menu, a round glass button in the bar. */
export const newChatItems = (navigate: (name: "NewNavi" | "NewProject") => void): NativeStackHeaderItemMenu => ({
  type: "menu",
  label: "New",
  icon: { type: "sfSymbol", name: "plus" },
  accessibilityLabel: "New Navi or project",
  menu: {
    items: [
      { type: "action", label: "New Navi", description: "A personal assistant", icon: { type: "sfSymbol", name: "sparkles" }, onPress: () => navigate("NewNavi") },
      { type: "action", label: "New Project", description: "A repo or a folder", icon: { type: "sfSymbol", name: "folder.badge.plus" }, onPress: () => navigate("NewProject") },
    ],
  },
});

/** The Chats list's +: New Navi or New Project, in iOS's own pull-down menu (an alert's choices on Android). */
export const newChatOptions = (t: Palette, navigate: (name: "NewNavi" | "NewProject") => void): NativeStackNavigationOptions => {
  const open = (name: "NewNavi" | "NewProject") => () => navigate(name);
  if (Platform.OS === "ios") return { unstable_headerRightItems: () => [newChatItems(navigate)] };
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

const InfoStack = createNativeStackNavigator<ChatInfoParams>();

/**
 * A project's or Navi's screen, Rename, Agent Profiles and a Navi's skills (their editor a sheet), pushed over its chat
 * as one screen of the root stack, with a bar of their own that slides in and out with them. The root stack's bar stays
 * hidden over the chat and these, as over the chats list: one it shows and hides again on the way back stood over the
 * screen sliding in, then slid off late (Chat's chatOptions). Info, first in this stack, has a back button of its own
 * to the chat.
 */
function ChatInfo() {
  const t = useTheme();
  const root = useNavigation();
  return (
    <InfoStack.Navigator>
      <InfoStack.Screen name="Info" component={Info} options={{ ...pushed(t, "Info"), ...backTo(t, () => root.goBack()) }} />
      <InfoStack.Screen name="Rename" component={Rename} options={pushed(t, "Name")} />
      <InfoStack.Screen name="Profiles" component={Profiles} options={pushed(t, "Agent Profiles")} />
      <InfoStack.Screen name="Skills" component={Skills} options={pushed(t, "Skills")} />
      <InfoStack.Screen name="Skill" component={Skill} options={pushed(t, "")} />
      <InfoStack.Screen name="SkillEdit" component={SkillEdit} options={({ route }) => sheet(t, route.params.name)} />
      <InfoStack.Screen name="SkillHistory" component={SkillHistory} options={pushed(t, "History")} />
      <InfoStack.Screen name="SkillVersion" component={SkillVersion} options={({ route }) => pushed(t, `Version ${String(route.params.version)}`)} />
    </InfoStack.Navigator>
  );
}

/** The back button of a stack's first screen, which leaves the stack, as the system's own. */
export const backTo = (t: Palette, onPress: () => void): NativeStackNavigationOptions =>
  Platform.OS === "ios"
    ? { unstable_headerLeftItems: () => [{ type: "button", label: "Back", icon: { type: "sfSymbol", name: "chevron.left" }, accessibilityLabel: "Back", onPress }] }
    : {
        headerLeft: () => (
          <Pressable accessibilityRole="button" accessibilityLabel="Back" hitSlop={12} onPress={onPress}>
            <Symbol ios="chevron.left" android="arrow_back" size={24} color={t.accent} />
          </Pressable>
        ),
      };

/** A chat's ⓘ on Android, which opens its project's or Navi's screen. On iOS the chat's own bar has it (Chat's ChatBar). */
export const infoOptions = (t: Palette, onPress: () => void): NativeStackNavigationOptions =>
  Platform.OS === "ios"
    ? {}
    : {
        headerRight: () => (
          <Pressable accessibilityRole="button" accessibilityLabel="Info" hitSlop={12} onPress={onPress}>
            <Symbol ios="info.circle" android="info" size={24} color={t.accent} />
          </Pressable>
        ),
      };
