// One browser session, in the panel's wide width. While it runs: the page as the agent sees it, what the agent is
// doing now, Take over, and its steps as they come. Taken over, the page is yours: the frame's bar turns to say so,
// your clicks and keys go to the page, and Hand back gives it to the agent, which looks at the page again and goes
// on; meanwhile it waits, and its line says so. An agent that asks you to take over says why above the page. Once
// it has ended: its replay, the recording with its steps beside it, each step a jump to its moment and a way into
// the page's snapshot at that step. A login filled from 1Password is a step in words; its value is never on the hub
// to show, nor in a snapshot.
import { ChevronLeft, CornerUpLeft, Hand, KeyRound, ListTree, Pause, Play } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Button, EmptyState, StateGlyph, Text, Tooltip, Truncate, cx, useBeat } from "../../ui";
import { RolePill } from "../agents/parts";
import { useNow } from "../live/clock";
import { MiddleCut } from "../live/parts";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";
import {
  actionLine,
  durationOf,
  fmtDuration,
  frameAt,
  glyphOf,
  isLive,
  nodeLine,
  nowLine,
  siteOf,
  spans,
  stepAt,
  STATE_TONE,
  STATE_WORD,
  TARGET_WORD,
  type BrowserSession,
  type PageSnapshot,
  type SessionAction,
  type SessionFrame,
} from "./model";
import { actInPage, handBack, takeOver, useBrowserSessions } from "./preview";
import s from "./sessions.module.css";

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

export function SessionView({ project, id }: { project: ProjectKey; id: string }) {
  const session = useBrowserSessions(project).find((x) => x.id === id);
  if (session === undefined) {
    return (
      <div className={s.view} data-screen="sessions.missing">
        <EmptyState title="This session isn’t here">It may be from before the hub kept sessions, or from another project.</EmptyState>
      </div>
    );
  }
  const live = isLive(session);
  return (
    <section className={s.view} aria-label={session.purpose} data-screen={live ? "sessions.live" : "sessions.replay"}>
      <Head session={session} />
      {live ? <Live session={session} /> : <Replay key={session.id} session={session} />}
    </section>
  );
}

/** Its state in words beside its glyph, its agent (a link to its work); its purpose; the site, when it started, how long. */
function Head({ session: x }: { session: BrowserSession }) {
  const now = useNow(isLive(x));
  const agent = toHash(panelRoute(x.projectRef, { tab: "agents", agent: x.agent.laneId }));
  return (
    <div className={s.head}>
      <span className={s.headState}>
        <StateGlyph state={glyphOf(x.state)} label={STATE_WORD[x.state]} phase={1} />
        <Text size="xs" tone={STATE_TONE[x.state]} strong={x.state === "asking" || x.state === "yours"}>
          {STATE_WORD[x.state]}
        </Text>
        <a className={s.agentLink} href={agent} title="Open its agent">
          <RolePill role={x.agent.role} />
          <Truncate size="xs" tone="quiet" expand="none">
            {x.agent.title}
          </Truncate>
        </a>
      </span>
      <Text as="h2" size="md" strong>
        {x.purpose}
      </Text>
      <span className={s.headMeta}>
        <span className={s.site}>{siteOf(x)}</span>
        <Text size="xs" tone="quiet" tabular>
          {`started ${clock.format(new Date(x.startedAt))} · ${fmtDuration(durationOf(x, now))}`}
        </Text>
      </span>
    </div>
  );
}

