// What every screen of a paired hub reads: its session, the state it shows, the pairing, and the two ways out.
import type { NavigatorScreenParams } from "@react-navigation/native";
import { createContext, useContext } from "react";
import type { Paired } from "./hub/pair";
import type { Session } from "./session";
import type { Key, State } from "./store";

export interface HubContextValue {
  readonly session: Session;
  readonly state: State;
  readonly paired: Paired;
  /** Asks first, then signs this phone out on the hub and forgets it. */
  readonly disconnect: () => void;
  /** The key was refused: forget the hub, to pair again. */
  readonly pairAgain: () => void;
}

export const HubContext = createContext<HubContextValue | null>(null);

export const useHub = (): HubContextValue => {
  const hub = useContext(HubContext);
  if (hub === null) throw new Error("useHub outside a paired hub");
  return hub;
};

export type ApprovalsParams = { Approvals: { focus?: string } | undefined };
export type TabParams = {
  ChatsTab: undefined;
  ApprovalsTab: NavigatorScreenParams<ApprovalsParams> | undefined;
  SettingsTab: undefined;
};
export type RootParams = {
  Home: NavigatorScreenParams<TabParams> | undefined;
  Chat: { key: Key };
} & ManageParams;
/** A project's and a Navi's own screens (screens/manage): made from the Chats list's +, opened from a chat's header. */
export type ManageParams = {
  NewNavi: undefined;
  NewProject: undefined;
  Info: { key: Key };
  Rename: { key: Key };
  Profiles: { key: Key };
};
export type PairParams = {
  Welcome: undefined;
  Scan: undefined;
  /** A scanned or opened pairing link's hub and code, which `auto` pairs with at once. */
  Pair: { hub?: string; code?: string; auto?: boolean } | undefined;
};
