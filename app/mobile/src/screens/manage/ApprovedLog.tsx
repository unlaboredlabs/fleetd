// What ran without asking, whole, pushed from Approvals' "Show all" (W601): the log in pages from the newest, the next
// older page read as it scrolls near the end, repeats of the same action one row with their count, each opening its
// line in the chat. Approvals itself shows only the newest few (`approvedRows`), so a busy project's log never takes
// over that screen.
import { useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { listTime, type Clock } from "../../chatView";
import { addApprovedPage, foldApproved, logWhy, timesWord, type ApprovedPages, type ApprovedRow } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { refOf, type Key } from "../../store";
import { space, useTheme } from "../../theme";
import { ListRow, ListSection } from "../../ui/List";
import { useNow } from "../time";
import { readApprovedPage } from "./api";
import { errorWords, Problem, useRead } from "./parts";

/** One row per folded run: the action, its latest time with why, and how many times it ran in a row. */
export const approvedRows = (rows: ReadonlyArray<ApprovedRow>, now: Clock, open: (messageId: string) => void) =>
  rows.map(({ entry: e, count }, i) => {
    const messageId = e.messageId;
    const times = timesWord(count);
    return (
      <ListRow
        key={`${e.at}-${String(i)}`}
        title={e.what.replace(/`/gu, "")}
        detail={`${listTime(e.at, now)} · ${logWhy(e)}`}
        {...(times === undefined ? {} : { value: times })}
        {...(messageId === undefined ? {} : { onPress: () => open(messageId) })}
      />
    );
  });

export function ApprovedLog({ navigation, route }: ChatInfoProps<"ApprovedLog">) {
  const t = useTheme();
  const now = useNow();
  const { session } = useHub();
  const key: Key = route.params.key;
  const ref = refOf(key);
  const first = useRead(() => readApprovedPage(session, ref), [session, key]);
  // The older pages read after the first, and the one being read.
  const [older, setOlder] = useState<ApprovedPages | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const head = first.value?.ok === true ? first.value.value : undefined;
  const pages = head === undefined ? undefined : older === null ? head : addApprovedPage(head, older);

  const more = async () => {
    const before = pages?.older;
    if (before === undefined || busy) return;
    setBusy(true);
    setProblem(undefined);
    const r = await readApprovedPage(session, ref, before);
    setBusy(false);
    if (!r.ok) setProblem(`Couldn't read older ones: ${errorWords(r.error)}`);
    else setOlder((was) => (was === null ? r.value : addApprovedPage(was, r.value)));
  };
  const nearEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    if (problem === undefined && layoutMeasurement.height + contentOffset.y >= contentSize.height - 400) void more();
  };
  const reload = () => {
    setOlder(null);
    setProblem(undefined);
    first.reload();
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      style={{ backgroundColor: t.grouped }}
      onScroll={nearEnd}
      scrollEventThrottle={200}
      refreshControl={<RefreshControl refreshing={false} onRefresh={reload} tintColor={t.secondary} />}
    >
      {first.value?.ok === false ? <Problem text={errorWords(first.value.error)} /> : null}
      {pages === undefined ? (
        first.value === undefined ? <ActivityIndicator style={{ marginTop: space.xl }} color={t.secondary} /> : null
      ) : (
        <ListSection footer="Each action the checker let through, or YOLO ran, newest first, with why.">
          {pages.log.length === 0
            ? [<ListRow key="none" title="Nothing yet" valueColor={t.secondary} />]
            : approvedRows(foldApproved(pages.log), now, (messageId) => navigation.navigate("Chat", { key, messageId }))}
        </ListSection>
      )}
      <Problem text={problem} />
      {pages?.older === undefined ? null : busy ? (
        <ActivityIndicator style={{ marginVertical: space.lg }} color={t.secondary} />
      ) : (
        <ListSection>
          <ListRow title="Show older" onPress={() => void more()} />
        </ListSection>
      )}
    </ScrollView>
  );
}
