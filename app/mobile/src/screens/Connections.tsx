// Settings › Connections (D653), the desktop's Connections sheet on the phone: what is connected on top (each one's
// mark, overlapping, and how many), then Paper, Notion (Named.tsx: Connect, the service's own sign-in) and Tailscale
// (an admin's Connect, its sign-in or approval, Disconnect), then Custom MCP: the team's other servers, each with
// where it stands, a tap offering Test, Sign In when it wants one, and Disconnect. Add Custom MCP takes a URL (iOS's
// prompt), saves it for every bot, and signs in when the server offers OAuth, else tests it. A command or headers
// from the vault are the desktop's to add. Replaces the Vault's Integrations and Machines' Network.
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, Linking, Platform, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import type { TailnetState } from "../../../desktop/src/shared/contracts";
import {
  connectedOf,
  connectionTestLine,
  countText,
  customOf,
  customState,
  freeName,
  initialOf,
  needsSignIn,
  suggestedName,
  tailnetCanConnect,
  tailnetLineOf,
  TAILSCALE_MACHINES_URL,
  tailnetWaits,
  tailnetWordOf,
  whereOf,
  NAMED,
  type McpServer,
  type StripItem,
} from "../desktop";
import { useHub } from "../hubContext";
import { CONNECT_WAIT_MS } from "../machines";
import { space, type, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { pick } from "./Machines";
import { NamedRow } from "./manage/Named";
import { disconnect, readServers, setOn, signInPage, test } from "./manage/namedApi";
import { machineName } from "./manage/model";
import { confirmDestructive, errorWords, Problem, useRead } from "./manage/parts";

const DOTS: ReadonlyArray<readonly [number, number, boolean]> = [
  [3, 3, false],
  [10, 3, false],
  [17, 3, false],
  [3, 10, true],
  [10, 10, true],
  [17, 10, true],
  [3, 17, false],
  [10, 17, true],
  [17, 17, false],
];

/** Tailscale's nine dots, white on its tile. */
export function TailscaleMark({ size = 15 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      {DOTS.map(([x, y, full]) => (
        <Circle key={`${String(x)}-${String(y)}`} cx={x} cy={y} r={2.4} fill="#FFFFFF" opacity={full ? 1 : 0.35} />
      ))}
    </Svg>
  );
}

export function Connections() {
  const t = useTheme();
  const { session, state } = useHub();
  const servers = useRead(() => readServers(session), [session]);
  const tailnet = useRead(() => session.call("tailnet_get", {}), [session]);
  const team = servers.value?.ok === true ? servers.value.value : [];
  const ts = tailnet.value?.ok === true ? (tailnet.value.output as TailnetState) : undefined;
  const reload = () => {
    servers.reload();
    tailnet.reload();
  };
  // The person signs in on Tailscale's page: its state is read again until it isn't waiting on them.
  const waitingOn = tailnetWaits(ts);
  const rereadTailnet = tailnet.reload;
  useEffect(() => {
    if (!waitingOn) return;
    const timer = setInterval(rereadTailnet, 2_000);
    return () => clearInterval(timer);
  }, [waitingOn, rereadTailnet]);
  // What the last Test of each custom MCP found, by name: an Add's lands under its new row.
  const [said, setSaid] = useState<Readonly<Record<string, Line>>>({});
  const tell = (name: string, line: Line | null) => setSaid((all) => {
    const { [name]: _gone, ...rest } = all;
    return line === null ? rest : { ...rest, [name]: line };
  });
  const strip = connectedOf(team, [], ts);
  const custom = customOf(team, []);
  const admin = state.admin === true;
  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={reload} tintColor={t.secondary} />}
    >
      <Strip items={strip} />
      {servers.value !== undefined && !servers.value.ok ? <Problem text={`Couldn't read the connections: ${errorWords(servers.value.error)}`} /> : null}
      <ListSection>
        {servers.value?.ok === true ? NAMED.map((entry) => <NamedRow key={entry.id} entry={entry} servers={team} reload={servers.reload} />) : null}
        {ts === undefined ? null : <TailscaleRow state={ts} admin={admin} reload={tailnet.reload} />}
      </ListSection>
      {servers.value?.ok === true ? (
        <ListSection header="Custom MCP">
          {custom.map((s) => (
            <CustomRow key={s.name} server={s} line={said[s.name] ?? null} tell={(l) => tell(s.name, l)} reload={servers.reload} />
          ))}
          <AddRow taken={team.map((s) => s.name)} tell={tell} reload={servers.reload} />
        </ListSection>
      ) : null}
    </ScrollView>
  );
}

