// A PR's Try it (W58): the PR's branch running on a machine for the person to use. While it
// starts, its steps as the machine reports them; once ready, the page in a frame the person drives (a browser session
// they hold from the start: its frames and their input, as a taken-over session's), its address for their own devices
// on the tailnet, and feedback: pins on the page, their words, a screenshot with the pins and the session's last 30 s,
// sent to the PR's agents as a fix request. It ends on End or after the project's idle time. Nothing runs until Try
// it, and a key that may only open running previews (D162) gets no Start.
import { Copy, ExternalLink, Image as ImageIcon, Lock, MapPin, Play, X } from "lucide-react";
import { useState, useSyncExternalStore, type MouseEvent } from "react";
import type { BrowserFrame, Preview, PreviewStep } from "../../../shared/contracts";
import { useData, useDataLayer } from "../../src/data/react";
import { Button, Checkbox, Code, copyText, cx, StateGlyph, Text, Textarea, toast, Truncate, useBeatRef } from "../../ui";
import { shortClock } from "../chat/format";
import { useFrameInput, useLiveFrame } from "../sessions/live";
import { MiddleCut } from "../live/parts";
import type { ProjectKey } from "../shell/routes";
import { CLIP_SECONDS, endPreview, sendFeedback, tryIt, useTryIt, type TryIt as TryItData } from "./hub";
import { atStep, endWords, idleWords, isLive, ofPr, startedWords, stateGlyph, stateWord, STATE_TONE, stepGlyph, tookWords, type Pin } from "./model";
import { shotWithPins } from "./shot";
import s from "./tryit.module.css";

const useMachineName = (machineId: string | undefined): string =>
  useData((st) => (machineId === undefined ? "its machine" : (st.machines[machineId]?.name ?? machineId)));

export function TryItView({ project, repo, number }: { project: ProjectKey; repo: string; number: number }) {
  const of = ofPr(repo, number);
  const t = useTryIt(project, of);
  const p = t.preview;
  const live = p !== undefined && isLive(p);
  return (
    // A preview that couldn't start is the view's own state, not an error page ("tryit.failed" would read as one).
    <div className={s.view} data-screen={p === undefined ? (t.asking ? "tryit.asking" : "tryit.off") : `tryit.${p.state === "failed" ? "start-failed" : p.state}`}>
      <Head t={t} />
      <div className={s.body}>{live ? <Running key={p.previewId} preview={p} pr={number} mayAct={t.canStart !== false} /> : <Off project={project} t={t} repo={repo} pr={number} />}</div>
    </div>
  );
}

/** Its state in words beside its glyph, where it runs and who asked; while it runs, when it ends and End. */
function Head({ t }: { t: TryItData }) {
  const layer = useDataLayer();
  const p = t.preview;
  const machine = useMachineName(p?.machineId);
  const [ending, setEnding] = useState(false);
  const live = p !== undefined && isLive(p);
  return (
    <div className={s.head}>
      <div className={s.headRow}>
        <span className={s.state}>
          {p === undefined ? (
            <Text size="sm" tone="quiet">
              {t.asking ? "Asking the hub to start it" : "Not running"}
            </Text>
          ) : (
            <>
              <StateGlyph state={stateGlyph(p.state)} size="sm" settled={!live} still={p.state === "ready"} />
              <Text size="sm" strong tone={STATE_TONE[p.state] ?? "quiet"}>
                {stateWord(p.state)}
              </Text>
              <Truncate size="xs" tone="quiet" expand="none">
                {`on ${machine} · ${p.askedBy.words === "you" ? "you asked" : `asked by ${p.askedBy.words}`}`}
              </Truncate>
              {p.head === undefined ? null : (
                <span className={s.commit} data-text="code" title="The commit it runs">
                  <Text mono size="xs" tone="quiet">
                    {p.head.slice(0, 7)}
                  </Text>
                </span>
              )}
            </>
          )}
        </span>
        {live && t.canStart !== false ? (
          <Button
            variant="quiet"
            size="sm"
            disabled={ending}
            onClick={() => {
              setEnding(true);
              void endPreview(layer, p).then(() => setEnding(false));
            }}
          >
            End
          </Button>
        ) : null}
      </div>
      {live ? (
        <Text size="xs" tone="quiet">
          {`${idleWords(p.idleUntil, (iso) => shortClock(iso))} Nothing of it is kept running.`}
        </Text>
      ) : null}
      {live && p.note !== undefined ? (
        <Text size="xs" tone="warning">
          {p.note}
        </Text>
      ) : null}
    </div>
  );
}

