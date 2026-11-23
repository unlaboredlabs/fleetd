// Settings › Providers, for admins, as the desktop's Settings › Hub › Providers: what agents run on, a section per
// provider (the desktop's shared/agentProviders.ts): how it is connected, then the task profiles that run on it (No
// profiles yet with none), each opening its editor (ProfileEdit.tsx), and Add Profile. The models a provider offers
// show only in a profile's editor. While a provider isn't connected
// its profiles say they can't be used until it is. Anthropic's connection opens the hub's Claude API key (Claude.tsx);
// Google's opens its own (Google below): a sign-in on each machine agents run on, the team's Gemini API key, and the
// bots whose Vault holds a key of their own, which wins there.
import { getRandomBytes } from "expo-crypto";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, TextInput, View } from "react-native";
import type { AntigravityStatusOutput, ClaudeAccountsGetOutput, GeminiKey, Profile, ProfileModel } from "../../../desktop/src/shared/contracts";
import { boxesOf, endpointOk, geminiKeyWords, keyOf as keyOfTyped, sealEach } from "../claude";
import { AGENT_PROVIDERS, googleConnected, googleWords, leadOf, providerOf, runsLine, type AgentProviderId } from "../desktop";
import { useHub, type SettingsProps } from "../hubContext";
import { keyOf } from "../store";
import { shape, space, type, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { GoogleSignIn } from "./GoogleSignIn";
import { machineName } from "./manage/model";
import { confirmDestructive, errorWords, Problem, useRead } from "./manage/parts";

/** Where Google is connected: undefined on a hub that doesn't say (it offers the sign-in on each machine that takes it). */
const useGoogle = () => {
  const { session } = useHub();
  const read = useRead(() => session.call("antigravity_status", {}), [session]);
  const roles = useRead(() => session.call("machine_roles", {}), [session]);
  const status = read.value?.ok === true ? (read.value.output as AntigravityStatusOutput) : undefined;
  const machines: { machineId: string; signedIn?: string | undefined }[] =
    status?.machines ?? (roles.value?.ok === true ? roles.value.output.machines.filter((m) => m.antigravityLogin === true).map((m) => ({ machineId: m.machineId })) : []);
  return { status, machines, reading: read.value === undefined, reload: () => (read.reload(), roles.reload()) };
};

export function Providers({ navigation }: SettingsProps<"Providers">) {
  const t = useTheme();
  const { session } = useHub();
  const models = useRead(() => session.call("profiles_list", {}), [session]);
  const claude = useRead(() => session.call("claude_accounts_get", {}), [session]);
  const google = useGoogle();
  // Back from a profile's editor: read again (the first focus is the mount's read).
  const { reload } = models;
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shown.current) reload();
      shown.current = true;
    }, [reload]),
  );
  const list: ReadonlyArray<ProfileModel> = models.value?.ok === true ? models.value.output.models : [];
  const profiles: ReadonlyArray<Profile> = models.value?.ok === true ? models.value.output.profiles : [];
  const accounts = claude.value?.ok === true ? (claude.value.output as ClaudeAccountsGetOutput) : undefined;
  const anthropic = [accounts?.hubApi === undefined ? null : "API Key", (accounts?.people ?? []).some((p) => p.subscription !== undefined) ? "Subscriptions" : null].filter((w) => w !== null).join(" · ");
  const connected = googleConnected(google.status);
  if (models.value === undefined) return <ActivityIndicator style={styles.loading} color={t.secondary} />;
  const lead = leadOf(profiles)?.id;
  // Each provider's connection, as its first row: its words, and whether its profiles can't be used until it connects.
  const connection: Record<AgentProviderId, { value: string | undefined; off: boolean; open: () => void }> = {
    anthropic: { value: anthropic === "" ? "Sign-In" : anthropic, off: false, open: () => navigation.navigate("Claude") },
    google: { value: googleWords(google.status) ?? (connected === "no" ? "Not Connected" : undefined), off: connected === "no", open: () => navigation.navigate("Google") },
  };
  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => (models.reload(), claude.reload(), google.reload())} tintColor={t.secondary} />}
    >
      {AGENT_PROVIDERS.map((p) => {
        const c = connection[p.id];
        const mine = profiles.filter((q) => providerOf(q.model).id === p.id);
        const canAdd = list.some((m) => providerOf(m.id).id === p.id);
        const footer = mine.length === 0 ? "No profiles yet." : c.off ? `${p.name} isn't connected: agents can't run on its profiles until it is.` : undefined;
        return (
          <ListSection key={p.id} header={p.name} {...(footer === undefined ? {} : { footer })}>
            <ListRow
              title="Connection"
              value={c.value}
              {...(p.id === "google" && connected !== "yes" ? { valueColor: t.warning } : {})}
              onPress={c.open}
            />
            {mine.map((q) => (
              <ListRow
                key={q.id}
                title={q.name}
                detail={runsLine(list, q)}
                value={c.off ? "Unusable" : [q.default ? "Default" : null, q.id === lead ? "Lead" : null].filter((w) => w !== null).join(" · ") || undefined}
                {...(c.off ? { valueColor: t.warning } : {})}
                onPress={() => navigation.navigate("ProfileEdit", { provider: p.id, id: q.id })}
              />
            ))}
            {canAdd ? <ListRow icon="plus" title="Add Profile" chevron={false} onPress={() => navigation.navigate("ProfileEdit", { provider: p.id })} /> : null}
          </ListSection>
        );
      })}
      <Problem text={models.value.ok ? undefined : `Profiles not read: ${errorWords(models.value.error)}`} />
    </ScrollView>
  );
}

