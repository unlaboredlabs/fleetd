// The lead's turn as one line in the composer island's band (ChatScreen), the agents' capsule's first item while they
// run, else in a capsule of its own: never a row of the conversation, so nothing in it moves as the line comes,
// changes or goes (D392). While the turn runs: a live glyph (thinking walks its ring, anything else is grain), what the lead does now at full strength under the dither scan
// (base.css), after a middle dot what the turn did so far in the quiet tone, and how long it has run, faint, counting.
// Writing the reply is a step like any other, so the line holds through it. A new wording crossfades in place, rising
// a few pixels, and stays at least DWELL_MS, so a passing step doesn't flicker; the count ticks without fading. Once
// the turn ends the line says "Worked for 4s" a moment (the reply keeps it as a stamp, model.ts), then fades; a send
// meanwhile turns it straight into the next turn's words. A screen reader hears the words at most once a second, never
// the count.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { cx, StateGlyph, useBeatRef } from "../../ui";
import { springCurve } from "../../ui/lib/spring";
import { GLIDE } from "./glide";
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
/** The line's edge and what follows it in the row moving to a new width: the chat's growing spring (glide.ts GLIDE). */
const SLIDE = GLIDE.grow;

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
  // As wide as what the wording on show says, from nothing as it comes to nothing as it goes; narrower than that, its
  // tally ellipsizes. Its box takes the new width at once (slide), never animating a layout property.
  const line = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  const wanted = useRef<number>(undefined);
  useLayoutEffect(() => {
    const [host, cl, rw] = [line.current, clip.current, row.current];
    if (host === null || cl === null || rw === null) return;
    const el = sizer.current;
    const glyph = rw.firstElementChild instanceof HTMLElement ? rw.firstElementChild.offsetWidth : 0;
    const want = cur === undefined || el === null ? 0 : glyph + parseFloat(getComputedStyle(rw).columnGap) + Math.ceil(el.getBoundingClientRect().width);
    if (want === wanted.current) return;
    const first = wanted.current === undefined;
    wanted.current = want;
    // Without Web Animations (jsdom), it only takes its width.
    const still = first || typeof host.animate !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches;
    slide(host, cl, rw, want, still);
  });
  return (
    <div
      ref={line}
      className={s.turnLine}
      data-turn-line=""
      data-turn={cur === undefined ? undefined : cur.glyph === "done" ? "done" : "running"}
      // Saying something, or fading out what it said: a lone line's capsule (ChatScreen) stays until its words have gone.
      data-shown={cur === undefined && out === undefined ? undefined : ""}
    >
      <div ref={clip} className={s.turnClip}>
        <div ref={row} className={s.turnRow}>
          <span className={s.turnGlyph}>
            <StateGlyph state={cur?.glyph ?? out?.glyph ?? "done"} size="sm" />
          </span>
          <span className={s.turnWords} aria-hidden>
            {out === undefined ? null : <Layer key={n - 1} words={out} count={count} leaving />}
            {cur === undefined ? null : <Layer key={n} words={cur} count={count} />}
            {/* The wording at its own width, unseen: what the line's width is set from. */}
            {cur === undefined ? null : <Layer ref={sizer} words={cur} count={count} sizer />}
          </span>
        </div>
      </div>
      <span className={s.srOnly} role="status">
        {told === "" ? null : <InlineText size="xs" text={told} />}
      </span>
    </div>
  );
}

/**
 * The line takes `width` at once, and what follows it in its row (the strip's headline, its now-line) is drawn where it
 * was and slides to its new place, on the compositor. The line's words are cut where the next item now starts: its
 * clip is drawn at the old edge and slides with them on the same spring, its row sliding back the other way so the
 * words stay still. A change mid-slide starts from where everything is drawn then.
 */
function slide(host: HTMLElement, clip: HTMLElement, row: HTMLElement, width: number, still: boolean): void {
  const after: HTMLElement[] = [];
  for (let e = host.nextElementSibling; e !== null; e = e.nextElementSibling) if (e instanceof HTMLElement) after.push(e);
  const was = after.map((e) => e.getBoundingClientRect().left);
  const edge = clip.getBoundingClientRect().right - host.getBoundingClientRect().left;
  if (!still) for (const e of [clip, row, ...after]) for (const a of e.getAnimations()) if (a.id === SLIDE_ID) a.cancel();
  host.style.width = `${String(width)}px`;
  // Gone, it gives back the gap after it.
  host.style.marginRight = width === 0 ? "calc(-1 * var(--turn-gap))" : "";
  // At rest the clip and the row follow the line's box (CSS); they are sized here only while they slide.
  const rest = () => {
    clip.style.right = "";
    clip.style.width = "";
    row.style.width = "";
  };
  rest();
  const now = host.offsetWidth;
  if (still || Math.abs(edge - now) < 0.5) return;
  const { ms, ease } = springCurve(SLIDE);
  const timing: KeyframeAnimationOptions = { duration: ms, easing: ease, id: SLIDE_ID };
  for (const [i, e] of after.entries()) {
    const by = (was[i] ?? 0) - e.getBoundingClientRect().left;
    if (Math.abs(by) >= 0.5) e.animate([{ transform: `translateX(${String(by)}px)` }, { transform: "none" }], timing);
  }
  // Drawn as wide as the wider of the two edges for the slide, then as wide as the line.
  const wide = Math.max(edge, now);
  clip.style.right = "auto";
  clip.style.width = `${String(wide)}px`;
  row.style.width = `${String(now)}px`;
  const held = { ...timing, fill: "forwards" } as const;
  const sliding = clip.animate([{ transform: `translateX(${String(edge - wide)}px)` }, { transform: `translateX(${String(now - wide)}px)` }], held);
  const back = row.animate([{ transform: `translateX(${String(wide - edge)}px)` }, { transform: `translateX(${String(wide - now)}px)` }], held);
  sliding.onfinish = () => {
    rest();
    sliding.cancel();
    back.cancel();
  };
}
const SLIDE_ID = "turn-slide";

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