/** What is connected, under the large title: each one's mark, overlapping, and how many. Nothing while nothing is. */
function Strip({ items }: { items: ReadonlyArray<StripItem> }) {
  const t = useTheme();
  const text = countText(items.length);
  if (text === null) return null;
  return (
    <View style={styles.strip} accessible accessibilityLabel={`${text}: ${items.map((i) => i.label).join(", ")}`}>
      <View style={styles.stack}>
        {items.slice(0, 5).map((i, ix) => (
          <View
            key={i.key}
            style={[styles.chip, { backgroundColor: i.named?.mark.tint ?? (i.tailscale === true ? "#242424" : t.cell), borderColor: t.grouped, marginLeft: ix === 0 ? 0 : -7 }]}
          >
            {i.named !== undefined ? (
              <Svg width={12} height={12} viewBox={i.named.mark.viewBox}>
                <Path d={i.named.mark.path} fill="#FFFFFF" />
              </Svg>
            ) : i.tailscale === true ? (
              <TailscaleMark size={12} />
            ) : (
              <Text style={[styles.initial, { color: t.secondary }]}>{initialOf(i.label)}</Text>
            )}
          </View>
        ))}
      </View>
      <Text style={[type.subhead, { color: t.secondary }]}>{text}</Text>
    </View>
  );
}

/** Tailscale: Connect (an admin's), its sign-in or approval while it waits, then the tailnet with Disconnect. */
function TailscaleRow({ state, admin, reload }: { state: TailnetState; admin: boolean; reload: () => void }) {
  const t = useTheme();
  const { session } = useHub();
  const word = tailnetWordOf(state);
  const line = tailnetLineOf(state, admin);
  const off = () =>
    confirmDestructive({
      title: state.status === "connected" ? "Disconnect Tailscale?" : "Stop connecting Tailscale?",
      message: "Agents lose the tailnet at once, and so do the custom MCPs on it.",
      button: "Disconnect",
      onConfirm: () =>
        void session.call("tailnet_disconnect", {}).then((out) => {
          if (out.ok) haptics.success();
          else Alert.alert("Not disconnected", errorWords(out.error));
          reload();
        }),
    });
  const press = () => {
    haptics.tap();
    if (state.status === "connected") return pick("Tailscale", ["Disconnect"], off);
    if (state.status === "login" && state.loginUrl !== undefined) {
      const url = state.loginUrl;
      return pick("Tailscale", ["Open Sign-In", "Cancel Connecting"], (i) => (i === 0 ? void Linking.openURL(url) : off()));
    }
    if (state.status === "approve") return pick("Tailscale", ["Open Tailscale", "Cancel Connecting"], (i) => (i === 0 ? void Linking.openURL(TAILSCALE_MACHINES_URL) : off()));
    // As long as the hub can take: a first Connect downloads Tailscale, starts it and waits for its sign-in page.
    void session.call("tailnet_connect", {}, CONNECT_WAIT_MS).then((out) => {
      reload();
      if (!out.ok) return Alert.alert("Not connected", errorWords(out.error));
      const url = (out.output as TailnetState).loginUrl;
      if (url !== undefined) void Linking.openURL(url);
    });
    setTimeout(reload, 1_000);
  };
  const acts = admin && (state.status === "connected" || state.status === "login" || state.status === "approve" || tailnetCanConnect(state));
  const value = word?.text ?? (acts ? "Connect" : undefined);
  const color = word === null ? (acts ? t.accent : t.secondary) : word.tone === "danger" ? t.danger : word.tone === "warning" ? t.warning : t.secondary;
  return (
    <ListRow
      title="Tailscale"
      mark={<TailscaleMark />}
      tint="#242424"
      {...(line === null ? {} : { detail: line.text })}
      {...(value === undefined ? {} : { value })}
      valueColor={color}
      {...(state.status === "connected" ? { valueDot: t.success } : {})}
      chevron={false}
      {...(acts ? { onPress: press } : {})}
    />
  );
}

/** A custom MCP: where it stands, a tap offering Test, Sign In when it wants one, and Disconnect. */
type Line = { readonly text: string; readonly tone: "success" | "warning" | "danger" };

