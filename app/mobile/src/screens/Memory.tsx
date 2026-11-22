// Memory, pushed from Settings: the person's own memory, as the desktop's You › Your memory. On top, the last tidy's
// "Memory refreshed" line with Undo while any of its changes holds; then the core every session reads, its whole text
// on a card to edit in place (its topic lines are the rows below, not text); then each topic, a row that opens its
// file on a card under it; then Import Memory. Saves go through memory_set; the hub never refuses one for size.
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useHub, type SettingsProps } from "../hubContext";
import { coreEntries, memoryClient, openChanges, withTopicLines, type MemoryFileShape, type MyMemory } from "../memory";
import { shape, space, type, useTheme } from "../theme";
import { Button } from "../ui/Button";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { errorWords, Problem } from "./manage/parts";

export function Memory({ navigation }: SettingsProps<"Memory">) {
  const t = useTheme();
  const { session } = useHub();
  const client = useMemo(() => memoryClient(session), [session]);
  const [mem, setMem] = useState<MyMemory | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const read = useCallback(() => {
    void client.read().then((r) => {
      if (r.ok) setMem(r.value);
      else setProblem(errorWords(r.error));
    });
  }, [client]);
  useFocusEffect(read);

  const act = (work: () => Promise<{ ok: boolean; error?: Parameters<typeof errorWords>[0] }>) => {
    setBusy(true);
    setProblem(undefined);
    void work().then((r) => {
      setBusy(false);
      if (r.ok) haptics.success();
      else {
        haptics.warning();
        if (r.error) setProblem(errorWords(r.error));
      }
      read();
    });
  };

  const tidied = mem?.tidied;
  const undoable = openChanges(tidied);
  return (
    <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
      {tidied?.text ? (
        <ListSection>
          <ListRow
            title={tidied.text}
            {...(undoable > 0 ? {} : { value: "Undone" })}
            accessory={undoable > 0 ? <Button label="Undo" kind="plain" size="small" disabled={busy} onPress={() => act(() => client.undoTidy(tidied))} /> : undefined}
          />
        </ListSection>
      ) : null}
      {mem ? (
        <FileCard
          key={`core:${mem.core.text}`}
          label="Your memory"
          text={coreEntries(mem.core.text)}
          busy={busy}
          onSave={(typed) => act(() => client.save(undefined, withTopicLines(typed, mem.core.text)))}
        />
      ) : null}
      {mem && mem.topics.length > 0
        ? // The open topic's card sits right under its row: the rows after it go on in a group of their own.
          splitAt(mem.topics, open).map((part, i) => (
            <View key={i}>
              <ListSection {...(i === 0 ? { header: "Topics" } : {})}>
                {part.rows.map((f) => (
                  <ListRow key={f.topic} title={f.topic ?? ""} chevron={false} onPress={() => setOpen(open === f.topic ? undefined : f.topic)} />
                ))}
              </ListSection>
              {part.opened ? (
                <FileCard
                  key={`${part.opened.topic ?? ""}:${part.opened.text}`}
                  label={part.opened.topic ?? ""}
                  text={part.opened.text}
                  busy={busy}
                  onSave={(typed) => act(() => client.save(part.opened?.topic, typed.trim() ? `${typed.replace(/\s+$/, "")}\n` : ""))}
                />
              ) : null}
            </View>
          ))
        : null}
      <Problem text={problem} />
      <ListSection>
        <ListRow title="Import Memory" onPress={() => navigation.navigate("ImportMemory")} />
      </ListSection>
    </ScrollView>
  );
}

/** The topics in groups: up to and with the open one, its file after it; then the rest. */
function splitAt(topics: readonly MemoryFileShape[], open: string | undefined): { rows: MemoryFileShape[]; opened?: MemoryFileShape }[] {
  const i = topics.findIndex((f) => f.topic === open);
  if (i < 0) return [{ rows: [...topics] }];
  const rest = topics.slice(i + 1);
  return [{ rows: topics.slice(0, i + 1), opened: topics[i] as MemoryFileShape }, ...(rest.length ? [{ rows: rest }] : [])];
}

/** One file's whole text on a card, edited in place; Save once it changed. */
function FileCard({ label, text, busy, onSave }: { label: string; text: string; busy: boolean; onSave: (typed: string) => void }) {
  const t = useTheme();
  const [draft, setDraft] = useState(text);
  return (
    <View style={styles.wrap}>
      <Text style={[type.footnote, styles.header, { color: t.secondary }]} accessibilityRole="header">
        {label}
      </Text>
      <View style={[styles.card, { backgroundColor: t.cell }]}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          scrollEnabled={false}
          autoCorrect={false}
          selectionColor={t.accent}
          textAlignVertical="top"
          placeholder="Nothing remembered yet"
          placeholderTextColor={t.tertiary}
          accessibilityLabel={`All of ${label}`}
          style={[type.body, styles.box, { color: t.label }]}
        />
      </View>
      {draft !== text ? (
        <View style={styles.save}>
          <Button label="Save" kind="tinted" size="small" busy={busy} onPress={() => onSave(draft)} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: space.lg },
  header: { marginHorizontal: space.lg * 2, marginBottom: space.sm - 2, textTransform: "uppercase" },
  card: { marginHorizontal: space.lg, borderRadius: shape.group, borderCurve: "continuous", overflow: "hidden" },
  box: { minHeight: 88, paddingHorizontal: space.lg, paddingTop: 12, paddingBottom: 12 },
  save: { marginHorizontal: space.lg * 2, marginTop: space.sm, alignItems: "flex-end" },
});
