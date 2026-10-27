// One browser session, in the panel's wide width. While it runs: the page as the agent sees it, the full width, what
// the agent is doing now, and Take over. Taken over, the page is yours: the frame's bar turns to say so, your
// clicks and keys go to the page, and Hand back gives it to the agent, which looks at the page again and goes on;
// meanwhile it waits, and its line says so. An agent that asks you to take over says why above the page. Once it has
// ended: its replay, the recording the full width; Steps opens its steps beside it, each step a jump to its moment and a
// way into the page's snapshot at that step. A login filled from 1Password is a step in words; its value is never on the hub to show, nor
// in a snapshot.
import { AppWindow, ChevronLeft, CornerUpLeft, Hand, KeyRound, ListOrdered, ListTree, Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Button, EmptyState, StateGlyph, Text, Tooltip, Truncate, cx, toast } from "../../ui";
import { useDataLayer } from "../../src/data/react";
import { display } from "../../../shared/shortcuts";
import { RolePill } from "../agents/parts";
import { useCommands } from "../palette";
import { useNow } from "../live/clock";
import { MiddleCut } from "../live/parts";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";
import {
  actionLine,
  durationOf,
  fmtDuration,
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
  FRAME,
  type BrowserSession,
  type FrameBox,
  type PageSnapshot,
  type SessionAction,
} from "./model";
import { structureOf } from "./dom";
import { useRecording, useSessions } from "./hub";
import { setControl, useFrameInput, useLiveFrame } from "./live";
import { showWindow, useInItsWindow } from "./windows";
import s from "./sessions.module.css";

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** One session; `windowed` in a window of its own (SessionWindow), which pops nothing out and links nowhere. */
export function SessionView({ project, id, windowed = false }: { project: ProjectKey; id: string; windowed?: boolean }) {
  const all = useSessions(project);
  const session = all.find((x) => x.id === id);
  // A session's window has its sessions from the main window a moment after it opens.
  if (session === undefined && windowed && all.length === 0) return <div className={s.view} aria-busy="true" />;
  if (session === undefined) {
    return (
      <div className={s.view} data-screen="sessions.missing">
        <EmptyState title="This screen isn’t here">It may be from before the hub kept screens, or from another project.</EmptyState>
      </div>
    );
  }
  const live = isLive(session);
  return (
    <section className={s.view} aria-label={session.purpose} data-screen={live ? "sessions.live" : "sessions.replay"}>
      <Head session={session} windowed={windowed} />
      {live ? <Live session={session} windowed={windowed} /> : <Replay key={session.id} session={session} />}
    </section>
  );
}