/** The page now, what the agent does, the one control (Take over or Hand back) and its steps as they come. */
function Live({ session: x }: { session: BrowserSession }) {
  const yours = x.state === "yours";
  useBeat(x.state === "starting");
  const page = useRef<HTMLDivElement>(null);
  // Taken over, the keys go to the page at once.
  useEffect(() => {
    if (yours) page.current?.focus();
  }, [yours]);
  return (
    <div className={s.body}>
      {x.state === "asking" && x.handoff !== undefined ? (
        <div className={s.ask} role="status">
          <span className={s.askWords}>
            <Text size="xs" tone="warning" strong>
              It asks you to take over
            </Text>
            <Text size="sm">{x.handoff.reason}</Text>
          </span>
          <Button variant="primary" size="sm" icon={<Hand aria-hidden />} onClick={() => takeOver(x.id)}>
            Take over
          </Button>
        </div>
      ) : null}
      <div className={s.stage}>
        <div className={s.player}>
          <Frame session={x} frame={x.frames.at(-1)} yours={yours} pageRef={page} />
          <div className={s.control}>
            <span className={s.nowLine}>
              <Text size="xs" tone="faint">
                {yours ? "The agent" : "Now"}
              </Text>
              <span className={s.nowWords} data-sweep={x.state === "starting" ? "" : undefined}>
                <Text size="xs" tone={x.state === "asking" ? "warning" : yours ? "quiet" : "default"}>
                  {nowLine(x)}
                </Text>
              </span>
            </span>
            {yours ? (
              <Button variant="primary" size="sm" icon={<CornerUpLeft aria-hidden />} onClick={() => handBack(x.id)}>
                Hand back
              </Button>
            ) : x.state === "running" ? (
              <Button variant="secondary" size="sm" icon={<Hand aria-hidden />} onClick={() => takeOver(x.id)}>
                Take over
              </Button>
            ) : null}
          </div>
        </div>
        <Steps actions={x.actions} />
      </div>
    </div>
  );
}

/**
 * The page in a frame: its address and who drives it on a bar above. Yours, the bar turns over (the page's words on
 * the text colour) and the page takes your clicks and keys; the agent's, it only shows. With a snapshot's `marks`, the
 * elements its step acted on are outlined on the page.
 */
function Frame({
  session: x,
  frame,
  yours = false,
  right,
  marks,
  pageRef,
}: {
  session: BrowserSession;
  frame: SessionFrame | undefined;
  yours?: boolean;
  right?: string;
  marks?: PageSnapshot | undefined;
  pageRef?: RefObject<HTMLDivElement | null>;
}) {
  const act = yours ? () => actInPage(x.id) : undefined;
  return (
    <div className={cx(s.frame, yours && s.yours)} data-control={yours ? "you" : "agent"}>
      <div className={s.bar}>
        <span className={s.url}>{frame === undefined ? <span /> : <MiddleCut text={frame.url} />}</span>
        <Text size="xs" tone="inherit" strong={yours} tabular>
          {right ?? (yours ? "You’re in control: mouse and keys go to the page" : x.state === "starting" ? "Starting" : "The agent is driving")}
        </Text>
      </div>
      <div
        ref={pageRef}
        className={s.screen}
        role={yours ? "application" : "img"}
        aria-label={yours ? "The page: your clicks and keys go to it" : `The page${frame === undefined ? "" : `: ${frame.url}`}`}
        tabIndex={yours ? 0 : undefined}
        onPointerDown={act}
        onKeyDown={act}
      >
        {frame === undefined ? <span className={s.blank} /> : <img src={frame.image} alt="" draggable={false} />}
        {marks?.targets.map((i) => {
          const b = marks.nodes[i]?.box;
          if (b === undefined) return null;
          const { width: w, height: h } = marks.page;
          return <span key={i} className={s.mark} style={{ left: `${String((b.x / w) * 100)}%`, top: `${String((b.y / h) * 100)}%`, width: `${String((b.width / w) * 100)}%`, height: `${String((b.height / h) * 100)}%` }} />;
        })}
      </div>
    </div>
  );
}

/** A step's time into the session, then its words: the verb, what it acted on, a key beside a filled login. */
function StepWords({ action }: { action: SessionAction }) {
  const line = actionLine(action);
  return (
    <>
      <span className={s.at}>{fmtDuration(action.at)}</span>
      <span className={cx(s.words, line.who === "you" && s.you)}>
        {line.login ? <KeyRound aria-hidden className={s.key} /> : null}
        <Truncate size="xs" tone={line.tone} lines={2} expand="none">
          {line.words}
        </Truncate>
        {line.machine === undefined ? null : (
          <span className={s.machine}>
            <MiddleCut text={line.machine} />
          </span>
        )}
      </span>
    </>
  );
}

