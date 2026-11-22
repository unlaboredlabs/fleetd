// Making and managing bots from the phone: their screens in the root stack (New Bot as a sheet; New Screen, a
// screen of your own, as one too; a project's screen, Rename, Agent Profiles, Lead Model, its Computer, Approvals, Payments,
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
import { WhoMerges } from "./WhoMerges";
import { Computer, ComputerLog } from "./Computer";
import { ApprovedLog } from "./ApprovedLog";
import { IconPicker } from "./IconPicker";
import { Info } from "./Info";
import { NewProject } from "./NewProject";
import { NewScreen } from "./NewScreen";
import { Payments } from "./Payments";
import { Watcher, Watching } from "./Watching";
import { Photo } from "./Photo";
import { LeadModel } from "./LeadModel";
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
import { VaultMove } from "../vault/VaultMove";
import { ownRoom, sheetRoom, stripRoom, useStripBars } from "../../ui/StripRoom";

type RootStack = ReturnType<typeof createNativeStackNavigator<RootParams>>;

export const sheet = (t: Palette, title: string): NativeStackNavigationOptions => ({
  title,
  presentation: "modal",
  headerTintColor: t.label,
  headerTitleStyle: { color: t.label },
  headerShadowVisible: false,
  // The bar on the page's own ground, on iOS too: left to iOS, an opaque bar takes the system's white, a white band
  // over the grey page (seen on the agents' Mac's simulator). A bar with no ground would lay every page out under it,
  // and a page's spinner, error or web view isn't in a scroll view that keeps clear of it. Its glyphs in the label's ink.
  headerStyle: { backgroundColor: t.grouped },
  // The large title's too, which iOS draws from the scroll edge's look while the title is expanded.
  headerLargeStyle: { backgroundColor: t.grouped },
  contentStyle: { backgroundColor: t.grouped },
});

/** A page pushed in a stack of grouped pages: a small title on the page's own ground. */
export const pushed = (t: Palette, title: string): NativeStackNavigationOptions => ({
  title,
  headerBackButtonDisplayMode: "minimal",
  headerTintColor: t.label,
  headerTitleStyle: { color: t.label },
  headerShadowVisible: false,
  // The bar as a sheet's.
  headerStyle: { backgroundColor: t.grouped },
  headerLargeStyle: { backgroundColor: t.grouped },
  contentStyle: { backgroundColor: t.grouped },
});

/** The root stack's screens for these. */
export const manageScreens = (Stack: RootStack, t: Palette) => (
  <Stack.Group>
    <Stack.Screen name="NewProject" component={NewProject} layout={sheetRoom} options={sheet(t, "New Bot")} />
    <Stack.Screen name="NewScreen" component={NewScreen} layout={sheetRoom} options={sheet(t, "New Screen")} />
    <Stack.Screen name="ChatInfo" component={ChatInfo} layout={ownRoom} options={{ headerShown: false }} />
    <Stack.Screen name="Icon" component={IconPicker} layout={sheetRoom} options={sheet(t, "Icon")} />
    <Stack.Screen name="Photo" component={Photo} options={{ presentation: "fullScreenModal", animation: "fade", headerShown: false, gestureEnabled: false, contentStyle: { backgroundColor: "#000000" } }} />
  </Stack.Group>
);

/** The Chats list's + on iOS: New Bot, a round glass button in the bar. */
export const newChatItem = (open: () => void): NativeStackHeaderItemButton => ({
  type: "button",
  label: "New Bot",
  icon: { type: "sfSymbol", name: "plus" },
  accessibilityLabel: "New Bot",
  onPress: () => {
    haptics.tap();
    open();
  },
});

