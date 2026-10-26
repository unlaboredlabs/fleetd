// A PR's Try it (design preview, W58): the PR's branch running on a machine for the person to use. The web build in a
// page frame, or the Android build on an emulator from the machine's pool, driven from here; its build steps while it
// starts; then feedback (pins on the page, words, a screenshot and the session's last 30 s) that goes to the PR's
// writer, and, where the person asked to try it before it merges, their sign-off. Nothing runs until Try it, and a run
// ends on End or after the idle time (docs/design/try-it.md).
import { Circle, ExternalLink, Globe, Image as ImageIcon, Lock, MapPin, RotateCw, Smartphone, Triangle, X } from "lucide-react";
import { useState, type MouseEvent } from "react";
import { Button, Checkbox, cx, Popover, PopoverContent, PopoverTrigger, StateGlyph, Text, Textarea, Truncate, useBeatRef, type GlyphState } from "../../ui";
import { shortClock } from "../chat/format";
import {
  addPin,
  dropPin,
  end,
  IDLE_MIN,
  MACHINE,
  notePin,
  pickTarget,
  send,
  setClip,
  setMarking,
  setWantTry,
  signOff,
  start,
  STEPS,
  URL_WEB,
  useTryIt,
  WRITER,
  type Run,
  type Target,
  type TryIt,
} from "./preview";
import { ShopApp, ShopPage } from "./Shop";
import s from "./tryit.module.css";

const TARGETS: readonly { readonly id: Target; readonly words: string; readonly icon: typeof Globe }[] = [
  { id: "web", words: "Web", icon: Globe },
  { id: "android", words: "Android", icon: Smartphone },
];

const PHASE: Readonly<Record<Run["phase"], { readonly word: string; readonly glyph: GlyphState; readonly tone: "default" | "success" | "quiet" }>> = {
  starting: { word: "Starting", glyph: "working", tone: "default" },
  ready: { word: "Ready", glyph: "working", tone: "success" },
  ended: { word: "Ended", glyph: "done", tone: "quiet" },
};

export function TryItView() {
  const st = useTryIt();
  const run = st.runs[st.target];
  return (
    <div className={s.view} data-screen={run === undefined ? "tryit.off" : `tryit.${run.phase}`}>
      <Head st={st} run={run} />
      <div className={s.body}>
        {run === undefined || run.phase === "ended" ? (
          <Off target={st.target} run={run} />
        ) : (
          <div className={s.stage}>
            <div className={s.player}>
              {st.target === "web" ? <WebFrame st={st} run={run} /> : <DeviceFrame st={st} run={run} />}
            </div>
            <Side st={st} run={run} />
          </div>
        )}
      </div>
    </div>
  );
}