/** Providers › Google: each machine's sign-in, then the bots whose Vault holds a Gemini key. */
export function Google() {
  const t = useTheme();
  const { state, paired } = useHub();
  const google = useGoogle();
  if (google.reading) return <ActivityIndicator style={styles.loading} color={t.secondary} />;
  const keyIn = google.status?.keyIn ?? [];
  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={google.reload} tintColor={t.secondary} />}
    >
      {google.machines.map((m) => (
        <GoogleSignIn key={m.machineId} machineId={m.machineId} name={machineName(state.machines, m.machineId, paired.cloud === true)} signedIn={m.signedIn} onSigned={google.reload} />
      ))}
      <GeminiKeySection teamKey={google.status?.teamKey} onSaved={google.reload} />
      {keyIn.length === 0 ? null : (
        <ListSection header="Bots with Their Own Key" footer="Their agents on Google run on the GEMINI_API_KEY in the bot's Vault instead of the team's.">
          {keyIn.map((r) => (
            <ListRow key={`${r.machineId}/${r.projectId}`} title={state.projects?.[keyOf(r)]?.title ?? r.projectId} />
          ))}
        </ListSection>
      )}
    </ScrollView>
  );
}

/**
 * The team's Gemini API key, as Providers › Anthropic has the hub's Claude key: a secure field, sealed here to each
 * machine's box key before it leaves the phone (gemini_key_set), and its endpoint; Remove once it is set.
 */
function GeminiKeySection({ teamKey, onSaved }: { teamKey: GeminiKey | undefined; onSaved: () => void }) {
  const t = useTheme();
  const { session, state } = useHub();
  const [key, setKey] = useState("");
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const shown = endpoint ?? teamKey?.endpoint ?? "";
  const words = geminiKeyWords(teamKey);
  const save = async () => {
    const typed = key.trim() === "" ? null : keyOfTyped(key);
    if (key.trim() !== "" && typed === null) return setProblem("That isn't an API key: it has spaces or line breaks in it.");
    if (!endpointOk(shown)) return setProblem("The endpoint isn't an http:// or https:// URL.");
    if (typed === null && teamKey === undefined) return setProblem("Paste the key from Google AI Studio.");
    const boxes = boxesOf(state.machines);
    if (typed !== null && boxes.length === 0) return setProblem("No machine takes secrets yet: add a machine first.");
    setBusy("save");
    setProblem(undefined);
    const ep = shown.trim().replace(/\/+$/u, "");
    const out = await session.call("gemini_key_set", { sealed: typed === null ? [] : sealEach(typed, boxes, getRandomBytes), ...(ep === "" ? {} : { endpoint: ep }) });
    setBusy(null);
    if (!out.ok) {
      haptics.warning();
      return setProblem(`Not saved: ${errorWords(out.error)}`);
    }
    haptics.success();
    setKey("");
    setEndpoint(null);
    onSaved();
  };
  const remove = () =>
    confirmDestructive({
      title: "Remove the team's Gemini key?",
      message: "Each machine forgets it. Agents on Google run on their bot's own key, else the machine's Google sign-in, from their next start.",
      button: "Remove",
      onConfirm: () => {
        setBusy("remove");
        void session.call("gemini_key_remove", {}).then((out) => {
          setBusy(null);
          if (!out.ok) setProblem(`Not removed: ${errorWords(out.error)}`);
          onSaved();
        });
      },
    });
  const changed = key.trim() !== "" || shown.trim() !== (teamKey?.endpoint ?? "");
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
  return (
    <>
      <ListSection header="Gemini API Key" {...(words.footer === undefined ? {} : { footer: words.footer })}>
        {field({ value: key, onChangeText: setKey, placeholder: teamKey === undefined ? "API Key" : "New API Key", label: "Gemini API key", secure: true })}
        {field({ value: shown, onChangeText: setEndpoint, placeholder: "Endpoint (Google's own)", label: "Gemini endpoint" })}
        <ListRow title={busy === "save" ? "Saving…" : "Save"} {...(busy === null && changed ? { onPress: () => void save() } : {})} chevron={false} />
        {teamKey === undefined ? null : <ListRow title={busy === "remove" ? "Removing…" : "Remove"} destructive {...(busy === null ? { onPress: remove } : {})} chevron={false} />}
      </ListSection>
      <Problem text={problem} />
    </>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
  field: { flexDirection: "row", alignItems: "center", minHeight: shape.row, paddingHorizontal: space.lg },
  input: { flex: 1, paddingVertical: 11 },
});