/** Not started, ended or failed: what Try it does, and the one control, for a key that may start one. */
function Off({ project, t, repo, pr }: { project: ProjectKey; t: TryItData; repo: string; pr: number }) {
  const layer = useDataLayer();
  const p = t.preview;
  const machine = useMachineName(p?.machineId);
  const failed = p?.state === "failed" ? (p.steps ?? []).find((x) => x.state === "failed") : undefined;
  const start = () => void tryIt(layer, project, ofPr(repo, pr), "start");
  return (
    <div className={s.off}>
      <Text size="md" strong>
        {p === undefined ? `Try #${String(pr)} on the web` : p.state === "failed" ? "It couldn’t start" : "Ended"}
      </Text>
      <Text size="sm" tone="quiet" className={s.offWords}>
        {p === undefined
          ? "Builds the PR’s branch on a machine with the project’s preview commands, starts it, and opens it here for you to use. Your own browser can open it too, from your devices on the tailnet."
          : p.state === "failed"
            ? `${failed === undefined ? (p.note ?? "A step failed.") : `${failed.words} failed.`} Nothing of it runs on ${machine} now.`
            : `${endWords(p)} Nothing of it runs on ${machine} now: the server, its port and its worktree are gone.`}
      </Text>
      {failed?.outputTail !== undefined ? <Code code={failed.outputTail} bare className={s.tail} /> : null}
      {p?.state === "failed" && failed !== undefined && p.note !== undefined ? (
        <Text size="xs" tone="quiet">
          {p.note}
        </Text>
      ) : null}
      {t.action === "none" ? (
        <Text size="sm" tone="quiet">
          Starting one takes a key with admin or operate access. This device’s key can open a preview once someone starts it.
        </Text>
      ) : (
        <>
          <Button variant="primary" size="sm" icon={<Play aria-hidden />} disabled={t.asking} onClick={start}>
            {p === undefined ? "Try it" : "Try it again"}
          </Button>
          <Text size="xs" tone="faint">
            Nothing is built until you ask. It ends when you’re done, or after a while without use.
          </Text>
        </>
      )}
    </div>
  );
}

/** The page as it was when the first pin went on it: what the pins sit on, and what the screenshot is drawn from. */
type Still = Pick<BrowserFrame, "jpegB64" | "width" | "height" | "url">;

// What the person marked and wrote, per preview, so switching tabs keeps it until it is sent.
interface Draft {
  readonly marking: boolean;
  readonly pins: readonly Pin[];
  readonly clip: boolean;
  readonly still?: Still;
  readonly sent?: { readonly to: string; readonly at: string; readonly pins: readonly Pin[]; readonly clip: boolean; readonly shot: boolean };
}
const FRESH: Draft = { marking: false, pins: [], clip: true };
let drafts: Readonly<Record<string, Draft>> = {};
const draftListeners = new Set<() => void>();
const setDraft = (id: string, change: (d: Draft) => Draft) => {
  drafts = { ...drafts, [id]: change(drafts[id] ?? FRESH) };
  for (const l of draftListeners) l();
};
const subscribeDrafts = (l: () => void) => {
  draftListeners.add(l);
  return () => draftListeners.delete(l);
};
const useDraft = (id: string): Draft => useSyncExternalStore(subscribeDrafts, () => drafts[id] ?? FRESH);

/**
 * Starting or ready: the page beside its steps, then feedback and its address once it answers. `mayAct`: the key may
 * start, end and send feedback (canStart's rule, D162); without it the person uses the page and nothing more.
 */
