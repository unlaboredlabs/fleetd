// The lead's turn as one line in the composer island's band (ChatScreen), before the agents' capsule: never a row of
// the conversation, so nothing in it moves as the line comes, changes or goes (D392). While the turn runs: a live glyph
// (thinking walks its ring, anything else is grain), what the lead does now at full strength under the dither scan
// (base.css), after a middle dot what the turn did so far in the quiet tone, and how long it has run, faint, counting.
// Writing the reply is a step like any other, so the line holds through it. A new wording crossfades in place, rising
// a few pixels, and stays at least DWELL_MS, so a passing step doesn't flicker; the count ticks without fading. Once
// the turn ends the line says "Worked for 4s" a moment (the reply keeps it as a stamp, model.ts), then fades; a send
// meanwhile turns it straight into the next turn's words. A screen reader hears the words at most once a second, never
// the count.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { cx, StateGlyph, useBeatRef } from "../../ui";
import { useData } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { useNow } from "../live";
import { leadDid, leadDoing, leadTurnSince, leadTurnUntil, sentenceCase, workedFor } from "./activity";
import type { ProjectRef } from "./slots";
import { InlineText } from "./text";
import s from "./view.module.css";

/** A wording shows at least this long before the next takes its place. */
const DWELL_MS = 380;
/**
 * The line waits this long before it goes, so a turn starting again right away turns it into its words instead; and
 * before it says only "Working" (all the hub knows, as a step ends), so the turn ending just after goes straight there.
 */
const GRACE_MS = 450;
/** How long "Worked for" stays in the band once the turn is over; the reply's stamp keeps it after. */
const HOLD_MS = 3_000;
/** The crossfade (view.module.css .turnLayer), and a frame to spare. */
const FADE_MS = 220;
/** The words a screen reader is told change at most this often. */
const SAY_EVERY_MS = 1_000;

interface Words {
  readonly key: string;
  readonly glyph: "thinking" | "working" | "done";
  /** What it does now, or how long it worked. */
  readonly now: string;
  /** What the turn did so far ("planned a piece of work · started 2 agents"); "" for nothing yet. */
  readonly did: string;
  /** Only "Working": all the hub says, between steps or as one ends. */
  readonly bare?: boolean;
}

export function TurnLine({ project, writing }: { project: ProjectRef; writing: boolean }) {
  const key = projectKey(project);
  const doing = useData((st) => leadDoing(st, key));
  const tally = useData((st) => leadDid(st, key));
  const since = useData((st) => leadTurnSince(st, key));
  const until = useData((st) => leadTurnUntil(st, key));
  const skew = useData((st) => st.live.skewMs ?? 0);
  const running = doing !== undefined;
  // A turn seen running here, by its start: only its end says "Worked for" here, not one long over as the chat opens.
  const [seen, setSeen] = useState<number>();
  if (running && since !== undefined && seen !== since) setSeen(since);
  const over = !running && seen !== undefined && since === seen && until !== undefined;
  const [held, setHeld] = useState<number>();
  useEffect(() => {
    if (!over) return;
    const timer = setTimeout(() => setHeld(seen), HOLD_MS);
    return () => clearTimeout(timer);
  }, [over, seen]);
  const step = running ? (writing ? "writing" : doing) : undefined;
  const worked = over && held !== seen ? workedFor(until - since) : undefined;
  const want = useMemo((): Words | undefined => {
    if (step !== undefined) {
      const glyph = step === "thinking" || step === "planning" ? "thinking" : "working";
      return { key: `${glyph}|${step}|${tally}`, glyph, now: sentenceCase(step), did: tally, bare: step === "working" };
    }
    return worked === undefined ? undefined : { key: `done|${worked}`, glyph: "done", now: `Worked for ${worked}`, did: "" };
  }, [step, tally, worked]);
  const { cur, out, n } = useCrossfade(want);
  const counting = cur !== undefined && cur.glyph !== "done" && since !== undefined && until === undefined;
  const clock = useNow(counting) + skew;
  const count = counting ? workedFor(clock - since) : undefined;
  const told = useThrottled(cur === undefined ? "" : [cur.now, cur.did].filter(Boolean).join(" · "), SAY_EVERY_MS);
  // As wide as what the wording on show says, from nothing as it comes to nothing as it goes (the width glides, so the
  // capsule after it moves aside rather than jumping); narrower than that, its tally ellipsizes.
  const line = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = line.current;
    if (host === null) return;
    const el = sizer.current;
    if (cur === undefined || el === null) return void (host.style.width = "");
    const glyph = host.firstElementChild instanceof HTMLElement ? host.firstElementChild.offsetWidth : 0;
    host.style.width = `${String(glyph + parseFloat(getComputedStyle(host).columnGap) + el.offsetWidth)}px`;
  });
  return (
    <div ref={line} className={s.turnLine} data-turn-line="" data-turn={cur === undefined ? undefined : cur.glyph === "done" ? "done" : "running"}>
      <span className={s.turnGlyph}>
        <StateGlyph state={cur?.glyph ?? out?.glyph ?? "done"} size="sm" />
      </span>
      <span className={s.turnWords} aria-hidden>
        {out === undefined ? null : <Layer key={n - 1} words={out} leaving />}
        {cur === undefined ? null : <Layer key={n} words={cur} count={count} />}
        {/* The wording at its own width, unseen: what the line's width is set from. */}
        {cur === undefined ? null : <Layer ref={sizer} words={cur} count={count} sizer />}
      </span>
      <span className={s.srOnly} role="status">
        {told === "" ? null : <InlineText size="xs" text={told} />}
      </span>
    </div>
  );
}