function Head({ st, run }: { st: TryIt; run: Run | undefined }) {
  const phase = run === undefined ? undefined : PHASE[run.phase];
  return (
    <div className={s.head}>
      <div className={s.headRow}>
        <span className={s.state}>
          {phase === undefined ? (
            <Text size="sm" tone="quiet">
              Not running
            </Text>
          ) : (
            <>
              <StateGlyph state={phase.glyph} size="sm" settled={run?.phase === "ended"} still={run?.phase === "ready"} />
              <Text size="sm" strong tone={phase.tone}>
                {phase.word}
              </Text>
              <Text size="xs" tone="quiet">
                {run?.phase === "ended" ? `on ${MACHINE}` : run?.phase === "ready" ? `on ${MACHINE} · you drive it` : `on ${MACHINE}`}
              </Text>
            </>
          )}
        </span>
        <span className={s.segments} role="radiogroup" aria-label="What to try">
          {TARGETS.map((t) => {
            const Icon = t.icon;
            const r = st.runs[t.id];
            return (
              <button key={t.id} type="button" role="radio" aria-checked={st.target === t.id} className={s.segment} onClick={() => pickTarget(t.id)}>
                <Icon aria-hidden className={s.segmentIcon} />
                {t.words}
                {r !== undefined && r.phase !== "ended" ? <span className={s.segmentWord}>{r.phase === "ready" ? "ready" : "starting"}</span> : null}
              </button>
            );
          })}
        </span>
      </div>
      {run !== undefined && run.phase !== "ended" ? (
        <div className={s.headRow}>
          <Text size="xs" tone="quiet">
            {`Ends when you press End, or after ${IDLE_MIN} min without use. Nothing of it is kept running.`}
          </Text>
          <Button variant="quiet" size="sm" onClick={() => end(st.target)}>
            End
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Not started, or ended: what Try it would do, and the one control. */
function Off({ target, run }: { target: Target; run: Run | undefined }) {
  return (
    <div className={s.off}>
      <Text size="md" strong>
        {run === undefined ? (target === "web" ? "Try #14 on the web" : "Try #14 on an Android emulator") : "Ended"}
      </Text>
      <Text size="sm" tone="quiet" className={s.offWords}>
        {run !== undefined
          ? `Nothing of it runs on ${MACHINE} now: the server, its port and its worktree are gone. Try it again builds the branch afresh, from the cache.`
          : target === "web"
            ? `Builds the PR’s branch on ${MACHINE} with the project’s preview commands, starts it, and opens it here for you to use. Your own browser can open it too, from your devices on the tailnet.`
            : `Builds the Android app from the PR’s branch, installs it on a fresh emulator from ${MACHINE}’s pool, and shows it here for you to drive.`}
      </Text>
      <Button variant="primary" size="sm" onClick={() => start(target)}>
        {run === undefined ? "Try it" : "Try it again"}
      </Button>
      <Text size="xs" tone="faint">
        {`Nothing is built until you ask. It ends when you’re done, or after ${IDLE_MIN} min without use.`}
      </Text>
    </div>
  );
}

/** While it starts: the step at work, its words scanned on the beat, over a still dither field. */
function Starting({ target, run }: { target: Target; run: Run }) {
  const step = STEPS[target][run.done];
  const sweep = useBeatRef<HTMLSpanElement>(true);
  return (
    <div className={s.starting}>
      <span className={s.startingWords}>
        <span ref={sweep} data-sweep="">
          <Text size="sm">{step?.words ?? "Starting"}</Text>
        </span>
        <Text size="xs" tone="quiet">{`Step ${String(run.done + 1)} of ${String(STEPS[target].length)}`}</Text>
      </span>
    </div>
  );
}

function Pins({ st, target }: { st: TryIt; target: Target }) {
  return (
    <>
      {st.pins
        .filter((p) => p.target === target)
        .map((p) => (
          <span key={p.n} className={s.pin} style={{ left: `${String(p.x * 100)}%`, top: `${String(p.y * 100)}%` }} aria-label={`Pin ${String(p.n)}`}>
            {p.n}
          </span>
        ))}
    </>
  );
}

/** Marking up: a click anywhere on the screen drops the next pin there; the app underneath takes no clicks. */
function MarkLayer({ target }: { target: Target }) {
  const drop = (e: MouseEvent<HTMLDivElement>) => {
    const layer = e.currentTarget;
    const r = layer.getBoundingClientRect();
    // What's under the pin, as the page names it: the node reads the same from the page's DOM.
    layer.style.pointerEvents = "none";
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest("button, a, h1, input");
    layer.style.pointerEvents = "";
    const words = under?.textContent.trim();
    const what = under === null || under === undefined || words === undefined || words === "" ? undefined : `the ${under.tagName === "H1" ? "heading" : under.tagName === "A" ? "link" : "button"} “${words}”`;
    addPin(target, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, what);
  };
  return <div className={s.markLayer} onClick={drop} role="presentation" data-mark="" />;
}

function WebFrame({ st, run }: { st: TryIt; run: Run }) {
  const url = `${URL_WEB}/checkout${st.web.screen === "cart" ? "" : `/${st.web.screen}`}?lang=${st.web.lang}`;
  return (
    <>
      <div className={cx(s.frame, st.marking && s.marking)}>
        <div className={s.bar}>
          {st.marking ? <MapPin aria-hidden className={s.barIcon} /> : <Lock aria-hidden className={s.barIcon} />}
          <span className={s.url}>
            <Truncate mono size="xs" tone="inherit">
              {st.marking ? "Marking up: click where it’s wrong" : run.phase === "ready" ? url : URL_WEB}
            </Truncate>
          </span>
          {run.phase === "ready" && !st.marking ? (
            <Button variant="quiet" size="sm" icon={<ExternalLink aria-hidden />} onClick={() => void window.fleetd.openExternal(url)}>
              Your browser
            </Button>
          ) : null}
        </div>
        <div className={s.screen} data-app-under-test="">
          {run.phase === "starting" ? <Starting target="web" run={run} /> : <ShopPage app={st.web} />}
          {st.marking ? <MarkLayer target="web" /> : null}
          <Pins st={st} target="web" />
        </div>
      </div>
      <Under st={st} run={run} />
    </>
  );
}

function DeviceFrame({ st, run }: { st: TryIt; run: Run }) {
  return (
    <>
      <div className={cx(s.well, st.marking && s.marking)}>
        <div className={s.phone}>
          <div className={s.phoneScreen} data-app-under-test="">
            {run.phase === "starting" ? <Starting target="android" run={run} /> : <ShopApp app={st.phone} />}
            {st.marking ? <MarkLayer target="android" /> : null}
            <Pins st={st} target="android" />
          </div>
        </div>
        <div className={s.keys} role="toolbar" aria-label="Emulator">
          <Button variant="quiet" iconOnly aria-label="Back" disabled={run.phase !== "ready"}>
            <Triangle aria-hidden className={s.backKey} />
          </Button>
          <Button variant="quiet" iconOnly aria-label="Home" disabled={run.phase !== "ready"}>
            <Circle aria-hidden />
          </Button>
          <Button variant="quiet" iconOnly aria-label="Rotate" disabled={run.phase !== "ready"}>
            <RotateCw aria-hidden />
          </Button>
          <Text size="xs" tone="quiet">
            {`Pixel 8 · Android 15 · emulator on ${MACHINE}`}
          </Text>
        </div>
      </div>
      <Under st={st} run={run} />
    </>
  );
}

/** Under the frame: who drives, and Mark up. */
function Under({ st, run }: { st: TryIt; run: Run }) {
  if (run.phase !== "ready") return null;
  return (
    <div className={s.under}>
      <Text size="xs" tone="quiet" className={s.underWords}>
        {st.marking
          ? "Click where it’s wrong; each click is a pin you can say something about."
          : st.target === "web"
            ? "Your clicks and keys go to the page. The session is recorded, as every session is."
            : "Your taps, swipes and keys go to the emulator. The session is recorded, as every session is."}
      </Text>
      <Button variant="secondary" size="sm" icon={st.marking ? <X aria-hidden /> : <MapPin aria-hidden />} onClick={() => setMarking(!st.marking)}>
        {st.marking ? "Done marking" : "Mark up"}
      </Button>
    </div>
  );
}

function Side({ st, run }: { st: TryIt; run: Run }) {
  return (
    <div className={s.side}>
      {run.phase === "starting" ? (
        <Steps target={st.target} run={run} />
      ) : (
        <>
          <Feedback st={st} />
          {st.target === "web" ? <Elsewhere /> : <OnYourPhone />}
          <SignOffBox st={st} />
          <Steps target={st.target} run={run} folded />
        </>
      )}
    </div>
  );
}

function Steps({ target, run, folded = false }: { target: Target; run: Run; folded?: boolean }) {
  const [open, setOpen] = useState(!folded);
  const steps = STEPS[target];
  return (
    <section className={s.block} aria-label="Steps">
      <div className={s.blockHead}>
        <Text size="xs" tone="quiet" strong>
          {folded ? "How it started" : "Starting"}
        </Text>
        {folded ? (
          <Button variant="quiet" size="sm" onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Show"}
          </Button>
        ) : null}
      </div>
      {folded && !open ? (
        <Text size="xs" tone="quiet">
          {target === "web" ? "Built in 44 s; setup reused, the build cache warm." : "Built in 1 min 21 s; a fresh emulator from the pool."}
        </Text>
      ) : (
        <ol className={s.steps}>
          {steps.map((step, i) => {
            const state: GlyphState = i < run.done ? "done" : i === run.done ? "working" : "queued";
            return (
              <li key={step.words} className={s.step}>
                <StateGlyph state={state} size="sm" settled />
                <span className={s.stepWords}>
                  <Text size="sm" tone={state === "queued" ? "quiet" : "default"}>
                    {step.words}
                  </Text>
                  {step.detail !== undefined ? (
                    <Truncate size="xs" tone="quiet" mono={step.detail.startsWith("http")}>
                      {step.detail}
                    </Truncate>
                  ) : null}
                </span>
                <Text size="xs" tone="faint" tabular>
                  {state === "done" ? (step.took ?? "") : ""}
                </Text>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Feedback({ st }: { st: TryIt }) {
  const pins = st.pins.filter((p) => p.target === st.target);
  if (st.sent !== undefined && !st.marking) {
    return (
      <section className={s.block} aria-label="Feedback">
        <div className={s.blockHead}>
          <Text size="xs" tone="quiet" strong>
            Feedback
          </Text>
        </div>
        <Text size="sm">{`Sent to ${WRITER} at ${shortClock(new Date(st.sent.atMs).toISOString())}.`}</Text>
        <Text size="xs" tone="quiet">
          It reads it at its next step, as a steer, and pushes the fix to #14. Try it again from there.
        </Text>
        <div className={s.arrives} aria-label="What the writer got">
          <Text size="xs" tone="quiet" strong>
            What the writer got
          </Text>
          <pre className={s.message}>{st.sent.text}</pre>
          <span className={s.files}>
            <span className={s.file} data-text="code">
              <ImageIcon aria-hidden className={s.fileIcon} />
              screenshot-1.png
            </span>
            {st.clip ? (
              <span className={s.file} data-text="code">
                clip.webm · 0:30
              </span>
            ) : null}
          </span>
        </div>
      </section>
    );
  }
  if (!st.marking && pins.length === 0) {
    return (
      <section className={s.block} aria-label="Feedback">
        <div className={s.blockHead}>
          <Text size="xs" tone="quiet" strong>
            Feedback
          </Text>
        </div>
        <Text size="sm" tone="quiet">
          {`Something off? Mark up the ${st.target === "web" ? "page" : "screen"}: point at it, say it in your words, and it goes to ${WRITER} as a fix to make.`}
        </Text>
      </section>
    );
  }
  return (
    <section className={s.block} aria-label="Feedback">
      <div className={s.blockHead}>
        <Text size="xs" tone="quiet" strong>
          {`Feedback for ${WRITER}`}
        </Text>
      </div>
      {pins.length === 0 ? (
        <Text size="sm" tone="quiet">
          Click the page where it’s wrong.
        </Text>
      ) : (
        <ol className={s.notes}>
          {pins.map((p) => (
            <li key={p.n} className={s.note}>
              <span className={s.noteN}>{p.n}</span>
              <Textarea aria-label={`What’s wrong at pin ${String(p.n)}`} placeholder="What’s wrong here?" minRows={2} maxRows={5} value={p.note} onChange={(e) => notePin(p.n, e.target.value)} />
              <Button variant="quiet" iconOnly aria-label={`Remove pin ${String(p.n)}`} onClick={() => dropPin(p.n)}>
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ol>
      )}
      <div className={s.attach}>
        <span className={s.file}>
          <ImageIcon aria-hidden className={s.fileIcon} />
          {`A screenshot of the ${st.target === "web" ? "page" : "screen"} with its pins`}
        </span>
        <Checkbox label="The last 30 s of the session" checked={st.clip} onCheckedChange={(v) => setClip(v === true)} />
      </div>
      <div className={s.actions}>
        <Button variant="primary" size="sm" disabled={pins.length === 0} onClick={send}>
          {`Send to ${WRITER}`}
        </Button>
      </div>
    </section>
  );
}

/** The web run from the person's own browser: the tailnet address, reachable from their devices only. */
function Elsewhere() {
  return (
    <section className={s.block} aria-label="On your own devices">
      <div className={s.blockHead}>
        <Text size="xs" tone="quiet" strong>
          On your own devices
        </Text>
      </div>
      <Truncate mono size="xs">
        {URL_WEB}
      </Truncate>
      <Text size="xs" tone="quiet">
        Opens from your devices on the tailnet only, while this runs. Anyone else gets nothing.
      </Text>
    </section>
  );
}

/** A 21×21 code in the app's dither: the install link. Drawn from a fixed seed: it stands for the real one. */
function Code() {
  const n = 21;
  const finder = (x: number, y: number) =>
    [
      [0, 0],
      [n - 7, 0],
      [0, n - 7],
    ].some(([fx = 0, fy = 0]) => {
      const dx = x - fx;
      const dy = y - fy;
      if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return false;
      return dx === 0 || dy === 0 || dx === 6 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
    });
  const inFinder = (x: number, y: number) => [[0, 0], [n - 7, 0], [0, n - 7]].some(([fx = 0, fy = 0]) => x >= fx - 1 && x <= fx + 7 && y >= fy - 1 && y <= fy + 7);
  const cells: string[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const on = inFinder(x, y) ? finder(x, y) : ((x * 7 + y * 13 + x * y * 3) % 5 === 0) !== ((x + y) % 3 === 0);
      if (on) cells.push(`M${String(x)} ${String(y)}h1v1h-1z`);
    }
  }
  return (
    <svg className={s.code} viewBox={`-1 -1 ${String(n + 2)} ${String(n + 2)}`} role="img" aria-label="Install link as a code">
      <path d={cells.join("")} fill="currentColor" shapeRendering="crispEdges" />
    </svg>
  );
}

function OnYourPhone() {
  return (
    <section className={s.block} aria-label="On your phone">
      <div className={s.blockHead}>
        <Text size="xs" tone="quiet" strong>
          On your phone
        </Text>
      </div>
      <div className={s.phoneWays}>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="secondary" size="sm" icon={<Smartphone aria-hidden />}>
              Install on Android
            </Button>
          </PopoverTrigger>
          <PopoverContent className={s.codePop} side="left" align="start">
            <Code />
            <Text size="sm">Scan with your phone’s camera</Text>
            <Text size="xs" tone="quiet">
              The link opens on your devices on the tailnet only, works for 1 hour, and installs this build (app-debug.apk, 18.4 MB) beside the store’s.
            </Text>
          </PopoverContent>
        </Popover>
      </div>
      <Text size="xs" tone="quiet">
        iPhone: needs the project’s TestFlight set up, then a build per PR goes there. Until then, an iOS simulator on a Mac machine, driven from here.
      </Text>
    </section>
  );
}

function SignOffBox({ st }: { st: TryIt }) {
  return (
    <section className={s.block} aria-label="Sign-off">
      <div className={s.blockHead}>
        <Text size="xs" tone="quiet" strong>
          Before it merges
        </Text>
      </div>
      {st.signedOff ? (
        <Text size="sm">You said it works for you. It goes into the merge line.</Text>
      ) : st.wantTry ? (
        <>
          <Text size="sm">The merge line holds #14 until you say it works for you.</Text>
          <div className={s.actions}>
            <Button variant="primary" size="sm" onClick={signOff}>
              Works for me
            </Button>
            <Button variant="quiet" size="sm" onClick={() => setWantTry(false)}>
              Don’t wait for me
            </Button>
          </div>
        </>
      ) : (
        <Checkbox
          label="I want to try this before it merges"
          description="The merge line waits for your “works for me”. This PR only."
          checked={false}
          onCheckedChange={(v) => setWantTry(v === true)}
        />
      )}
    </section>
  );
}

