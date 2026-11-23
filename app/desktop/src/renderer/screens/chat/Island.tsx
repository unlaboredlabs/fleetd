// The island over the composer (W651): one small glass capsule, centred in the band, as wide as what it says. What the
// lead does now, in words only when they say more than its avatar's motion does ("Reading `rounding.ts`", never a bare
// "Thinking"), else its glyph alone while nothing else in it says work, so it is drawn whenever the composer shows Stop
// (W669; while the bot stands in the reply's place, WakeRow.tsx, only words: the bot says the rest); a glyph per agent at work (three at most, those waiting on you first, in the attention color) and how many;
// a red dot while main is red. Nothing to say, nothing drawn. A click (or Enter) opens a card above it: main's
// reason in full, a row per agent (live/Lanes), and the count of the agents' DMs, a way to Activity's log of them; a
// second click, a press outside or Escape closes it. With none of those (the lead's step alone), it is no button. A file name too long for the room is cut once, in the middle.
import { useId, useLayoutEffect, useRef, useState, useEffect } from "react";
import { useSteady } from "../../../shared/steady";
import { cx, InlineCode, StateGlyph, Text, type GlyphState } from "../../ui";
import { useData } from "../../src/data/react";
import { leadLaneId, selectLeadAtWork } from "../../src/data/selectors";
import { projectKey } from "../../src/data/store";
import { useDmTotal } from "../dms/hooks";
import { countWords } from "../dms/model";
import { HubText } from "../projects/HubText";
import { panelRoute, toHash } from "../shell/routes";
import { Lanes, middleEllipsis, selectStrip, stripHeadline, useSteadyLine, type Strip, type StripAgent } from "../live";
import { leadDoing, sentenceCase } from "./activity";
import type { ProjectRef } from "./slots";
import s from "./island.module.css";
import { wakeShown } from "../../../shared/wake";
import { useWake } from "./wake";

/** Steps the lead's avatar already says by its motion: the island says nothing for them. */
const BARE = new Set(["working", "thinking", "writing"]);

/** Agents past this many are only in the count. */
const MAX_GLYPHS = 3;

const GLYPH: Readonly<Record<StripAgent["state"], GlyphState>> = { working: "working", needsYou: "waiting", onHold: "paused", queued: "queued" };

