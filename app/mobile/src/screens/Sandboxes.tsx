// Settings › Sandboxes, for admins (sandboxes.ts): the team's own hosted sandbox accounts, a section per provider in
// the order agents go to them, and under them what it's for. One not connected takes its API key in a secure field (and E2B a self-hosted domain),
// sealed here to the hub's box key before it leaves the phone; one connected has its limit, Test and Disconnect. A
// hub too old for sandbox_get shows a line saying so.
import { useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, RefreshControl, ScrollView, StyleSheet, TextInput, View } from "react-native";
import type { SandboxProviderState, SandboxState } from "../../../desktop/src/shared/contracts";
import { useHub } from "../hubContext";
import { introFooter, limitChoices, limitWords, providerFooter, providerName, takesDomain } from "../sandboxes";
import { shape, space, type, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { confirmDestructive, errorWords, Note, Problem, useRead } from "./manage/parts";
import { sealToHub } from "./vault/api";

/** Connect and Test wait for the provider's answer from one of the team's machines (the hub waits up to 45 s for it). */
const CHECK_TIMEOUT_MS = 60_000;

export function Sandboxes() {
  const t = useTheme();
  const { session } = useHub();
  const read = useRead(() => session.call("sandbox_get", {}), [session]);
  const r = read.value;
  if (r === undefined) return <ActivityIndicator style={styles.loading} color={t.secondary} />;
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
        <Problem text={r.error.code === "not_found" ? "This hub's fleetd is too old for hosted sandboxes: update it first." : `Couldn't read the sandboxes: ${errorWords(r.error)}`} />
      ) : (
        <Providers state={r.output as SandboxState} reload={read.reload} />
      )}
    </ScrollView>
  );
}

function Providers({ state, reload }: { state: SandboxState; reload: () => void }) {
  return (
    <>
      {state.providers.map((p) => (
        <Provider key={p.provider} p={p} boxPubKey={state.boxPubKey} reload={reload} />
      ))}
      <Note>{introFooter(state)}</Note>
    </>
  );
}

function Provider({ p, boxPubKey, reload }: { p: SandboxProviderState; boxPubKey: string; reload: () => void }) {
  const t = useTheme();
  const { session } = useHub();
  const name = providerName(p.provider);
  const [key, setKey] = useState("");
  const [domain, setDomain] = useState("");
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
    const d = takesDomain(p.provider) ? domain.trim() : "";
    void run("connect", () => session.call("sandbox_connect", { provider: p.provider, sealed, ...(d === "" ? {} : { domain: d }) }, CHECK_TIMEOUT_MS), "Not connected").then(() => setKey(""));
  };
  const pickLimit = () => {
    const choices = limitChoices(p.limit);
    const set = (n: number) => void run("limit", () => session.call("sandbox_set", { provider: p.provider, limit: n }), "Not changed");
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
      message: `The team's ${name} key, its limit and its domain go from the hub.`,
      button: "Disconnect",
      onConfirm: () => void run("disconnect", () => session.call("sandbox_disconnect", { provider: p.provider }), "Not disconnected"),
    });

  const footer = providerFooter(p);
  const footerText = problem ?? footer?.text;
  return (
    <>
      <ListSection header={name} {...(footerText === undefined || problem !== undefined || footer?.problem === true ? {} : { footer: footerText })}>
        {p.connected ? (
          <>
            <ListRow title="At Once" value={limitWords(p.limit)} {...(busy === null ? { onPress: pickLimit } : {})} chevron={false} />
            <ListRow title={busy === "test" ? "Testing…" : "Test"} value={works ? "Works" : undefined} valueColor={t.success} {...(busy === null ? { onPress: () => void run("test", () => session.call("sandbox_test", { provider: p.provider }, CHECK_TIMEOUT_MS), "Not tested") } : {})} chevron={false} />
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
            {takesDomain(p.provider) ? (
              <View style={styles.field}>
                <TextInput
                  value={domain}
                  onChangeText={setDomain}
                  placeholder="Domain, if self-hosted"
                  placeholderTextColor={t.tertiary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  keyboardType="url"
                  editable={busy === null}
                  accessibilityLabel="Self-hosted E2B domain"
                  selectionColor={t.accent}
                  style={[type.body, styles.input, { color: t.label }]}
                />
              </View>
            ) : null}
            <ListRow title={busy === "connect" ? "Connecting…" : "Connect"} {...(busy === null && key.trim() !== "" ? { onPress: connect } : {})} chevron={false} />
          </>
        )}
      </ListSection>
      {problem !== undefined || footer?.problem === true ? <Problem text={footerText} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
  field: { flexDirection: "row", alignItems: "center", minHeight: shape.row, paddingHorizontal: space.lg },
  input: { flex: 1, paddingVertical: 11 },
});
