// A screen another covers whole (the chats list under a chat) holds the state as it was when it was covered, and so
// draws nothing again while it can't be seen: on a busy workspace the state changes several times a second, and every
// reader of it would draw again with each change. React Navigation's freezeOnBlur doesn't freeze the screen right under
// the open one on the new architecture (it keeps it for the back swipe), and that is the one that costs. Back on top,
// it takes the state as it is now. A sheet leaves the screen under it showing, so that one stays live.
import type { NavigationProp, NavigationState, ParamListBase, RouteProp } from "@react-navigation/native";
import { useContext, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { HubContext, HubStoreContext, useHub, type HubContextValue, type HubStore } from "../hubContext";

/** The screens that cover the whole screen under them when they're pushed over it: not sheets, which leave it showing. */
export const COVERING: ReadonlySet<string> = new Set(["Chat", "Settings", "ChatInfo", "Screen", "Photo"]);

/** Whether the route `key` has one that covers it whole right above it. */
export const coveredIn = (state: Pick<NavigationState, "routes"> | undefined, key: string): boolean => {
  const routes = state?.routes ?? [];
  const at = routes.findIndex((r) => r.key === key);
  const above = at < 0 ? undefined : routes[at + 1];
  return above !== undefined && COVERING.has(above.name);
};

/** The hub as a covered screen reads it: what it read when it was covered, and the live one again once it isn't. */
export const heldHub = (held: HubContextValue | undefined, live: HubContextValue, covered: boolean): HubContextValue => (covered && held !== undefined ? held : live);

const still = (state: HubContextValue["state"]): HubStore => ({ subscribe: () => () => undefined, getState: () => state });

/** A root screen's content, held while another screen covers it. */
export function Covered({ navigation, route, children }: { navigation: NavigationProp<ParamListBase>; route: RouteProp<ParamListBase>; children: ReactElement }) {
  const live = useHub();
  const liveStore = useContext(HubStoreContext);
  const [covered, setCovered] = useState(() => coveredIn(navigation.getState(), route.key));
  useEffect(() => {
    const look = () => setCovered(coveredIn(navigation.getState(), route.key));
    look();
    return navigation.addListener("state", look);
  }, [navigation, route.key]);
  const held = useRef<HubContextValue | undefined>(undefined);
  const hub = heldHub(held.current, live, covered);
  held.current = hub;
  // The same store while held, so the views that follow it (hubContext.ts useHubSelect) draw nothing again.
  const heldState = hub === live ? undefined : hub.state;
  const store = useMemo(() => (heldState === undefined ? liveStore : still(heldState)), [heldState, liveStore]);
  return (
    <HubContext.Provider value={hub}>
      <HubStoreContext.Provider value={store}>{children}</HubStoreContext.Provider>
    </HubContext.Provider>
  );
}

/** The layout of a root screen another can cover (App.tsx). */
export const coveredRoom = ({ navigation, route, children }: { navigation: NavigationProp<ParamListBase>; route: RouteProp<ParamListBase>; children: ReactElement }): ReactElement => (
  <Covered navigation={navigation} route={route}>
    {children}
  </Covered>
);
