// The bot in the reply's place, the desktop's own (screens/chat/WakeRow.tsx, its shared/wake.ts): from your send, and
// for as long as its lead works (but while its reply's words stream in where it sat), the bot at the thread's end with
// one quiet line beside it: what the lead does now in plain words (shared/steps.ts) and how long its turn has run
// ("Editing index.html · 0:42"), never dots. A tap on the line opens the turn's last few steps under it, and a second
// folds them. While the lead can't take it, one plain line instead says why; a start that never came, that it didn't start, with Restart Lead beside it. A cloud bot asleep arrives asleep, stirs, and wakes with its computer's steps, one quiet word
// beside it that rises out as the next rises in (ui/motion.ts swapIn and swapOut). A failed try slumps, with one plain
// reason and a Try again that counts down to the start's own retry (on the hub's clock) and goes at once when tapped; a
// tap that starts nothing says why beside it. At the thread's newest end, under the last message.
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import {
  activityLabel,
  askedAt,
  atWork,
  mergeSteps,
  plainStep,
  restartNote,
  stepLabel,
  STIR_MS,
  tryAgainLabel,
  tryAgainNow,
  turnClock,
  useSteady,
  waitingFor,
  wakePose,
  wakeWords,
  workingLine,
  type StepLabel,
  type Wake,
} from "../desktop";
import { useHub } from "../hubContext";
import { refOf, type Key } from "../store";
import { codeRuns, leadActivityOf } from "../turn";
import { mono, space, type, useTheme } from "../theme";
import { Avatar, type Pictured } from "../ui/Avatar";
import { useAnnounceChange } from "../ui/announce";
import { haptics } from "../ui/haptics";
import { swapIn, swapOut, useReduceMotion } from "../ui/motion";
import { restartLead } from "./manage/api";

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
  const working = atWork(wake);
  // Claude's retries too: their plain line comes once they have gone on for a while (RETRY_SAID_MS).
  const ticking = working || wake.phase === "waking" || wake.phase === "failed" || wake.phase === "received";
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
  // What the lead does now in plain words, held steady through its short tool calls; a computer's start is wakeWords'.
  const activity = leadActivityOf(state, chatKey);
  const step = activity === undefined || activity.kind === "starting" ? undefined : activityLabel(activity);
  const doing = useSteady(step, step ?? "", step === undefined);
  // Since its turn began; opened mid-turn, since your message it answers.
  const messages = state.chats[chatKey]?.messages;
  const since = state.turnSince[chatKey] ?? (waitingFor(messages, false) ? askedAt(messages) : undefined);
  const reason = wakeWords(wake, now);
  const said = reason ?? workingLine(wake, doing, since, now);
  const atStep = working && reason === undefined && said !== undefined;
  const [open, setOpen] = useState(false);
  const key = said === undefined ? "" : said.count === undefined || atStep ? said.words : "slow";
  return (
    <Animated.View entering={FadeIn.duration(reduce ? 0 : 360)}>
      <View style={styles.row} accessibilityRole="text" accessibilityLabel={said?.words ?? (wake.phase === "working" || wake.phase === "writing" ? "Working" : "Thinking")}>
        <Avatar name={title} size={BOT_SIZE} picture={picture} bot={wakePose(wake, stirred)} />
        <View style={styles.words}>
          {said === undefined ? null : atStep ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${plainStep(said.words)}. The lead’s steps this turn`}
              accessibilityState={{ expanded: open }}
              hitSlop={space.sm}
              onPress={() => {
                haptics.tap();
                setOpen((o) => !o);
              }}
              style={({ pressed }) => [styles.line, pressed && { backgroundColor: t.fill }]}
            >
              <Animated.View key={key} entering={swapIn(reduce)} exiting={swapOut(reduce)} style={styles.said}>
                <Text style={[type.subhead, { color: t.secondary }]} numberOfLines={1}>
                  <Runs text={said.words} />
                </Text>
              </Animated.View>
              {said.count === undefined ? null : <Text style={[type.subhead, styles.count, { color: t.tertiary }]}>{` · ${said.count}`}</Text>}
            </Pressable>
          ) : (
            <Animated.View key={key} entering={swapIn(reduce)} exiting={swapOut(reduce)} style={styles.said}>
              <Text style={[type.subhead, { color: t.secondary }]} numberOfLines={2}>
                {said.words}
                {said.count === undefined ? null : <Text style={{ color: t.tertiary }}>{`  ${said.count}`}</Text>}
              </Text>
            </Animated.View>
          )}
          {wake.phase === "failed" ? <TryAgain key={`${wake.reason}|${String(wake.retryAt)}`} chatKey={chatKey} wake={wake} now={now} /> : null}
          {wake.phase === "unstarted" ? <RestartLead chatKey={chatKey} /> : null}
        </View>
      </View>
      {open && atStep ? <TurnSteps chatKey={chatKey} since={since} now={now} doing={doing} /> : null}
    </Animated.View>
  );
}

/** A step's words, its machine text (a file's name, a site, in backticks: shared/steps.ts) in the mono voice. */
function Runs({ text }: { text: string }) {
  return (
    <>
      {codeRuns(text).map((r, i) =>
        r.code ? (
          <Text key={i} style={styles.code}>
            {r.text}
          </Text>
        ) : (
          r.text
        ),
      )}
    </>
  );
}

/** The most steps the line opens: the turn's last few. */
const RECENT = 6;

/**
 * The turn's last few steps under the row, oldest first, each in plain words with its time into the turn, the one it
 * is on now last and in full voice: read when opened (agent_work on the lead's thread, from agents_list's lead row),
 * and again as its step moves on.
 */
function TurnSteps({ chatKey, since, now, doing }: { chatKey: Key; since: number | undefined; now: number; doing: string | undefined }) {
  const t = useTheme();
  const { session } = useHub();
  const [steps, setSteps] = useState<readonly (StepLabel & { readonly at: number })[]>();
  useEffect(() => {
    let gone = false;
    void (async () => {
      const agents = await session.call("agents_list", { projectRef: refOf(chatKey) });
      const thread = agents.ok ? agents.output.agents.find((a) => a.role === "lead")?.threadRef : undefined;
      if (thread === undefined) return;
      const work = await session.call("agent_work", { machineId: thread.machineId, threadId: thread.threadId, limit: 40 });
      if (gone || !work.ok) return;
      const labelled = work.output.steps.flatMap((step) => {
        const at = Date.parse(step.at);
        if (step.kind !== "action" || (since !== undefined && at < since)) return [];
        const label = stepLabel(step);
        return label === undefined || label.prose === true ? [] : [{ ...label, at }];
      });
      // In the order they happened; the one running now, which the hub stamps with its start, last.
      const ordered = labelled
        .map((step, i) => ({ step, i }))
        .sort((a, b) => Number(a.step.running === true) - Number(b.step.running === true) || a.step.at - b.step.at || a.i - b.i)
        .map(({ step }) => step);
      setSteps(mergeSteps(ordered).slice(-RECENT) as (StepLabel & { readonly at: number })[]);
    })();
    return () => {
      gone = true;
    };
  }, [session, chatKey, since, doing]);
  const shown = useMemo(() => steps ?? [], [steps]);
  return (
    <Animated.View entering={FadeIn.duration(200)} style={styles.steps}>
      {steps === undefined ? (
        <Text style={[type.footnote, { color: t.secondary }]}>Reading its steps…</Text>
      ) : shown.length === 0 ? (
        <Text style={[type.footnote, { color: t.secondary }]}>{doing ?? "Thinking"}</Text>
      ) : (
        shown.map((step, i) => (
          <View key={`${String(i)}:${step.text}`} style={styles.step}>
            <Text style={[type.footnote, styles.stepText, { color: i === shown.length - 1 ? t.label : t.secondary }]} numberOfLines={1}>
              <Runs text={step.text} />
              {step.failed === undefined ? null : <Text style={{ color: t.danger }}>{` · ${step.failed}`}</Text>}
            </Text>
            {since === undefined ? null : <Text style={[type.footnote, styles.count, { color: t.tertiary }]}>{turnClock(Math.min(step.at, now) - since)}</Text>}
          </View>
        ))
      )}
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

/** Restart Lead, beside a start that never came: the bot's Restart Lead (its Lead Model screen's), and what it came to. */
function RestartLead({ chatKey }: { chatKey: Key }) {
  const t = useTheme();
  const { session } = useHub();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
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
          void restartLead(session, refOf(chatKey)).then((r) => {
            setNote(restartNote(r));
            setBusy(false);
          });
        }}
      >
        <Text style={[type.subhead, styles.act, { color: busy ? t.secondary : t.label }]}>Restart Lead</Text>
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
  line: { flexDirection: "row", alignItems: "baseline", flexShrink: 1, marginLeft: -space.sm, paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: 8 },
  count: { fontVariant: ["tabular-nums"] },
  code: { fontFamily: mono, fontSize: 13 },
  // Under the line, from the words' edge: the bot's width and the gap beside it.
  steps: { marginLeft: BOT_SIZE + space.sm + 2, marginTop: space.xs, marginBottom: space.xs, gap: 6 },
  step: { flexDirection: "row", alignItems: "baseline", gap: space.md },
  stepText: { flexShrink: 1, flexGrow: 1 },
  act: { fontWeight: "600", fontVariant: ["tabular-nums"] },
});
