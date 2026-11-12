// What every screen of a paired hub reads: its session, the state it shows, the pairing, and the way out.
import type { CompositeScreenProps, NavigatorScreenParams } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { createContext, useContext } from "react";
import type { KeptHub, SavedAccount } from "./cloud/account";
import type { SkillOrigin } from "./desktop";
import type { OnSignedIn } from "./screens/Cloud";
import type { AgentMessage } from "./screens/dms/model";
import type { VaultItemSummary, VaultKind } from "./screens/vault/types";
import type { Filter } from "./lists";
import type { Session } from "./session";
import type { Key, State } from "./store";

export interface HubContextValue {
  readonly session: Session;
  readonly state: State;
  /** The hub shown. */
  readonly paired: KeptHub;
  /** Asks first, then signs this phone out on the hub and forgets it. */
  readonly disconnect: () => void;
  /** Every hub this phone keeps a key for, the one shown among them. */
  readonly hubs: readonly KeptHub[];
  /** Who is signed in to fleetd cloud, or null. */
  readonly account: SavedAccount | null;
  /** Shows another hub this phone keeps, whose notifications then come here in this one's place. */
  readonly switchTo: (hub: KeptHub) => void;
  /** Keeps a sign-in's teams beside the hubs kept, and shows the first. */
  readonly signedIn: OnSignedIn;
  /** Asks first, then drops this phone's key on every team of the account and ends its session. */
  readonly signOutCloud: () => Promise<void>;
}

export const HubContext = createContext<HubContextValue | null>(null);

export const useHub = (): HubContextValue => {
  const hub = useContext(HubContext);
  if (hub === null) throw new Error("useHub outside a paired hub");
  return hub;
};

/**
 * The session alone, which never changes while paired: for a view that only calls the hub (a picture loading), so it
 * doesn't draw again with every change to the state (a streamed word).
 */
export const SessionContext = createContext<Session | null>(null);

export const useSession = (): Session => {
  const session = useContext(SessionContext);
  if (session === null) throw new Error("useSession outside a paired hub");
  return session;
};

export type RootParams = {
  /** Chats; Open Approvals (a Shortcuts action) opens it on Needs You. */
  Home: NavigatorScreenParams<ChatsParams> | undefined;
  /** The person's avatar on Chats opens it. */
  Settings: undefined;
  /**
   * `messageId`: a search hit; `requestId`: an approval, at its card. Either is scrolled to and lit for a moment.
   * `tap`: one notification tap from the next, so a second tap on the same one while the chat is open lands again (a
   * chat's own, with no message or approval, at its newest). `at`: opened again after the app was closed, scrolled
   * where it was (cache.ts OpenChat): `offset` points up from its newest end, its newest `rows` drawn from the first.
   */
  Chat: { key: Key; messageId?: string; requestId?: string; tap?: number; at?: { offset: number; rows: number } };
  /** A project's or agent's live screen, full screen over its chat (screens/Screen.tsx). */
  Screen: { key: Key; sessionId: string };
} & ManageParams;
/** The chats list's own stack: `filter` picks one, each time `at` changes (a link opened again). */
export type ChatsParams = {
  Chats: { filter?: Filter; at?: number } | undefined;
};
/** A project's own screens (screens/manage): made from the Chats list's +, opened from a chat's header. */
type ManageParams = {
  /** `back`: once made, back to where it was opened (Import Memory) rather than to its chat. */
  NewProject: { back?: boolean } | undefined;
  /** A screen of the person's own for a project: its kind and machine, then its live view (NewScreen.tsx). */
  NewScreen: { key: Key };
  /** A project's screen and what it opens, a stack of their own over its chat (manage/index.tsx ChatInfo). */
  ChatInfo: NavigatorScreenParams<ChatInfoParams>;
  /** Its icon: its bot, or a photo (IconPicker.tsx). */
  Icon: { key: Key };
  /** A photo as picked, moved and scaled in a circle to become the chat's picture; with no `key`, the person's own. */
  Photo: { key?: Key | undefined; uri: string; width: number; height: number; mime: "image/jpeg" | "image/png" | "image/webp" };
};
export type ChatInfoParams = {
  Info: { key: Key };
  Rename: { key: Key };
  Profiles: { key: Key };
  /** How its risky actions are approved, and what ran without asking (Approvals.tsx). */
  Approvals: { key: Key };
  /** All that ran without asking, read in pages as it scrolls (ApprovedLog.tsx). */
  ApprovedLog: { key: Key };
  /** The card it pays with and what it bought (Payments.tsx). */
  Payments: { key: Key };
  /** The other hubs it reaches (LinkedHubs.tsx). */
  LinkedHubs: { key: Key };
  /** Its skills (Skills.tsx), a skill's view, its editor, its history and one version's change. */
  Skills: { key: Key };
  Skill: { key: Key; origin: SkillOrigin; name: string };
  SkillEdit: { key: Key; name: string };
  SkillHistory: { key: Key; origin: SkillOrigin; name: string };
  SkillVersion: { key: Key; origin: SkillOrigin; name: string; version: number };
  /** The chat's artifacts (screens/artifacts), and one of them: its newest version, or `version`. */
  Artifacts: { key: Key };
  Artifact: { key: Key; name: string; version?: number | undefined };
  /** An artifact's versions, on Android (iOS picks them from the bar's menu); `shown`, the one open under it. */
  ArtifactVersions: { key: Key; name: string; shown?: number | undefined };
  /** Its agents' DMs to each other, newest first (screens/dms), and one of them with who got it when. */
  Dms: { key: Key };
  Dm: { key: Key; message: AgentMessage };
} & VaultParams;
/**
 * The Vault's screens (screens/vault), in Settings for the team's logins, cards and addresses, and in a project's
 * screen for its variables (`key`). `item` is the row's metadata, shown while the item is read again; never a value.
 */
export type VaultParams = {
  Vault: { key?: Key } | undefined;
  VaultItem: { itemId: string; item?: VaultItemSummary; key?: Key };
  /** A new item of `kind`, or `item` changed. */
  VaultEdit: { kind: VaultKind; item?: VaultItemSummary; key?: Key };
  /** Items picked from the person's 1Password, brought into the team vault. */
  VaultImport: undefined;
  /** A set-aside variable added to a project picked here. */
  VaultMove: { item: VaultItemSummary };
};
/** A ChatInfo screen's props: its own stack's, and the root stack's above it (Photo, back to the chats list). */
export type ChatInfoProps<T extends keyof ChatInfoParams> = CompositeScreenProps<NativeStackScreenProps<ChatInfoParams, T>, NativeStackScreenProps<RootParams>>;
/** Settings, a stack of its own from the avatar on Chats (App.tsx SettingsScreens), and what it pushes. */
export type SettingsParams = {
  Settings: undefined;
  ImportMemory: undefined;
  Devices: undefined;
} & VaultParams;
/** A Settings screen's props: its own stack's, and the root stack's above it (New Project). */
export type SettingsProps<T extends keyof SettingsParams> = CompositeScreenProps<NativeStackScreenProps<SettingsParams, T>, NativeStackScreenProps<RootParams>>;
export type PairParams = {
  Welcome: undefined;
  /** Use Your Own Hub, from a first screen that offers fleetd cloud's Sign In too: the welcome with the pairing's two ways. */
  OwnHub: undefined;
  Scan: undefined;
  /** A scanned or opened pairing link's hub and code, which `auto` pairs with at once. */
  Pair: { hub?: string; code?: string; auto?: boolean } | undefined;
};
