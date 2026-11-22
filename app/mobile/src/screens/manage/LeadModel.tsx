// Lead Model, pushed from a project's screen, as the desktop's Lead model on its Agents page: the profile its lead
// starts on, the hub's lead profile until it picks its own (project_set leadProfile), and Restart Lead while its lead
// runs on another (leadRestart), waiting on its turn once asked mid-turn (leadRestarting). A profile claude refused can't be picked, and says why.
import { useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView } from "react-native";
import type { HubError } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { refOf } from "../../store";
import { space, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { restartLead, setLeadProfile } from "./api";
import { LEAD_HUB, leadLines } from "./model";
import { CheckRow, errorWords, Problem, useRead } from "./parts";

export function LeadModel({ route }: ChatInfoProps<"LeadModel">) {
  const t = useTheme();
  const { session } = useHub();
  const ref = refOf(route.params.key);
  const read = useRead(() => session.call("profiles_list", { projectRef: ref }), [session, route.params.key]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<HubError | null>(null);
  const view = read.value?.ok === true ? read.value.output : undefined;

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
      <ListSection>
        {view === undefined ? (
          <ListRow title={read.value?.ok === false ? "Couldn't read the profiles" : "Reading…"} />
        ) : (
          leadLines(view).map((l) => (
            <CheckRow
              key={l.value}
              title={l.title}
              detail={l.why}
              checked={l.checked}
              disabled={l.disabled || busy !== null}
              onPress={() => {
                if (!l.checked) void run("pick", () => setLeadProfile(session, ref, l.value === LEAD_HUB ? undefined : l.value));
              }}
            />
          ))
        )}
      </ListSection>
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