/** The Chats list's + elsewhere: New Bot. */
export const newChatOptions = (t: Palette, open: () => void): NativeStackNavigationOptions => {
  if (Platform.OS === "ios") return { unstable_headerRightItems: () => [newChatItem(open)] };
  return {
    headerRight: () => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New Bot"
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
 * A project's screen, Rename, Agent Profiles, Lead Model, Watching, Who merges, Approvals, Payments and Skills (a skill's editor a sheet),
 * pushed over its chat as one screen of the root stack, with a bar of their own that slides in and out with them. The root stack's bar stays
 * hidden over the chat and these, as over the chats list: one it shows and hides again on the way back stood over the
 * screen sliding in, then slid off late (Chat's chatOptions). Info, first in this stack, has a back button of its own
 * to the chat.
 */
function ChatInfo() {
  const t = useTheme();
  const root = useNavigation();
  const stripBars = useStripBars(t.grouped);
  return (
    <InfoStack.Navigator screenLayout={stripRoom} screenOptions={stripBars}>
      <InfoStack.Screen name="Info" component={Info} options={{ ...pushed(t, "Info"), ...backTo(t, () => root.goBack()) }} />
      <InfoStack.Screen name="Rename" component={Rename} options={pushed(t, "Name")} />
      <InfoStack.Screen name="Profiles" component={Profiles} options={pushed(t, "Agent Profiles")} />
      <InfoStack.Screen name="LeadModel" component={LeadModel} options={pushed(t, "Lead Model")} />
      <InfoStack.Screen name="Watching" component={Watching} options={pushed(t, "Watching")} />
      <InfoStack.Screen name="Watcher" component={Watcher} options={pushed(t, "")} />
      <InfoStack.Screen name="Approvals" component={Approvals} options={pushed(t, "Approvals")} />
      <InfoStack.Screen name="WhoMerges" component={WhoMerges} options={pushed(t, "Who Merges")} />
      <InfoStack.Screen name="ApprovedLog" component={ApprovedLog} options={pushed(t, "Ran Without Asking")} />
      <InfoStack.Screen name="Payments" component={Payments} options={pushed(t, "Payments")} />
      <InfoStack.Screen name="Skills" component={Skills} options={pushed(t, "Skills")} />
      <InfoStack.Screen name="Skill" component={Skill} options={pushed(t, "")} />
      <InfoStack.Screen name="SkillEdit" component={SkillEdit} layout={sheetRoom} options={({ route }) => sheet(t, route.params.name)} />
      <InfoStack.Screen name="SkillHistory" component={SkillHistory} options={pushed(t, "History")} />
      <InfoStack.Screen name="SkillVersion" component={SkillVersion} options={({ route }) => pushed(t, `Version ${String(route.params.version)}`)} />
      <InfoStack.Screen name="Artifacts" component={Artifacts} options={pushed(t, "Artifacts")} />
      <InfoStack.Screen name="Artifact" component={Artifact} options={{ ...pushed(t, ""), headerStyle: { backgroundColor: t.bg }, contentStyle: { backgroundColor: t.bg } }} />
      <InfoStack.Screen name="ArtifactVersions" component={ArtifactVersions} options={pushed(t, "Versions")} />
      <InfoStack.Screen name="Dms" component={Dms} options={pushed(t, "DMs Between Agents")} />
      <InfoStack.Screen name="Dm" component={Dm} options={pushed(t, "DM")} />
      <InfoStack.Screen name="Computer" component={Computer} options={pushed(t, "Computer")} />
      <InfoStack.Screen name="ComputerLog" component={ComputerLog} options={pushed(t, "Log")} />
      <InfoStack.Screen name="Vault" component={Vault} options={pushed(t, "Vault")} />
      <InfoStack.Screen name="VaultItem" component={VaultItem} options={pushed(t, "")} />
      <InfoStack.Screen name="VaultEdit" component={VaultEdit} layout={sheetRoom} options={sheet(t, "")} />
      <InfoStack.Screen name="VaultImport" component={VaultImport} layout={sheetRoom} options={sheet(t, "Import from 1Password")} />
      <InfoStack.Screen name="VaultMove" component={VaultMove} layout={sheetRoom} options={sheet(t, "")} />
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
