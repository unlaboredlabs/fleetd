// The bot in the reply's place, the desktop's own (screens/chat/WakeRow.tsx, its shared/wake.ts): from your send until
// the reply's first words show where it sat, or the turn ends without one, the bot under your message with the lead's
// typing bubble beside it, as a person's avatar and dots in Messages; while the lead can't take it, one plain line
// instead says why. A cloud bot asleep arrives asleep, stirs, and wakes with its computer's steps, one quiet word
// beside it that rises out as the next rises in (ui/motion.ts swapIn and swapOut). A failed try slumps, with one plain
// reason and a Try again that counts down to the start's own retry (on the hub's clock) and goes at once when tapped; a
// tap that starts nothing says why beside it. At the thread's newest end, under the last message.
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { STIR_MS, tryAgainLabel, tryAgainNow, wakeDots, wakePose, wakeWords, type Wake } from "../desktop";
import { useHub } from "../hubContext";
import { refOf, type Key } from "../store";
import { space, type, useTheme } from "../theme";
import { Avatar, type Pictured } from "../ui/Avatar";
import { useAnnounceChange } from "../ui/announce";
import { haptics } from "../ui/haptics";
import { swapIn, swapOut, useReduceMotion } from "../ui/motion";
import { TypingDots } from "../ui/TypingDots";

/** The bot's size in the reply's place: its face reads at a glance, a step under a bubble's line pair. */
const BOT_SIZE = 36;

export function WakeRow({ chatKey, wake, title, picture }: { chatKey: Key; wake: Wake; title: string; picture: Pictured | undefined }) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const [stirred, setStirred] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setStirred(true), STIR_MS);
    return () => clearTimeout(timer);
  }, []);
  const ticking = wake.phase === "waking" || wake.phase === "failed" || wake.phase === "received";
  // Timed on the hub's clock, as its start's times are (store.ts skewMs).
  const { state } = useHub();
  const skew = state.skewMs ?? 0;
  const [local, setNow] = useState(() => Date.now());
  const now = local + skew;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const said = wakeWords(wake, now);
  const key = said === undefined ? "" : said.count === undefined ? said.words : "slow";
  return (
    <Animated.View
      entering={FadeIn.duration(reduce ? 0 : 360)}
      style={styles.row}
      accessibilityRole="text"
      accessibilityLabel={said?.words ?? (wake.phase === "working" || wake.phase === "writing" ? "Working" : "Thinking")}
    >
      <Avatar name={title} size={BOT_SIZE} picture={picture} bot={wakePose(wake, stirred)} />
      {wakeDots(wake) ? <TypingDots label={wake.phase === "working" ? "The lead is working" : "The lead is thinking"} /> : null}
      <View style={styles.words}>
        {said === undefined ? null : (
          <Animated.View key={key} entering={swapIn(reduce)} exiting={swapOut(reduce)} style={styles.said}>
            <Text style={[type.subhead, { color: t.secondary }]} numberOfLines={2}>
              {said.words}
              {said.count === undefined ? null : <Text style={{ color: t.tertiary }}>{`  ${said.count}`}</Text>}
            </Text>
          </Animated.View>
        )}
        {wake.phase === "failed" ? <TryAgain key={`${wake.reason}|${String(wake.retryAt)}`} chatKey={chatKey} wake={wake} now={now} /> : null}
      </View>
    </Animated.View>
  );
}

/** Try again: the start's waiting try goes now. A tap that started nothing says why beside it (tryAgainNote). */
function TryAgain({ chatKey, wake, now }: { chatKey: Key; wake: Extract<Wake, { phase: "failed" }>; now: number }) {
  const t = useTheme();
  const { session } = useHub();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  // VoiceOver hears it as Android's live region does.
  useAnnounceChange(note);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        hitSlop={space.sm}
        onPress={() => {
          haptics.tap();
          setBusy(true);
          setNote(undefined);
          void tryAgainNow(() => session.call("chat_start_now", { projectRef: refOf(chatKey) })).then((said) => {
            setNote(said);
            setBusy(false);
          });
        }}
      >
        <Text style={[type.subhead, styles.act, { color: busy ? t.secondary : t.label }]}>{tryAgainLabel(wake, now)}</Text>
      </Pressable>
      {note === undefined ? null : (
        <Text style={[type.subhead, { color: t.secondary }]} accessibilityLiveRegion="polite">
          {note}
        </Text>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.sm + 2, paddingTop: space.sm, paddingBottom: space.xs },
  words: { flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: space.sm + 2 },
  said: { flexShrink: 1 },
  act: { fontWeight: "600", fontVariant: ["tabular-nums"] },
});
