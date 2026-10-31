// One version of a skill, pushed from its history: its why, who wrote it and when, and what it changed from the
// version before as a prose diff (lines added in green, removed in red, the words that changed inside a line marked,
// unchanged runs folded to a row that opens them). An older version of the Navi's own skill can be restored: it comes
// back as a new version (skill_revert), so nothing is lost.
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { fullTime } from "../../chatView";
import { isYours, type DiffLine, type DiffPiece } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { mono, shape, space, type, useTheme, type Palette } from "../../theme";
import { Button } from "../../ui/Button";
import { haptics } from "../../ui/haptics";
import { EmptyState } from "../../ui/States";
import { useNow } from "../time";
import { errorWords, Note, Problem, useRead } from "./parts";
import { readSkill, restoreSkill } from "./skillsApi";
import { diffChunks, diffSummary, offers, whoOf, type SkillRead } from "./skillsModel";

interface Pair {
  readonly after: SkillRead;
  /** The version before's text; undefined for the first, or one older than the hub keeps. */
  readonly before?: string;
}

export function SkillVersion({ navigation, route }: ChatInfoProps<"SkillVersion">) {
  const t = useTheme();
  const now = useNow();
  const { state, session } = useHub();
  const { key, origin, name, version } = route.params;
  const p = state.projects?.[key];
  const read = useRead(async () => {
    if (p === undefined) return undefined;
    const after = await readSkill(session, p, origin, name, version);
    if (!after.ok) return after;
    const previous = after.value.versions.find((v) => v.version < version);
    if (previous === undefined) return { ok: true as const, value: { after: after.value } as Pair };
    const before = await readSkill(session, p, origin, name, previous.version);
    return before.ok ? { ok: true as const, value: { after: after.value, before: before.value.text } as Pair } : before;
  }, [session, p?.machineId, p?.projectId, origin, name, version]);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const r = read.value;
  if (p === undefined) return <EmptyState icon="folder" title="Not Here" body="The hub doesn't list it any more." />;
  if (r === undefined) return <ActivityIndicator style={styles.loading} color={t.secondary} />;
  if (!r.ok) {
    return (
      <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic">
        <Problem text={`Couldn't read this version: ${errorWords(r.error)}`} />
      </ScrollView>
    );
  }
  const { after, before } = r.value;
  const v = after.versions.find((x) => x.version === version);
  const current = after.versions[0]?.version === version;
  const restorable = !current && offers(after.skill, isYours(p, state.me)).edit && state.hub.phase === "live";
  const chunks = diffChunks(before ?? "", after.text, open);
  const who = v === undefined ? undefined : whoOf(v, state.meName);

  const restore = () => {
    setBusy(true);
    void restoreSkill(session, p, name, version).then((res) => {
      setBusy(false);
      if (!res.ok) return Alert.alert("Couldn't restore it", errorWords(res.error));
      haptics.success();
      navigation.popTo("Skill", { key, origin, name });
    });
  };

  return (
    <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: space.xxl }}>
      <View style={styles.head}>
        {v?.why === undefined ? null : (
          <Text style={[type.title3, { color: t.label }]} selectable>
            {v.why}
          </Text>
        )}
        {v === undefined || who === undefined ? null : (
          <Text style={[type.subhead, { color: t.secondary }]}>
            {who === "you" ? "You" : who}, {fullTime(v.at, now)}
          </Text>
        )}
        {current ? (
          <View style={[styles.pill, { backgroundColor: t.accentSoft }]}>
            <Text style={[type.footnote, styles.pillText, { color: t.accent }]}>Current version</Text>
          </View>
        ) : null}
      </View>

      <Text style={[type.footnote, styles.summary, { color: t.secondary }]}>{before === undefined ? "Its first version" : diffSummary(before, after.text)}</Text>
      <View style={[styles.diff, { backgroundColor: t.cell }]}>
        {chunks.map((c) =>
          c.t === "fold" ? (
            <Pressable
              key={`fold${String(c.from)}`}
              accessibilityRole="button"
              onPress={() => {
                haptics.tap();
                setOpen(new Set([...open, c.from]));
              }}
            >
              {({ pressed }) => (
                <View style={[styles.fold, { backgroundColor: pressed ? t.fill : t.fillQuiet }]}>
                  <Text style={[type.footnote, { color: t.accent }]}>{c.count === 1 ? "1 unchanged line" : `${String(c.count)} unchanged lines`}</Text>
                </View>
              )}
            </Pressable>
          ) : (
            <Line key={c.ix} line={c.line} />
          ),
        )}
      </View>

      {restorable ? (
        <>
          <View style={styles.actions}>
            <Button label="Restore This Version" kind="tinted" size="large" icon="update" busy={busy} disabled={busy} onPress={restore} />
          </View>
          <Note>It comes back as a new version. The versions after it stay in the history.</Note>
        </>
      ) : null}
    </ScrollView>
  );
}

/** Its colors for an added and a removed line, and stronger ones for the words that changed inside it. */
const tones = (t: Palette) =>
  t.dark
    ? { add: "rgba(48,209,88,0.16)", addWord: "rgba(48,209,88,0.38)", del: "rgba(255,69,58,0.16)", delWord: "rgba(255,69,58,0.38)" }
    : { add: "rgba(52,199,89,0.13)", addWord: "rgba(52,199,89,0.34)", del: "rgba(255,59,48,0.09)", delWord: "rgba(255,59,48,0.24)" };

function Line({ line }: { line: DiffLine }) {
  const t = useTheme();
  const c = tones(t);
  const add = line.op === "add";
  const del = line.op === "del";
  const words = line.words;
  return (
    <View style={[styles.line, add && { backgroundColor: c.add }, del && { backgroundColor: c.del }]} accessibilityLabel={`${add ? "Added" : del ? "Removed" : "Unchanged"}: ${line.text}`}>
      <Text style={[styles.gutter, { color: add ? t.success : del ? t.danger : "transparent" }]}>{add ? "+" : del ? "−" : " "}</Text>
      <Text style={[type.subhead, styles.text, { color: line.op === "same" ? t.secondary : t.label }]} selectable>
        {line.text === "" ? " " : words === undefined ? line.text : words.map((w: DiffPiece, i) => <Text key={i} style={w.op === "same" ? null : { backgroundColor: add ? c.addWord : c.delWord }}>{w.text}</Text>)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
  head: { paddingHorizontal: space.lg * 2, paddingTop: space.lg, gap: space.xs },
  pill: { alignSelf: "flex-start", marginTop: space.sm, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 100 },
  pillText: { fontWeight: "600" },
  summary: { marginHorizontal: space.lg * 2, marginTop: space.xl, paddingBottom: 7 },
  diff: { marginHorizontal: space.lg, borderRadius: shape.group, borderCurve: "continuous", overflow: "hidden", paddingVertical: space.sm },
  line: { flexDirection: "row", paddingRight: space.lg, paddingVertical: 2 },
  gutter: { width: 28, textAlign: "center", fontFamily: mono, fontSize: 14, lineHeight: 20 },
  text: { flex: 1 },
  fold: { marginHorizontal: space.sm, marginVertical: space.xs, borderRadius: 10, borderCurve: "continuous", alignItems: "center", paddingVertical: 7 },
  actions: { marginHorizontal: space.lg, marginTop: space.xl },
});
