// The app: pair with a hub once, then its chats, where its approvals are answered too. The paired hub lives in secure
// storage (vault.ts); one Session talks to it while the app runs, and checks its link whenever the app comes back to
// the front. Pairing makes the phone's notification key; Disconnect signs the phone out on the hub, after a confirm, and
// forgets both. A build given fleetd cloud's values also signs in (screens/Cloud.tsx): each of the account's teams is a
// hub this phone keeps a key for, beside the person's own; one is shown at a time, its notifications the ones that
// come, and Settings switches between them. A pairing link (`fleetd://pair?…`, from a QR code scanned with iOS's
// Camera) opens the app and, once confirmed, pairs it. A Shortcuts action's link (src/shortcutLink.ts) opens a chat, or Chats on Needs You.
//
// Navigation is iOS's own (react-native-screens): Chats, as Messages on iOS 26, with a compact bar on top and the
// search field and filters in a toolbar at the bottom, no tab bar; the person's avatar at its top left pushes
// Settings, a stack with a large title of its own, and a chat is pushed over the list, which a swipe from the edge
// takes back. An approval has no screen of its own: its chat floats to the top of Chats, and its card in the chat
// answers it.
import { createNavigationContainerRef, NavigationContainer, useNavigation, type InitialState } from "@react-navigation/native";
import { createNativeStackNavigator, type NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { requireOptionalNativeModule } from "expo";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActionSheetIOS, Alert, AppState, Linking, Platform, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { diskCache, diskPreviews, forgetCache, forgetPreviews } from "./src/cacheStore";
import { watchNetwork } from "./src/networkWatch";
import { webSocketTransport } from "./src/hub/socket";
import { afterSignIn, endSession, revokeDropped, revokeOver, signOutAll, type KeptHub, type SavedAccount } from "./src/cloud/account";
import { cloudDomain } from "./src/desktop";
import { pairLinkStep } from "./src/hub/pairLink";
import { HubContext, SessionContext, type ChatsParams, type HubContextValue, type PairParams, type RootParams, type SettingsParams } from "./src/hubContext";
import { pushDeps, useTappedRoute } from "./src/notifications";
import { pinStoreFor, sectionStoreFor } from "./src/prefsStore";
import { sameHub } from "./src/devices";
import { chatAt, type Route } from "./src/push";
import { Chat, chatOptions } from "./src/screens/Chat";
import { Chats, searchBar } from "./src/screens/Chats";
import { cloud, type OnSignedIn } from "./src/screens/Cloud";
import { Pair, Scan, Welcome } from "./src/screens/Connect";
import { backTo, infoOptions, manageScreens, newChatOptions, pushed, sheet } from "./src/screens/manage";
import { Devices } from "./src/screens/Devices";
import { ImportMemory } from "./src/screens/ImportMemory";
import { Screen } from "./src/screens/Screen";
import { Settings } from "./src/screens/Settings";
import { Vault } from "./src/screens/vault/Vault";
import { VaultEdit } from "./src/screens/vault/VaultEdit";
import { VaultImport } from "./src/screens/vault/VaultImport";
import { VaultItem } from "./src/screens/vault/VaultItem";
import { VaultMove } from "./src/screens/vault/VaultMove";
import { parseShortcutLink, type ShortcutLink } from "./src/shortcutLink";
import { Session } from "./src/session";
import type { State } from "./src/store";
import { devicesStack, tapGoesNowhere, tappedStack } from "./src/tapped";
import { navigationTheme, useTheme, type Palette } from "./src/theme";
import { haptics } from "./src/ui/haptics";
import { SwipeGroup, useSwipeGroup } from "./src/ui/SwipeRow";
import { forgetPaired, forgetPush, loadAccount, loadHubs, loadPaired, pairWith, saveAccount, saveHubs } from "./src/vault";

const nav = createNavigationContainerRef<RootParams>();
const pairNav = createNavigationContainerRef<PairParams>();

// The splash stays until the first screen is on screen (its stack's transitionEnd, iOS's viewDidAppear), with the chats
// as last seen (cache.ts): left to itself it goes on React's first frame, an empty one while secure storage is read,
// and the app opened on a blank screen for a moment. It never stays longer than SPLASH_MOST_MS.
const SPLASH_MOST_MS = 3000;
void SplashScreen.preventAutoHideAsync().catch(() => undefined);
const firstScreen = (): void => SplashScreen.hide();
setTimeout(firstScreen, SPLASH_MOST_MS);

/** Where a Shortcuts action opens the app, left by it (modules/shortcut-link): iOS opens no scheme of ours for one. */
const shortcutLinks =
  Platform.OS === "ios" ? requireOptionalNativeModule<{ take(): string | null; addListener(event: "onOpened", listener: () => void): { remove(): void } }>("FleetdShortcutLink") : null;

/** The newest link the app was opened with (or while running), until it is handled. */
const useOpenedLink = (): [string | null, () => void] => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    void Linking.getInitialURL().then((u) => u && setUrl(u));
    const sub = Linking.addEventListener("url", (e) => setUrl(e.url));
    const take = () => {
      const left = shortcutLinks?.take() ?? null;
      if (left !== null) setUrl(left);
    };
    take();
    const opened = shortcutLinks?.addListener("onOpened", take);
    return () => {
      sub.remove();
      opened?.remove();
    };
  }, []);
  const handled = useCallback(() => setUrl(null), []);
  return [url, handled];
};

