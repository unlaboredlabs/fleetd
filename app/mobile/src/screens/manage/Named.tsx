// The team's named services on Connections (Paper, Notion), connected once for every bot (D592, D653), as the
// desktop's Connections sheet has them (namedServers.ts). Connect saves the server the manual form would, then opens the service's own sign-in page in the
// in-app browser; once the person is back (iOS: the sheet closed; Android, whose Custom Tab returns at once: the app
// active again) the row reads again and, signed in, tests it. Connected, a tap offers Test, Add Another Account (one more
// server at the service's URL under a name of its own, signed in with the other account) and Disconnect; one that needs
// a sign-in says so, and a tap signs in. Each account is a row of its own. Calls: namedApi.ts.
import * as WebBrowser from "expo-web-browser";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, AppState, Platform } from "react-native";
import Svg, { Path } from "react-native-svg";
import { accountLabel, accountState, nameFor, serverNameProblem, type McpServer, type Named } from "../../desktop";
import { useHub } from "../../hubContext";
import { useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListRow } from "../../ui/List";
import { machineName } from "./model";
import { connect, disconnect, httpsLine, needsHttps, readServers, rowOf, signInPage, test, testLine, turnOn } from "./namedApi";
import { confirmDestructive, errorWords, offerHttps } from "./parts";

function Mark({ entry }: { entry: Named }) {
  return (
    <Svg width={15} height={15} viewBox={entry.mark.viewBox}>
      <Path d={entry.mark.path} fill="#FFFFFF" />
    </Svg>
  );
}

/** A named service on Connections, or one of its accounts: Connect, its sign-in, then its state with Test, Add
 * Another Account and Disconnect. With several, or one named otherwise (notion-work), each says its own name under the
 * service's. */
export function NamedRow({ entry, server, servers, reload }: { entry: Named; server?: McpServer; servers: McpServer[]; reload: () => void }) {
  const t = useTheme();
  const { session, state: hub, paired } = useHub();
  const cloud = paired.cloud === true;
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<{ text: string } | null>(null);
  const state = server === undefined ? ({ kind: "add" } as const) : accountState(server);
  const row = rowOf(state);
  const label = server === undefined ? entry.label : accountLabel(entry, server, servers);

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

  // The account whose sign-in is open in the browser, until the person is back from it.
  const away = useRef<string | null>(null);

  // Back from the service's page: the row reads again, and a sign-in that took is tested. Another account, added from
  // this row, is a row of its own: its Test isn't said under this one.
  const back = async () => {
    const name = away.current;
    away.current = null;
    reload();
    const now = await readServers(session);
    if (!now.ok) return failed("Couldn't read it again", now.error);
    const after = now.value.find((s) => s.name === name);
    if (after === undefined || accountState(after).kind !== "connected") return;
    if (server === undefined || after.name === server.name) await runTest(after);
    else haptics.success();
  };

  // The service's own page in the in-app browser. iOS returns once its sheet is closed; Android's Custom Tab returns
  // as it opens ("opened"), so there the app coming back to the front is the return.
  const signIn = async (sv: McpServer) => {
    const page = await signInPage(session, sv, entry.label);
    if (!page.ok && needsHttps(page.error)) {
      // One line, and the one fix: an admin's tap gives the workspace an https address and signs in again.
      haptics.warning();
      setLine({ text: httpsLine(entry.label) });
      return offerHttps(session, entry.label, hub.admin === true, () => go(() => signIn(sv)), (text) => setLine({ text }));
    }
    if (!page.ok) return failed("Couldn't sign in", page.error);
    away.current = sv.name;
    const shown = await WebBrowser.openBrowserAsync(page.value);
    if (shown.type !== "opened") await back();
  };

  const returned = useEffectEvent(() => {
    if (away.current === null) return;
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
      else if (i === 1) another();
      else if (i === 2) remove(sv);
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions({ title: label, options: [first, "Add Another Account", "Disconnect", "Cancel"], destructiveButtonIndex: 2, cancelButtonIndex: 3 }, pick);
      return;
    }
    // Android's alert shows three buttons at most: no Cancel button, a tap outside cancels.
    Alert.alert(
      label,
      undefined,
      [
        { text: "Disconnect", style: "destructive", onPress: () => pick(2) },
        { text: "Add Another Account", onPress: () => pick(1) },
        { text: first, onPress: () => pick(0) },
      ],
      { cancelable: true },
    );
  };

  // One more account: saved under the name the person gives it (the first free one offered), then signed in.
  const another = () => {
    const taken = servers.map((s) => s.name);
    const add = (typed: string) => {
      const name = typed.trim();
      const wrong = serverNameProblem(name, taken);
      if (wrong !== null) return Alert.alert("Not added", wrong);
      go(async () => {
        const saved = await connect(session, entry, servers, name);
        if (!saved.ok) return failed("Not added", saved.error);
        await signIn(saved.value);
      });
    };
    if (Platform.OS !== "ios") return add(nameFor(entry, taken));
    Alert.prompt(
      `Another ${entry.label} Account`,
      `It signs in on its own: on ${entry.label}'s page, pick the other account. Agents tell the two apart by this name.`,
      [{ text: "Cancel", style: "cancel" }, { text: "Connect", onPress: (name?: string) => name !== undefined && add(name) }],
      "plain-text",
      nameFor(entry, taken),
    );
  };

  const on = async (sv: McpServer) => {
    const out = await turnOn(session, sv);
    if (!out.ok) return failed("Not turned on", out.error);
    haptics.success();
  };

  const remove = (sv: McpServer) =>
    confirmDestructive({
      title: `Disconnect ${label}?`,
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
  // Else an account's own name, when it has one.
  const detail = line?.text ?? (state.kind === "signin" ? state.problem?.replace(/`/gu, "") : undefined) ?? (label === entry.label ? undefined : label);
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
