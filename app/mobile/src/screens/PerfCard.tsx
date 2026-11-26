// A screen's performance on the phone: a slim glass strip under the bar that floats over the page and never moves it,
// with the verdict and the three numbers that say the most (frames shown, round trip, the machine's CPU) over the last
// minute's frames. A tap opens the rest under it, the measures three to a line; a tap on the strip again or anywhere
// outside closes them. The bar's pulse button shows or hides the strip, and the choice holds for every screen
// (screenPerf.ts). Only the strip and the open card take touches: the page beside them is the page's.
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Line, Path } from "react-native-svg";
import { GRAPH_H, GRAPH_W, graphOf, type GraphSecond, type PerfNow } from "../desktop";
import { stripOf } from "../perfStrip";
import { MAX_FPS } from "../screen";
import { space, type, useTheme } from "../theme";
import { Glass } from "../ui/Glass";
import { haptics } from "../ui/haptics";

type Kind = Parameters<typeof stripOf>[1];

/** Frames a second over the last minute, as the desktop's graph: shown, what this phone could have shown (what was
 * made, up to what it draws), and the frames between them filled. */
function Graph({ history, height }: { history: readonly GraphSecond[]; height: number }) {
  const t = useTheme();
  const g = graphOf(history, MAX_FPS);
  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${String(GRAPH_W)} ${String(GRAPH_H)}`} preserveAspectRatio="none">
      <Path d={g.gap} fill={t.warning} fillOpacity={0.3} />
      <Path d={g.target} fill="none" stroke={t.tertiary} strokeWidth={1} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
      <Path d={g.shown} fill="none" stroke={t.label} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </Svg>
  );
}

export function PerfStrip({ now, kind, open, onOpen }: { now: PerfNow | undefined; kind: Kind; open: boolean; onOpen: (open: boolean) => void }) {
  const t = useTheme();
  const { verdict, brief, rows } = stripOf(now, kind);
  const tone = verdict.tone === "success" ? t.success : verdict.tone === "warning" ? t.warning : t.label;
  const toggle = () => {
    haptics.tap();
    onOpen(!open);
  };
  return (
    <Pressable onPress={toggle} accessibilityRole="button" accessibilityLabel={`${verdict.word}. ${verdict.line}${verdict.detail === undefined ? "" : `. ${verdict.detail}`}`} accessibilityHint={open ? "Hides the measures" : "Shows every measure"} accessibilityState={{ expanded: open }}>
          <Glass appear style={[styles.strip, open && styles.stripOpen]}>
            <View style={styles.line}>
              <Text style={[type.footnote, styles.strong, { color: tone }]} numberOfLines={1}>
                {verdict.word}
              </Text>
              <Text style={[type.footnote, styles.brief, { color: t.secondary }]} numberOfLines={1}>
                {brief}
              </Text>
            </View>
            <Graph history={now?.history ?? []} height={14} />
            {!open ? null : (
              <View style={styles.more}>
                <Text style={[type.caption, { color: t.secondary }]}>
                  {verdict.detail === undefined ? verdict.line : `${verdict.line}. ${verdict.detail}.`}
                </Text>
                <View style={styles.grid}>
                  {rows.map((r) => (
                    <View key={r.label} style={styles.cell}>
                      <Text style={[type.caption2, { color: t.secondary }]} numberOfLines={1}>
                        {r.label}
                      </Text>
                      <Text style={[type.footnote, styles.value, { color: r.tone === "warning" ? t.warning : t.label }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                        {r.value}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </Glass>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  strip: { borderRadius: 18, borderCurve: "continuous", paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.sm, gap: 6 },
  stripOpen: { borderRadius: 22, paddingBottom: space.md },
  line: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  strong: { fontWeight: "600" },
  brief: { flex: 1, textAlign: "right", fontVariant: ["tabular-nums"] },
  more: { gap: space.sm, paddingTop: 2 },
  grid: { flexDirection: "row", flexWrap: "wrap", rowGap: space.sm },
  cell: { width: "33.33%", gap: 1, paddingRight: space.sm },
  value: { fontVariant: ["tabular-nums"] },
});
