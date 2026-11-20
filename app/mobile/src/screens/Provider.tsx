// Settings › Machines › a provider, for admins (machines.ts): one provider the team connects with its own key
// (boat.dev). Not connected, its API key in a secure field, sealed here to the hub's box key before it leaves the phone; connected, its limit where it has one, Test and Disconnect.
import { useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, RefreshControl, ScrollView, StyleSheet, TextInput, View } from "react-native";
import type { SandboxState } from "../../../desktop/src/shared/contracts";
import { useHub, type SettingsProps } from "../hubContext";
import { canWords, type HostedAction, limitChoices, limitWords, providerFooter, providerName, providersOf, runnerOf, specOf, type ProviderState } from "../machines";
import { shape, space, type, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { confirmDestructive, errorWords, Problem, useRead } from "./manage/parts";
import { sealToHub } from "./vault/api";

/** Connect and Test wait for the provider's answer from one of the team's machines (the hub waits up to 45 s for it). */
const CHECK_TIMEOUT_MS = 60_000;

export function Provider({ route, navigation }: SettingsProps<"Provider">) {
  const t = useTheme();
  const { session } = useHub();
  const read = useRead(() => session.call("sandbox_get", {}), [session]);
  const r = read.value;
  if (r === undefined) return <ActivityIndicator style={styles.loading} color={t.secondary} />;
  const state: ProviderState | undefined = !r.ok ? undefined : providersOf(r.output as SandboxState).find((p) => p.id === route.params.id);
  const boxPubKey = r.ok ? (r.output as { boxPubKey: string }).boxPubKey : "";
  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={read.reload} tintColor={t.secondary} />}
    >
      {!r.ok ? (
        <Problem text={`Couldn't read it: ${errorWords(r.error)}`} />
      ) : state === undefined ? (
        <Problem text="This hub doesn't have it." />
      ) : (
        <Keyed p={state} boxPubKey={boxPubKey} reload={read.reload} connectClaude={() => navigation.navigate("Claude")} />
      )}
    </ScrollView>
  );
}

function Keyed({ p, boxPubKey, reload, connectClaude }: { p: ProviderState; boxPubKey: string; reload: () => void; connectClaude: () => void }) {
  const t = useTheme();
  const { session, state } = useHub();
  const name = providerName(p.id);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"connect" | "test" | "limit" | "disconnect" | null>(null);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [works, setWorks] = useState(false);

  const run = async (what: NonNullable<typeof busy>, call: () => Promise<{ ok: boolean; error?: { message: string; fix?: string | undefined } }>, failed: string) => {
    setBusy(what);
    setProblem(undefined);
    setWorks(false);
    const out = await call();
    setBusy(null);
    if (!out.ok) {
      haptics.warning();
      setProblem(`${failed}: ${out.error === undefined ? "" : errorWords(out.error)}`);
    } else {
      haptics.success();
      if (what === "test" || what === "connect") setWorks(true);
    }
    reload();
  };

  const connect = () => {
    const typed = key.trim();
    if (typed === "") return;
    const sealed = sealToHub({ key: typed }, boxPubKey);
    if (sealed === null) return setProblem("The hub's key didn't come through. Try again.");
    const call = () => session.call("sandbox_connect", { provider: p.id, sealed }, CHECK_TIMEOUT_MS);
    void run("connect", call, "Not connected").then(() => setKey(""));
  };
  const pickLimit = () => {
    const choices = limitChoices(p.limit ?? 0);
    const set = (n: number) => void run("limit", () => session.call("sandbox_set", { provider: p.id, limit: n }), "Not changed");
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions({ title: `Agents at once in ${name}`, options: [...choices.map(limitWords), "Cancel"], cancelButtonIndex: choices.length }, (i) => {
        const n = choices[i];
        if (n !== undefined) set(n);
      });
    } else {
      Alert.alert(`Agents at once in ${name}`, undefined, [...choices.slice(0, 8).map((n) => ({ text: limitWords(n), onPress: () => set(n) })), { text: "Cancel", style: "cancel" as const }]);
    }
  };
  const disconnect = () =>
    confirmDestructive({
      title: `Disconnect ${name}?`,
      message: `The team's ${name} key and its limit go from the hub.`,
      button: "Disconnect",
      onConfirm: () => void run("disconnect", () => session.call("sandbox_disconnect", { provider: p.id }), "Not disconnected"),
    });

  // Its real state (shared/hostedRow.ts, as the desktop's row): while someone has to act, why with its fix, and the
  // one row that fixes it.
  const footer = providerFooter(p, runnerOf(state.machines));
  const test = () => void run("test", () => session.call("sandbox_test", { provider: p.id }, CHECK_TIMEOUT_MS), "Not tested");
  const fix = footer?.action;
  const footerText = problem ?? footer?.text;
  return (
    <>
      <ListSection header={canWords(specOf(p.id))} {...(footerText === undefined || problem !== undefined || footer?.problem === true ? {} : { footer: footerText })}>
        {p.connected ? (
          <>
            {fix === undefined || problem !== undefined ? null : (
              <ListRow title={busy === "test" ? "Testing…" : FIX_TITLES[fix]} {...(busy === null ? { onPress: fix === "connect" ? connectClaude : test } : {})} chevron={fix === "connect"} />
            )}
            {p.limit === undefined ? null : <ListRow title="At Once" value={limitWords(p.limit)} {...(busy === null ? { onPress: pickLimit } : {})} chevron={false} />}
            <ListRow title={busy === "test" ? "Testing…" : "Test"} value={works ? "Works" : undefined} valueColor={t.success} {...(busy === null ? { onPress: test } : {})} chevron={false} />
            <ListRow title={busy === "disconnect" ? "Disconnecting…" : "Disconnect"} destructive {...(busy === null ? { onPress: disconnect } : {})} chevron={false} />
          </>
        ) : (
          <>
            <View style={styles.field}>
              <TextInput
                value={key}
                onChangeText={setKey}
                placeholder="API Key"
                placeholderTextColor={t.tertiary}
                secureTextEntry
                textContentType="none"
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                editable={busy === null}
                accessibilityLabel={`${name} API key`}
                selectionColor={t.accent}
                style={[type.body, styles.input, { color: t.label }]}
              />
            </View>
            <ListRow title={busy === "connect" ? "Connecting…" : "Connect"} {...(busy === null && key.trim() !== "" ? { onPress: connect } : {})} chevron={false} />
          </>
        )}
      </ListSection>
      {problem !== undefined || footer?.problem === true ? <Problem text={footerText} /> : null}
    </>
  );
}

/** The fix's row, in the phone's title case: the desktop's button words (shared/hostedRow.ts ACTION_LABELS). */
const FIX_TITLES: Readonly<Record<HostedAction, string>> = { connect: "Connect a Claude Account", retry: "Try Again", test: "Test Again" };

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
  field: { flexDirection: "row", alignItems: "center", minHeight: shape.row, paddingHorizontal: space.lg },
  input: { flex: 1, paddingVertical: 11 },
});
