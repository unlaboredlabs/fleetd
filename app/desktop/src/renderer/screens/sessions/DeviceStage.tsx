// A phone screen's device around its picture (W859): in 3D, a model of the real device (deviceModel's numbers, drawn by
// scene.ts) that a drag turns and that folds, opens and turns with its simulator; flat, the same device face on, drawn
// with CSS around the picture itself. Either way the picture fills the lit display exactly: the frame is built from the
// picture's own shape, so nothing is letterboxed, and a Duo's cover shows in a Duo's cover, never a plain iPhone.
// The toolbar beside it (DeviceRail) has the device's controls while it's yours, and always the view's: 3D or flat, and
// back to facing you, fitted. 3D is the default where WebGL runs on a graphics card; a software renderer starts flat.
//
// The picture comes as a ScreenSurface (surface.ts): its canvas is the 3D display's texture, redrawn on each picture,
// and in the flat frame it is the display itself. While the screen is yours, a press on the 3D display goes to the
// device at the point under it; anywhere else a drag turns the model.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { cx, Text } from "../../ui";
import { bodyOf, flatOf, poseOf, type Body, type Pose } from "./deviceModel";
import type { Stage } from "./scene";
import type { ScreenSurface } from "./surface";
import { webgl, type Webgl } from "./webgl";
import { keyframesOf, moveOf, MOVE_MS, turnBetween, type Box } from "./turn";
import s from "./sessions.module.css";

/** Where a point of the viewport falls on the picture, as fractions from its top left; null off it. */
export type Place = (clientX: number, clientY: number) => { x: number; y: number } | null;

/** 3D or flat, as this computer last had it. */
export type ViewMode = "3d" | "flat";
const MODE_KEY = "fleetd.screens.view";
const storedMode = (): ViewMode | undefined => {
  const v = window.localStorage.getItem(MODE_KEY);
  return v === "3d" || v === "flat" ? v : undefined;
};

/** The 3D view's state, for the toolbar's view buttons. */
export interface StageView {
  readonly mode: ViewMode;
  readonly setMode: (mode: ViewMode) => void;
  /** Back to facing you, fitted; only while turned. */
  readonly face: (() => void) | undefined;
  /** 3D can't start here (no WebGL): only flat. */
  readonly flatOnly: boolean;
}

/** A device's body and pose for a session's device and picture: stable while they don't change. */
export function useDevice(kind: string | undefined, model: string | undefined, fold: string | undefined, orientation: string | undefined, size: { width: number; height: number } | undefined) {
  const w = size?.width ?? 0;
  const h = size?.height ?? 0;
  const body = useMemo(() => bodyOf(kind, model, w === 0 ? undefined : { width: w, height: h }), [kind, model, w, h]);
  const pose = useMemo(() => (body === undefined ? undefined : poseOf(body, fold, orientation, w === 0 ? undefined : { width: w, height: h })), [body, fold, orientation, w, h]);
  return { body, pose };
}

export function DeviceStage({
  body,
  pose,
  surface,
  screen,
  rail,
  takes,
  input,
  placeRef,
  label,
  caption,
}: {
  body: Body;
  pose: Pose;
  /** The picture; absent until its first one. */
  surface: ScreenSurface | undefined;
  /** The display's own element in the flat frame: the picture, and the words on an empty one. */
  screen: (style: CSSProperties) => ReactNode;
  /** The toolbar, given the view's state. */
  rail: (view: StageView) => ReactNode;
  /** The screen is yours here: presses on its display go to the device. */
  takes: boolean;
  /** The device's input handlers (useFrameInput), for presses on the 3D display. */
  input: Record<string, ((e: never) => void) | undefined> | undefined;
  /** Set to the 3D display's point lookup while 3D shows, for `input`'s coordinates. */
  placeRef: RefObject<Place | null>;
  label: string;
  /** Words on the display before its first picture. */
  caption?: string;
}) {
  // What the person chose on this computer, if they have.
  const [chosen, setChosen] = useState<ViewMode | undefined>(storedMode);
  // This window's WebGL (webgl.ts, probed once): none is flat only; a software renderer is flat unless the person chose
  // 3D here. A stage that then fails to start says none.
  const [renderer, setRenderer] = useState<Webgl>(webgl);
  const setMode = (m: ViewMode) => {
    window.localStorage.setItem(MODE_KEY, m);
    setChosen(m);
  };
  const failed = renderer === "none";
  const three = !failed && (chosen === "3d" || (chosen === undefined && renderer === "gpu"));
  // Back to facing you, while a drag has turned it.
  const [face, setFace] = useState<{ run: () => void } | undefined>(undefined);
  const view: StageView = {
    mode: three ? "3d" : "flat",
    setMode,
    face: three ? face?.run : undefined,
    flatOnly: failed,
  };
  return (
    <div className={s.deviceAt} data-mode={view.mode}>
      {/* The flat device stays put in both modes, so the picture's own elements (a replay's video, the live JPEG and
          H.264 canvas) are never made anew when 3D and flat switch: in 3D they keep loading and playing out of sight,
          and the model draws their picture. */}
      <Flat body={body} pose={pose} screen={screen} away={three} />
      {three ? (
        <>
          <Model
            body={body}
            pose={pose}
            surface={surface}
            takes={takes}
            input={input}
            placeRef={placeRef}
            label={label}
            onFace={setFace}
            onRenderer={setRenderer}
          />
          {surface === undefined && caption !== undefined ? (
            <span className={s.modelCaption}>
              <Text size="xs" tone="quiet">
                {caption}
              </Text>
            </span>
          ) : null}
        </>
      ) : null}
      {rail(view)}
    </div>
  );
}

