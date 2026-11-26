// The bot in the reply's place (shared/wake.ts, the person's pick of W792's designs, for every turn since W852, for the
// whole turn since W949): from your send, and for as long as its lead works, the bot at the chat's end in its own look
// thinking or working, and one quiet line beside it: what the lead does now in plain words (shared/steps.ts) and how
// long its turn has run ("Editing index.html · 0:42"). Never anonymous dots. A click or Enter on the line opens the
// turn's last few steps above it, in the same words; a second click, a press outside or Escape closes them. Past
// RETRY_SAID_MS of Claude not serving it, the line says so ("Claude is overloaded, retrying…"). While the lead can't
// take it, one plain line instead says why; a start that never came, that it didn't start, with Restart lead beside
// it. A cloud bot asleep arrives asleep, stirs, and wakes with its computer's steps, one quiet word beside it that rises
// out as the next rises in. A failed try slumps, with one plain reason and a Try again that counts down to the start's
// own retry and goes at once when pressed; a press that starts nothing says why beside it.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { StepLabel } from "../../../shared/steps";
import { plainWords, StepText } from "../agents/StepText";
import { useSteady } from "../../../shared/steady";
import { leadLaneId } from "../../../shared/turnWords";
import { askedAt, atWork, restartNote, STIR_MS, turnClock, tryAgainLabel, tryAgainNow, waitingFor, wakePose, wakeShown, wakeWords, workingLine, type Wake } from "../../../shared/wake";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { projectKey, type DataState, type ProjectKey } from "../../src/data/store";
import { Avatar, Popover, PopoverContent, PopoverTrigger } from "../../ui";
import { usePicture } from "../projects/ProjectAvatar";
import { activityWords, useStepWords } from "../../src/stepWords";
import { leadTurnSince } from "./activity";
import type { ProjectRef } from "./slots";
import { useHubNow, useWake } from "./wake";
import s from "./wake.module.css";

/** The size of the bot in the reply's place: its face reads at a glance, a step under a bubble's line pair. */
const BOT_SIZE = 36;

export function WakeRow({ project, writing }: { project: ProjectRef; writing: boolean }) {
  const key = projectKey(project);
  const wake = useWake(key, writing);
  if (!wakeShown(wake) || wake === undefined) return null;
  return <Woken project={project} wake={wake} />;
}

function Woken({ project, wake }: { project: ProjectRef; wake: Wake }) {
  const key = projectKey(project);
  const summary = useData((d) => d.projects[key]);
  const picture = usePicture(summary);
  const [stirred, setStirred] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setStirred(true), STIR_MS);
    return () => clearTimeout(timer);
  }, []);
  const working = atWork(wake);
  const now = useHubNow(working || wake.phase === "waking" || wake.phase === "failed" || wake.phase === "received");
  const doing = useLeadStep(key);
  // Since its turn began; opened mid-turn, with no start among the events this app has, since your message it answers.
  const since = useData((st) => leadTurnSince(st, key) ?? (waitingFor(st.chats[key]?.messages, false) ? askedAt(st.chats[key]?.messages) : undefined));
  // What holds it up, a slow start or Claude's retries outrank the step: they are what the person needs to know.
  const said = wakeWords(wake, now) ?? workingLine(wake, doing, since, now);
  // A reason, or that the lead didn't start: a line that wraps, not a word that gives way to the next.
  const plain = wake.phase === "held" || wake.phase === "unstarted";
  // The step at work: its words give way to the next, the time beside them counts on.
  const step = working && wakeWords(wake, now) === undefined;
  const words =
    said === undefined ? undefined : step ? (
      <Swap id={said.words}>
        <StepText text={said.words} />
      </Swap>
    ) : (
      <>
        {said.words}
        {said.count === undefined ? null : <span className={s.count}>{said.count}</span>}
      </>
    );
  return (
    <div className={s.row} data-wake={wake.phase} role="status" aria-label={said === undefined ? (wake.phase === "working" || wake.phase === "writing" ? "Working" : "Thinking") : plainWords(said.words)}>
      <span className={s.bot}>
        <Avatar name={summary?.title ?? ""} size={BOT_SIZE} src={picture} bot={wakePose(wake, stirred)} color={summary?.avatarColor} shape={summary?.avatarShape} />
      </span>
      {step && said !== undefined ? (
        <TurnSteps project={project} since={since} now={now} doing={doing}>
          {words}
          {said.count === undefined ? null : <span className={s.clock}>{said.count}</span>}
        </TurnSteps>
      ) : (
        <span className={plain ? s.reason : s.words}>
          {words === undefined ? null : plain ? words : <Swap id={said?.count === undefined ? (said?.words ?? "") : "slow"}>{words}</Swap>}
          {wake.phase === "failed" ? <TryAgain key={`${wake.reason}|${String(wake.retryAt)}`} project={project} wake={wake} now={now} /> : null}
          {wake.phase === "unstarted" ? <RestartLead project={project} /> : null}
        </span>
      )}
    </div>
  );
}

