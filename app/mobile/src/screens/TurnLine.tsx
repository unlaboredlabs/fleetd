// The lead's turn as one line over the composer, the desktop's own (screens/chat/TurnLine.tsx): never a row of the
// thread, so nothing in it moves as the line comes, changes or goes (D392). While the turn runs: a live glyph (thinking
// walks its ring, anything else is grain), what the lead does now in the desktop's words under its dither scan, and how
// long the turn has run, faint, counting. Writing the reply is a step like any other, so the line holds through it. A
// new wording crossfades in place, rising a few points, and stays at least DWELL_MS, so a passing step doesn't flicker;
// the count ticks without fading. Once the turn ends the line says "Worked for 4s" a moment (the reply keeps the time
// it took with its own, a drag left away: ui/Reveal.tsx), then fades. VoiceOver hears it turn from thinking to working
// and back, never each tick. Off screen (`still`) the glyph holds still, and the scan and the count stop.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useDerivedValue, useSharedValue } from "react-native-reanimated";
import { sentenceCase, workedFor } from "../desktop";
import { LOOP_BEATS } from "../glyph";
import { useHub } from "../hubContext";
import type { Key } from "../store";
import { mono, space, type, useTheme } from "../theme";
import { codeRuns, leadActivityOf, SWEEP, SWEEP_WIDTH, turnView } from "../turn";
import { useAnnounceChange } from "../ui/announce";
import { swapIn, swapOut, useBeat, useReduceMotion } from "../ui/motion";
import { GLYPH_SIZE, StateGlyph } from "../ui/StateGlyph";

/** The line's height; the thread keeps this much room over the composer for it, always, so it never moves for it. */
export const TURN_LINE_HEIGHT = 20;
/** A wording shows at least this long before the next takes its place. */
const DWELL_MS = 380;
/** The line waits this long before it goes, so a turn starting again right away turns it into its words instead. */
const GRACE_MS = 450;
/** How long "Worked for" stays over the composer once the turn is over; the reply's time column keeps it after. */
const HOLD_MS = 3_000;

interface Words {
  readonly key: string;
  readonly glyph: "thinking" | "working" | "done";
  /** What it does now, or how long it worked. */
  readonly now: string;
}

export function TurnLine({ chatKey, writing, still }: { chatKey: Key; writing: boolean; still: boolean }) {
  // The hub's state, which only this line reads: the thread doesn't draw again with it.
  const { state } = useHub();
  const running = state.chatStates[chatKey]?.leadWorking === true;
  const activity = leadActivityOf(state, chatKey);
  const since = state.turnSince[chatKey];
  const ended = state.turnWorked[chatKey];
  const theme = useTheme();
  const reduce = useReduceMotion();
  // A turn seen running here, by its start: only its end says "Worked for" here, not one long over as the chat opens.
  const [seen, setSeen] = useState<number>();
  if (running && since !== undefined && seen !== since) setSeen(since);
  const over = !running && ended !== undefined && ended.since === seen;
  const [held, setHeld] = useState<number>();
  useEffect(() => {
    if (!over) return;
    const timer = setTimeout(() => setHeld(seen), HOLD_MS);
    return () => clearTimeout(timer);
  }, [over, seen]);
  const view = running ? turnView(writing ? { kind: "writing" } : activity, since, 0) : undefined;
  const worked = over && held !== seen ? workedFor(ended.until - ended.since) : undefined;
  const glyph = view?.glyph;
  const now = view?.now;
  const want = useMemo((): Words | undefined => {
    if (glyph !== undefined && now !== undefined) return { key: `${glyph}|${now}`, glyph, now };
    return worked === undefined ? undefined : { key: `done|${worked}`, glyph: "done", now: `Worked for ${worked}` };
  }, [glyph, now, worked]);
  const { cur, n } = useShown(want);
  const [nowMs, setNow] = useState(() => Date.now());
  const counting = cur !== undefined && cur.glyph !== "done" && running && since !== undefined && !still;
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);
  const count = cur !== undefined && cur.glyph !== "done" && running && since !== undefined ? workedFor(nowMs - since) : undefined;
  // Said as it turns from thinking to working and back, and as it ends, not at each step or second, nor as the chat opens.
  useAnnounceChange(cur === undefined ? undefined : cur.glyph === "thinking" ? "Thinking" : cur.glyph === "done" ? cur.now : "Working");
  return (
    <View style={styles.line} pointerEvents="none">
      {cur === undefined ? null : (
        <Animated.View
          key={n}
          entering={swapIn(reduce)}
          exiting={swapOut(reduce)}
          // A soft patch of the thread's ground behind it keeps it legible over the thread scrolled up.
          style={[styles.layer, { backgroundColor: theme.thread, shadowColor: theme.thread }]}
          accessible
          accessibilityRole="text"
          accessibilityLabel={cur.now}
        >
          <Layer words={cur} count={count} still={still} />
        </Animated.View>
      )}
    </View>
  );
}

function Layer({ words, count, still }: { words: Words; count: string | undefined; still: boolean }) {
  const theme = useTheme();
  const done = words.glyph === "done";
  return (
    <>
      <View style={styles.glyph}>
        <StateGlyph state={words.glyph} still={still} />
      </View>
      <Swept still={still || done}>
        <Text style={[type.footnote, styles.now, done ? { color: theme.secondary, fontWeight: "400" } : { color: theme.label }]} numberOfLines={1}>
          {codeRuns(words.now).map((r, i) =>
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
      {count === undefined ? null : <Text style={[type.footnote, styles.text, styles.count, { color: theme.tertiary }]}>{count}</Text>}
    </>
  );
}

/**
 * The wording on show. A new one takes its place once it has stayed DWELL_MS (the newest waiting wins); nothing takes
 * its place only after GRACE_MS, so a wording followed at once by another never blinks out between them. `n` counts
 * the wordings, a key for each, so the one before leaves as the next comes.
 */
function useShown(want: Words | undefined): { cur: Words | undefined; n: number } {
  const [shown, setShown] = useState<{ cur: Words | undefined; n: number }>(() => ({ cur: want, n: 0 }));
  const at = useRef(0);
  const shownKey = shown.cur?.key;
  useEffect(() => {
    if (want?.key === shownKey) return;
    const timer = setTimeout(
      () => {
        at.current = Date.now();
        setShown((was) => ({ cur: want, n: was.n + 1 }));
      },
      want === undefined ? GRACE_MS : Math.max(0, at.current + DWELL_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [want, shownKey]);
  return shown;
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
  line: { height: TURN_LINE_HEIGHT },
  layer: {
    position: "absolute",
    top: 0,
    left: 0,
    maxWidth: "100%",
    height: TURN_LINE_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    borderRadius: 6,
    shadowOpacity: 1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  glyph: { width: GLYPH_SIZE, alignItems: "center" },
  swept: { flexShrink: 1, overflow: "hidden" },
  text: { lineHeight: TURN_LINE_HEIGHT },
  now: { fontWeight: "500", lineHeight: TURN_LINE_HEIGHT },
  code: { fontFamily: mono, fontSize: 12 },
  count: { fontVariant: ["tabular-nums"] },
  band: { position: "absolute", top: 0, bottom: 0, left: 0 },
});
