// Memory, pushed from a bot's screen, as the desktop's Instructions & memory: on top, the changes held for an admin's
// OK (a line that loosens what asks or merges, from someone who isn't one), each with who taught it, and for an owner or
// admin Keep and Don't Keep, and Keep All while two or more wait; then the bot's always-on lines, and each topic as one
// row that opens in place. However big the memory, the screen stays short: past the first few, held changes and lines
// fold under Show, and each line reads as two until tapped. Reads memory_get with the bot; answers with
// memory_hold_answer. Editing stays on the desktop.
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { botMemoryClient, FOLD, folded, HELD_FOLD, heldDetail, type BotFile, type BotLine, type BotMemory as Read, type HeldShape } from "../../botMemory";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { refOf } from "../../store";
import { space, type, useTheme } from "../../theme";
import { Button } from "../../ui/Button";
import { haptics } from "../../ui/haptics";
import { Icon } from "../../ui/Icon";
import { ListRow, ListSection } from "../../ui/List";
import { errorWords, Problem, useBotLocked } from "./parts";

const lines = (n: number) => `${String(n)} ${n === 1 ? "line" : "lines"}`;

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
  // What the person unfolded: "held", "core", or a topic's name.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const toggle = (k: string) => {
    haptics.tap();
    setOpened((o) => {
      const next = new Set(o);
      if (!next.delete(k)) next.add(k);
      return next;
    });
  };

  const read = useCallback(() => {
    setReading(true);
    void client.read(refOf(key)).then((r) => {
      setReading(false);
      if (r.ok) setMem(r.value);
      else setProblem(errorWords(r.error));
    });
  }, [client, key]);
  useFocusEffect(read);

  // Answered one at a time, in order; the first refusal stops the rest and says why.
  const answer = async (hs: readonly HeldShape[], keep: boolean) => {
    haptics.tap();
    setBusy(hs.length === 1 ? (hs[0]?.messageId ?? null) : "all");
    setProblem(undefined);
    for (const h of hs) {
      const r = await client.answer(ref, h.messageId, keep);
      if (!r.ok) {
        haptics.warning();
        setProblem(errorWords(r.error));
        break;
      }
    }
    setBusy(null);
    read();
  };

  const held = mem?.held ?? [];
  const files = mem?.files ?? [];
  const core = files.find((f) => f.topic === undefined);
  const topics = files.filter((f) => f.topic !== undefined && f.lines.length > 0);
  const heldFold = folded(held, HELD_FOLD, opened.has("held"));
  const coreFold = folded(core?.lines ?? [], FOLD, opened.has("core"));
  return (
    <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic" refreshControl={<RefreshControl refreshing={reading && mem !== undefined} onRefresh={read} />}>
      {held.length > 0 ? (
        <ListSection
          header={`Waiting for an admin · ${String(held.length)}`}
          footer={
            locked
              ? "These loosen what asks or merges, so they wait for an owner or admin. Until then the bot goes by its memory as it is."
              : "These loosen what asks or merges. Nothing changes until you keep one."
          }
        >
          {[
            ...heldFold.shown.map((h) => <Held key={h.messageId} held={h} locked={locked} busy={busy} onAnswer={(keep) => void answer([h], keep)} />),
            ...(heldFold.more > 0 || opened.has("held") ? [<More key="more" words={opened.has("held") ? "Show Fewer" : `Show ${String(heldFold.more)} More`} onPress={() => toggle("held")} />] : []),
            ...(locked || held.length < 2
              ? []
              : [<More key="all" words={busy === "all" ? "Keeping…" : `Keep All ${String(held.length)}`} onPress={() => busy === null && void answer(held, true)} />]),
          ]}
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
        <>
          {core !== undefined && core.lines.length > 0 ? (
            <ListSection header="Always on" footer="Every session of this bot reads these.">
              {[
                ...coreFold.shown.map((l, i) => <Line key={`${String(i)}:${l.text}`} line={l} />),
                ...(coreFold.more > 0 || opened.has("core") ? [<More key="more" words={opened.has("core") ? "Show Fewer" : `Show All ${String(core.lines.length)}`} onPress={() => toggle("core")} />] : []),
              ]}
            </ListSection>
          ) : null}
          {topics.length > 0 ? (
            <ListSection header="Topics" footer="Each is read only when its work comes up.">
              {topics.flatMap((f) => topicRows(f, opened.has(`topic:${f.topic ?? ""}`), () => toggle(`topic:${f.topic ?? ""}`)))}
            </ListSection>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

/** A topic: one row with how many lines it holds, and its lines under it once tapped open. */
function topicRows(f: BotFile, open: boolean, onPress: () => void) {
  const name = f.topic ?? "";
  return [
    <ListRow key={`t:${name}`} title={name} value={lines(f.lines.length)} chevron={false} accessory={<Disclosure open={open} />} onPress={onPress} />,
    ...(open ? f.lines.map((l, i) => <Line key={`t:${name}:${String(i)}:${l.text}`} line={l} />) : []),
  ];
}

function Disclosure({ open }: { open: boolean }) {
  const t = useTheme();
  return <Icon name={open ? "chevronDown" : "chevron"} size={14} color={t.tertiary} weight="semibold" />;
}

/** Show More, Show All, Show Fewer or Keep All: a row in the link's blue, as the desktop's are. */
function More({ words, onPress }: { words: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {({ pressed }) => (
        <View style={[styles.row, pressed && { backgroundColor: t.fillQuiet }]}>
          <Text style={[type.body, { color: t.link }]}>{words}</Text>
        </View>
      )}
    </Pressable>
  );
}

/** A held change: two lines and who taught it until tapped, then all of it; Keep and Don't Keep for an admin. */
function Held({ held: h, locked, busy, onAnswer }: { held: HeldShape; locked: boolean; busy: string | null; onAnswer: (keep: boolean) => void }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.row}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}>
        <Text style={[type.body, { color: t.label }]} numberOfLines={open ? undefined : 2}>
          {h.text}
        </Text>
        <Text style={[type.footnote, { color: t.secondary }]} numberOfLines={open ? undefined : 1}>
          {heldDetail(h, !open)}
        </Text>
      </Pressable>
      {locked ? null : (
        <View style={styles.actions}>
          <Button label="Keep" kind="tinted" size="small" busy={busy === h.messageId} disabled={busy !== null} onPress={() => onAnswer(true)} />
          <Button label="Don't Keep" kind="plain" size="small" disabled={busy !== null} onPress={() => onAnswer(false)} />
        </View>
      )}
    </View>
  );
}

/** One line of a file: two lines of its words until tapped, then all of them and who taught it when the workspace knows. */
function Line({ line }: { line: BotLine }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <Pressable
      style={styles.row}
      accessibilityState={{ expanded: open }}
      accessibilityLabel={line.by === undefined ? line.text : `${line.text}${/[.!?]$/u.test(line.text) ? "" : "."} From ${line.by}`}
      onPress={() => setOpen(!open)}
    >
      <Text style={[type.body, { color: t.label }]} numberOfLines={open ? undefined : 2} selectable={open}>
        {line.text}
      </Text>
      {line.by === undefined || !open ? null : <Text style={[type.footnote, { color: t.secondary }]}>From {line.by}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { gap: 2, paddingHorizontal: space.lg, paddingVertical: 11 },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.sm },
});