/** The device flat, face on: a CSS frame the picture's shape, its corners the device's, an island, an open Duo's crease. */
function Flat({ body, pose, screen, away }: { body: Body; pose: Pose; screen: (style: CSSProperties) => ReactNode; away: boolean }) {
  const f = flatOf(body, pose);
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<{ box: Box; roll: number } | null>(null);
  // Turned or folded, it moves to its new shape from where it stood (turn.ts) rather than jumping.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const box = { width: el.offsetWidth, height: el.offsetHeight };
    const was = last.current;
    last.current = { box, roll: pose.roll };
    if (was === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const move = moveOf(was.box, box, turnBetween(ROLL_WORD[was.roll], ROLL_WORD[pose.roll]));
    if (move !== null) el.animate(keyframesOf(move), { duration: MOVE_MS, easing: EASE });
  }, [f.aspect, pose.roll]);
  const pct = (n: number) => `calc(var(--w) * ${String(n)})`;
  const radius = (r: readonly number[]) => r.map(pct).join(" ");
  return (
    <div className={s.flatAt} data-away={away ? "" : undefined} inert={away} aria-hidden={away || undefined} style={{ "--aspect": String(f.aspect) } as CSSProperties}>
      <div
        ref={ref}
        className={s.flat}
        data-kind={body.kind}
        data-roll={pose.roll}
        data-panel={pose.panel}
        style={{ borderRadius: radius(f.outer), padding: `calc(var(--w) * ${String(f.bezelX)})`, "--finish": hex(body.finish.frame) } as CSSProperties}
      >
        {screen({ borderRadius: radius(f.inner), aspectRatio: String(f.screenAspect), width: "100%" })}
        {f.island === undefined ? null : (
          <span
            className={s.island}
            aria-hidden
            style={{
              left: `calc(var(--w) * ${String(f.bezelX)} + (100% - 2 * var(--w) * ${String(f.bezelX)}) * ${String(f.island.left)})`,
              top: `calc(var(--w) * ${String(f.bezelX)} + (100% - 2 * var(--w) * ${String(f.bezelX)}) * ${String(f.island.top)})`,
              width: `calc((100% - 2 * var(--w) * ${String(f.bezelX)}) * ${String(f.island.width)})`,
              height: `calc((100% - 2 * var(--w) * ${String(f.bezelX)}) * ${String(f.island.height)})`,
            }}
          />
        )}
        {f.crease === undefined ? null : <span className={s.crease} data-crease={f.crease} aria-hidden />}
      </div>
    </div>
  );
}

const ROLL_WORD: Readonly<Record<number, string>> = { 0: "portrait", 90: "landscape_left", [-90]: "landscape_right", 180: "portrait_upside_down" };
const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** tokens.css --ease-spring, sampled (WAAPI takes no var()). */
const EASE =
  "linear(0, 0.056 5%, 0.177 10%, 0.316 15%, 0.449 20%, 0.566 25%, 0.665 30%, 0.744 35%, 0.807 40%, 0.855 45%, 0.893 50%, 0.921 55%, 0.942 60%, 0.958 65%, 0.969 70%, 0.978 75%, 0.984 80%, 0.988 85%, 0.992 90%, 0.994 95%, 1)";

/** How far a press may move before it is a drag (px). */
const SLOP = 3;