export default function App() {
  const t = useTheme();
  // The hub shown; undefined while secure storage is read.
  const [paired, setPaired] = useState<KeptHub | null | undefined>(undefined);
  // Every hub this phone keeps a key for, and who is signed in to fleetd cloud.
  const [hubs, setHubs] = useState<readonly KeptHub[]>([]);
  const [account, setAccount] = useState<SavedAccount | null>(null);
  const [note, setNote] = useState<string | undefined>(undefined);
  // Storage that can't be read pairs again, rather than leave a blank screen.
  useEffect(() => {
    void (async () => {
      const shown = await loadPaired().catch(() => null);
      const list = await loadHubs(shown).catch(() => (shown === null ? [] : [shown]));
      setAccount(await loadAccount().catch(() => null));
      setHubs(list);
      setPaired(shown === null ? null : (list.find((h) => h.hub === shown.hub) ?? shown));
    })();
  }, []);
  /** Shows `next` (null: none, the first screen), `list` the hubs kept; a hub shown gets a notification key pair of its own. */
  const show = useCallback(async (next: KeptHub | null, list: readonly KeptHub[]) => {
    await saveHubs(list);
    setHubs(list);
    if (next === null) {
      forgetCache();
      await Promise.all([forgetPaired(), forgetPush()]);
    } else await pairWith(next);
    setPaired(next);
  }, []);
  // Disconnect, or a key the hub refused: that hub goes, and the next one kept shows, or the first screen.
  const forget = useCallback(
    (why?: string) => {
      const rest = hubs.filter((h) => h.hub !== paired?.hub);
      setNote(rest.length === 0 ? why : undefined);
      forgetCache();
      void show(rest[0] ?? null, rest).catch(() => setPaired(null));
    },
    [hubs, paired, show],
  );
  // Signed in: the account's teams beside the person's own hubs, the first of them shown. A new sign-in's session
  // replaces the one kept, which ends as signing out would end it; each key it replaces, and an earlier account's
  // teams, are revoked on their hubs from memory as they leave the keychain.
  const signedIn = useCallback<OnSignedIn>(
    async (out) => {
      const before = account;
      await saveAccount(out.account);
      setAccount(out.account);
      if (cloud !== null && before !== null && before.sessionId !== out.account.sessionId) void endSession(fetch, cloud, before.sessionId);
      const { hubs: list, dropped } = afterSignIn(hubs, out.teams);
      void revokeDropped((h) => revokeOver({ hub: h.hub, key: h.key, transport: webSocketTransport }), dropped);
      forgetPreviews(dropped.filter((h) => !list.some((k) => k.hub === h.hub)).map((h) => h.hub));
      setNote(undefined);
      await show(list.find((h) => h.cloud === true) ?? null, list);
    },
    [account, hubs, show],
  );
  // Signed out, `rest` the hubs left: a team shown gives way to the person's own hub, or the first screen.
  const signedOut = useCallback(
    async (rest: readonly KeptHub[]) => {
      await saveAccount(null).catch(() => undefined);
      setAccount(null);
      // The teams' picture previews go with them; the hub that stays keeps its own.
      forgetPreviews(hubs.filter((h) => !rest.some((r) => r.hub === h.hub)).map((h) => h.hub));
      if (paired?.cloud === true) await show(rest[0] ?? null, rest);
      else await saveHubs(rest).then(() => setHubs(rest));
    },
    [hubs, paired, show],
  );
  const theme = useMemo(() => navigationTheme(t), [t]);
  // A pairing link from outside the app (iOS's Camera, a page, a message): a phone that isn't paired asks first, once
  // the pairing screens are up, as anyone can send one; a paired one says how to switch hubs.
  const [link, handled] = useOpenedLink();
  // Bumped each time the pairing screens come up: a link that came first goes on then.
  const [pairShown, setPairShown] = useState(0);
  // A Shortcuts action's link, until the paired hub's screens go there.
  const [opened, setOpened] = useState<ShortcutLink | null>(null);
  useEffect(() => {
    if (link === null || paired === undefined) return;
    const shortcut = parseShortcutLink(link);
    if (shortcut !== null) {
      // A phone that isn't paired shows its pairing screens.
      if (paired !== null) setOpened(shortcut);
      return handled();
    }
    const step = pairLinkStep(link, "outside", paired?.hubName ?? null, cloud === null ? null : cloudDomain(cloud.accountsUrl));
    if (step.t === "ignore") return handled();
    if (step.t === "paired") {
      Alert.alert(step.title, step.message);
      return handled();
    }
    if (step.t === "refuse") {
      haptics.warning();
      Alert.alert(step.failure.message, step.failure.fix?.replace(/`/gu, ""));
      return handled();
    }
    // From outside, a good link always asks first.
    if (step.t !== "confirm") return handled();
    if (!pairNav.isReady()) return;
    handled();
    const { hub, code } = step;
    Alert.alert(step.title, step.message, [
      { text: "Cancel", style: "cancel" },
      { text: "Connect", onPress: () => pairNav.navigate("Pair", { hub, code, auto: true }) },
    ]);
  }, [link, paired, pairShown, handled]);
  // Behind every screen, as during a push or a keyboard's slide: the scheme's ground, not the build's one color.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(t.bg).catch(() => undefined);
  }, [t.bg]);
  return (
    <GestureHandlerRootView style={styles.fill}>
    <KeyboardProvider>
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <View style={[styles.fill, { backgroundColor: t.bg }]}>
        {paired === undefined ? null : paired === null ? (
          <NavigationContainer ref={pairNav} theme={theme} onReady={() => setPairShown((n) => n + 1)}>
            <Pairing
              note={note}
              onPaired={async (p) => {
                await show(p, [...hubs.filter((h) => h.hub !== p.hub), p]);
                setNote(undefined);
              }}
              onSignedIn={signedIn}
            />
          </NavigationContainer>
        ) : (
          <Hub
            key={`${paired.hub} ${paired.key}`}
            paired={paired}
            hubs={hubs}
            account={account}
            onForget={forget}
            onShow={(h) => void show(h, hubs).catch(() => Alert.alert("Couldn't switch hubs", "This phone couldn't write its keychain. Try again."))}
            onSignedIn={signedIn}
            onSignedOut={signedOut}
            opened={opened}
            onOpened={() => setOpened(null)}
          />
        )}
      </View>
    </SafeAreaProvider>
    </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

/** A large title that collapses into a translucent bar, as Settings'. */
const largeTitle = (t: Palette): NativeStackNavigationOptions => ({
  headerLargeTitleEnabled: true,
  headerLargeTitleShadowVisible: false,
  headerTintColor: t.label,
  headerTitleStyle: { color: t.label },
  headerLargeTitleStyle: { color: t.label },
  ...(Platform.OS === "ios" ? {} : { headerStyle: { backgroundColor: t.bg }, headerShadowVisible: false }),
});

const PairStack = createNativeStackNavigator<PairParams>();

function Pairing({ note, onPaired, onSignedIn }: { note: string | undefined; onPaired: (p: KeptHub) => Promise<void>; onSignedIn: OnSignedIn }) {
  const t = useTheme();
  return (
    <PairStack.Navigator screenListeners={{ transitionEnd: firstScreen }} screenOptions={{ headerTintColor: t.label, headerTitleStyle: { color: t.label }, headerShadowVisible: false, ...(Platform.OS === "ios" ? {} : { headerStyle: { backgroundColor: t.grouped } }), contentStyle: { backgroundColor: t.grouped } }}>
      <PairStack.Screen name="Welcome" options={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }}>
        {(props) => <Welcome {...props} note={note} onSignedIn={onSignedIn} />}
      </PairStack.Screen>
      <PairStack.Screen name="OwnHub" options={{ title: "", headerTransparent: true, headerBackButtonDisplayMode: "minimal", contentStyle: { backgroundColor: t.bg } }}>
        {(props) => <Welcome {...props} note={undefined} onSignedIn={onSignedIn} own />}
      </PairStack.Screen>
      <PairStack.Screen name="Scan" component={Scan} options={{ headerShown: false, presentation: "fullScreenModal", contentStyle: { backgroundColor: "#000000" } }} />
      <PairStack.Screen name="Pair" options={{ title: "Enter Code", headerBackButtonDisplayMode: "minimal" }}>
        {(props) => <Pair {...props} onPaired={onPaired} />}
      </PairStack.Screen>
    </PairStack.Navigator>
  );
}

let taps = 0;

/**
 * Opens where a tapped notification goes, an approval's chat at its card, a screen's live view over its chat (push.ts
 * chatAt), over the chats list and nothing else (tapped.ts): false while not known yet.
 */
const go = (route: Route, state: Pick<State, "requests" | "requestsRead" | "projects">, hub: string): boolean => {
  // A new sign-in's: this hub's Devices, to sign it out there; another hub's (shown before a switch) just opens the app.
  if (route.t === "devices") {
    if (sameHub(route.hub, hub)) nav.reset(devicesStack(nav.getRootState()?.routes ?? []) as Parameters<typeof nav.reset>[0]);
    return true;
  }
  const at = chatAt(route, state.requests, state.requestsRead);
  if (at === undefined) return false;
  if (at === null || tapGoesNowhere(state.projects, at)) return true;
  // A screen that won't let go (an edited skill's "Discard changes?") keeps the stack as it is.
  nav.reset(tappedStack(nav.getRootState()?.routes ?? [], at, ++taps) as Parameters<typeof nav.reset>[0]);
  return true;
};

/** Asks before a destructive step, as iOS does: an action sheet, or Android's alert. */
const confirm = (title: string, message: string, action: string, onYes: () => void, onNo: () => void = () => undefined): void => {
  haptics.warning();
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions({ title, message, options: [action, "Cancel"], destructiveButtonIndex: 0, cancelButtonIndex: 1 }, (i) => (i === 0 ? onYes() : onNo()));
  } else {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: onNo },
      { text: action, style: "destructive", onPress: onYes },
    ]);
  }
};

interface HubProps {
  readonly paired: KeptHub;
  readonly hubs: readonly KeptHub[];
  readonly account: SavedAccount | null;
  readonly onForget: (why?: string) => void;
  /** Shows another hub kept. */
  readonly onShow: (hub: KeptHub) => void;
  readonly onSignedIn: OnSignedIn;
  /** The account's teams are signed out, `rest` the hubs left. */
  readonly onSignedOut: (rest: readonly KeptHub[]) => Promise<void>;
  readonly opened: ShortcutLink | null;
  readonly onOpened: () => void;
}

function Hub({ paired, hubs, account, onForget, onShow, onSignedIn, onSignedOut, opened, onOpened }: HubProps) {
  const session = useMemo(() => new Session({ hub: paired.hub, key: paired.key, transport: webSocketTransport, push: pushDeps, pins: pinStoreFor(paired.hub), sections: sectionStoreFor(paired.hub), cache: diskCache, previews: diskPreviews }), [paired]);
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const t = useTheme();
  const theme = useMemo(() => navigationTheme(t), [t]);
  // Read once, as the navigator starts: a tapped notification's chat replaces it (tryPending).
  const [reopened] = useState(() => reopenedState(session.reopen));
  // A tapped notification before the navigator is ready, or before an approval's chat is known, waits for them.
  const pending = useRef<Route | null>(null);
  // Open Approvals' link, which waits for the navigator too.
  const approvals = useRef(false);
  const tryPending = useCallback(() => {
    if (!nav.isReady()) return;
    if (approvals.current) {
      approvals.current = false;
      nav.navigate("Home", { screen: "Chats", params: { filter: "needsYou", at: ++taps } });
    }
    if (pending.current === null) return;
    if (go(pending.current, session.getState(), paired.hub)) pending.current = null;
  }, [session, paired.hub]);
  useTappedRoute((route) => {
    pending.current = route;
    tryPending();
  });
  useEffect(() => {
    tryPending();
    return nav.addListener("state", tryPending);
  }, [tryPending]);
  useEffect(tryPending, [state.requests, state.requestsRead, tryPending]);
  useEffect(() => {
    if (opened === null) return;
    if (opened.t === "chat") pending.current = { t: "chat", key: opened.key };
    else approvals.current = true;
    onOpened();
    tryPending();
  }, [opened, onOpened, tryPending]);

  useEffect(() => {
    session.start();
    // Only from behind: Control Center, a system alert or Face ID make the app inactive a moment, and its link lives.
    let was = AppState.currentState;
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active" && was === "background") session.wake();
      if (s === "background") session.sleep();
      was = s;
    });
    const unwatch = watchNetwork(() => session.networkChanged());
    return () => {
      sub.remove();
      unwatch();
      session.stop();
    };
  }, [session]);

  // Signing out of the hub shown: its key is revoked on purpose, so the hub refusing it is no news to say.
  const leaving = useRef(false);
  const value = useMemo((): HubContextValue => {
    const signOut = () =>
      void session.signOut().then((r) => {
        if (r.ok) return onForget();
        leaving.current = false;
        Alert.alert("The hub didn't sign this phone out", `${r.error.message} Forget the hub here anyway? Then sign the phone out under Settings › You in the desktop app.`, [
          { text: "Cancel", style: "cancel" },
          { text: "Forget anyway", style: "destructive", onPress: () => onForget() },
        ]);
      });
    const disconnect = () =>
      confirm(`Disconnect from ${paired.hubName}?`, "This phone signs out of the hub and stops getting its notifications. Pairing again takes a new code.", "Disconnect", () => {
        leaving.current = true;
        signOut();
      });
    // This hub's notifications stop before another's start: each hub shown gets its own key pair.
    const switchTo = (hub: KeptHub) => {
      haptics.select();
      void session.leave().finally(() => onShow(hub));
    };
    const signedIn: OnSignedIn = async (out) => {
      await session.leave().catch(() => undefined);
      await onSignedIn(out);
    };
    const teams = hubs.filter((h) => h.cloud === true);
    const names = teams.map((h) => h.hubName).join(", ");
    const signOutCloud = () =>
      new Promise<void>((resolve) =>
        confirm(
          "Sign Out of fleetd?",
          `This phone drops its key on ${names === "" ? "your fleetd teams" : names} and stops getting their notifications. Agents keep running, and your own hubs stay as they are.`,
          "Sign Out",
          () => {
            if (paired.cloud === true) leaving.current = true;
            void signOutAll(
              {
                config: cloud,
                fetch,
                // Every team kept, not only the one shown: the shown one over its own link, the others over one each.
                revoke: (h) => (h.hub === paired.hub ? session.signOut().then((r) => r.ok) : revokeOver({ hub: h.hub, key: h.key, transport: webSocketTransport })),
              },
              account,
              hubs,
            )
              .then(async (out) => {
                await onSignedOut(out.hubs);
                if (out.kept.length > 0) Alert.alert("Some teams weren't reached", `${out.kept.join(", ")} couldn't be reached, so this phone stays in its Devices until someone signs it out there.`);
              })
              .finally(resolve);
          },
          resolve,
        ),
      );
    return { session, state, paired, disconnect, hubs, account, switchTo, signedIn, signOutCloud };
  }, [session, state, paired, hubs, account, onForget, onShow, onSignedIn, onSignedOut]);

  // A refused key is the one link state that asks something of the person: iOS's own alert, over whatever shows.
  const refused = state.hub.phase === "refused" ? state.hub.message : undefined;
  useEffect(() => {
    if (refused === undefined || leaving.current) return;
    haptics.warning();
    Alert.alert("Pair This Phone Again", refused, [
      { text: "Not Now", style: "cancel" },
      { text: "Pair Again", onPress: () => onForget("This phone's key was refused: pair it again.") },
    ]);
  }, [refused, onForget]);

  return (
    <SessionContext.Provider value={session}>
      <HubContext.Provider value={value}>
        <NavigationContainer ref={nav} theme={theme} {...(reopened === undefined ? {} : { initialState: reopened })}>
          <Root />
        </NavigationContainer>
      </HubContext.Provider>
    </SessionContext.Provider>
  );
}

