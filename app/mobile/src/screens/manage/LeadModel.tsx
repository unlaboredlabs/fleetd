// Lead Model, pushed from a project's screen, as the desktop's Lead model on its Agents page: the profile its lead
// starts on, the hub's lead profile until it picks its own (project_set leadProfile), and Restart Lead while its lead
// runs on another (leadRestart), waiting on its turn once asked mid-turn (leadRestarting). A profile claude refused can't be picked, and says why.
// The profiles are in a section per provider (Anthropic, Google); an admin also finds each of Google's models no profile
// runs on yet, which makes a profile on it and picks it. While its lead runs on Google and Google isn't connected (no
// machine signed in, no Gemini key in this bot), Sign In with Google is right under them.
import { useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView } from "react-native";
import { googleConnected, MODEL_CHOICE, providerOf, type AntigravityStatusOutput, type HubError } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { refOf } from "../../store";
import { space, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { restartLead, setLeadProfile, startLeadOn } from "./api";
import { GoogleSignIn } from "../GoogleSignIn";
import { LEAD_HUB, leadLines, leadSections, machineName } from "./model";
import { CheckRow, errorWords, Problem, useRead } from "./parts";

export function LeadModel({ route }: ChatInfoProps<"LeadModel">) {
  const t = useTheme();
  const { session, state, paired } = useHub();
  const ref = refOf(route.params.key);
  const read = useRead(() => session.call("profiles_list", { projectRef: ref }), [session, route.params.key]);
  const google = useRead(() => session.call("antigravity_status", {}), [session]);
  const roles = useRead(() => session.call("machine_roles", {}), [session]);
  const status = google.value?.ok === true ? (google.value.output as AntigravityStatusOutput) : undefined;
  const admin = state.admin === true;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<HubError | null>(null);
  const view = read.value?.ok === true ? read.value.output : undefined;
  // Its lead's model, and the machines a sign-in goes to (on a hub that doesn't say, each that takes one).
  const leadName = view?.leadProfile ?? view?.profiles.find((p) => p.lead)?.name ?? view?.profiles.find((p) => p.default)?.name;
  const leadModel = view?.profiles.find((p) => p.name === leadName)?.model;
  const onGoogle = leadModel !== undefined && providerOf(leadModel).id === "google";
  const signIns: { machineId: string; signedIn?: string | undefined }[] = (
    status?.machines ?? (roles.value?.ok === true ? roles.value.output.machines.filter((m) => m.antigravityLogin === true).map((m): { machineId: string; signedIn?: string } => ({ machineId: m.machineId })) : [])
  ).filter((m) => m.signedIn === undefined);

  const run = async (what: string, go: () => Promise<{ ok: true } | { ok: false; error: HubError }>) => {
    if (busy !== null) return;
    haptics.select();
    setBusy(what);
    setError(null);
    const r = await go();
    setBusy(null);
    if (!r.ok) setError(r.error);
    read.reload();
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      style={{ backgroundColor: t.grouped }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={read.reload} tintColor={t.secondary} />}
    >
      {view === undefined ? (
        <ListSection>
          <ListRow title={read.value?.ok === false ? "Couldn't read the profiles" : "Reading…"} />
        </ListSection>
      ) : (
        leadSections(leadLines(view, admin)).map((s) => (
          <ListSection key={s.group ?? "hub"} {...(s.group === undefined ? {} : { header: s.group })}>
            {s.lines.map((l) => (
              <CheckRow
                key={l.value}
                title={l.title}
                detail={l.why}
                checked={l.checked}
                disabled={l.disabled || busy !== null}
                onPress={() => {
                  if (l.checked) return;
                  if (l.value.startsWith(MODEL_CHOICE)) void run("pick", () => startLeadOn(session, ref, l.value.slice(MODEL_CHOICE.length), view.profiles));
                  else void run("pick", () => setLeadProfile(session, ref, l.value === LEAD_HUB ? undefined : l.value));
                }}
              />
            ))}
          </ListSection>
        ))
      )}
      {admin && onGoogle && googleConnected(status, ref) !== "yes"
        ? signIns.map((m) => <GoogleSignIn key={m.machineId} machineId={m.machineId} name={machineName(state.machines, m.machineId, paired.cloud === true)} signedIn={m.signedIn} onSigned={google.reload} />)
        : null}
      {view?.leadRestarting === true ? (
        <ListSection>
          <ListRow title="Restart Lead" value="After its turn" />
        </ListSection>
      ) : view?.leadRestart === true ? (
        <ListSection>
          <ListRow
            title="Restart Lead"
            chevron={false}
            {...(busy === null ? { onPress: () => void run("restart", () => restartLead(session, ref)) } : {})}
            {...(busy === "restart" ? { accessory: <ActivityIndicator color={t.secondary} /> } : {})}
          />
        </ListSection>
      ) : null}
      <Problem text={read.value?.ok === false ? errorWords(read.value.error) : error === null ? undefined : `Not changed: ${errorWords(error)}`} />
    </ScrollView>
  );
}
