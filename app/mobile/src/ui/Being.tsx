// A project's bot, as the desktop draws it (its shared/bot.ts and ui/primitives/Bot.tsx): one character for every
// project without a picture, whose motion says its state, in react-native-svg. It has no circle: its body alone, in
// the shape (BOT_BODIES) and color (BOT_PAINT) picked for it, cropped to fill its box (CROP), is the picture. Its hops
// and slumps reach a little past the box, so it's drawn on a canvas REACH larger on each side, never clipped. Its rig
// lives in a shared value and steps on the UI thread, in a frame callback that runs only while beingLife.ts says it
// moves (a live state on screen, a moment, a change settling); each frame poses the body and draws both eyes from the
// rig's springs, drawn again at a rate of its own (beingDraw.ts). A new `state` blends from wherever it is. At rest
// nothing runs.
import { NavigationContext } from "@react-navigation/native";
import { useContext, useEffect, useId, useRef, useState, type ComponentRef } from "react";
import { Dimensions, View } from "react-native";
import Animated, { runOnJS, runOnUI, useAnimatedProps, useFrameCallback, useSharedValue } from "react-native-reanimated";
import Svg, { Defs, FeGaussianBlur, Filter, G, Path, type GProps, type PathProps } from "react-native-svg";
import { advanceRig, BOT_BODIES, CROP, DIMMED, REACH, drawnAt, frameOf, LARGE, moment, newRig, paintOf, setRigState, shapeOf, type BotState, type Frame, type Rig } from "../desktop";
import { drawEveryMs, drawStep } from "../beingDraw";
import { useTheme } from "../theme";
import { bringToLife, type Life } from "./beingLife";
import { useReduceMotion } from "./motion";

const AnimatedG = Animated.createAnimatedComponent(G);
const AnimatedPath = Animated.createAnimatedComponent(Path);

/** A glow dimmer than this is drawn as none. */
const GLOW_LIT = 0.01;

const VIEW = `${String(CROP.x - REACH)} ${String(CROP.y - REACH)} ${String(CROP.w + 2 * REACH)} ${String(CROP.w + 2 * REACH)}`;

