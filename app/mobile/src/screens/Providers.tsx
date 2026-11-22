// Settings › Providers, for admins, as the desktop's Settings › Hub › Providers: what agents run on, a row per provider
// (the desktop's shared/agentProviders.ts) with how it is connected and the models it offers under its name. Anthropic
// opens the hub's Claude API key (Claude.tsx); Google opens its own (Google below): a sign-in on each machine agents run
// on, and the bots whose Vault holds a Gemini key.
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet } from "react-native";
import type { AntigravityStatusOutput, ClaudeAccountsGetOutput, ProfileModel } from "../../../desktop/src/shared/contracts";
import { googleConnected, googleWords, runsWords } from "../desktop";
import { useHub, type SettingsProps } from "../hubContext";
import { keyOf } from "../store";
import { space, useTheme } from "../theme";
import { ListRow, ListSection } from "../ui/List";
import { GoogleSignIn } from "./GoogleSignIn";
import { machineName } from "./manage/model";
import { useRead } from "./manage/parts";

/** How many models a row names under its provider, then how many more: one line on a phone. */
const MODELS_SHOWN = 1;

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
  const list: ReadonlyArray<ProfileModel> = models.value?.ok === true ? models.value.output.models : [];
  const accounts = claude.value?.ok === true ? (claude.value.output as ClaudeAccountsGetOutput) : undefined;
  const anthropic = [accounts?.hubApi === undefined ? null : "API Key", (accounts?.people ?? []).some((p) => p.subscription !== undefined) ? "Subscriptions" : null].filter((w) => w !== null).join(" · ");
  const connected = googleConnected(google.status);
  if (models.value === undefined) return <ActivityIndicator style={styles.loading} color={t.secondary} />;
  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => (models.reload(), claude.reload(), google.reload())} tintColor={t.secondary} />}
    >
      <ListSection>
        <ListRow title="Anthropic" detail={runsWords(list, "anthropic", MODELS_SHOWN)} value={anthropic === "" ? "Sign-In" : anthropic} onPress={() => navigation.navigate("Claude")} />
        <ListRow
          title="Google"
          detail={runsWords(list, "google", MODELS_SHOWN)}
          value={googleWords(google.status) ?? (connected === "no" ? "Not Connected" : undefined)}
          {...(connected === "yes" ? {} : { valueColor: t.warning })}
          onPress={() => navigation.navigate("Google")}
        />
      </ListSection>
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
      <ListSection header="Gemini API Key" footer="A bot's agents on Google run on the GEMINI_API_KEY in its Vault, ahead of a sign-in.">
        {keyIn.length === 0 ? (
          <ListRow title="No bot has one yet" />
        ) : (
          keyIn.map((r) => <ListRow key={`${r.machineId}/${r.projectId}`} title={state.projects?.[keyOf(r)]?.title ?? r.projectId} />)
        )}
      </ListSection>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
});