/**
 * The chat that was open when the app was last closed, over the chats list, where it was scrolled to: the app opens
 * where it was left, as Messages does, rather than on the list.
 */
const reopenedState = (reopen: Session["reopen"]): InitialState | undefined =>
  reopen === undefined
    ? undefined
    : {
        index: 1,
        routes: [
          { name: "Home", params: undefined },
          { name: "Chat", params: { key: reopen.key, at: { offset: reopen.at.offset, rows: reopen.at.rows } } },
        ],
      };

const RootStack = createNativeStackNavigator<RootParams>();

function Root() {
  const t = useTheme();
  return (
    // A screen under another (the chats list under a chat) doesn't draw again while it's covered: a streamed reply
    // changes the state with every word.
    <RootStack.Navigator screenListeners={{ transitionEnd: firstScreen }} screenOptions={{ headerTintColor: t.label, contentStyle: { backgroundColor: t.bg }, freezeOnBlur: true }}>
      <RootStack.Screen name="Home" component={ChatsHome} options={{ headerShown: false, title: "Chats" }} />
      <RootStack.Screen name="Settings" component={SettingsScreens} options={{ headerShown: false }} />
      {/* One screen per chat, and per live screen: opening another pushes it, never swaps the open one's in place. */}
      <RootStack.Screen name="Chat" component={Chat} getId={({ params }) => params.key} options={({ route }) => ({ ...chatOptions(t), ...infoOptions(t, () => nav.navigate("ChatInfo", { screen: "Info", params: { key: route.params.key } })) })} />
      <RootStack.Screen name="Screen" component={Screen} getId={({ params }) => params.sessionId} options={{ headerShown: false, presentation: "fullScreenModal", gestureEnabled: false, contentStyle: { backgroundColor: t.dark ? "#000000" : t.grouped } }} />
      {manageScreens(RootStack, t)}
    </RootStack.Navigator>
  );
}

