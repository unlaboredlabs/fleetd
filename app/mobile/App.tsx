// The app: pair with a hub once, then its chats, where its approvals are answered too. The paired hub lives in secure
// storage (vault.ts); one Session talks to it while the app runs, and dials again whenever the app comes back to the
// front. Pairing makes the phone's notification key; Disconnect signs the phone out on the hub, after a confirm, and
// forgets both. A pairing link (`fleetd://pair?…`, from a QR code scanned with iOS's Camera) opens the app and, once
// confirmed, pairs it.
//
// Navigation is iOS's own (react-native-screens): UIKit's tab bar for Chats and Settings (a drawn one on Android), each
// a stack with a large title that collapses on scroll, and a chat pushed over them, which a swipe from the edge takes
// back. An approval has no screen of its own: its chat floats to the top of Chats, and its card in the chat answers it.
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeBottomTabNavigator } from "@react-navigation/bottom-tabs/unstable";
import { createNavigationContainerRef, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator, type NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActionSheetIOS, Alert, AppState, Linking, Platform, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { webSocketTransport } from "./src/hub/socket";
import type { Paired } from "./src/hub/pair";
import { pairLinkStep } from "./src/hub/pairLink";
import { HubContext, SessionContext, useHub, type HubContextValue, type PairParams, type RootParams, type TabParams } from "./src/hubContext";
import { approvals } from "./src/lists";
import { pushDeps, useTappedRoute } from "./src/notifications";
import { chatAt, type Route } from "./src/push";
import { Chat, chatOptions } from "./src/screens/Chat";
import { Chats, searchBar } from "./src/screens/Chats";
import { Pair, Scan, Welcome } from "./src/screens/Connect";
import { infoOptions, manageScreens, newChatOptions } from "./src/screens/manage";
import { Settings } from "./src/screens/Settings";
import { Session } from "./src/session";
import { navigationTheme, useTheme, type Palette } from "./src/theme";
import { haptics } from "./src/ui/haptics";
import { Icon, sfSymbol, type IconName } from "./src/ui/Icon";
import { forgetPaired, forgetPush, loadPaired, pairWith } from "./src/vault";

const nav = createNavigationContainerRef<RootParams>();
const pairNav = createNavigationContainerRef<PairParams>();

/** The newest link the app was opened with (or while running), until it is handled. */
const useOpenedLink = (): [string | null, () => void] => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    void Linking.getInitialURL().then((u) => setUrl(u ?? null));
    const sub = Linking.addEventListener("url", (e) => setUrl(e.url));
    return () => sub.remove();
  }, []);
  const handled = useCallback(() => setUrl(null), []);
  return [url, handled];
};

export default function App() {
  const t = useTheme();
  // Undefined while secure storage is read.
  const [paired, setPaired] = useState<Paired | null | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  // Storage that can't be read pairs again, rather than leave a blank screen.
  useEffect(() => {
    void loadPaired()
      .catch(() => null)
      .then(setPaired);
  }, []);
  const forget = useCallback((why?: string) => {
    setNote(why);
    void Promise.all([forgetPaired(), forgetPush()]).then(() => setPaired(null));
  }, []);
  const theme = useMemo(() => navigationTheme(t), [t]);
  // A pairing link from outside the app (iOS's Camera, a page, a message): a phone that isn't paired asks first, once
  // the pairing screens are up, as anyone can send one; a paired one says how to switch hubs.
  const [link, handled] = useOpenedLink();
  // Bumped each time the pairing screens come up: a link that came first goes on then.
  const [pairShown, setPairShown] = useState(0);
  useEffect(() => {
    if (link === null || paired === undefined) return;
    const step = pairLinkStep(link, "outside", paired?.hubName ?? null);
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
                await pairWith(p);
                setNote(undefined);
                setPaired(p);
              }}
            />
          </NavigationContainer>
        ) : (
          <NavigationContainer ref={nav} theme={theme}>
            <Hub key={`${paired.hub} ${paired.key}`} paired={paired} onForget={forget} />
          </NavigationContainer>
        )}
      </View>
    </SafeAreaProvider>
    </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

