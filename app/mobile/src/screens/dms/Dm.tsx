// One DM between agents, pushed from the DMs log: who sent it, its whole text (selectable, to copy), when, and each
// recipient with what became of it for them and when, with the hub's own words on it (why it is held, what it answers). Its
// receipts read again on a DM event in the project, while it is among the newest. Read-only: there is nothing to
// edit or delete.
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { bubbleTime, fullTime, listTime, type Clock } from "../../chatView";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { space, type, useTheme } from "../../theme";
import { ListRow, ListSection } from "../../ui/List";
import { useNow } from "../time";
import { readDms } from "./api";
import { OutcomeGlyph, useDmsChanged } from "./Dms";
import { glyphOf, outcomeWord, type AgentMessage, type DmReceipt } from "./model";

/** When a receipt came: its clock time today, else its day and clock time. */
const receiptTime = (at: string, clock: Clock): string => {
  const day = listTime(at, clock);
  const time = bubbleTime(at, clock);
  return day === time ? time : `${day}, ${time}`;
};

export function Dm({ route }: ChatInfoProps<"Dm">) {
  const t = useTheme();
  const now = useNow();
  const { state, session } = useHub();
  const { key } = route.params;
  const p = state.projects?.[key];
  const [m, setM] = useState<AgentMessage>(route.params.message);
  const reload = useCallback(() => {
    if (p === undefined) return;
    void readDms(session, p).then((r) => {
      const fresh = r.ok ? r.value.messages.find((x) => x.id === route.params.message.id) : undefined;
      if (fresh !== undefined) setM(fresh);
    });
  }, [p, session, route.params.message.id]);
  useDmsChanged(p === undefined ? undefined : { machineId: p.machineId, projectId: p.projectId }, reload);

  return (
    <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: space.xxl }}>
      <ListSection header="From">
        <ListRow title={m.from.taskId} detail={m.from.title} />
      </ListSection>
      <ListSection header="Message" footer={`Sent ${fullTime(m.sentAt, now)}`}>
        <View style={styles.text}>
          <Text style={[type.body, { color: t.label }]} selectable>
            {m.text}
          </Text>
        </View>
      </ListSection>
      <ListSection header={m.to.length === 1 ? "To" : `To ${String(m.to.length)} agents`} footer="Kept as sent: nobody can edit or delete a DM.">
        {m.to.map((r) => (
          <ReceiptRow key={r.taskId} receipt={r} when={r.at === undefined ? undefined : receiptTime(r.at, now)} />
        ))}
      </ListSection>
    </ScrollView>
  );
}

/** One recipient, as the log's rows: its id and when, its title, what became of it, and the hub's words on that. */
function ReceiptRow({ receipt: r, when }: { receipt: DmReceipt; when: string | undefined }) {
  const t = useTheme();
  return (
    <View style={styles.receipt} accessible>
      <View style={styles.top}>
        <Text style={[type.body, styles.grow, { color: t.label }]}>{r.taskId}</Text>
        {when === undefined ? null : <Text style={[type.subhead, { color: t.secondary }]}>{when}</Text>}
      </View>
      {r.title === undefined ? null : (
        <Text style={[type.subhead, { color: t.secondary }]} numberOfLines={2}>
          {r.title}
        </Text>
      )}
      <View style={styles.outcome}>
        <OutcomeGlyph glyph={glyphOf({ to: [r] })} size={13} />
        <Text style={[type.subhead, styles.grow, { color: t.label }]}>{outcomeWord(r.outcome)}</Text>
      </View>
      {r.detail === undefined || r.detail.trim() === "" ? null : <Text style={[type.footnote, { color: t.secondary }]}>{r.detail}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  text: { paddingHorizontal: space.lg, paddingVertical: 12 },
  receipt: { gap: 2, paddingHorizontal: space.lg, paddingVertical: 11 },
  top: { flexDirection: "row", alignItems: "center", gap: space.sm },
  outcome: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  grow: { flex: 1 },
});