const ChatsStack = createNativeStackNavigator<ChatsParams>();
const SettingsStack = createNativeStackNavigator<SettingsParams>();

/** The chats list in a stack of its own, whose bar and toolbar (ui/Toolbar.tsx) slide away under a chat. */
function ChatsHome() {
  const t = useTheme();
  const swiped = useSwipeGroup();
  return (
    <SwipeGroup swipes={swiped}>
      {/* A touch on the screen away from the rows closes the open one: the list's space, and the native bars' avatar,
          +, filters button and search field, which only a view around the navigator hears. */}
      <View style={styles.fill} onTouchStart={swiped.touched}>
        <ChatsStack.Navigator screenOptions={{ headerTintColor: t.label, headerShadowVisible: false, contentStyle: { backgroundColor: t.bg }, ...(Platform.OS === "ios" ? {} : { headerStyle: { backgroundColor: t.bg } }) }}>
          <ChatsStack.Screen name="Chats" component={Chats} options={{ headerSearchBarOptions: searchBar, ...newChatOptions(t, () => nav.navigate("NewProject")) }} />
        </ChatsStack.Navigator>
      </View>
    </SwipeGroup>
  );
}

/**
 * Settings, from the avatar on Chats: a stack of its own with its large title, as the chat's Info, and a way back.
 * Import Memory is pushed over it, with a small title and the system's back button; the Vault with a large title of
 * its own, as iOS's Passwords, its items pushed over it and its forms as sheets.
 */