export function Being({ state, size, color, shape }: { state: BotState; size: number; color?: string | undefined; shape?: string | undefined }) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const nav = useContext(NavigationContext);
  const id = useId().replace(/[^\w-]/g, "");
  const ref = useRef<ComponentRef<typeof View>>(null);
  const p = paintOf(color, t.dark);
  // The rig lives as long as the bot at its size; its first frame is drawn settled in the state it arrives in. Its
  // small-size rules go by the size its body is drawn at, its life on its own by its box.
  const [first] = useState(() => newRig(state, drawnAt(size), Math.floor(Math.random() * 2 ** 31), size >= LARGE));
  // Its glow is a Gaussian blur through Core Image each time the bot is drawn, even while it's dark: drawn only while
  // it's lit (a bot that needs you), as the frames say.
  const [lit, setLit] = useState(() => first.glow && frameOf(first).glow > GLOW_LIT);
  const glow = first.glow && lit;
  const litNow = useSharedValue(lit);
  const rig = useSharedValue<Rig>(first);
  const frame = useSharedValue<Frame>(frameOf(first));
  const calm = useSharedValue(reduce);
  // Read by its life as it goes, so turning Reduce Motion on or off keeps the same life, which then settles it.
  const reduced = useRef(reduce);
  const at = useRef(state);
  const life = useRef<Life | null>(null);

  const every = drawEveryMs(size);
  /** Since it was last drawn, in ms. */
  const sinceDrawn = useSharedValue(0);
  /** Its pose from the rig, and its glow drawn while lit. */
  const draw = (r: Rig) => {
    "worklet";
    const next = frameOf(r);
    frame.value = next;
    if (r.glow && next.glow > GLOW_LIT !== litNow.value) {
      litNow.value = next.glow > GLOW_LIT;
      runOnJS(setLit)(litNow.value);
    }
  };
  const tick = useFrameCallback((info) => {
    // Null on the first frame after a start: a bot that slept goes on from where it was.
    const ms = info.timeSincePreviousFrame ?? 0;
    const step = drawStep(sinceDrawn.value, ms, every);
    sinceDrawn.value = step.since;
    rig.modify((r) => {
      "worklet";
      advanceRig(r, ms / 1000, calm.value);
      if (step.draw) draw(r);
      return r;
    }, false);
  }, false);
  // Stopped between drawings: drawn once more, as it came to rest.
  const settle = () => {
    "worklet";
    sinceDrawn.value = 0;
    draw(rig.value);
  };

  useEffect(() => {
    const l = bringToLife({
      solo: first.solo,
      idle: () => at.current === "idle",
      calm: () => reduced.current,
      run: (on) => {
        tick.setActive(on);
        if (!on) runOnUI(settle)();
      },
      moment: () =>
        rig.modify((r) => {
          "worklet";
          moment(r);
          return r;
        }, false),
      visible: () =>
        new Promise((resolve) => {
          const view = ref.current;
          if (view === null || nav?.isFocused() === false) return resolve(false);
          view.measureInWindow((x: number, y: number, w: number, h: number) => {
            const win = Dimensions.get("window");
            resolve(w > 0 && y + h > 0 && y < win.height && x + w > 0 && x < win.width);
          });
        }),
    });
    life.current = l;
    return () => {
      l.release();
      life.current = null;
    };
  }, [first, nav, rig, tick]);

  // Reduce Motion turned on mid-loop: the same life runs on while the springs settle into the still pose.
  useEffect(() => {
    if (reduced.current === reduce) return;
    reduced.current = reduce;
    calm.value = reduce;
    life.current?.wake();
  }, [reduce, calm]);

  useEffect(() => {
    if (at.current === state) return;
    at.current = state;
    rig.modify((r) => {
      "worklet";
      setRigState(r, state, calm.value);
      return r;
    }, false);
    life.current?.wake();
  }, [state, rig, calm]);

  // `matrix` is the native prop react-native-svg turns a transform into; its JS types don't name it.
  const body = useAnimatedProps(() => ({ matrix: frame.value.body as unknown as number[] }) as Partial<GProps>);
  const eyes = useAnimatedProps(() => ({ fillOpacity: 1 - DIMMED * frame.value.dim }) as Partial<GProps>);
  const glowing = useAnimatedProps(() => ({ opacity: p.glowA * frame.value.glow }) as Partial<GProps>, [p.glowA]);
  const left = useAnimatedProps(() => ({ d: frame.value.eyes[0] }) as Partial<PathProps>);
  const right = useAnimatedProps(() => ({ d: frame.value.eyes[1] }) as Partial<PathProps>);
  const leftGlow = useAnimatedProps(() => ({ d: frame.value.eyes[0] }) as Partial<PathProps>);
  const rightGlow = useAnimatedProps(() => ({ d: frame.value.eyes[1] }) as Partial<PathProps>);

  const out = (size * REACH) / CROP.w;
  const canvas = size + 2 * out;
  return (
    <View ref={ref} style={{ width: size, height: size }}>
      <Svg width={canvas} height={canvas} viewBox={VIEW} style={{ position: "absolute", left: -out, top: -out }}>
        {glow ? (
          <Defs>
            <Filter id={`${id}g`} x="-60%" y="-60%" width="220%" height="220%">
              <FeGaussianBlur stdDeviation={2.4} />
            </Filter>
          </Defs>
        ) : null}
        <AnimatedG animatedProps={body}>
          <Path d={BOT_BODIES[shapeOf(shape)]} fill={p.body} />
          {glow ? (
            <AnimatedG animatedProps={glowing} filter={`url(#${id}g)`} fill={p.eye}>
              <AnimatedPath animatedProps={leftGlow} />
              <AnimatedPath animatedProps={rightGlow} />
            </AnimatedG>
          ) : null}
          <AnimatedG animatedProps={eyes} fill={p.eye}>
            <AnimatedPath animatedProps={left} />
            <AnimatedPath animatedProps={right} />
          </AnimatedG>
        </AnimatedG>
      </Svg>
    </View>
  );
}