/** A large title that collapses into a translucent bar, as Messages' and Settings'. */
const largeTitle = (t: Palette): NativeStackNavigationOptions => ({
  headerLargeTitleEnabled: true,
  headerLargeTitleShadowVisible: false,
  headerTintColor: t.accent,
  headerTitleStyle: { color: t.label },
  headerLargeTitleStyle: { color: t.label },
  ...(Platform.OS === "ios" ? {} : { headerStyle: { backgroundColor: t.bg }, headerShadowVisible: false }),
});

const PairStack = createNativeStackNavigator<PairParams>();

function Pairing({ note, onPaired }: { note: string | undefined; onPaired: (p: Paired) => Promise<void> }) {
  const t = useTheme();
  return (
    <PairStack.Navigator screenOptions={{ headerTintColor: t.accent, headerTitleStyle: { color: t.label }, headerShadowVisible: false, headerStyle: { backgroundColor: t.grouped }, contentStyle: { backgroundColor: t.grouped } }}>
      <PairStack.Screen name="Welcome" options={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }}>
        {(props) => <Welcome {...props} note={note} />}
      </PairStack.Screen>
      <PairStack.Screen name="Scan" component={Scan} options={{ headerShown: false, presentation: "fullScreenModal", contentStyle: { backgroundColor: "#000000" } }} />
      <PairStack.Screen name="Pair" options={{ title: "Enter Code", headerBackButtonDisplayMode: "minimal" }}>
        {(props) => <Pair {...props} onPaired={onPaired} />}
      </PairStack.Screen>
    </PairStack.Navigator>
  );
}

let taps = 0;

/** Opens where a tapped notification goes, an approval's chat at its card (push.ts chatAt): false while not known yet. */
const go = (route: Route, requests: Parameters<typeof chatAt>[1]): boolean => {
  const at = chatAt(route, requests);
  if (at === undefined) return false;
  if (at !== null) nav.navigate("Chat", at.requestId === undefined ? { key: at.key } : { key: at.key, requestId: at.requestId, tap: ++taps });
  return true;
};

function Hub({ paired, onForget }: { paired: Paired; onForget: (why?: string) => void }) {
  const session = useMemo(() => new Session({ hub: paired.hub, key: paired.key, transport: webSocketTransport, push: pushDeps }), [paired]);
  const state = useSyncExternalStore(session.subscribe, session.getState);
  // A tapped notification before the navigator is ready, or before an approval's chat is known, waits for them.
  const pending = useRef<Route | null>(null);
  const tryPending = useCallback(() => {
    if (pending.current === null || !nav.isReady()) return;
    if (go(pending.current, session.getState().requests)) pending.current = null;
  }, [session]);
  useTappedRoute((route) => {
    pending.current = route;
    tryPending();
  });
  useEffect(() => {
    tryPending();
    return nav.addListener("state", tryPending);
  }, [tryPending]);
  useEffect(tryPending, [state.requests, tryPending]);

  useEffect(() => {
    session.start();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") session.wake();
    });
    return () => {
      sub.remove();
      session.stop();
    };
  }, [session]);

  const value = useMemo((): HubContextValue => {
    const signOut = () =>
      void session.signOut().then((r) => {
        if (r.ok) return onForget();
        Alert.alert("The hub didn't sign this phone out", `${r.error.message} Forget the hub here anyway? Then sign the phone out under Settings › You in the desktop app.`, [
          { text: "Cancel", style: "cancel" },
          { text: "Forget anyway", style: "destructive", onPress: () => onForget() },
        ]);
      });
    const title = `Disconnect from ${paired.hubName}?`;
    const message = "This phone signs out of the hub and stops getting its notifications. Pairing again takes a new code.";
    const disconnect = () => {
      haptics.warning();
      if (Platform.OS === "ios") {
        ActionSheetIOS.showActionSheetWithOptions({ title, message, options: ["Disconnect", "Cancel"], destructiveButtonIndex: 0, cancelButtonIndex: 1 }, (i) => {
          if (i === 0) signOut();
        });
      } else {
        Alert.alert(title, message, [
          { text: "Cancel", style: "cancel" },
          { text: "Disconnect", style: "destructive", onPress: signOut },
        ]);
      }
    };
    return { session, state, paired, disconnect };
  }, [session, state, paired, onForget]);

  // A refused key is the one link state that asks something of the person: iOS's own alert, over whatever shows.
  const refused = state.hub.phase === "refused" ? state.hub.message : undefined;
  useEffect(() => {
    if (refused === undefined) return;
    haptics.warning();
    Alert.alert("Pair This Phone Again", refused, [
      { text: "Not Now", style: "cancel" },
      { text: "Pair Again", onPress: () => onForget("This phone's key was refused: pair it again.") },
    ]);
  }, [refused, onForget]);

  return (
    <SessionContext.Provider value={session}>
      <HubContext.Provider value={value}>
        <Root />
      </HubContext.Provider>
    </SessionContext.Provider>
  );
}