export function Island({ project, warning }: { project: ProjectRef; warning: string | undefined }) {
  const loaded = useData(selectStrip(project));
  const strip = loaded === undefined || loaded.agents === 0 ? undefined : loaded;
  // A computer's start is the bot's in the reply's place to say (WakeRow.tsx): never held here, so it can't linger once
  // the wake is over.
  const starting = useData((st) => st.live.lanes[leadLaneId(project)]?.activity?.activity.kind === "starting");
  const said = useData((st) => leadDoing(st, projectKey(project)));
  const now = starting && said !== undefined ? "working" : said;
  // Held steady through its short tool calls (shared/steady.ts); thinking, or working with nothing more known, is the
  // quiet state between them.
  const doing = useSteady(now, now ?? "", now === undefined || now === "thinking" || now === "working");
  // The bot in the reply's place (WakeRow.tsx) says the lead is on it, so its bare glyph here would repeat it; a step
  // in words says more, and stays.
  const waking = wakeShown(useWake(projectKey(project)));
  const step = doing === undefined || BARE.has(doing) ? undefined : sentenceCase(doing);
  // The lead at work, as the composer's Stop has it (live, or last known offline), with no words and no agents' glyphs
  // to say so: its glyph, still while offline.
  const atWork = useData(selectLeadAtWork(projectKey(project)));
  const lead = waking || atWork === undefined || step !== undefined || strip !== undefined ? undefined : atWork;
  const dms = countWords(useDmTotal(project));
  // The card has something to show: the agents, main's reason or the agents' DMs. Without, the island is no button.
  const opens = strip !== undefined || warning !== undefined || dms !== undefined;
  const box = useRef<HTMLDivElement>(null);
  const cardId = useId();
  const [open, setOpen] = useState(false);
  // Open, a press anywhere outside the island closes it.
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && !box.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  if (strip === undefined && step === undefined && lead === undefined && warning === undefined) return null;
  const leadLabel = lead === undefined ? undefined : sentenceCase(doing ?? "working");
  const label = [step ?? leadLabel, strip === undefined ? undefined : stripHeadline(strip), warning === undefined ? undefined : "main is red"].filter(Boolean).join(" · ");
  const close = () => setOpen(false);
  const says = (
    <>
      {step === undefined ? null : <Step words={step} />}
      {lead === undefined ? null : (
        <span className={s.glyph}>
          <StateGlyph state={doing === "thinking" ? "thinking" : "working"} size="sm" still={lead === "held"} />
        </span>
      )}
      {strip === undefined ? null : <Fleet strip={strip} />}
      {warning === undefined ? null : <span className={s.red} aria-hidden />}
    </>
  );
  return (
    <div
      ref={box}
      className={s.island}
      data-island=""
      data-fit={step?.includes("`") === true ? "" : undefined}
      data-open={open ? "" : undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      {opens ? (
        <button type="button" className={s.press} aria-label={label} aria-expanded={open} aria-controls={open ? cardId : undefined} onClick={() => setOpen((o) => !o)}>
          {says}
        </button>
      ) : (
        <span className={s.press} role="group" aria-label={label} data-still="">
          {says}
        </span>
      )}
      {open && opens ? <Card id={cardId} strip={strip} warning={warning} dms={dms} project={project} onClose={close} /> : null}
    </div>
  );
}

/** The lead's step: its words, then a file name as code, which alone gives way to a narrow band. */
function Step({ words }: { words: string }) {
  const at = words.indexOf("`");
  const end = words.lastIndexOf("`");
  if (at === -1 || end <= at) return <span className={s.words}>{words}</span>;
  return (
    <span className={s.step}>
      <span className={s.words}>{words.slice(0, at).trimEnd()}</span>
      <FitName name={words.slice(at + 1, end)} />
    </span>
  );
}

let measure: CanvasRenderingContext2D | null | undefined;
/** The width of one character of `el`'s (monospaced) font. */
const charWidth = (el: HTMLElement): number => {
  measure ??= document.createElement("canvas").getContext("2d");
  if (!measure) return 7;
  measure.font = getComputedStyle(el).font;
  return measure.measureText("0000000000").width / 10 || 7;
};

/** The fewest characters a cut name keeps: its start, an ellipsis and its end. */
const MIN_CHARS = 9;

/**
 * A name as code, as wide as it is whole (an unseen copy holds that width), cut once in the middle to the room the
 * island has, so it never ends mid-word and both its start and its extension show.
 */
function FitName({ name }: { name: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState<number>();
  useLayoutEffect(() => {
    const el = ref.current;
    const code = el?.firstElementChild;
    if (!el || !(code instanceof HTMLElement)) return;
    const pad = parseFloat(getComputedStyle(code).paddingLeft) + parseFloat(getComputedStyle(code).paddingRight);
    // Never narrower than its fewest characters, so the cut copy is never clipped; nor the island narrower than
    // everything else it says and that.
    const least = Math.ceil(pad + MIN_CHARS * charWidth(code));
    el.style.minWidth = `${String(least)}px`;
    const island = el.closest<HTMLElement>("[data-island]");
    const press = island?.firstElementChild;
    const ro = new ResizeObserver(() => {
      setFits(Math.max(MIN_CHARS, Math.floor((el.clientWidth - pad) / charWidth(code))));
      if (!island || !(press instanceof HTMLElement)) return;
      // Hidden in a band too narrow for the step (island.module.css), the name sets no floor.
      island.style.minWidth = el.offsetWidth === 0 ? "" : `${String(Math.ceil(press.offsetWidth - el.offsetWidth + least))}px`;
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (island) island.style.minWidth = "";
    };
  }, []);
  const shown = fits === undefined ? name : middleEllipsis(name, fits);
  return (
    <span ref={ref} className={s.name} title={shown === name ? undefined : name}>
      <InlineCode>{name}</InlineCode>
      <InlineCode>{shown}</InlineCode>
    </span>
  );
}

/** The agents at work: a glyph each, a few at most, then how many. */
function Fleet({ strip }: { strip: Strip }) {
  return (
    <span className={s.fleet}>
      <span className={s.glyphs}>
        {strip.lanes.slice(0, MAX_GLYPHS).map((a, i) => (
          <FleetGlyph key={a.laneId} agent={a} phase={i} />
        ))}
      </span>
      <span className={s.count}>{strip.agents}</span>
    </span>
  );
}

/** One agent's glyph: thinking walks its ring, a tool's work is grain, held steady as its row's line is. */
function FleetGlyph({ agent, phase }: { agent: StripAgent; phase: number }) {
  const line = useSteadyLine(agent.line);
  return (
    <span className={cx(s.glyph, agent.state === "needsYou" && s.needs)}>
      <StateGlyph state={agent.state === "working" && line.thinking ? "thinking" : GLYPH[agent.state]} size="sm" phase={phase} />
    </span>
  );
}

/**
 * Opened above the island: main's reason in full, the agents a row each, and the agents' DMs. With the DMs alone, a
 * capsule like the island, centred over it, not a card as wide as the composer around one line.
 */
function Card({ id, project, strip, warning, dms, onClose }: { id: string; project: ProjectRef; strip: Strip | undefined; warning: string | undefined; dms: string | undefined; onClose: () => void }) {
  const only = strip === undefined && warning === undefined;
  return (
    <div id={id} className={s.card} data-island-card="" data-only={only ? "" : undefined}>
      {warning === undefined ? null : (
        <p className={s.reason}>
          <span className={s.red} aria-hidden />
          <Text size="xs" tone="inherit">
            <HubText>{warning}</HubText>
          </Text>
        </p>
      )}
      {strip === undefined ? null : <Lanes id={`${id}-lanes`} project={project} strip={strip} onOpened={onClose} />}
      {dms === undefined ? null : (
        <a className={s.dms} href={toHash(panelRoute(project, { tab: "activity", dms: true }))} onClick={onClose}>
          {dms}
        </a>
      )}
    </div>
  );
}