/** Its state in words beside its glyph, its agent (a link to its work); its purpose; the site, its start, how long. */
function Head({ session: x, windowed }: { session: BrowserSession; windowed: boolean }) {
  const now = useNow(isLive(x));
  const agent = toHash(panelRoute(x.projectRef, { tab: "agents", agent: x.agent.laneId }));
  const who = (
    <>
      {x.agent.role === undefined ? null : <RolePill role={x.agent.role} />}
      <Truncate size="xs" tone="quiet" expand="none">
        {x.agent.title}
      </Truncate>
    </>
  );
  return (
    <div className={s.head}>
      <span className={s.headState}>
        <StateGlyph state={glyphOf(x.state)} label={STATE_WORD[x.state]} phase={1} />
        <Text size="xs" tone={STATE_TONE[x.state]} strong={x.state === "asking" || x.state === "yours"}>
          {STATE_WORD[x.state]}
        </Text>
        {windowed ? (
          <span className={s.agentLink}>{who}</span>
        ) : (
          <a className={s.agentLink} href={agent} title="Open its agent">
            {who}
          </a>
        )}
      </span>
      <Text as="h2" size="md" strong>
        {x.purpose}
      </Text>
      <span className={s.headMeta}>
        {siteOf(x) === "" ? null : <span className={s.site}>{siteOf(x)}</span>}
        <Text size="xs" tone="quiet" tabular>
          {`started ${clock.format(new Date(x.startedAt))} · ${fmtDuration(durationOf(x, now))}`}
        </Text>
        {x.credentialsFilled === undefined ? null : (
          <span className={s.filled}>
            <KeyRound aria-hidden className={s.key} />
            <Text size="xs" tone="quiet">
              {`${String(x.credentialsFilled)} ${x.credentialsFilled === 1 ? "login" : "logins"} filled from 1Password`}
            </Text>
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * The page now, the full width, what the agent does and the one control (Take over or Hand back); its steps come with
 * its recording, once it ends. Beside Take
 * over, the pop-out takes the page over in a window of its own; while the session is in its window, this one shows that
 * and offers to bring that window forward. Taken over, ⌘⇧↩ (Ctrl+Shift+Enter) hands back: the app's keymap catches it
 * in the capture phase, so the page never sees those keys.
 */
function Live({ session: x, windowed }: { session: BrowserSession; windowed: boolean }) {
  const layer = useDataLayer();
  const yours = x.state === "yours";
  const away = useInItsWindow(x.id) && !windowed;
  // This window watches the page, unless the session's own window has it (that one watches it).
  const frame = useLiveFrame(x.id, !away);
  const takes = yours && !away;
  const input = useFrameInput(x.id, frame, takes);
  const page = useRef<HTMLDivElement>(null);
  const [asking, setAsking] = useState<"human" | "agent" | null>(null);
  // Taken over, the keys go to the page at once (in the window that has it).
  useEffect(() => {
    if (takes) page.current?.focus();
  }, [takes]);
  const control = (to: "human" | "agent") => {
    setAsking(to);
    void setControl(layer, x.id, to).then((ok) => {
      setAsking(null);
      if (!ok) toast({ title: to === "human" ? "Couldn’t take over" : "Couldn’t hand back", description: "The hub didn’t take it. Try again.", key: `control:${x.id}` });
    });
  };
  useCommands(
    [
      {
        id: "session.handBack",
        title: "Hand back the page",
        detail: "Give the page you took over back to its agent",
        group: "actions",
        enabled: () => takes,
        run: () => control("agent"),
      },
    ],
    [x.id, takes],
  );
  const popOut = () => {
    if (!yours) control("human");
    showWindow(x.projectRef, x.id);
  };
  const popOutButton = windowed ? null : (
    <Tooltip content="Take over in its own window">
      <Button variant="quiet" size="sm" iconOnly icon={<AppWindow aria-hidden />} aria-label="Take over in its own window" disabled={asking !== null} onClick={popOut} />
    </Tooltip>
  );
  const takeOver = (variant: "primary" | "secondary") => (
    <span className={s.controls}>
      {popOutButton}
      <Button variant={variant} size="sm" icon={<Hand aria-hidden />} disabled={asking !== null} onClick={() => control("human")}>
        Take over
      </Button>
    </span>
  );
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
          {takeOver("primary")}
        </div>
      ) : null}
      <div className={s.player}>
        <Frame
          {...(frame === undefined ? {} : { image: { src: `data:image/jpeg;base64,${frame.jpegB64}`, url: frame.url, width: frame.width, height: frame.height } })}
          yours={yours}
          away={away}
          pageRef={page}
          input={input}
          caption={away ? "It shows in its own window." : "Waiting for the page…"}
        />
        <div className={s.control}>
          <span className={s.nowLine}>
            <Text size="xs" tone="faint">
              {yours ? "The agent" : "Now"}
            </Text>
            <span className={s.nowWords}>
              <Text size="xs" tone={x.state === "asking" ? "warning" : yours ? "quiet" : "default"}>
                {nowLine(x)}
              </Text>
            </span>
          </span>
          {away ? (
            <Button variant="secondary" size="sm" icon={<AppWindow aria-hidden />} onClick={() => showWindow(x.projectRef, x.id)}>
              Show its window
            </Button>
          ) : yours ? (
            <Button
              variant="primary"
              size="sm"
              icon={<CornerUpLeft aria-hidden />}
              shortcut={display("session.handBack", window.fleetd.platform)}
              disabled={asking !== null}
              onClick={() => control("agent")}
            >
              Hand back
            </Button>
          ) : x.state === "running" ? (
            takeOver("secondary")
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The page in a frame, at the page's own shape: its address and who drives it on a bar above. Yours, the bar turns over
 * (the page's words on the text colour) and the page takes your clicks, keys and pastes (`input`); the agent's, it only
 * shows.
 */
function Frame({
  image,
  yours = false,
  away = false,
  right,
  media,
  caption,
  url: given,
  mark,
  input,
  pageRef,
}: {
  /** The page now: a live frame, in its own pixels. */
  image?: { readonly src: string; readonly url?: string | undefined; readonly width: number; readonly height: number };
  yours?: boolean;
  /** Yours, but in the session's own window: this one only shows that. */
  away?: boolean;
  right?: string | undefined;
  /** What plays in the page's place (a recording's video). */
  media?: ReactNode;
  /** Words on an empty page: why nothing shows there. */
  caption?: string | undefined;
  /** The page's address when there is no live frame (a replay's step's). */
  url?: string | undefined;
  /** What a step acted on, outlined where it was (in the video frame's pixels). */
  mark?: FrameBox | undefined;
  input?: ReturnType<typeof useFrameInput>;
  pageRef?: RefObject<HTMLDivElement | null>;
}) {
  const takes = input !== undefined;
  const url = image?.url ?? given;
  return (
    <div className={cx(s.frame, yours && s.yours)} data-control={yours ? "you" : "agent"}>
      <div className={s.bar}>
        <span className={s.url}>{url === undefined ? <span /> : <MiddleCut text={url} />}</span>
        <Text size="xs" tone="inherit" strong={yours} tabular>
          {right ?? (away ? "You’re in control, in its own window" : yours ? "You’re in control: mouse and keys go to the page" : "The agent is driving")}
        </Text>
      </div>
      <div
        ref={pageRef}
        className={s.screen}
        style={image === undefined ? undefined : { aspectRatio: `${String(image.width)} / ${String(image.height)}` }}
        role={takes ? "application" : "img"}
        aria-label={takes ? "The page: your clicks and keys go to it" : `The page${url === undefined ? "" : `: ${url}`}`}
        tabIndex={takes ? 0 : undefined}
        {...input}
      >
        {media ??
          (image === undefined ? (
            <span className={s.blank}>{caption === undefined ? null : <Text size="xs" tone="quiet">{caption}</Text>}</span>
          ) : (
            <img src={image.src} alt="" draggable={false} />
          ))}
        {mark === undefined ? null : (
          <span
            className={s.mark}
            data-target-box=""
            style={{
              left: `${String((mark.x / FRAME.width) * 100)}%`,
              top: `${String((mark.y / FRAME.height) * 100)}%`,
              width: `${String((mark.width / FRAME.width) * 100)}%`,
              height: `${String((mark.height / FRAME.height) * 100)}%`,
            }}
          />
        )}
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

const SPEEDS = [1, 2, 4] as const;

/**
 * The recording, the full width, and its steps behind Steps, closed until you open them. Play runs it; the scrubber's ticks are the steps, a dithered stretch the time
 * a person had the page; a step jumps to its moment, and the step on screen is marked. A step's snapshot, opened from
 * its line, takes the steps' place: the page's structure as that step found it, what it acted on highlighted there and
 * outlined on the page. Play, the scrubber, Back or Escape close it.
 */
function Replay({ session: x }: { session: BrowserSession }) {
  if (x.state === "saving" || x.state === "lost" || x.state === "expired") return <NoRecording session={x} />;
  return x.recording === undefined ? <NoRecording session={x} /> : <Recorded session={x} />;
}

/** Why there is nothing to play: the recording is on its way, was lost, or retention deleted it. */
function NoRecording({ session: x }: { session: BrowserSession }) {
  const words =
    x.state === "ended"
      ? "It has no recording."
      : x.state === "saving"
      ? "Saving the recording. It plays here once the hub has it."
      : x.state === "lost"
        ? `Its recording was lost${x.note === undefined ? "." : `: ${x.note}.`}`
        : "Its recording expired: the hub keeps recordings for a while, then deletes them.";
  return (
    <div className={cx(s.body, s.note)} data-state={x.state}>
      <Text size="sm" tone={x.state === "lost" ? "danger" : "quiet"}>
        {words}
      </Text>
    </div>
  );
}

/** A recorded session's files from the hub, read once, then played. */
function Recorded({ session: x }: { session: BrowserSession }) {
  const { data, error } = useRecording(x);
  if (error) {
    return (
      <div className={cx(s.body, s.note)} role="alert">
        <Text size="sm" tone="danger">
          Couldn’t read its recording from the hub. Open it again to retry.
        </Text>
      </div>
    );
  }
  if (data === undefined) return <div className={s.body} aria-busy="true" aria-label="Reading its recording" />;
  return <Player session={x} actions={data.actions} {...(data.video === undefined ? {} : { video: data.video })} />;
}

/**
 * Plays a recording: its video when it has one (the video's clock leads), else a clock of its own over its steps. Steps,
 * at the end of its controls, opens them beside it (under it in a narrow panel) and closes them again.
 */
function Player({ session: x, actions, video }: { session: BrowserSession; actions: readonly SessionAction[]; video?: Blob }) {
  const duration = x.recording?.durationMs ?? actions.at(-1)?.at ?? 0;
  const media = useRef<HTMLVideoElement>(null);
  // The video plays from a URL for its blob, made for as long as the player shows it.
  useEffect(() => {
    const el = media.current;
    if (el === null || video === undefined) return undefined;
    const url = URL.createObjectURL(video);
    el.src = url;
    return () => {
      el.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [video]);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [open, setOpen] = useState<number | null>(null);
  const [steps, setSteps] = useState(false);
  useEffect(() => {
    if (media.current !== null) media.current.playbackRate = speed;
  }, [speed, video]);
  useEffect(() => {
    if (!playing || video !== undefined) return undefined;
    const timer = window.setInterval(() => {
      setAt((t) => {
        const next = Math.min(duration, t + 100 * speed);
        if (next >= duration) setPlaying(false);
        return next;
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [playing, speed, duration, video]);
  const step = stepAt(actions, at);
  const timeline = useRef<HTMLOListElement>(null);
  useEffect(() => {
    timeline.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: "nearest" });
  }, [step, open, steps]);
  const yours = spans(actions, duration);
  // Where `t` is along the scrubber, in percent; a recording with no length puts everything at its start.
  const place = (t: number): string => `${String(duration === 0 ? 0 : (t / duration) * 100)}%`;
  const shown = open === null ? undefined : actions[open];
  // A step's page, as structure: given (the preview), or made from the HTML the node read, only once it is opened.
  const page = useMemo(() => shown?.snapshot ?? (shown?.page === undefined ? undefined : structureOf(shown.page.html, shown.selector)), [shown]);
  const to = (t: number) => {
    setAt(t);
    if (media.current !== null) media.current.currentTime = t / 1000;
  };
  const play = () => {
    setOpen(null);
    const v = media.current;
    if (v !== null) {
      if (v.paused) void v.play();
      else v.pause();
      return;
    }
    if (at >= duration) setAt(0);
    setPlaying((p) => !p);
  };
  const seek = (t: number) => {
    setOpen(null);
    to(t);
  };
  const snapshot = (i: number) => {
    media.current?.pause();
    setPlaying(false);
    to(actions[i]?.at ?? 0);
    setOpen(i);
  };

  return (
    <div className={s.body}>
      <div className={cx(s.stage, steps && s.withSteps)}>
        <div className={s.player}>
          <Frame
            caption={video === undefined ? (x.note ?? "This recording has no video. Its steps and pages are under Steps.") : undefined}
            url={actions.slice(0, step + 1).findLast((a) => a.page !== undefined)?.page?.url}
            mark={shown?.box}
            media={
              video === undefined ? undefined : (
                <video
                  ref={media}
                  muted
                  playsInline
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                  onTimeUpdate={(e) => setAt(e.currentTarget.currentTime * 1000)}
                />
              )
            }
            right={shown !== undefined ? `Snapshot at ${fmtDuration(shown.at)}` : yours.some(([a, b]) => at >= a && at < b) ? "You had the page" : "Recording"}
          />
          <div className={s.transport}>
            <Button variant="quiet" size="sm" iconOnly icon={playing ? <Pause aria-hidden /> : <Play aria-hidden />} aria-label={playing ? "Pause" : "Play"} onClick={play} />
            <div className={s.scrub}>
              <span className={s.track} />
              <span className={s.played} style={{ "--at": String(duration === 0 ? 0 : at / duration) } as CSSProperties} />
              {yours.map(([a, b]) => (
                <span key={a} className={s.yoursSpan} style={{ left: place(a), width: place(b - a) }} />
              ))}
              {actions.map((a, i) => (
                <span key={`${String(a.at)}:${String(i)}`} className={s.tick} style={{ left: place(a.at) }} />
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
            <Button
              variant={steps ? "secondary" : "quiet"}
              size="sm"
              icon={<ListOrdered aria-hidden />}
              aria-pressed={steps}
              onClick={() => {
                setOpen(null);
                setSteps((o) => !o);
              }}
            >
              Steps
            </Button>
          </div>
        </div>
        {!steps ? null : shown !== undefined && page !== undefined ? (
          <Snapshot key={open} action={shown} snapshot={page} onClose={() => setOpen(null)} />
        ) : (
          <div className={s.steps}>
            <span className={s.stepsHead}>
              <Text size="xs" tone="quiet" strong>
                Steps
              </Text>
              <Text size="xs" tone="faint" tabular>
                {String(actions.length)}
              </Text>
            </span>
            <ol ref={timeline} className={s.log} aria-label="Its steps: each jumps the recording to its moment">
              {actions.map((a, i) => (
                <li key={`${String(a.at)}:${String(i)}`} className={cx(s.stepRow, i === step && s.current)}>
                  <button type="button" className={cx(s.step, s.jump)} aria-current={i === step ? "step" : undefined} onClick={() => seek(a.at)}>
                    <StepWords action={a} />
                  </button>
                  {a.snapshot === undefined && a.page === undefined ? (
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
