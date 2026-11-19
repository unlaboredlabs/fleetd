// Settings › Claude, for admins (claude.ts), as the desktop's Settings › Hub › Setup › Claude has it: the hub's API key,
// in a secure field, sealed here to each machine's box key before it leaves the phone, and its endpoint, Anthropic's
// own prefilled. One on the tailnet says so while Tailscale isn't connected, and Connect Tailscale is right under it
// (the hub answers with Tailscale's sign-in page, which opens). Save tests it at once; Test and Remove once it is set.
import { getRandomBytes } from "expo-crypto";
import { useEffect, useState } from "react";
import { ActivityIndicator, Linking, RefreshControl, ScrollView, StyleSheet, TextInput, View } from "react-native";
import type { ClaudeAccountsGetOutput, TailnetState } from "../../../desktop/src/shared/contracts";
import { boxesOf, endpointOk, endpointShown, endpointToSave, keyOf, keyWords, sealEach, tailnetLine } from "../claude";
import { useHub } from "../hubContext";
import { CONNECT_WAIT_MS, tailnetWaiting } from "../machines";
import { shape, space, type, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { confirmDestructive, errorWords, Problem, useRead } from "./manage/parts";

/** A Test is one tiny claude call on a machine; the hub waits for it. */
const TEST_MS = 120_000;

export function Claude() {
  const t = useTheme();
  const { session, state } = useHub();
  const accounts = useRead(() => session.call("claude_accounts_get", {}), [session]);
  const tailnet = useRead(() => session.call("tailnet_get", {}), [session]);
  const api = accounts.value?.ok === true ? (accounts.value.output as ClaudeAccountsGetOutput).hubApi : undefined;
  const ts = tailnet.value?.ok === true ? (tailnet.value.output as TailnetState) : undefined;
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | "tailscale" | null>(null);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [works, setWorks] = useState(false);
  // The field holds the saved endpoint until the person types over it.
  const shown = endpoint ?? endpointShown(api?.endpoint);
  // The person signs in on Tailscale's page: its state is read again until it isn't waiting on them.
  const waitingOn = tailnetWaiting(ts);
  const rereadTailnet = tailnet.reload;
  useEffect(() => {
    if (!waitingOn) return;
    const timer = setInterval(rereadTailnet, 2_000);
    return () => clearInterval(timer);
  }, [waitingOn, rereadTailnet]);

  if (accounts.value === undefined) return <ActivityIndicator style={styles.loading} color={t.secondary} />;
  if (!accounts.value.ok) return <Problem text={`Couldn't read the hub's Claude: ${errorWords(accounts.value.error)}`} />;

  const test = async () => {
    const out = await session.call("claude_account_test", { account: "hub_api" }, TEST_MS);
    const ok = out.ok && out.output.test.ok;
    setWorks(ok);
    if (!ok) setProblem(out.ok ? `Not working: ${out.output.test.error ?? "claude failed"}` : `Not tested: ${errorWords(out.error)}`);
    return ok;
  };
  const save = async () => {
    const typed = key.trim() === "" ? null : keyOf(key);
    if (key.trim() !== "" && typed === null) return setProblem("That isn't an API key: it has spaces or line breaks in it.");
    if (!endpointOk(shown)) return setProblem("The endpoint isn't an http:// or https:// URL.");
    if (typed === null && api === undefined) return setProblem("Paste the API key from the Claude Console.");
    const boxes = boxesOf(state.machines);
    if (typed !== null && boxes.length === 0) return setProblem("No machine takes secrets yet: add a machine or connect a provider first.");
    const saved = endpointToSave(shown);
    setBusy("save");
    setProblem(undefined);
    setWorks(false);
    const out = await session.call("claude_hub_api_set", { sealed: typed === null ? [] : sealEach(typed, boxes, getRandomBytes), ...(saved === undefined ? {} : { endpoint: saved }) });
    if (!out.ok) {
      setBusy(null);
      haptics.warning();
      return setProblem(`Not saved: ${errorWords(out.error)}`);
    }
    setKey("");
    setEndpoint(null);
    accounts.reload();
    setBusy("test");
    if (await test()) haptics.success();
    else haptics.warning();
    setBusy(null);
  };
  const remove = () =>
    confirmDestructive({
      title: "Remove the hub's API key?",
      message: "Each machine forgets it. Leads and automations run on the hub owner's subscription from their next start, else each machine's own login.",
      button: "Remove",
      onConfirm: () => {
        setBusy("remove");
        void session.call("claude_hub_api_remove", {}).then((out) => {
          setBusy(null);
          if (!out.ok) setProblem(`Not removed: ${errorWords(out.error)}`);
          accounts.reload();
        });
      },
    });
  const connectTailscale = () => {
    if (ts?.status === "login" && ts.loginUrl !== undefined) return void Linking.openURL(ts.loginUrl);
    if (ts?.status === "approve") return void Linking.openURL("https://login.tailscale.com/admin/machines");
    setBusy("tailscale");
    void session.call("tailnet_connect", {}, CONNECT_WAIT_MS).then((out) => {
      setBusy(null);
      tailnet.reload();
      if (!out.ok) return setProblem(`Tailscale not connected: ${errorWords(out.error)}`);
      const url = (out.output as TailnetState).loginUrl;
      if (url !== undefined) void Linking.openURL(url);
    });
  };

  const words = keyWords(api);
  // A hub that serves no Tailscale, or one whose OS can't run it, says nothing of it here.
  const line = ts === undefined || (ts.status === "off" && ts.problem !== undefined) ? null : tailnetLine(shown, ts.status === "connected");
  const field = (props: { value: string; onChangeText: (v: string) => void; placeholder: string; label: string; secure?: boolean }) => (
    <View style={styles.field}>
      <TextInput
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={t.tertiary}
        {...(props.secure === true ? { secureTextEntry: true } : { keyboardType: "url" as const })}
        textContentType="none"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        editable={busy === null}
        accessibilityLabel={props.label}
        selectionColor={t.accent}
        style={[type.body, styles.input, { color: t.label }]}
      />
    </View>
  );
  const changed = key.trim() !== "" || endpointToSave(shown) !== api?.endpoint;
  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => (accounts.reload(), tailnet.reload())} tintColor={t.secondary} />}
    >
      <ListSection header="Hub API Key" {...(words.footer === undefined ? {} : { footer: words.footer })}>
        {field({ value: shown, onChangeText: setEndpoint, placeholder: "Endpoint", label: "Endpoint" })}
        {field({ value: key, onChangeText: setKey, placeholder: api === undefined ? "API Key" : "New API Key", label: "API key", secure: true })}
        <ListRow
          title={busy === "save" ? "Saving…" : busy === "test" ? "Testing…" : "Save and Test"}
          {...(busy === null && changed ? { onPress: () => void save() } : {})}
          chevron={false}
        />
      </ListSection>
      {line === null ? null : (
        <ListSection footer={waitingOn ? `${line} Finish signing in to Tailscale.` : line}>
          <ListRow
            title={busy === "tailscale" ? "Connecting…" : ts?.status === "login" ? "Open Tailscale Sign-In" : ts?.status === "approve" ? "Open Tailscale" : "Connect Tailscale"}
            valueColor={t.warning}
            {...(busy === null && ts?.status !== "starting" ? { onPress: connectTailscale } : {})}
            chevron={false}
          />
        </ListSection>
      )}
      {api === undefined ? null : (
        <ListSection>
          <ListRow
            title={busy === "test" ? "Testing…" : "Test"}
            value={works ? "Works" : undefined}
            valueColor={t.success}
            {...(busy === null ? { onPress: () => void (setBusy("test"), setProblem(undefined), test().then(() => setBusy(null))) } : {})}
            chevron={false}
          />
          <ListRow title={busy === "remove" ? "Removing…" : "Remove"} destructive {...(busy === null ? { onPress: remove } : {})} chevron={false} />
        </ListSection>
      )}
      <Problem text={problem} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
  field: { flexDirection: "row", alignItems: "center", minHeight: shape.row, paddingHorizontal: space.lg },
  input: { flex: 1, paddingVertical: 11 },
});