/** The live log: newest last, kept in view; a step that comes while you watch rises in, once. */
function Steps({ actions }: { actions: readonly SessionAction[] }) {
  const list = useRef<HTMLOListElement>(null);
  const [first] = useState(actions.length);
  useLayoutEffect(() => {
    const el = list.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [actions.length]);
  return (
    <div className={s.steps}>
      <span className={s.stepsHead}>
        <Text size="xs" tone="quiet" strong>
          Steps
        </Text>
        <Text size="xs" tone="faint" tabular>
          {String(actions.length)}
        </Text>
      </span>
      <ol ref={list} className={s.log} aria-label="Its steps">
        {actions.map((a, i) => (
          <li key={`${String(a.at)}:${String(i)}`} className={cx(s.step, i >= first && s.arrive)}>
            <StepWords action={a} />
          </li>
        ))}
      </ol>
    </div>
  );
}

const SPEEDS = [1, 2, 4] as const;

/**
 * The recording and its steps beside it. Play runs it; the scrubber's ticks are the steps, a dithered stretch the
 * time a person had the page; a step jumps to its moment, and the step on screen is marked. A step's snapshot, opened
 * from its line, takes the steps' place: the page's structure as that step found it, what it acted on highlighted there
 * and outlined on the page. Play, the scrubber, Back or Escape close it.
 */
function Replay({ session: x }: { session: BrowserSession }) {
  const duration = x.recording?.durationMs ?? x.actions.at(-1)?.at ?? 0;
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setInterval(() => {
      setAt((t) => {
        const next = Math.min(duration, t + 100 * speed);
        if (next >= duration) setPlaying(false);
        return next;
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [playing, speed, duration]);
  const step = stepAt(x.actions, at);
  const timeline = useRef<HTMLOListElement>(null);
  useEffect(() => {
    timeline.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: "nearest" });
  }, [step, open]);
  const yours = spans(x.actions, duration);
  const shown = open === null ? undefined : x.actions[open];
  const play = () => {
    setOpen(null);
    if (at >= duration) setAt(0);
    setPlaying((p) => !p);
  };
  const seek = (t: number) => {
    setOpen(null);
    setAt(t);
  };
  const snapshot = (i: number) => {
    setPlaying(false);
    setAt(x.actions[i]?.at ?? 0);
    setOpen(i);
  };

  return (
    <div className={s.body}>
      <div className={cx(s.stage, s.replay)}>
        <div className={s.player}>
          <Frame
            session={x}
            frame={frameAt(x.frames, at)}
            marks={shown?.snapshot}
            right={shown !== undefined ? `Snapshot at ${fmtDuration(shown.at)}` : yours.some(([a, b]) => at >= a && at < b) ? "You had the page" : "Recording"}
          />
          <div className={s.transport}>
            <Button variant="quiet" size="sm" iconOnly icon={playing ? <Pause aria-hidden /> : <Play aria-hidden />} aria-label={playing ? "Pause" : "Play"} onClick={play} />
            <div className={s.scrub}>
              <span className={s.track} />
              <span className={s.played} style={{ "--at": String(duration === 0 ? 0 : at / duration) } as CSSProperties} />
              {yours.map(([a, b]) => (
                <span key={a} className={s.yoursSpan} style={{ left: `${String((a / duration) * 100)}%`, width: `${String(((b - a) / duration) * 100)}%` }} />
              ))}
              {x.actions.map((a, i) => (
                <span key={`${String(a.at)}:${String(i)}`} className={s.tick} style={{ left: `${String((a.at / duration) * 100)}%` }} />
              ))}
              <input
                className={s.range}
                type="range"
                min={0}
                max={duration}
                step={100}
                value={at}
                aria-label="Where in the recording"
                aria-valuetext={`${fmtDuration(at)} of ${fmtDuration(duration)}`}
                onChange={(e) => seek(Number(e.currentTarget.value))}
              />
            </div>
            <Text size="xs" tone="quiet" tabular>
              {`${fmtDuration(at)} / ${fmtDuration(duration)}`}
            </Text>
            <div className={s.speed} role="group" aria-label="Speed">
              {SPEEDS.map((v) => (
                <button key={v} type="button" className={s.speedOption} aria-pressed={speed === v} onClick={() => setSpeed(v)}>
                  {`${String(v)}×`}
                </button>
              ))}
            </div>
          </div>
        </div>
        {shown?.snapshot !== undefined ? (
          <Snapshot key={open} action={shown} snapshot={shown.snapshot} onClose={() => setOpen(null)} />
        ) : (
          <div className={s.steps}>
            <span className={s.stepsHead}>
              <Text size="xs" tone="quiet" strong>
                Steps
              </Text>
              <Text size="xs" tone="faint" tabular>
                {String(x.actions.length)}
              </Text>
            </span>
            <ol ref={timeline} className={s.log} aria-label="Its steps: each jumps the recording to its moment">
              {x.actions.map((a, i) => (
                <li key={`${String(a.at)}:${String(i)}`} className={cx(s.stepRow, i === step && s.current)}>
                  <button type="button" className={cx(s.step, s.jump)} aria-current={i === step ? "step" : undefined} onClick={() => seek(a.at)}>
                    <StepWords action={a} />
                  </button>
                  {a.snapshot === undefined ? (
                    <span className={s.snapSlot} />
                  ) : (
                    <Tooltip content="The page at this step">
                      <Button
                        variant="quiet"
                        size="sm"
                        iconOnly
                        className={s.snapOpen}
                        icon={<ListTree aria-hidden />}
                        aria-label={`The page at ${fmtDuration(a.at)}`}
                        onClick={() => snapshot(i)}
                      />
                    </Tooltip>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A step's page snapshot, where its steps were: the step in words, then the page's structure as it found it, one
 * element a line under its parent (its role, its name, its value); the elements it acted on are highlighted and say
 * what it did to them. A secret field says where its value came from and never shows it.
 */
function Snapshot({ action, snapshot, onClose }: { action: SessionAction; snapshot: PageSnapshot; onClose: () => void }) {
  const tree = useRef<HTMLOListElement>(null);
  useEffect(() => {
    tree.current?.querySelector("[data-target]")?.scrollIntoView({ block: "nearest" });
  }, []);
  const did = TARGET_WORD[action.kind];
  return (
    <section
      className={s.steps}
      aria-label={`The page at ${fmtDuration(action.at)}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <span className={s.stepsHead}>
        <Button variant="quiet" size="sm" icon={<ChevronLeft aria-hidden />} onClick={onClose} autoFocus>
          Steps
        </Button>
        <Text size="xs" tone="quiet" strong>
          {`The page at ${fmtDuration(action.at)}`}
        </Text>
      </span>
      <div className={cx(s.step, s.snapStep)}>
        <StepWords action={action} />
      </div>
      <ol ref={tree} className={cx(s.log, s.tree)} aria-label="The page’s structure">
        {snapshot.nodes.map((node, i) => {
          const line = nodeLine(node);
          const target = snapshot.targets.includes(i);
          return (
            <li key={i} className={cx(s.node, target && s.target)} style={{ "--depth": String(node.depth) } as CSSProperties} data-target={target ? "" : undefined}>
              <span className={s.role}>{line.role}</span>
              {line.name === undefined ? null : <span className={s.name}>{line.name}</span>}
              {line.value === undefined ? null : <span className={s.value}>{line.value}</span>}
              {line.hidden === undefined ? null : (
                <span className={s.hidden}>
                  {node.secret === "vault" ? <KeyRound aria-hidden className={s.key} /> : null}
                  {line.hidden}
                </span>
              )}
              {target && did !== undefined ? <span className={s.did}>{did}</span> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