/** The device in 3D: a WebGL canvas the stage's size; drags turn it, presses on its display go to the device while it's yours. */
function Model({
  body,
  pose,
  surface,
  takes,
  input,
  placeRef,
  label,
  onFace,
  onRenderer,
}: {
  body: Body;
  pose: Pose;
  surface: ScreenSurface | undefined;
  takes: boolean;
  input: Record<string, ((e: never) => void) | undefined> | undefined;
  placeRef: RefObject<Place | null>;
  label: string;
  /** Says how to face it front again once a drag turned it, and undefined once it faces you. */
  onFace: (face: { run: () => void } | undefined) => void;
  onRenderer: (renderer: "gpu" | "software" | "none") => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<Stage | null>(null);
  // While a press that began on the display is down: its last point on it.
  const held = useRef<{ x: number; y: number } | null>(null);
  // The stage, once three.js (its own chunk, loaded only for a 3D device) has made it.
  const [made, setMade] = useState<Stage | null>(null);
  useEffect(() => {
    const el = canvas.current;
    const holder = box.current;
    if (el === null || holder === null) return undefined;
    let gone = false;
    let built: Stage | undefined;
    let observer: ResizeObserver | undefined;
    void import("./scene").then(
      ({ createStage }) => {
        if (gone) return;
        try {
          built = createStage(el);
        } catch {
          onRenderer("none");
          return;
        }
        const st = built;
        onRenderer(st.software() ? "software" : "gpu");
        stage.current = st;
        const resize = () => st.resize(holder.clientWidth, holder.clientHeight);
        resize();
        observer = new ResizeObserver(resize);
        observer.observe(holder);
        placeRef.current = (x, y) => {
          const r = el.getBoundingClientRect();
          const at = st.pick((x - r.left) / Math.max(1, r.width), (y - r.top) / Math.max(1, r.height));
          // A press that slides off the display keeps its last point on it, as a finger at a real screen's edge.
          if (at !== null && held.current !== null) held.current = at;
          return at ?? held.current;
        };
        setMade(st);
      },
      () => onRenderer("none"),
    );
    return () => {
      gone = true;
      observer?.disconnect();
      placeRef.current = null;
      stage.current = null;
      built?.dispose();
    };
  }, [placeRef, onRenderer]);
  useEffect(() => {
    made?.set({ body, pose });
  }, [made, body, pose]);
  // Taken over, the keys go to the device at once.
  useEffect(() => {
    if (takes) box.current?.focus();
  }, [takes]);
  // The picture: its canvas the display's texture, redrawn on each new picture.
  useEffect(() => {
    if (made === null) return undefined;
    made.picture(surface?.element);
    if (surface === undefined) return undefined;
    return surface.onPicture(() => made.changed());
  }, [made, surface]);

  const faceFront = () => {
    stage.current?.face();
    onFace(undefined);
  };
  // One gesture at a time: a press on the display (to the device), or a drag (turns the model).
  const gesture = useRef<{ kind: "device" | "turn"; x: number; y: number; moved: boolean } | null>(null);
  const call = (name: string, e: unknown) => (input?.[name] as ((e: unknown) => void) | undefined)?.(e);
  return (
    <div
      ref={box}
      className={s.model}
      role={takes ? "application" : "img"}
      aria-label={takes ? `${label}: your clicks and keys go to it; drag outside its screen to turn it` : `${label}: drag to turn it`}
      tabIndex={takes ? 0 : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0 && !takes) return;
        const onScreen = takes && placeRef.current?.(e.clientX, e.clientY) !== null;
        gesture.current = { kind: onScreen ? "device" : "turn", x: e.clientX, y: e.clientY, moved: false };
        if (onScreen) {
          held.current = placeRef.current?.(e.clientX, e.clientY) ?? null;
          call("onPointerDown", e);
        }
        else e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const g = gesture.current;
        if (g === null) {
          if (takes) call("onPointerMove", e);
          return;
        }
        if (g.kind === "device") {
          call("onPointerMove", e);
          return;
        }
        const dx = e.clientX - g.x;
        const dy = e.clientY - g.y;
        if (!g.moved && Math.hypot(dx, dy) < SLOP) return;
        g.moved = true;
        g.x = e.clientX;
        g.y = e.clientY;
        const st = stage.current;
        if (st === null) return;
        st.turnBy(dx, dy);
        onFace(st.turned() ? { run: faceFront } : undefined);
      }}
      onPointerUp={(e) => {
        const g = gesture.current;
        gesture.current = null;
        if (g?.kind === "device") call("onPointerUp", e);
        held.current = null;
      }}
      onPointerCancel={() => {
        gesture.current = null;
        held.current = null;
      }}
      onDoubleClick={(e) => {
        if (takes && placeRef.current?.(e.clientX, e.clientY) !== null) return;
        faceFront();
      }}
      onWheel={(e) => {
        if (takes && placeRef.current?.(e.clientX, e.clientY) !== null) call("onWheel", e);
      }}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => call("onKeyDown", e)}
      onKeyUp={(e: KeyboardEvent<HTMLDivElement>) => call("onKeyUp", e)}
      onPaste={(e) => call("onPaste", e)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvas} className={cx(s.modelCanvas)} />
    </div>
  );
}
