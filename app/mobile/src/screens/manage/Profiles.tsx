// Agent Profiles, pushed from a project's screen, as the desktop's project Agents page: the hub's task profiles, each
// checked when its lead may run agents on it (project_set). The default is always allowed; running tasks keep theirs.
import { useState } from "react";
import { RefreshControl, ScrollView } from "react-native";
import { runsLine, type HubError } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { refOf } from "../../store";
import { space, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { setProfile } from "./api";
import { profileLines } from "./model";
import { CheckRow, errorWords, Problem, useRead } from "./parts";

export function Profiles({ route }: ChatInfoProps<"Profiles">) {
  const t = useTheme();
  const { session } = useHub();
  const ref = refOf(route.params.key);
  const read = useRead(() => session.call("profiles_list", { projectRef: ref }), [session, route.params.key]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<HubError | null>(null);
  const view = read.value?.ok === true ? read.value.output : undefined;

  const toggle = async (name: string, on: boolean) => {
    if (view === undefined || busy !== null) return;
    haptics.select();
    setBusy(name);
    setError(null);
    const r = await setProfile(session, ref, view, name, on);
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
      <ListSection footer="Its lead may run agents on the checked profiles, and is told each one's note to pick by. The hub's default is always allowed; running agents keep theirs.">
        {view === undefined ? (
          <ListRow title={read.value?.ok === false ? "Couldn't read the profiles" : "Reading…"} />
        ) : (
          profileLines(view).map((p) => {
            const profile = view.profiles.find((x) => x.name === p.name);
            const runs = profile === undefined ? "" : runsLine(view.models, profile);
            return (
              <CheckRow
                key={p.name}
                title={p.name}
                detail={p.note === "" ? runs : `${runs}. ${p.note}`}
                checked={p.checked}
                disabled={p.fixed || busy !== null}
                onPress={() => void toggle(p.name, !p.checked)}
              />
            );
          })
        )}
      </ListSection>
      <Problem text={read.value?.ok === false ? errorWords(read.value.error) : error === null ? undefined : `Not changed: ${errorWords(error)}`} />
    </ScrollView>
  );
}