function SettingsScreens() {
  const t = useTheme();
  const root = useNavigation();
  return (
    <SettingsStack.Navigator screenOptions={{ ...largeTitle(t), contentStyle: { backgroundColor: t.grouped } }}>
      <SettingsStack.Screen name="Settings" component={Settings} options={backTo(t, () => root.goBack())} />
      <SettingsStack.Screen name="Devices" component={Devices} options={{ ...pushed(t, "Devices"), headerLargeTitleEnabled: false }} />
      <SettingsStack.Screen name="ImportMemory" component={ImportMemory} options={{ ...pushed(t, "Import Memory"), headerLargeTitleEnabled: false }} />
      <SettingsStack.Screen name="Vault" component={Vault} options={{ ...pushed(t, "Vault"), headerLargeTitleEnabled: true }} />
      <SettingsStack.Screen name="VaultItem" component={VaultItem} options={{ ...pushed(t, ""), headerLargeTitleEnabled: false }} />
      <SettingsStack.Screen name="VaultEdit" component={VaultEdit} options={{ ...sheet(t, ""), headerLargeTitleEnabled: false }} />
      <SettingsStack.Screen name="VaultImport" component={VaultImport} options={{ ...sheet(t, "Import from 1Password"), headerLargeTitleEnabled: false }} />
      <SettingsStack.Screen name="VaultMove" component={VaultMove} options={{ ...sheet(t, ""), headerLargeTitleEnabled: false }} />
    </SettingsStack.Navigator>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
