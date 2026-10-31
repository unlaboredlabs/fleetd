// What every screen of a paired hub reads: its session, the state it shows, the pairing, and the way out.
import type { CompositeScreenProps, NavigatorScreenParams } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { createContext, useContext } from "react";
import type { SkillOrigin } from "./desktop";
import type { Paired } from "./hub/pair";
import type { Session } from "./session";
import type { Key, State } from "./store";

export interface HubContextValue {
  readonly session: Session;
  readonly state: State;
  readonly paired: Paired;
  /** Asks first, then signs this phone out on the hub and forgets it. */
  readonly disconnect: () => void;
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
  Home: undefined;
  /** The person's avatar on Chats opens it. */
  Settings: undefined;
  /**
   * `messageId`: a search hit; `requestId`: an approval, at its card. Either is scrolled to and lit for a moment.
   * `tap`: one notification tap from the next, so a second tap on the same one while the chat is open lands again.
   */
  Chat: { key: Key; messageId?: string; requestId?: string; tap?: number };
} & ManageParams;
/** A project's and a Navi's own screens (screens/manage): made from the Chats list's +, opened from a chat's header. */
export type ManageParams = {
  NewNavi: undefined;
  NewProject: undefined;
  /** A project's or Navi's screen and what it opens, a stack of their own over its chat (manage/index.tsx ChatInfo). */
  ChatInfo: NavigatorScreenParams<ChatInfoParams>;
  /** Its icon: a built-in face and color, or a photo (IconPicker.tsx). */
  Icon: { key: Key };
  /** A photo as picked, moved and scaled in a circle to become the chat's picture. */
  Photo: { key: Key; uri: string; width: number; height: number; mime: "image/jpeg" | "image/png" | "image/webp" };
};
export type ChatInfoParams = {
  Info: { key: Key };
  Rename: { key: Key };
  Profiles: { key: Key };
  /** A Navi's skills (Skills.tsx), a skill's view, its editor, its history and one version's change. */
  Skills: { key: Key };
  Skill: { key: Key; origin: SkillOrigin; name: string };
  SkillEdit: { key: Key; name: string };
  SkillHistory: { key: Key; origin: SkillOrigin; name: string };
  SkillVersion: { key: Key; origin: SkillOrigin; name: string; version: number };
};
/** A ChatInfo screen's props: its own stack's, and the root stack's above it (Photo, back to the chats list). */
export type ChatInfoProps<T extends keyof ChatInfoParams> = CompositeScreenProps<NativeStackScreenProps<ChatInfoParams, T>, NativeStackScreenProps<RootParams>>;
export type PairParams = {
  Welcome: undefined;
  Scan: undefined;
  /** A scanned or opened pairing link's hub and code, which `auto` pairs with at once. */
  Pair: { hub?: string; code?: string; auto?: boolean } | undefined;
};