function CustomRow({ server, line, tell, reload }: { server: McpServer; line: Line | null; tell: (line: Line | null) => void; reload: () => void }) {
  const t = useTheme();
  const { session, state: hub } = useHub();
  const [busy, setBusy] = useState(false);
  const setLine = tell;
  const said = customState(server);
  const signIn = needsSignIn(server);
  const runTest = async () => {
    const out = await test(session, server);
    if (!out.ok) {
      haptics.warning();
      return setLine({ text: `Test failed: ${errorWords(out.error)}`, tone: "danger" });
    }
    const l = connectionTestLine(out.value, machineName(hub.machines, out.value.machineId));
    if (l.tone === "success") haptics.success();
    else haptics.warning();
    setLine(l);
  };
  const go = (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setLine(null);
    void work().finally(() => {
      setBusy(false);
      reload();
    });
  };
  const signInNow = () =>
    go(async () => {
      const page = await signInPage(session, server, server.name);
      if (!page.ok) return setLine({ text: errorWords(page.error), tone: "danger" });
      await WebBrowser.openBrowserAsync(page.value);
    });
  const remove = () =>
    confirmDestructive({
      title: `Disconnect ${server.name}?`,
      message: "Every bot's agents lose it now. Its sign-in or keys leave every machine.",
      button: "Disconnect",
      onConfirm: () =>
        go(async () => {
          const out = await disconnect(session, server);
          if (!out.ok) return setLine({ text: `Not disconnected: ${errorWords(out.error)}`, tone: "danger" });
          haptics.success();
        }),
    });
  const press = () => {
    haptics.tap();
    const toggle = server.enabled ? "Turn Off" : "Turn On";
    const labels = [...(signIn ? ["Sign In"] : []), "Test", toggle, "Disconnect"];
    const act = (label: string | undefined) => {
      if (label === "Sign In") signInNow();
      else if (label === "Test") go(runTest);
      else if (label === toggle)
        go(async () => {
          const out = await setOn(session, server, !server.enabled);
          if (!out.ok) return setLine({ text: `Not changed: ${errorWords(out.error)}`, tone: "danger" });
          haptics.success();
        });
      else if (label === "Disconnect") remove();
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: server.name, options: [...labels, "Cancel"], destructiveButtonIndex: labels.length - 1, cancelButtonIndex: labels.length },
        (i) => act(labels[i]),
      );
      return;
    }
    pick(server.name, labels, (i) => act(labels[i]));
  };
  const detail = line?.text ?? (signIn ? server.oauth?.problem?.replace(/`/gu, "") : undefined) ?? whereOf(server);
  const tone = said === null ? t.secondary : said.tone === "danger" ? t.danger : said.tone === "warning" ? t.warning : t.secondary;
  return (
    <ListRow
      title={server.name}
      mark={<Text style={[styles.initial, { color: t.secondary }]}>{initialOf(server.name)}</Text>}
      detail={detail}
      {...(line === null ? {} : { detailColor: line.tone === "success" ? t.success : line.tone === "warning" ? t.warning : t.danger })}
      {...(said === null ? {} : { value: said.text, valueColor: tone })}
      chevron={false}
      onPress={press}
      {...(busy ? { accessory: <ActivityIndicator color={t.secondary} /> } : {})}
    />
  );
}

/** Add Custom MCP: a URL, saved for every bot by the name it suggests; signed in when it offers OAuth, else tested. */
function AddRow({ taken, tell, reload }: { taken: string[]; tell: (name: string, line: Line | null) => void; reload: () => void }) {
  const t = useTheme();
  const { session, state: hub } = useHub();
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const add = (url: string) => {
    const name = suggestedName({ kind: "url", url, command: "" });
    if (name === "") return setLine("Give its http or https URL.");
    const free = freeName(name, taken);
    setBusy(true);
    setLine(null);
    void (async () => {
      const saved = await session.call("mcp_server_set", {
        scope: { kind: "global" },
        name: free,
        enabled: true,
        roles: { lead: true, writers: true, reviewers: true },
        transport: { type: "http", url: url.trim() },
        env: [],
        headers: [],
      });
      if (!saved.ok) return setLine(`Not added: ${errorWords(saved.error)}`);
      const server = saved.output.server;
      if (needsSignIn(server)) {
        const page = await signInPage(session, server, free);
        if (!page.ok) return setLine(errorWords(page.error));
        await WebBrowser.openBrowserAsync(page.value);
        return;
      }
      const tested = await test(session, server);
      const l: Line = tested.ok ? connectionTestLine(tested.value, machineName(hub.machines, tested.value.machineId)) : { text: `Test failed: ${errorWords(tested.error)}`, tone: "danger" };
      tell(free, l);
      if (l.tone === "success") haptics.success();
      else haptics.warning();
    })().finally(() => {
      setBusy(false);
      reload();
    });
  };
  if (Platform.OS !== "ios") return <ListRow title="Add Custom MCP" detail="Add one from the desktop app." chevron={false} />;
  return (
    <ListRow
      title="Add Custom MCP"
      icon="plus"
      {...(line === null ? {} : { detail: line })}
      valueColor={t.accent}
      chevron={false}
      onPress={() => {
        haptics.tap();
        Alert.prompt("Custom MCP", "Paste its URL. Commands and headers are added in the desktop app.", [{ text: "Cancel", style: "cancel" }, { text: "Add", onPress: (url?: string) => url !== undefined && add(url) }], "plain-text", "", "url");
      }}
      {...(busy ? { accessory: <ActivityIndicator color={t.secondary} /> } : {})}
    />
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: "row", alignItems: "center", gap: space.sm, marginHorizontal: space.lg + space.xs, marginTop: space.xs, marginBottom: space.xs },
  stack: { flexDirection: "row", alignItems: "center" },
  chip: { width: 24, height: 24, borderRadius: 7, borderCurve: "continuous", borderWidth: 2, alignItems: "center", justifyContent: "center" },
  initial: { fontSize: 13, fontWeight: "600" },
});