function Running({ preview: p, pr, mayAct }: { preview: Preview; pr: number; mayAct: boolean }) {
  const ready = p.state === "ready";
  const d = useDraft(p.previewId);
  const frame = useLiveFrame(p.sessionId ?? "", ready && p.sessionId !== undefined);
  return (
    <div className={s.stage}>
      <div className={s.player}>
        <Frame preview={p} frame={frame} draft={d} />
        {ready ? (
          <div className={s.under}>
            <Text size="xs" tone="quiet" className={s.underWords}>
              {d.marking ? "Click where it’s wrong; each click is a pin you can say something about." : "Your clicks and keys go to the page. The screen is recorded, as every screen is."}
            </Text>
            {mayAct ? (
              <Button
                variant="secondary"
                size="sm"
                icon={d.marking ? <X aria-hidden /> : <MapPin aria-hidden />}
                onClick={() => setDraft(p.previewId, (x) => ({ ...x, marking: !x.marking }))}
              >
                {d.marking ? "Done marking" : "Mark up"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className={s.side}>
        {ready ? (
          <>
            {mayAct ? (
              <Feedback preview={p} pr={pr} draft={d} frame={frame} />
            ) : (
              <section className={s.block} aria-label="Feedback">
                <div className={s.blockHead}>
                  <Text size="xs" tone="quiet" strong>
                    Feedback
                  </Text>
                </div>
                <Text size="sm" tone="quiet">
                  Sending feedback to the agents, and ending the preview, take a key with admin or operate access. This device’s key can use the page.
                </Text>
              </section>
            )}
            <Elsewhere preview={p} />
            <Steps preview={p} folded />
          </>
        ) : (
          <Steps preview={p} />
        )}
      </div>
    </div>
  );
}

/** The page in its frame: its address on a bar above, and the person's input going to it unless they are marking. */
function Frame({ preview: p, frame, draft: d }: { preview: Preview; frame: BrowserFrame | undefined; draft: Draft }) {
  const ready = p.state === "ready";
  const input = useFrameInput(p.sessionId ?? "", frame, ready && !d.marking && p.sessionId !== undefined);
  // Marking, the page holds still once a pin is on it, so the pins stay where they were put and match the screenshot.
  const shown = d.marking && d.still !== undefined ? d.still : frame;
  const url = shown?.url ?? p.url;
  return (
    <div className={cx(s.frame, d.marking && s.marking)}>
      <div className={s.bar}>
        {d.marking ? <MapPin aria-hidden className={s.barIcon} /> : <Lock aria-hidden className={s.barIcon} />}
        <span className={s.url}>
          {d.marking ? (
            <Text size="xs" tone="inherit" strong>
              Marking up: click where it’s wrong
            </Text>
          ) : url === undefined ? (
            <Text size="xs" tone="inherit">
              {ready ? "" : "Not answering yet"}
            </Text>
          ) : (
            <MiddleCut text={url} />
          )}
        </span>
        {ready && !d.marking ? (
          <Text size="xs" tone="inherit">
            You drive it
          </Text>
        ) : null}
      </div>
      <div
        className={s.screen}
        style={shown === undefined ? undefined : { aspectRatio: `${String(shown.width)} / ${String(shown.height)}` }}
        role={input === undefined ? "img" : "application"}
        aria-label={input === undefined ? `The preview${url === undefined ? "" : `: ${url}`}` : "The preview: your clicks and keys go to it"}
        tabIndex={input === undefined ? undefined : 0}
        data-app-under-test=""
        {...input}
      >
        {!ready ? (
          <Starting steps={p.steps ?? []} />
        ) : shown === undefined ? (
          <span className={s.blank}>
            <Text size="xs" tone="quiet">
              Waiting for the page…
            </Text>
          </span>
        ) : (
          <img src={`data:image/jpeg;base64,${shown.jpegB64}`} alt="" draggable={false} />
        )}
        {d.marking ? <MarkLayer id={p.previewId} frame={frame} /> : null}
        {/* Over the page they were put on only: the live page may have moved on since. */}
        {(d.marking ? d.pins : []).map((pin, i) => (
          <span key={i} className={s.pin} style={{ left: `${String(pin.x * 100)}%`, top: `${String(pin.y * 100)}%` }} aria-label={`Pin ${String(i + 1)}`}>
            {i + 1}
          </span>
        ))}
      </div>
    </div>
  );
}

/** While it starts: the step at work, its words scanned on the beat, over a still dither field. */
function Starting({ steps }: { steps: readonly PreviewStep[] }) {
  const at = atStep(steps);
  const sweep = useBeatRef<HTMLSpanElement>(true);
  return (
    <div className={s.starting}>
      <span className={s.startingWords}>
        <span ref={sweep} data-sweep="">
          <Text size="sm">{at.step?.words ?? "Starting"}</Text>
        </span>
        {at.of > 0 ? <Text size="xs" tone="quiet">{`Step ${String(at.n)} of ${String(at.of)}`}</Text> : null}
      </span>
    </div>
  );
}

/** Marking up: a click anywhere on the page drops the next pin there; the page underneath takes no input. */
function MarkLayer({ id, frame }: { id: string; frame: BrowserFrame | undefined }) {
  const drop = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const pin: Pin = { x: (e.clientX - r.left) / Math.max(1, r.width), y: (e.clientY - r.top) / Math.max(1, r.height), note: "" };
    // The first pin keeps the page as it is now: the screenshot is drawn from it, not from the page when it is sent.
    const now = frame === undefined ? undefined : { jpegB64: frame.jpegB64, width: frame.width, height: frame.height, ...(frame.url === undefined ? {} : { url: frame.url }) };
    setDraft(id, (d) => {
      if (d.pins.length >= 20) return d;
      const still = d.still ?? now;
      return { marking: d.marking, clip: d.clip, pins: [...d.pins, pin], ...(still === undefined ? {} : { still }) };
    });
  };
  return <div className={s.markLayer} onClick={drop} role="presentation" data-pin-layer="" />;
}

function Steps({ preview: p, folded = false }: { preview: Preview; folded?: boolean }) {
  const [open, setOpen] = useState(!folded);
  const steps = p.steps ?? [];
  return (
    <section className={s.block} aria-label="Steps">
      <div className={s.blockHead}>
        <Text size="xs" tone="quiet" strong>
          {folded ? "How it started" : "Starting"}
        </Text>
        {folded && steps.length > 0 ? (
          <Button variant="quiet" size="sm" onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Show"}
          </Button>
        ) : null}
      </div>
      {folded && !open ? (
        <Text size="xs" tone="quiet">
          {startedWords(p)}
        </Text>
      ) : steps.length === 0 ? (
        <Text size="xs" tone="quiet">
          Waiting for its machine to take it.
        </Text>
      ) : (
        <ol className={s.steps}>
          {steps.map((step, i) => (
            <li key={`${String(i)}:${step.words}`} className={s.step}>
              <StateGlyph state={stepGlyph(step.state)} size="sm" settled />
              <span className={s.stepWords}>
                <Text size="sm" tone={step.state === "queued" ? "quiet" : "default"}>
                  {step.words}
                </Text>
                {step.detail !== undefined ? (
                  <Truncate size="xs" tone="quiet" mono={step.detail.startsWith("http")}>
                    {step.state === "reused" ? `reused: ${step.detail}` : step.detail}
                  </Truncate>
                ) : step.state === "reused" ? (
                  <Text size="xs" tone="quiet">
                    reused
                  </Text>
                ) : null}
              </span>
              <Text size="xs" tone="faint" tabular>
                {step.state === "done" ? tookWords(step.tookMs) : ""}
              </Text>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Its writer's name in the words of a fix request's heading. */
const whose = (pr: number) => `#${String(pr)}’s agents`;

function Feedback({ preview: p, pr, draft: d, frame }: { preview: Preview; pr: number; draft: Draft; frame: BrowserFrame | undefined }) {
  const layer = useDataLayer();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const id = p.previewId;
  const send = () => {
    setBusy(true);
    setFailed(null);
    const page = d.still ?? frame;
    const at = page?.url ?? p.url;
    void (async () => {
      const shot = page === undefined ? undefined : await shotWithPins(page, d.pins);
      const out = await sendFeedback(layer, p, { pins: d.pins, at, shotB64: shot, clip: d.clip });
      setBusy(false);
      if (!out.ok) {
        setFailed(out.words);
        return;
      }
      setDraft(id, (x) => ({ ...FRESH, clip: x.clip, sent: { to: out.to, at: new Date().toISOString(), pins: x.pins, clip: x.clip, shot: shot !== undefined } }));
    })();
  };
  if (d.sent !== undefined && !d.marking && d.pins.length === 0) {
    const sent = d.sent;
    return (
      <section className={s.block} aria-label="Feedback">
        <div className={s.blockHead}>
          <Text size="xs" tone="quiet" strong>
            Feedback
          </Text>
        </div>
        <Text size="sm">{`Sent to ${sent.to}.`}</Text>
        <Text size="xs" tone="quiet">
          {`At ${shortClock(sent.at)}, as a fix to make. Once it’s pushed to #${String(pr)}, try it again from there.`}
        </Text>
        <div className={s.arrives} aria-label="What you sent">
          <ol className={s.sentPins}>
            {sent.pins.map((pin, i) => (
              <li key={i} className={s.note}>
                <span className={s.noteN}>{i + 1}</span>
                <Text size="xs" tone={pin.note.trim() === "" ? "quiet" : "default"} preserveLines>
                  {pin.note.trim() === "" ? "No words: see the screenshot." : pin.note.trim()}
                </Text>
              </li>
            ))}
          </ol>
          <span className={s.files}>
            {sent.shot ? (
              <span className={s.file} data-text="code">
                <ImageIcon aria-hidden className={s.fileIcon} />
                screenshot-1.png
              </span>
            ) : null}
            {sent.clip ? <span className={s.file} data-text="code">{`the screen’s last ${String(CLIP_SECONDS)} s`}</span> : null}
          </span>
        </div>
      </section>
    );
  }
  if (!d.marking && d.pins.length === 0) {
    return (
      <section className={s.block} aria-label="Feedback">
        <div className={s.blockHead}>
          <Text size="xs" tone="quiet" strong>
            Feedback
          </Text>
        </div>
        <Text size="sm" tone="quiet">
          {`Something off? Mark up the page: point at it, say it in your words, and it goes to ${whose(pr)} as a fix to make.`}
        </Text>
      </section>
    );
  }
  return (
    <section className={s.block} aria-label="Feedback">
      <div className={s.blockHead}>
        <Text size="xs" tone="quiet" strong>
          {`Feedback for ${whose(pr)}`}
        </Text>
      </div>
      {d.pins.length === 0 ? (
        <Text size="sm" tone="quiet">
          Click the page where it’s wrong.
        </Text>
      ) : (
        <ol className={s.notes}>
          {d.pins.map((pin, i) => (
            <li key={i} className={s.note}>
              <span className={s.noteN}>{i + 1}</span>
              <Textarea
                aria-label={`What’s wrong at pin ${String(i + 1)}`}
                placeholder="What’s wrong here?"
                minRows={2}
                maxRows={5}
                maxLength={2000}
                value={pin.note}
                onChange={(e) => {
                  const note = e.target.value;
                  setDraft(id, (x) => ({ ...x, pins: x.pins.map((q, j) => (j === i ? { ...q, note } : q)) }));
                }}
              />
              <Button variant="quiet" iconOnly aria-label={`Remove pin ${String(i + 1)}`} onClick={() => setDraft(id, (x) => (x.pins.length === 1 ? { marking: x.marking, clip: x.clip, pins: [] } : { ...x, pins: x.pins.filter((_, j) => j !== i) }))}>
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ol>
      )}
      <div className={s.attach}>
        <span className={s.file}>
          <ImageIcon aria-hidden className={s.fileIcon} />A screenshot of the page with its pins
        </span>
        <Checkbox label={`The last ${String(CLIP_SECONDS)} s of the screen`} checked={d.clip} onCheckedChange={(v) => setDraft(id, (x) => ({ ...x, clip: v === true }))} />
      </div>
      {failed === null ? null : (
        <p className={s.failed} role="alert">
          <Text size="xs" tone="danger">{`Not sent. ${failed}`}</Text>
        </p>
      )}
      <div className={s.actions}>
        <Button variant="primary" size="sm" disabled={d.pins.length === 0 || busy} onClick={send}>
          {busy ? "Sending…" : `Send to ${whose(pr)}`}
        </Button>
      </div>
    </section>
  );
}

/** The preview from the person's own browser: its tailnet address, open to their devices only while it runs. */
function Elsewhere({ preview: p }: { preview: Preview }) {
  const url = p.url;
  if (url === undefined) return null;
  const copy = () =>
    void copyText(url).then((ok) => {
      if (ok) toast({ title: "Copied the address", key: `preview-url:${p.previewId}` });
    });
  const open = () =>
    void window.fleetd.openExternal(url).then((o) => {
      if (!o.ok) toast({ title: "Couldn’t open your browser", description: o.message, tone: "danger" });
    });
  return (
    <section className={s.block} aria-label="On your own devices">
      <div className={s.blockHead}>
        <Text size="xs" tone="quiet" strong>
          On your own devices
        </Text>
      </div>
      <span className={s.address}>
        <Truncate mono size="xs">
          {url}
        </Truncate>
      </span>
      <Text size="xs" tone="quiet">
        Opens from your devices on the tailnet only, while this runs. Anyone else gets nothing.
      </Text>
      <div className={s.actions}>
        <Button variant="secondary" size="sm" icon={<ExternalLink aria-hidden />} onClick={open}>
          Your browser
        </Button>
        <Button variant="quiet" size="sm" icon={<Copy aria-hidden />} onClick={copy}>
          Copy
        </Button>
      </div>
    </section>
  );
}
