// Approvals, pushed from a project's screen, as the desktop's Settings › Projects › Approvals: how its risky actions
// (sends, shares, a site it opens on its own for the first time, a final confirm on a site) are approved, one of the
// three modes checked, with what every mode keeps; then what ran without asking, newest first, each opening its line
// in the chat. Reads and writes the project's approvals tools (PROJECT_TOOLS).
import { useState } from "react";
import { RefreshControl, ScrollView } from "react-native";
import { listTime } from "../../chatView";
import { APPROVAL_MODES, FLOORS, logWhy, type ApprovalMode, type HubError } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { refOf } from "../../store";
import { space, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { useNow } from "../time";
import { readApprovals, setApprovalMode } from "./api";
import { CheckRow, errorWords, Note, Problem, useRead } from "./parts";

const HELP = "What it does without asking you: its sends, replies, shares and invites, a site it opens on its own for the first time, and the final Confirm on a site. Its own commands never ask.";

export function Approvals({ navigation, route }: ChatInfoProps<"Approvals">) {
  const t = useTheme();
  const now = useNow();
  const { state, session } = useHub();
  const key = route.params.key;
  const ref = refOf(key);
  const read = useRead(() => readApprovals(session, ref), [session, key]);
  const [busy, setBusy] = useState<ApprovalMode | null>(null);
  const [error, setError] = useState<HubError | null>(null);
  const live = state.hub.phase === "live";
  const view = read.value?.ok === true ? read.value.value : undefined;

  const pick = async (mode: ApprovalMode) => {
    if (view === undefined || busy !== null || mode === view.approvals.mode) return;
    haptics.select();
    setBusy(mode);
    setError(null);
    const r = await setApprovalMode(session, ref, mode);
    setBusy(null);
    if (!r.ok) setError(r.error);
    read.reload();
  };

  const saved = view?.approvals;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      style={{ backgroundColor: t.grouped }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={read.reload} tintColor={t.secondary} />}
    >
      <ListSection footer={HELP}>
        {saved === undefined ? (
          <ListRow title={read.value?.ok === false ? "Couldn't read its approvals" : "Reading…"} />
        ) : (
          APPROVAL_MODES.map((m) => <CheckRow key={m.mode} title={m.label} detail={m.description} checked={(busy ?? saved.mode) === m.mode} disabled={!live || busy !== null} onPress={() => void pick(m.mode)} />)
        )}
      </ListSection>
      <Problem text={read.value?.ok === false ? errorWords(read.value.error) : error === null ? undefined : `Not changed: ${errorWords(error)}`} />
      {saved === undefined ? null : <Note>{FLOORS}</Note>}

      {view === undefined ? null : (
        <ListSection header="Ran without asking" footer="Each action the checker let through, or YOLO ran, newest first, with why.">
          {view.log.length === 0 ? (
            <ListRow title="Nothing yet" valueColor={t.secondary} />
          ) : (
            view.log.map((e, i) => {
              const messageId = e.messageId;
              return (
                <ListRow
                  key={`${e.at}-${String(i)}`}
                  title={e.what.replace(/`/gu, "")}
                  detail={`${listTime(e.at, now)} · ${logWhy(e)}`}
                  {...(messageId === undefined ? {} : { onPress: () => navigation.navigate("Chat", { key, messageId }) })}
                />
              );
            })
          )}
        </ListSection>
      )}
    </ScrollView>
  );
}
