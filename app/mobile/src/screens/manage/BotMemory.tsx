// Memory, pushed from a bot's screen, as the desktop's Instructions & memory: on top, the changes held for an admin's
// OK (a line that loosens what asks or merges, from someone who isn't one), each with who taught it, and for an owner or
// admin Keep and Don't Keep; then the bot's always-on lines and each topic's, each with who taught it in a quiet line
// under its words. Reads memory_get with the bot; answers with memory_hold_answer. Editing stays on the desktop.
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { botMemoryClient, heldDetail, type BotLine, type BotMemory as Read, type HeldShape } from "../../botMemory";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { refOf } from "../../store";
import { space, type, useTheme } from "../../theme";
import { Button } from "../../ui/Button";
import { haptics } from "../../ui/haptics";
import { ListSection } from "../../ui/List";
import { errorWords, Problem, useBotLocked } from "./parts";

export function BotMemory({ route }: ChatInfoProps<"Memory">) {
  const t = useTheme();
  const { session } = useHub();
  const key = route.params.key;
  const ref = refOf(key);
  const client = useMemo(() => botMemoryClient(session), [session]);
  const locked = useBotLocked();
  const [mem, setMem] = useState<Read | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const read = useCallback(() => {
    setReading(true);
    void client.read(refOf(key)).then((r) => {
      setReading(false);
      if (r.ok) setMem(r.value);
      else setProblem(errorWords(r.error));
    });
  }, [client, key]);
  useFocusEffect(read);

  const answer = (h: HeldShape, keep: boolean) => {
    haptics.tap();
    setBusy(h.messageId);
    setProblem(undefined);
    void client.answer(ref, h.messageId, keep).then((r) => {
      setBusy(null);
      if (r.ok) haptics.success();
      else {
        haptics.warning();
        setProblem(errorWords(r.error));
      }
      read();
    });
  };

  const held = mem?.held ?? [];
  const files = mem?.files ?? [];
  return (
    <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic" refreshControl={<RefreshControl refreshing={reading && mem !== undefined} onRefresh={read} />}>
      {held.length > 0 ? (
        <ListSection
          header="Waiting for an admin"
          footer={
            locked
              ? "These loosen what asks or merges, so they wait for an owner or admin. Until then the bot goes by its memory as it is."
              : "These loosen what asks or merges. Nothing changes until you keep one."
          }
        >
          {held.map((h) => (
            <View key={h.messageId} style={styles.row}>
              <Text style={[type.body, { color: t.label }]}>{h.text}</Text>
              <Text style={[type.footnote, { color: t.secondary }]}>{heldDetail(h)}</Text>
              {locked ? null : (
                <View style={styles.actions}>
                  <Button label="Keep" kind="tinted" size="small" busy={busy === h.messageId} disabled={busy !== null} onPress={() => answer(h, true)} />
                  <Button label="Don't Keep" kind="plain" size="small" disabled={busy !== null} onPress={() => answer(h, false)} />
                </View>
              )}
            </View>
          ))}
        </ListSection>
      ) : null}
      <Problem text={problem} />
      {mem === undefined ? null : files.every((f) => f.lines.length === 0) ? (
        <ListSection>
          <View style={styles.row}>
            <Text style={[type.body, { color: t.secondary }]}>Nothing remembered yet</Text>
          </View>
        </ListSection>
      ) : (
        files
          .filter((f) => f.lines.length > 0)
          .map((f) => (
            <ListSection key={f.topic ?? ""} header={f.topic ?? "Always on"} {...(f.topic === undefined ? { footer: "Every session of this bot reads these." } : {})}>
              {f.lines.map((l, i) => (
                <Line key={`${String(i)}:${l.text}`} line={l} />
              ))}
            </ListSection>
          ))
      )}
    </ScrollView>
  );
}

/** One line of a file: its words in full, and who taught it under them when the workspace knows. */
function Line({ line }: { line: BotLine }) {
  const t = useTheme();
  return (
    <View style={styles.row} accessible accessibilityLabel={line.by === undefined ? line.text : `${line.text}${/[.!?]$/u.test(line.text) ? "" : "."} From ${line.by}`}>
      <Text style={[type.body, { color: t.label }]} selectable>
        {line.text}
      </Text>
      {line.by === undefined ? null : <Text style={[type.footnote, { color: t.secondary }]}>From {line.by}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: 2, paddingHorizontal: space.lg, paddingVertical: 11 },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.sm },
});