function Layer({ words, count, leaving = false, sizer = false, ref }: { words: Words; count?: string | undefined; leaving?: boolean; sizer?: boolean; ref?: Ref<HTMLDivElement> }) {
  const done = words.glyph === "done";
  // The scan over what it does now steps on the app's beat, as its glyph does; not while it fades out.
  const scan = useBeatRef<HTMLSpanElement>(!leaving && !sizer && !done);
  return (
    <div ref={ref} className={cx(s.turnLayer, sizer && s.turnSizer)} data-leaving={leaving ? "" : undefined}>
      <span className={s.turnSaid}>
        <span ref={scan} className={cx(s.turnNow, done && s.turnDone)} data-sweep={done || sizer ? undefined : ""}>
          <InlineText size="xs" tone={done ? "quiet" : undefined} text={words.now} />
        </span>
        {words.did === "" ? null : ` · ${words.did}`}
      </span>
      {count === undefined ? null : <span className={s.turnCount}>{count}</span>}
    </div>
  );
}

/**
 * The wording on show and the one fading out under it. A new wording takes its place once the one on show has stayed
 * DWELL_MS (the newest waiting wins); nothing, or a bare "Working" in a step's place, takes it only after GRACE_MS, so a
 * wording followed at once by another never blinks out or flickers between them. `n` counts the wordings, a key for each.
 */
function useCrossfade(want: Words | undefined): { cur: Words | undefined; out: Words | undefined; n: number } {
  const [shown, setShown] = useState<{ cur: Words | undefined; out: Words | undefined; n: number }>(() => ({ cur: want, out: undefined, n: 0 }));
  const at = useRef(0);
  const shownKey = shown.cur?.key;
  // A bare "Working" waits only when it would take a step's place.
  const stepShown = shown.cur !== undefined && shown.cur.glyph !== "done";
  useEffect(() => {
    if (want?.key === shownKey) return;
    const timer = setTimeout(
      () => {
        at.current = Date.now();
        setShown((was) => ({ cur: want, out: was.cur, n: was.n + 1 }));
      },
      want === undefined || (want.bare === true && stepShown) ? GRACE_MS : Math.max(0, at.current + DWELL_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [want, shownKey, stepShown]);
  const fading = shown.out !== undefined;
  useEffect(() => {
    if (!fading) return;
    const timer = setTimeout(() => setShown((was) => ({ ...was, out: undefined })), FADE_MS);
    return () => clearTimeout(timer);
  }, [fading, shown.n]);
  return shown;
}

/** `value`, taking a new one at most once per `every` ms: the newest waiting is taken once the time is up. */
function useThrottled<T>(value: T, every: number): T {
  const [shown, setShown] = useState(value);
  const at = useRef(0);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const timer = setTimeout(
      () => {
        at.current = Date.now();
        setShown(value);
      },
      Math.max(0, at.current + every - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [value, shown, every]);
  return shown;
}
