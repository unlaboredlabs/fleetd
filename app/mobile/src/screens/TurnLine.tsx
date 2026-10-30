// The turn line that ends a chat's thread while its lead works, in place of a typing bubble: the desktop's own
// (screens/chat/ChatList.tsx LeadActivity). A live glyph (thinking walks its ring, anything else is grain), what the
// lead does now in the desktop's words under its dither scan, and how long the turn has run, faint, counting. The words
// change at most once a second; the count is apart from them, so VoiceOver isn't told each tick. Off screen (`still`)
// the glyph holds still, and the scan and the count stop.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useDerivedValue, useSharedValue } from "react-native-reanimated";
import { LOOP_BEATS } from "../glyph";
import { useHub } from "../hubContext";
import type { Key } from "../store";
import { mono, space, type, useTheme } from "../theme";
import { codeRuns, leadActivityOf, SWEEP, SWEEP_WIDTH, turnView } from "../turn";
import { useBeat, useReduceMotion } from "../ui/motion";
import { GLYPH_SIZE, StateGlyph } from "../ui/StateGlyph";

/** The lead's activity changes with its frames; the line takes a new value at most once a second. */
const ACTIVITY_EVERY_MS = 1000;

export function TurnLine({ chatKey, still }: { chatKey: Key; still: boolean }) {
  const t = useTheme();
  // The hub's state, which a row reads only here: the rest of the thread doesn't draw again with it.
  const { state } = useHub();
  const activity = leadActivityOf(state, chatKey);
  const since = state.turnSince[chatKey];
  const [shown, setShown] = useState(activity);
  const at = useRef(0);
  useEffect(() => {
    if (activity === shown) return;
    const timer = setTimeout(
      () => {
        at.current = Date.now();
        setShown(activity);
      },
      Math.max(0, at.current + ACTIVITY_EVERY_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [activity, shown]);
  const [nowMs, setNow] = useState(() => Date.now());
  const counting = since !== undefined && !still;
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);
  const line = turnView(shown, since, nowMs);
  return (
    <View style={styles.turn} accessible accessibilityRole="text" accessibilityLabel={line.now} accessibilityLiveRegion="polite">
      <View style={styles.glyph}>
        <StateGlyph state={line.glyph} still={still} />
      </View>
      <Swept still={still}>
        <Text style={[type.footnote, styles.now, { color: t.label }]} numberOfLines={1}>
          {codeRuns(line.now).map((r, i) =>
            r.code ? (
              <Text key={i} style={styles.code}>
                {r.text}
              </Text>
            ) : (
              r.text
            ),
          )}
        </Text>
      </Swept>
      {line.count === undefined ? null : <Text style={[type.footnote, styles.count, { color: t.tertiary }]}>{line.count}</Text>}
    </View>
  );
}

/** Words under the desktop's dither scan: a checkered band of the thread's ground that steps across them on the beat. */
function Swept({ still, children }: { still: boolean; children: ReactNode }) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const moving = !still && !reduce;
  const beat = useBeat(moving);
  const width = useSharedValue(0);
  const step = useDerivedValue(() => Math.floor(beat.value) % LOOP_BEATS);
  const band = useAnimatedStyle(() => {
    const w = width.value * SWEEP_WIDTH;
    return { width: w, transform: [{ translateX: (SWEEP[step.value] ?? SWEEP[0]) * w }] };
  });
  return (
    <View style={styles.swept} onLayout={(e) => (width.value = e.nativeEvent.layout.width)}>
      {children}
      {moving ? (
        <Animated.View pointerEvents="none" style={[styles.band, band]}>
          <Image source={require("../../assets/dither.png")} resizeMode="repeat" tintColor={t.thread} style={StyleSheet.absoluteFill} />
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  turn: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: 10, paddingLeft: space.md, paddingRight: 56 },
  glyph: { width: GLYPH_SIZE, alignItems: "center" },
  swept: { flexShrink: 1, overflow: "hidden" },
  now: { fontWeight: "500" },
  code: { fontFamily: mono, fontSize: 12 },
  count: { fontVariant: ["tabular-nums"] },
  band: { position: "absolute", top: 0, bottom: 0, left: 0 },
});
