// The app: pair with a hub once, then its chats and approvals. The paired hub lives in secure storage (vault.ts);
// one Session talks to it while the app runs, and dials again whenever the app comes back to the front. Pairing makes
// the phone's notification key; Disconnect signs the phone out on the hub, after a confirm, and forgets both. A pairing
// link (`fleetd://pair?…`, from a QR code scanned with iOS's Camera) opens the app and pairs it in one step.
//
// Navigation is iOS's own (react-native-screens): UIKit's tab bar for Chats, Approvals and Settings (a drawn one on
// Android), each a stack with a large title that collapses on scroll, and a chat pushed over them, which a swipe from
// the edge takes back.
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeBottomTabNavigator } from "@react-navigation/bottom-tabs/unstable";
import { createNavigationContainerRef, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator, type NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActionSheetIOS, Alert, AppState, Linking, Platform, StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { webSocketTransport } from "./src/hub/socket";
import type { Paired } from "./src/hub/pair";
import { parsePairLink } from "./src/hub/pairLink";
import { HubContext, useHub, type ApprovalsParams, type HubContextValue, type PairParams, type RootParams, type TabParams } from "./src/hubContext";
import { approvals } from "./src/lists";
import { pushDeps, useTappedRoute } from "./src/notifications";
import type { Route } from "./src/push";
import { Approvals } from "./src/screens/Approvals";
import { Chat, chatOptions } from "./src/screens/Chat";
import { Chats, searchBar } from "./src/screens/Chats";
import { Pair, Scan, Welcome } from "./src/screens/Connect";
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
  // A pairing link: pairs a phone that isn't, once the pairing screens are up; a paired one says how to switch hubs.
  const [link, handled] = useOpenedLink();
  // Bumped each time the pairing screens come up: a link that came first goes on then.
  const [pairShown, setPairShown] = useState(0);
  useEffect(() => {
    if (link === null || paired === undefined) return;
    const parsed = parsePairLink(link);
    if (parsed === null) return handled();
    if (paired !== null) {
      Alert.alert(`Connected to ${paired.hubName}`, "To pair with another hub, disconnect under Settings first, then scan its code again.");
      return handled();
    }
    if (!parsed.ok) {
      haptics.warning();
      Alert.alert(parsed.failure.message, parsed.failure.fix?.replace(/`/gu, ""));
      return handled();
    }
    if (!pairNav.isReady()) return;
    pairNav.navigate("Pair", { hub: parsed.hub, code: parsed.code, auto: true });
    handled();
  }, [link, paired, pairShown, handled]);
  // Behind every screen, as during a push or a keyboard's slide: the scheme's ground, not the build's one color.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(t.bg).catch(() => undefined);
  }, [t.bg]);
  return (
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

/** Where a tapped notification goes: its chat, or Approvals with its request on top. */
const go = (route: Route): void => {
  if (route.t === "chat") nav.navigate("Chat", { key: route.key });
  else nav.navigate("Home", { screen: "ApprovalsTab", params: { screen: "Approvals", params: route.requestId === undefined ? {} : { focus: route.requestId } } });
};

function Hub({ paired, onForget }: { paired: Paired; onForget: (why?: string) => void }) {
  const session = useMemo(() => new Session({ hub: paired.hub, key: paired.key, transport: webSocketTransport, push: pushDeps }), [paired]);
  const state = useSyncExternalStore(session.subscribe, session.getState);
  // A tapped notification before the navigator is ready waits for it.
  const pending = useRef<Route | null>(null);
  useTappedRoute((route) => {
    if (nav.isReady()) go(route);
    else pending.current = route;
  });
  useEffect(() => {
    const tryPending = () => {
      if (pending.current === null || !nav.isReady()) return;
      go(pending.current);
      pending.current = null;
    };
    tryPending();
    return nav.addListener("state", tryPending);
  }, []);

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
    return { session, state, paired, disconnect, pairAgain: () => onForget("This phone's key was refused: pair it again.") };
  }, [session, state, paired, onForget]);

  return (
    <HubContext.Provider value={value}>
      <Root />
    </HubContext.Provider>
  );
}

const RootStack = createNativeStackNavigator<RootParams>();

function Root() {
  const t = useTheme();
  return (
    <RootStack.Navigator screenOptions={{ headerTintColor: t.accent, contentStyle: { backgroundColor: t.bg } }}>
      <RootStack.Screen name="Home" component={Tabs} options={{ headerShown: false, title: "Chats" }} />
      <RootStack.Screen name="Chat" component={Chat} options={chatOptions(t)} />
    </RootStack.Navigator>
  );
}

const NativeTabBar = createNativeBottomTabNavigator<TabParams>();
const TabBar = createBottomTabNavigator<TabParams>();
const ChatsStack = createNativeStackNavigator<{ Chats: undefined }>();
const ApprovalsStack = createNativeStackNavigator<ApprovalsParams>();
const SettingsStack = createNativeStackNavigator<{ Settings: undefined }>();

function ChatsTab() {
  const t = useTheme();
  return (
    <ChatsStack.Navigator screenOptions={{ ...largeTitle(t), contentStyle: { backgroundColor: t.bg } }}>
      <ChatsStack.Screen name="Chats" component={Chats} options={{ headerSearchBarOptions: searchBar }} />
    </ChatsStack.Navigator>
  );
}

function ApprovalsTab() {
  const t = useTheme();
  return (
    <ApprovalsStack.Navigator screenOptions={{ ...largeTitle(t), contentStyle: { backgroundColor: t.grouped } }}>
      <ApprovalsStack.Screen name="Approvals" component={Approvals} />
    </ApprovalsStack.Navigator>
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
  { name: "ApprovalsTab", component: ApprovalsTab, title: "Approvals", icon: "approvals", iconOn: "approvalsOn" },
  { name: "SettingsTab", component: SettingsTab, title: "Settings", icon: "settings", iconOn: "settingsOn" },
] as const satisfies ReadonlyArray<{ name: keyof TabParams; component: () => React.JSX.Element; title: string; icon: IconName; iconOn: IconName }>;

function Tabs() {
  const t = useTheme();
  const { state } = useHub();
  const waiting = approvals(state.requests).length;
  const badge = (name: keyof TabParams) => (name === "ApprovalsTab" && waiting > 0 ? { tabBarBadge: String(waiting) } : {});
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