const RootStack = createNativeStackNavigator<RootParams>();

function Root() {
  const t = useTheme();
  return (
    // A screen under another (the chats list under a chat) doesn't draw again while it's covered: a streamed reply
    // changes the state with every word.
    <RootStack.Navigator screenOptions={{ headerTintColor: t.accent, contentStyle: { backgroundColor: t.bg }, freezeOnBlur: true }}>
      <RootStack.Screen name="Home" component={Tabs} options={{ headerShown: false, title: "Chats" }} />
      <RootStack.Screen name="Chat" component={Chat} options={({ route }) => ({ ...chatOptions(t), ...infoOptions(t, () => nav.navigate("Info", { key: route.params.key })) })} />
      {manageScreens(RootStack, t)}
    </RootStack.Navigator>
  );
}

const NativeTabBar = createNativeBottomTabNavigator<TabParams>();
const TabBar = createBottomTabNavigator<TabParams>();
const ChatsStack = createNativeStackNavigator<{ Chats: undefined }>();
const SettingsStack = createNativeStackNavigator<{ Settings: undefined }>();

function ChatsTab() {
  const t = useTheme();
  return (
    <ChatsStack.Navigator screenOptions={{ ...largeTitle(t), contentStyle: { backgroundColor: t.bg } }}>
      <ChatsStack.Screen name="Chats" component={Chats} options={{ headerSearchBarOptions: searchBar, ...newChatOptions(t, (name) => nav.navigate(name)) }} />
    </ChatsStack.Navigator>
  );
}

function SettingsTab() {
  const t = useTheme();
  return (
    <SettingsStack.Navigator screenOptions={{ ...largeTitle(t), contentStyle: { backgroundColor: t.grouped } }}>
      <SettingsStack.Screen name="Settings" component={Settings} />
    </SettingsStack.Navigator>
  );
}

const TABS = [
  { name: "ChatsTab", component: ChatsTab, title: "Chats", icon: "chats", iconOn: "chatsOn" },
  { name: "SettingsTab", component: SettingsTab, title: "Settings", icon: "settings", iconOn: "settingsOn" },
] as const satisfies ReadonlyArray<{ name: keyof TabParams; component: () => React.JSX.Element; title: string; icon: IconName; iconOn: IconName }>;

function Tabs() {
  const t = useTheme();
  const { state } = useHub();
  // The approvals waiting, whose chats are on top of Chats: seen from Settings too.
  const waiting = approvals(state.requests).length;
  const badge = (name: keyof TabParams) => (name === "ChatsTab" && waiting > 0 ? { tabBarBadge: String(waiting) } : {});
  if (Platform.OS === "ios") {
    return (
      <NativeTabBar.Navigator screenOptions={{ tabBarActiveTintColor: t.accent }}>
        {TABS.map((tab) => (
          <NativeTabBar.Screen
            key={tab.name}
            name={tab.name}
            component={tab.component}
            options={{
              title: tab.title,
              ...badge(tab.name),
              tabBarIcon: ({ focused }) => ({ type: "sfSymbol", name: sfSymbol(focused ? tab.iconOn : tab.icon) }),
            }}
          />
        ))}
      </NativeTabBar.Navigator>
    );
  }
  return (
    <TabBar.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.secondary,
        tabBarStyle: { backgroundColor: t.bg, borderTopColor: t.separator },
      }}
    >
      {TABS.map((tab) => (
        <TabBar.Screen
          key={tab.name}
          name={tab.name}
          component={tab.component}
          options={{
            title: tab.title,
            ...badge(tab.name),
            tabBarBadgeStyle: { backgroundColor: t.danger, color: "#FFFFFF" },
            tabBarIcon: ({ color, focused }) => <Icon name={focused ? tab.iconOn : tab.icon} size={24} color={color} />,
          }}
        />
      ))}
    </TabBar.Navigator>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
