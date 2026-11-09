// A project's bot, as the desktop draws it (its shared/bot.ts and ui/primitives/Bot.tsx): one character for every
// project without a picture, whose motion says its state, in react-native-svg. Its rig lives in a shared value and
// steps on the UI thread, in a frame callback that runs only while beingLife.ts says it moves (a live state on screen,
// a moment, a change settling); each frame poses the body, its shadow and sheen, and draws both eyes from the rig's
// springs. A new `state` blends from wherever it is. At rest nothing runs.
import { NavigationContext } from "@react-navigation/native";
import { useContext, useEffect, useId, useRef, useState, type ComponentRef } from "react";
import { Dimensions, View } from "react-native";
import Animated, { useAnimatedProps, useFrameCallback, useSharedValue } from "react-native-reanimated";
import Svg, { Defs, Ellipse, FeGaussianBlur, Filter, G, Path, RadialGradient, Rect, Stop, type GProps, type PathProps } from "react-native-svg";
import { advanceRig, BODY, DIMMED, frameOf, LIGHT, moment, newRig, PAINT, setRigState, SMALL, type BotState, type Frame, type Rig } from "../desktop";
import { useTheme } from "../theme";
import { bringToLife, type Life } from "./beingLife";
import { useReduceMotion } from "./motion";

const AnimatedG = Animated.createAnimatedComponent(G);
const AnimatedPath = Animated.createAnimatedComponent(Path);

export function Being({ state, size }: { state: BotState; size: number }) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const nav = useContext(NavigationContext);
  const id = useId().replace(/[^\w-]/g, "");
  const ref = useRef<ComponentRef<typeof View>>(null);
  const p = PAINT[t.dark ? "dark" : "light"];
  const glow = size >= SMALL;
  // The rig lives as long as the bot at its size; its first frame is drawn settled in the state it arrives in.
  const [first] = useState(() => newRig(state, size, Math.floor(Math.random() * 2 ** 31)));
  const rig = useSharedValue<Rig>(first);
  const frame = useSharedValue<Frame>(frameOf(first));
  const calm = useSharedValue(reduce);
  const at = useRef(state);
  const life = useRef<Life | null>(null);

  const tick = useFrameCallback((info) => {
    // Null on the first frame after a start: a bot that slept goes on from where it was.
    const dt = (info.timeSincePreviousFrame ?? 0) / 1000;
    rig.modify((r) => {
      "worklet";
      advanceRig(r, dt, calm.value);
      frame.value = frameOf(r);
      return r;
    }, false);
  }, false);

  useEffect(() => {
    calm.value = reduce;
    life.current?.wake();
  }, [reduce, calm]);

  useEffect(() => {
    const l = bringToLife({
      solo: first.solo,
      idle: () => at.current === "idle",
      calm: () => reduce,
      run: (on) => tick.setActive(on),
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
  }, [first, reduce, nav, rig, tick]);

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
  const shadow = useAnimatedProps(() => ({ matrix: frame.value.shadow as unknown as number[], opacity: frame.value.shadowOpacity }) as Partial<GProps>);
  const sheen = useAnimatedProps(() => ({ matrix: frame.value.sheen as unknown as number[] }) as Partial<GProps>);
  const eyes = useAnimatedProps(() => ({ fillOpacity: 1 - DIMMED * frame.value.dim }) as Partial<GProps>);
  const glowing = useAnimatedProps(() => ({ opacity: p.glowA * frame.value.glow }) as Partial<GProps>, [p.glowA]);
  const left = useAnimatedProps(() => ({ d: frame.value.eyes[0] }) as Partial<PathProps>);
  const right = useAnimatedProps(() => ({ d: frame.value.eyes[1] }) as Partial<PathProps>);
  const leftGlow = useAnimatedProps(() => ({ d: frame.value.eyes[0] }) as Partial<PathProps>);
  const rightGlow = useAnimatedProps(() => ({ d: frame.value.eyes[1] }) as Partial<PathProps>);

  return (
    <View ref={ref} style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Defs>
          <RadialGradient id={`${id}b`} gradientUnits="userSpaceOnUse" cx={LIGHT.cx} cy={LIGHT.cy} r={LIGHT.r}>
            <Stop offset="0" stopColor={p.hi} />
            <Stop offset={LIGHT.mid} stopColor={p.body} />
            <Stop offset="1" stopColor={p.lo} />
          </RadialGradient>
          <RadialGradient id={`${id}h`} gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1">
            <Stop offset="0" stopColor={p.sheen} stopOpacity={p.sheenA} />
            <Stop offset="1" stopColor={p.sheen} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id={`${id}s`} gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1">
            <Stop offset="0" stopColor={p.shadow} stopOpacity={p.shadowA} />
            <Stop offset="1" stopColor={p.shadow} stopOpacity={0} />
          </RadialGradient>
          {glow ? (
            <Filter id={`${id}g`} x="-60%" y="-60%" width="220%" height="220%">
              <FeGaussianBlur stdDeviation={2.4} />
            </Filter>
          ) : null}
        </Defs>
        <Rect width="100" height="100" fill={p.field} />
        <AnimatedG animatedProps={shadow}>
          <Ellipse rx="1" ry="1" fill={`url(#${id}s)`} />
        </AnimatedG>
        <AnimatedG animatedProps={body}>
          <Path d={BODY} fill={`url(#${id}b)`} />
          <AnimatedG animatedProps={sheen}>
            <Ellipse rx="1" ry="1" fill={`url(#${id}h)`} />
          </AnimatedG>
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
