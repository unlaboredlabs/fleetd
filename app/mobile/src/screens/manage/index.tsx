// Making and managing projects from the phone: their screens in the root stack (New Project as a sheet; New Screen, a
// screen of your own, as one too; a project's screen, Rename, Agent Profiles, Approvals, Payments, Linked hubs,
// Skills, the chat's Artifacts and one artifact, its agents' DMs and one DM, its Vault (screens/vault), pushed over its chat, in a stack of their own, its icon as a
// sheet, and Move and Scale for its picture over everything), and the two ways in: the Chats list's + and a chat's
// bar. App.tsx adds these to its
// navigators.
import { useNavigation } from "@react-navigation/native";
import { createNativeStackNavigator, type NativeStackHeaderItemButton, type NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { Platform, Pressable } from "react-native";
import type { ChatInfoParams, RootParams } from "../../hubContext";
import { useTheme, type Palette } from "../../theme";
import { haptics } from "../../ui/haptics";
import { Approvals } from "./Approvals";
import { IconPicker } from "./IconPicker";
import { Info } from "./Info";
import { LinkedHubs } from "./LinkedHubs";
import { NewProject } from "./NewProject";
import { NewScreen } from "./NewScreen";
import { Payments } from "./Payments";
import { Photo } from "./Photo";
import { Profiles } from "./Profiles";
import { Rename } from "./Rename";
import { Skill } from "./Skill";
import { SkillEdit } from "./SkillEdit";
import { SkillHistory } from "./SkillHistory";
import { Skills } from "./Skills";
import { SkillVersion } from "./SkillVersion";
import { Symbol } from "./parts";
import { Artifact } from "../artifacts/Artifact";
import { Artifacts } from "../artifacts/Artifacts";
import { ArtifactVersions } from "../artifacts/ArtifactVersions";
import { Dm } from "../dms/Dm";
import { Dms } from "../dms/Dms";
import { Vault } from "../vault/Vault";
import { VaultEdit } from "../vault/VaultEdit";
import { VaultImport } from "../vault/VaultImport";
import { VaultItem } from "../vault/VaultItem";

type RootStack = ReturnType<typeof createNativeStackNavigator<RootParams>>;

export const sheet = (t: Palette, title: string): NativeStackNavigationOptions => ({
  title,
  presentation: "modal",
  headerTintColor: t.label,
  headerTitleStyle: { color: t.label },
  headerShadowVisible: false,
  // iOS 26's bar is glass over the page, its glyphs in the label's ink; elsewhere, the page's ground.
  ...(Platform.OS === "ios" ? {} : { headerStyle: { backgroundColor: t.grouped } }),
  contentStyle: { backgroundColor: t.grouped },
});

/** A page pushed in a stack of grouped pages: a small title on the page's own ground. */
export const pushed = (t: Palette, title: string): NativeStackNavigationOptions => ({
  title,
  headerBackButtonDisplayMode: "minimal",
  headerTintColor: t.label,
  headerTitleStyle: { color: t.label },
  headerShadowVisible: false,
  // iOS 26's bar is glass over the page, its glyphs in the label's ink; elsewhere, the page's ground.
  ...(Platform.OS === "ios" ? {} : { headerStyle: { backgroundColor: t.grouped } }),
  contentStyle: { backgroundColor: t.grouped },
});

/** The root stack's screens for these. */
export const manageScreens = (Stack: RootStack, t: Palette) => (
  <Stack.Group>
    <Stack.Screen name="NewProject" component={NewProject} options={sheet(t, "New Project")} />
    <Stack.Screen name="NewScreen" component={NewScreen} options={sheet(t, "New Screen")} />
    <Stack.Screen name="ChatInfo" component={ChatInfo} options={{ headerShown: false }} />
    <Stack.Screen name="Icon" component={IconPicker} options={sheet(t, "Icon")} />
    <Stack.Screen name="Photo" component={Photo} options={{ presentation: "fullScreenModal", animation: "fade", headerShown: false, gestureEnabled: false, contentStyle: { backgroundColor: "#000000" } }} />
  </Stack.Group>
);

/** The Chats list's + on iOS: New Project, a round glass button in the bar. */
export const newChatItem = (open: () => void): NativeStackHeaderItemButton => ({
  type: "button",
  label: "New Project",
  icon: { type: "sfSymbol", name: "plus" },
  accessibilityLabel: "New Project",
  onPress: () => {
    haptics.tap();
    open();
  },
});

/** The Chats list's + elsewhere: New Project. */
export const newChatOptions = (t: Palette, open: () => void): NativeStackNavigationOptions => {
  if (Platform.OS === "ios") return { unstable_headerRightItems: () => [newChatItem(open)] };
  return {
    headerRight: () => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New Project"
        hitSlop={12}
        onPress={() => {
          haptics.tap();
          open();
        }}
      >
        <Symbol ios="plus" android="add" size={24} color={t.accent} />
      </Pressable>
    ),
  };
};

const InfoStack = createNativeStackNavigator<ChatInfoParams>();

/**
 * A project's screen, Rename, Agent Profiles, Approvals, Payments, Linked hubs and Skills (a skill's editor a sheet),
 * pushed over its chat as one screen of the root stack, with a bar of their own that slides in and out with them. The root stack's bar stays
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
      <InfoStack.Screen name="Approvals" component={Approvals} options={pushed(t, "Approvals")} />
      <InfoStack.Screen name="Payments" component={Payments} options={pushed(t, "Payments")} />
      <InfoStack.Screen name="LinkedHubs" component={LinkedHubs} options={pushed(t, "Linked Hubs")} />
      <InfoStack.Screen name="Skills" component={Skills} options={pushed(t, "Skills")} />
      <InfoStack.Screen name="Skill" component={Skill} options={pushed(t, "")} />
      <InfoStack.Screen name="SkillEdit" component={SkillEdit} options={({ route }) => sheet(t, route.params.name)} />
      <InfoStack.Screen name="SkillHistory" component={SkillHistory} options={pushed(t, "History")} />
      <InfoStack.Screen name="SkillVersion" component={SkillVersion} options={({ route }) => pushed(t, `Version ${String(route.params.version)}`)} />
      <InfoStack.Screen name="Artifacts" component={Artifacts} options={pushed(t, "Artifacts")} />
      <InfoStack.Screen name="Artifact" component={Artifact} options={{ ...pushed(t, ""), headerStyle: { backgroundColor: t.bg }, contentStyle: { backgroundColor: t.bg } }} />
      <InfoStack.Screen name="ArtifactVersions" component={ArtifactVersions} options={pushed(t, "Versions")} />
      <InfoStack.Screen name="Dms" component={Dms} options={pushed(t, "DMs Between Agents")} />
      <InfoStack.Screen name="Dm" component={Dm} options={pushed(t, "DM")} />
      <InfoStack.Screen name="Vault" component={Vault} options={pushed(t, "Vault")} />
      <InfoStack.Screen name="VaultItem" component={VaultItem} options={pushed(t, "")} />
      <InfoStack.Screen name="VaultEdit" component={VaultEdit} options={sheet(t, "")} />
      <InfoStack.Screen name="VaultImport" component={VaultImport} options={sheet(t, "Import from 1Password")} />
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

/** A chat's ⓘ on Android, which opens its project's screen. On iOS the chat's own bar has it (Chat's ChatBar). */
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