const refOf = (key: ProjectKey) => {
  const at = key.indexOf("/");
  return { machineId: key.slice(0, at), projectId: key.slice(at + 1) };
};
const leadActivityOf = (st: DataState, key: ProjectKey) => st.live.lanes[leadLaneId(refOf(key))]?.activity?.activity;

/** What the lead does now in plain words, held steady through its short tool calls (shared/steady.ts); undefined while
 * it only thinks. */
function useLeadStep(key: ProjectKey): string | undefined {
  const activity = useData((st) => leadActivityOf(st, key));
  // Drawn again once the words load, a moment after the first paint (src/stepWords.ts).
  useStepWords();
  // A computer's start is the wake's own to say (wakeWords), never held over as a step.
  const now = activity === undefined || activity.kind === "starting" ? undefined : activityWords(activity);
  return useSteady(now, now ?? "", now === undefined);
}

/** The line as a button: pressed, the turn's last few steps open above it (TurnSteps.tsx). */
function TurnSteps({ project, since, now, doing, children }: { project: ProjectRef; since: number | undefined; now: number; doing: string | undefined; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={s.line} aria-label={open ? "Hide the lead’s steps" : "The lead’s steps this turn"}>
          {children}
        </button>
      </PopoverTrigger>
      {/* Nothing in it to press: focus stays on the line, which Escape or a second press closes it from. */}
      <PopoverContent side="top" align="start" className={s.steps} aria-label="The lead’s steps this turn" onOpenAutoFocus={(e) => e.preventDefault()}>
        {open ? <RecentSteps project={project} since={since} now={now} doing={doing} /> : null}
      </PopoverContent>
    </Popover>
  );
}

/** The most steps the line opens: the turn's last few, the rest on the lead's own page. */
const RECENT = 6;
const ALL = {} as const;
const NO_THREAD = { machineId: "", threadId: "" };

