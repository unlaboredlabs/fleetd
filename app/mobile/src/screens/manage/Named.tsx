// The team's named services on Connections (Paper, Notion), connected once for every bot (D592, D653), as the
// desktop's Connections sheet has them (namedServers.ts). Connect saves the server the manual form would, then opens the service's own sign-in page in the
// in-app browser; once the person is back (iOS: the sheet closed; Android, whose Custom Tab returns at once: the app
// active again) the row reads again and, signed in, tests it. Connected, a tap offers Test and
// Disconnect; one that needs a sign-in says so, and a tap signs in. Calls: namedApi.ts.
import * as WebBrowser from "expo-web-browser";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, AppState, Platform } from "react-native";
import Svg, { Path } from "react-native-svg";
import { namedState, type McpServer, type Named } from "../../desktop";
import { useHub } from "../../hubContext";
import { useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListRow } from "../../ui/List";
import { machineName } from "./model";
import { connect, disconnect, readServers, rowOf, signInPage, test, testLine, turnOn } from "./namedApi";
import { confirmDestructive, errorWords } from "./parts";

function Mark({ entry }: { entry: Named }) {
  return (
    <Svg width={15} height={15} viewBox={entry.mark.viewBox}>
      <Path d={entry.mark.path} fill="#FFFFFF" />
    </Svg>
  );
}

/** A named service on Connections: Connect, its sign-in, then its state with Test and Disconnect. */
export function NamedRow({ entry, servers, reload }: { entry: Named; servers: McpServer[]; reload: () => void }) {
  const t = useTheme();
  const { session, state: hub, paired } = useHub();
  const cloud = paired.cloud === true;
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<{ text: string } | null>(null);
  const state = namedState(entry, servers);
  const row = rowOf(state);
  const server = state.kind === "add" ? undefined : state.server;

  const failed = (what: string, e: { message: string; fix?: string | undefined }) => {
    haptics.warning();
    setLine({ text: `${what}: ${errorWords(e)}` });
  };

  const runTest = async (sv: McpServer) => {
    const out = await test(session, sv);
    if (!out.ok) return failed("Not tested", out.error);
    const said = testLine(out.value, machineName(hub.machines, out.value.machineId, cloud));
    if (said.signIn || out.value.result.error !== undefined) haptics.warning();
    else haptics.success();
    setLine({ text: said.text });
  };

  // A sign-in open in the browser, until the person is back from it.
  const away = useRef(false);

  // Back from the service's page: the row reads again, and a sign-in that took is tested.
  const back = async () => {
    away.current = false;
    reload();
    const now = await readServers(session);
    if (!now.ok) return failed("Couldn't read it again", now.error);
    const after = namedState(entry, now.value);
    if (after.kind === "connected") await runTest(after.server);
  };

  // The service's own page in the in-app browser. iOS returns once its sheet is closed; Android's Custom Tab returns
  // as it opens ("opened"), so there the app coming back to the front is the return.
  const signIn = async (sv: McpServer) => {
    const page = await signInPage(session, sv, entry.label);
    if (!page.ok) return failed("Couldn't sign in", page.error);
    away.current = true;
    const shown = await WebBrowser.openBrowserAsync(page.value);
    if (shown.type !== "opened") await back();
  };

  const returned = useEffectEvent(() => {
    if (!away.current) return;
    setBusy(true);
    void back().finally(() => setBusy(false));
  });
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") returned();
    });
    return () => sub.remove();
  }, []);

  const go = (work: () => Promise<void>) => {
    if (busy) return;
    haptics.tap();
    setBusy(true);
    setLine(null);
    void work().finally(() => {
      setBusy(false);
      reload();
    });
  };

  const press = () => {
    if (row.press === "connect") {
      go(async () => {
        const saved = await connect(session, entry, servers);
        if (!saved.ok) return failed("Not connected", saved.error);
        await signIn(saved.value);
      });
    } else if (server !== undefined && row.press === "signin") go(() => signIn(server));
    else if (server !== undefined) sheet(server);
  };

  const sheet = (sv: McpServer) => {
    const first = state.kind === "off" ? "Turn On" : "Test";
    const pick = (i: number) => {
      if (i === 0) go(() => (state.kind === "off" ? on(sv) : runTest(sv)));
      else if (i === 1) remove(sv);
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions({ title: entry.label, options: [first, "Disconnect", "Cancel"], destructiveButtonIndex: 1, cancelButtonIndex: 2 }, pick);
      return;
    }
    Alert.alert(entry.label, undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: () => pick(1) },
      { text: first, onPress: () => pick(0) },
    ]);
  };

  const on = async (sv: McpServer) => {
    const out = await turnOn(session, sv);
    if (!out.ok) return failed("Not turned on", out.error);
    haptics.success();
  };

  const remove = (sv: McpServer) =>
    confirmDestructive({
      title: `Disconnect ${entry.label}?`,
      message: "Every bot's lead and agents start without it from their next message.",
      button: "Disconnect",
      onConfirm: () =>
        go(async () => {
          const out = await disconnect(session, sv);
          if (!out.ok) return failed("Not disconnected", out.error);
          haptics.success();
        }),
    });

  const tone = row.tone === "accent" ? t.accent : row.tone === "danger" ? t.danger : t.secondary;
  // What the last press found, else why it is signed out.
  const detail = line?.text ?? (state.kind === "signin" ? state.problem?.replace(/`/gu, "") : undefined);
  return (
    <ListRow
      title={entry.label}
      mark={<Mark entry={entry} />}
      tint={entry.mark.tint}
      {...(detail === undefined ? {} : { detail })}
      value={row.value}
      valueColor={tone}
      chevron={false}
      onPress={press}
      {...(busy ? { accessory: <ActivityIndicator color={t.secondary} /> } : {})}
    />
  );
}
