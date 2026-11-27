// One agent, pushed from its bot's Info: the desktop's agent page on the phone. While it works: its role and state,
// what it does now, Watch when it has a screen open, Stop, a box to steer it, and its newest steps. Once it ends, the
// record the workspace kept: how it ended and how long it ran, its report, the files it changed, its commits, its
// screens' replays and its step log, read-only. Read again on its task's and thread's events and on focus.
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import type { AgentRow, BrowserSession, HubError, Task, WorkStep } from "../../desktop";
import { changeStat, changeTotals } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { space, type, useTheme } from "../../theme";
import { Button } from "../../ui/Button";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { Markdown } from "../../ui/Markdown";
import { Names } from "../../ui/Names";
import { errorWords, FieldRow, Problem } from "../manage/parts";
import { readRow, readScreens, readSteps, readTask, steerAgent, stopAgent } from "./api";
import { endedLine, fileRow, hasEnded, kindRole, nowWords, roleWord, stepRow } from "./model";

const newId = (): string => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

const STATUS: Record<AgentRow["status"], string> = {
  queued: "Queued",
  starting: "Starting",
  working: "Working",
  stalled: "Stalled",
  idle: "Idle",
  done: "Finished",
  failed: "Failed",
  cancelled: "Stopped",
  waiting: "Waiting for you",
  parked: "Paused at the usage limit",
};

export function Agent({ route }: ChatInfoProps<"Agent">) {
  const t = useTheme();
  const nav = useNavigation<{ navigate: (screen: "Screen", params: { key: string; sessionId: string }) => void }>();
  const { state, session } = useHub();
  const { key, laneId } = route.params;
  const p = state.projects?.[key];
  const [row, setRow] = useState<AgentRow>();
  const [task, setTask] = useState<Task>();
  const [steps, setSteps] = useState<{ list: WorkStep[]; before?: string | undefined }>();
  const [screens, setScreens] = useState<BrowserSession[]>([]);
  const [error, setError] = useState<HubError | null>(null);
  const [stopping, setStopping] = useState(false);
  const taskId = row?.taskId ?? route.params.taskId;

  const reload = useCallback(async () => {
    if (p === undefined) return;
    const r = await readRow(session, p, laneId);
    if (!r.ok) return setError(r.error);
    setError(null);
    if (r.value !== undefined) setRow(r.value);
    const id = r.value?.taskId ?? route.params.taskId;
    if (id === undefined) return;
    const [tr, sr] = await Promise.all([readTask(session, id), readScreens(session, p, id)]);
    if (tr.ok) setTask(tr.value);
    if (sr.ok) setScreens(sr.value);
    const thread = (tr.ok ? tr.value.threadRef : undefined) ?? r.value?.threadRef;
    if (thread === undefined) return;
    const w = await readSteps(session, thread);
    if (w.ok) setSteps((had) => (had === undefined || had.list.length <= w.value.steps.length ? { list: w.value.steps, before: w.value.before } : had));
  }, [p, session, laneId, route.params.taskId]);

  // Its task's or thread's events read it again, a beat apart at most.
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () =>
      session.onEvent((e) => {
        const d = e.data as { taskId?: unknown } | undefined;
        const ours = (taskId !== undefined && d?.taskId === taskId) || (row?.threadRef !== undefined && e.threadId === row.threadRef.threadId);
        if (!ours || pending.current !== undefined) return;
        pending.current = setTimeout(() => {
          pending.current = undefined;
          void reload();
        }, 800);
      }),
    [session, taskId, row?.threadRef, reload],
  );
  useEffect(() => () => clearTimeout(pending.current), []);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const earlier = async () => {
    const thread = task?.threadRef ?? row?.threadRef;
    if (thread === undefined || steps?.before === undefined) return;
    const w = await readSteps(session, thread, steps.before);
    if (w.ok) setSteps({ list: [...w.value.steps, ...steps.list], before: w.value.before });
  };

  const stop = async () => {
    if (taskId === undefined || stopping) return;
    setStopping(true);
    const r = await stopAgent(session, taskId);
    setStopping(false);
    if (!r.ok) {
      haptics.warning();
      return setError(r.error);
    }
    haptics.success();
    setTask(r.value);
    void reload();
  };

  const ended = task !== undefined && endedLine(task) !== undefined ? task : undefined;
  const live = row !== undefined && !hasEnded(row) && ended === undefined;
  const title = row?.title ?? task?.title ?? route.params.title;
  const role = roleWord(row?.role ?? kindRole(task?.kind ?? "write"));
  const line = ended !== undefined ? endedLine(ended) : row !== undefined ? STATUS[row.status] : undefined;
  const tone = ended?.state === "failed" ? t.danger : ended?.state === "done" ? t.success : live && row.status === "waiting" ? t.warning : t.secondary;
  const watching = screens.find((s) => s.state === "live");
  const recorded = screens.filter((s) => s.state === "recorded");
  const files = ended?.result?.files ?? [];
  const totals = changeStat(changeTotals(files).additions, changeTotals(files).deletions);
  const commits = ended?.result?.commits ?? [];
  // Its last words are the report above: the log doesn't say them twice.
  const report = ended?.result?.tail.trim();
  const rows = (steps?.list ?? []).flatMap((s, i, all) => {
    const last = i === all.length - 1 && s.kind === "message" && s.role === "assistant" && report !== undefined && report.endsWith(s.text.trim().slice(-200));
    const r = last ? undefined : stepRow(s);
    return r === undefined ? [] : [r];
  });

  if (p === undefined) return null;
  return (
    <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: space.xxl }}>
      <View style={styles.head}>
        <Text style={[type.caption, styles.caps, { color: t.secondary }]}>{role}</Text>
        <Text style={[type.title3, { color: t.label }]} selectable>
          {title}
        </Text>
        {line === undefined ? null : <Text style={[type.subhead, { color: tone }]}>{line}</Text>}
      </View>
      {live ? (
        <>
          <ListSection header="Now">
            <ListRow title={nowWords(row) ?? STATUS[row.status]} />
            {watching === undefined ? null : <ListRow title="Watch its screen" icon="eye" onPress={() => nav.navigate("Screen", { key, sessionId: watching.sessionId })} />}
          </ListSection>
          {taskId === undefined ? null : <Steer taskId={taskId} />}
          {taskId === undefined || row.role === "lead" ? null : (
            <View style={styles.stop}>
              <Button label={stopping ? "Stopping…" : "Stop"} kind="tinted" destructive busy={stopping} onPress={() => void stop()} />
            </View>
          )}
        </>
      ) : null}
      {ended === undefined ? null : (
        <>
          <ListSection header="Report">
            <View style={styles.text}>
              {ended.result === undefined || ended.result.tail.trim() === "" ? (
                <Text style={[type.body, { color: t.secondary }]}>It left no report.</Text>
              ) : (
                <Markdown text={ended.result.tail} ink={t.label} ground={t.cell} />
              )}
            </View>
          </ListSection>
          {files.length === 0 ? null : (
            <ListSection header={`Files Changed · ${String(files.length)}`} {...(totals === "" ? {} : { footer: `${totals} lines` })}>
              {files.map((f) => {
                const r = fileRow(f);
                return <ListRow key={f.path} title={r.title} detail={r.detail} value={r.value} />;
              })}
            </ListSection>
          )}
          {commits.length === 0 ? null : (
            <ListSection header="Commits">
              {commits.map((c) => (
                <ListRow key={c.sha} title={c.subject} detail={c.sha} />
              ))}
            </ListSection>
          )}
          {recorded.length === 0 ? null : (
            <ListSection header="Screens">
              {recorded.map((s) => (
                <ListRow key={s.sessionId} title={s.purpose} detail="Replay" icon="browser" onPress={() => nav.navigate("Screen", { key, sessionId: s.sessionId })} />
              ))}
            </ListSection>
          )}
        </>
      )}
      <Problem text={error === null ? undefined : `Not read: ${errorWords(error)}`} />
      <ListSection header="Steps">
        {steps === undefined ? (
          <View style={styles.text}>
            <ActivityIndicator />
          </View>
        ) : rows.length === 0 ? (
          <ListRow title="No steps yet" />
        ) : (
          [
            ...(steps.before === undefined ? [] : [<ListRow key="earlier" title="Earlier Steps" onPress={() => void earlier()} chevron={false} />]),
            ...rows.map((r) =>
              r.said ? (
                <View key={r.id} style={styles.text}>
                  <Text style={[type.subhead, { color: t.secondary }]} numberOfLines={6} selectable>
                    <Names text={r.title} />
                  </Text>
                </View>
              ) : (
                <ListRow key={r.id} title={r.title} detail={r.detail} detailColor={r.failed ? t.danger : undefined} />
              ),
            ),
          ]
        )}
      </ListSection>
    </ScrollView>
  );
}