/** The turn's last few steps, oldest first, the one it is on now last and in full voice. */
function RecentSteps({ project, since, now, doing }: { project: ProjectRef; since: number | undefined; now: number; doing: string | undefined }) {
  useToolQuery("agents_list", ALL);
  const lane = leadLaneId(project);
  const thread = useData((st) => st.agents?.find((r) => r.laneId === lane)?.threadRef);
  const work = useToolQuery("agent_work", thread === undefined ? NO_THREAD : { machineId: thread.machineId, threadId: thread.threadId, limit: 40 }, { enabled: thread !== undefined });
  const { refetch } = work;
  // Its step moved on while open: read again, so the list ends where the line does.
  useEffect(() => {
    if (thread !== undefined) void refetch();
  }, [doing, thread, refetch]);
  const words = useStepWords();
  const steps = useMemo((): readonly (StepLabel & { readonly at?: number })[] | undefined => {
    const all = work.data?.steps;
    if (all === undefined || words === undefined) return undefined;
    const { mergeSteps, stepLabel } = words;
    const labelled = all.flatMap((step) => {
      const at = Date.parse(step.at);
      // This turn's, and what it did: its own words are in the chat, and its thoughts are for its page.
      if (step.kind !== "action" || (since !== undefined && at < since)) return [];
      const label = stepLabel(step);
      return label === undefined || label.prose === true ? [] : [{ ...label, at }];
    });
    // In the order they happened; the one running now, which the hub stamps with its start, last.
    const ordered = labelled
      .map((step, i) => ({ step, i }))
      .sort((a, b) => Number(a.step.running === true) - Number(b.step.running === true) || a.step.at - b.step.at || a.i - b.i)
      .map(({ step }) => step);
    return mergeSteps(ordered).slice(-RECENT);
  }, [work.data, since, words]);
  // Nothing to read yet (no thread known, or none taken this turn): what it does now, as the line says.
  if (steps === undefined && thread !== undefined) return <div className={s.stepsNote} aria-busy="true">Reading its steps…</div>;
  if (steps === undefined) return <div className={s.stepsNote}>{doing ?? "Thinking"}</div>;
  if (steps.length === 0) return <div className={s.stepsNote}>{doing ?? "Thinking"}</div>;
  return (
    <ol className={s.stepList}>
      {steps.map((step, i) => (
        <li key={`${String(i)}:${step.text}`} className={s.stepItem} data-failed={step.failed === undefined ? undefined : ""} title={step.raw ?? plainWords(step.text)}>
          <span className={s.stepText}>
            <StepText text={step.text} />
          </span>
          {step.failed === undefined ? null : <span className={s.stepFailed}>{step.failed}</span>}
          <span className={s.stepAt}>{since === undefined || step.at === undefined ? null : turnClock(Math.min(step.at, now) - since)}</span>
        </li>
      ))}
    </ol>
  );
}

/** Try again: the start's waiting try goes now. A press that started nothing says why beside it (shared/wake.ts tryAgainNote). */
function TryAgain({ project, wake, now }: { project: ProjectRef; wake: Extract<Wake, { phase: "failed" }>; now: number }) {
  const layer = useDataLayer();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  return (
    <>
      <button
        type="button"
        className={s.act}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setNote(undefined);
          void tryAgainNow(() => layer.call("chat_start_now", { projectRef: project })).then((said) => {
            setNote(said);
            setBusy(false);
          });
        }}
      >
        {tryAgainLabel(wake, now)}
      </button>
      {note === undefined ? null : (
        <span className={s.note} role="status">
          {note}
        </span>
      )}
    </>
  );
}

/** Restart lead, beside a start that never came: the lead's Restart lead (project_set leadRestart), and what it came to. */
function RestartLead({ project }: { project: ProjectRef }) {
  const layer = useDataLayer();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  return (
    <>
      <button
        type="button"
        className={s.act}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setNote(undefined);
          void layer
            .call("project_set", { ...project, leadRestart: true })
            .then(restartNote, (error: unknown) => restartNote({ ok: false, error: { message: error instanceof Error ? error.message : String(error) } }))
            .then((said) => {
              setNote(said);
              setBusy(false);
            });
        }}
      >
        Restart lead
      </button>
      {note === undefined ? null : (
        <span className={s.note} role="status">
          {note}
        </span>
      )}
    </>
  );
}

/** Words that give way to the next: the old rise out as the new rise in, on the spring. `id` names what they say. */
function Swap({ id, children }: { id: string; children: ReactNode }) {
  const [shown, setShown] = useState<{ id: string; node: ReactNode; old?: { id: string; node: ReactNode } | undefined }>({ id, node: children });
  if (shown.id !== id) setShown({ id, node: children, old: { id: shown.id, node: shown.node } });
  else if (shown.node !== children) setShown({ ...shown, node: children });
  const leaving = shown.old?.id;
  useEffect(() => {
    if (leaving === undefined) return;
    const timer = setTimeout(() => setShown((x) => ({ id: x.id, node: x.node })), 420);
    return () => clearTimeout(timer);
  }, [leaving]);
  return (
    <span className={s.swap}>
      {shown.old === undefined ? null : (
        <span key={`old:${shown.old.id}`} className={s.out} aria-hidden>
          {shown.old.node}
        </span>
      )}
      <span key={shown.id} className={shown.old === undefined ? undefined : s.in}>
        {shown.node}
      </span>
    </span>
  );
}
