// The app: pair with a hub once, then its chats and approvals. The paired hub lives in secure storage (vault.ts);
// one Session talks to it while the app runs, and dials again whenever the app comes back to the front. Pairing makes
// the phone's notification key; Disconnect signs the phone out on the hub, after a confirm, and forgets both.
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert, AppState, BackHandler, StyleSheet, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { webSocketTransport } from "./src/hub/socket";
import type { Paired } from "./src/hub/pair";
import { Chat } from "./src/screens/Chat";
import { Connect } from "./src/screens/Connect";
import { Approvals, Chats, Tabs, type Tab } from "./src/screens/Home";
import { pushDeps, useTappedRoute } from "./src/notifications";
import type { Route } from "./src/push";
import { Session } from "./src/session";
import type { Key } from "./src/store";
import { approvals } from "./src/lists";
import { color } from "./src/theme";
import { ConnectionLine, Header, TextButton } from "./src/ui";
import { forgetPaired, forgetPush, loadPaired, pushKeys, savePaired } from "./src/vault";

export default function App() {
  // Undefined while secure storage is read.
  const [paired, setPaired] = useState<Paired | null | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  useEffect(() => {
    void loadPaired().then(setPaired);
  }, []);
  const forget = (why?: string) => {
    setNote(why);
    void Promise.all([forgetPaired(), forgetPush()]).then(() => setPaired(null));
  };
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={styles.fill} edges={["top", "bottom"]}>
        {paired === undefined ? null : paired === null ? (
          <Connect
            note={note}
            onPaired={(p) => {
              setNote(undefined);
              void Promise.all([savePaired(p), forgetPush().then(pushKeys)]).then(() => setPaired(p));
            }}
          />
        ) : (
          <Hub key={`${paired.hub} ${paired.key}`} paired={paired} onForget={forget} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

/** `focus`: the approval a tapped notification named, shown first. */
type Place = { readonly at: "home"; readonly tab: Tab; readonly focus?: string } | { readonly at: "chat"; readonly key: Key; readonly tab: Tab };

const placeOf = (route: Route): Place =>
  route.t === "chat" ? { at: "chat", key: route.key, tab: "chats" } : { at: "home", tab: "approvals", focus: route.requestId };

function Hub({ paired, onForget }: { paired: Paired; onForget: (why?: string) => void }) {
  const session = useMemo(() => new Session({ hub: paired.hub, key: paired.key, transport: webSocketTransport, push: pushDeps }), [paired]);
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const [place, setPlace] = useState<Place>({ at: "home", tab: "chats" });
  useTappedRoute((route) => setPlace(placeOf(route)));

  const disconnect = () =>
    Alert.alert(`Disconnect from ${paired.hubName}?`, "This phone signs out of the hub and stops getting its notifications. Pairing again takes a new code.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: () =>
          void session.signOut().then((r) => {
            if (r.ok) return onForget();
            Alert.alert("The hub didn't sign this phone out", `${r.error.message} Forget the hub here anyway? Then sign the phone out under Settings › You in the desktop app.`, [
              { text: "Cancel", style: "cancel" },
              { text: "Forget anyway", style: "destructive", onPress: () => onForget() },
            ]);
          }),
      },
    ]);

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

  const chatKey = place.at === "chat" ? place.key : null;
  useEffect(() => {
    session.openChat(chatKey);
  }, [session, chatKey]);

  useEffect(() => {
    if (place.at !== "chat") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setPlace({ at: "home", tab: place.tab });
      return true;
    });
    return () => sub.remove();
  }, [place]);

  const line = <ConnectionLine state={state.hub} onPairAgain={() => onForget("This phone's key was refused: pair it again.")} />;

  if (place.at === "chat") {
    const project = state.projects?.[place.key];
    const chat = state.chatStates[place.key];
    return (
      <View style={styles.fill}>
        <Header
          title={project?.title ?? "Chat"}
          detail={chat?.leadWorking === true ? "Working…" : chat?.needsYou === true ? "Waiting for you" : undefined}
          left={<TextButton label="‹ Back" onPress={() => setPlace({ at: "home", tab: place.tab })} />}
        />
        {line}
        <Chat state={state} session={session} chatKey={place.key} />
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <Header title={paired.hubName} detail={paired.hub} right={<TextButton label="Disconnect" onPress={disconnect} />} />
      {line}
      <Tabs tab={place.tab} onTab={(tab) => setPlace({ at: "home", tab })} waiting={approvals(state.requests).length} />
      {place.tab === "chats" ? (
        <Chats state={state} onOpen={(key) => setPlace({ at: "chat", key, tab: "chats" })} />
      ) : (
        <Approvals state={state} session={session} focus={place.focus} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.bg },
});