/** A box to steer it: what it reads at its next step. */
function Steer({ taskId }: { taskId: string }) {
  const { session } = useHub();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string>();
  const send = async () => {
    const words = text.trim();
    if (words === "" || busy) return;
    setBusy(true);
    const r = await steerAgent(session, taskId, words, newId());
    setBusy(false);
    if (!r.ok) {
      haptics.warning();
      return setSaid(`Not sent: ${errorWords(r.error)}`);
    }
    haptics.success();
    setText("");
    setSaid("Sent. It reads this at its next step.");
  };
  return (
    <ListSection header="Steer This Agent" {...(said === undefined ? {} : { footer: said })}>
      <FieldRow
        value={text}
        onChangeText={setText}
        placeholder="Tell it something"
        multiline
        editable={!busy}
        returnKeyType="send"
        submitBehavior="submit"
        onSubmitEditing={() => void send()}
        accessibilityLabel="Steer this agent"
      />
      <ListRow title={busy ? "Sending…" : "Send"} {...(text.trim() === "" || busy ? {} : { onPress: () => void send() })} chevron={false} off={text.trim() === ""} />
    </ListSection>
  );
}

const styles = StyleSheet.create({
  head: { gap: 2, paddingHorizontal: space.lg + space.xs, paddingTop: space.md, paddingBottom: space.sm },
  caps: { textTransform: "uppercase", letterSpacing: 0.4 },
  text: { paddingHorizontal: space.lg, paddingVertical: 12 },
  stop: { paddingHorizontal: space.lg, marginTop: space.sm },
});
