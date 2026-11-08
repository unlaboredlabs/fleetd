// A project's built-in avatar, as the desktop draws it (its shared/botAvatar.ts and ui/primitives/BotFace.tsx): Ink,
// a soft-black being with light eyes on a pale tint of its color, in react-native-svg. Its moves come from the
// conductor (beingLife.ts) and run on the UI thread: a clock runs only while they do, and each frame poses the being,
// its shadow and sheen, and each face part and its blink, from the moves' springs. At rest nothing runs.
import { NavigationContext } from "@react-navigation/native";
import { useContext, useEffect, useId, useMemo, useRef, type ComponentRef, type ReactNode } from "react";
import { Dimensions, View } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedProps, useDerivedValue, useSharedValue, withSequence, withTiming, type DerivedValue } from "react-native-reanimated";
import Svg, { Defs, Ellipse, G, Path, RadialGradient, Rect, Stop, type GProps } from "react-native-svg";
import { blinks, BODY, colorsOf, drawnFace, LARGE, LIGHT, motionAt, PLACE, pose, poseParts, STILL, type IconColor, type IconFace, type Matrix } from "../desktop";
import { useTheme } from "../theme";
import { bringToLife } from "./beingLife";
import { useReduceMotion } from "./motion";

const AnimatedG = Animated.createAnimatedComponent(G);

/** A group that `posed`'s `index`th matrix moves. */
function Moving({ posed, index, children }: { posed: DerivedValue<Matrix[]>; index: number; children: ReactNode }) {
  // `matrix` is the native prop react-native-svg turns a transform into; its JS types don't name it.
  const props = useAnimatedProps(() => ({ matrix: (posed.value[index] ?? [1, 0, 0, 1, 0, 0]) as number[] }) as Partial<GProps>);
  return <AnimatedG animatedProps={props}>{children}</AnimatedG>;
}

export function Being({ face, color, size }: { face: IconFace; color: IconColor; size: number }) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const nav = useContext(NavigationContext);
  const id = useId().replace(/[^\w-]/g, "");
  const ref = useRef<ComponentRef<typeof View>>(null);
  const k = colorsOf(color, t.dark);
  const drawn = useMemo(() => drawnFace(face), [face]);
  const parts = useMemo(() => poseParts(drawn), [drawn]);
  const moves = useSharedValue<readonly number[]>([0, 0, 0, 0, 0]);
  const clock = useSharedValue(0);
  const posed = useDerivedValue(() => pose(parts, motionAt(moves.value, clock.value)), [parts]);

  useEffect(() => {
    if (reduce) return;
    const stop = bringToLife({
      canBlink: blinks(face),
      large: size >= LARGE,
      play: (next, from, until) => {
        moves.value = next;
        clock.value = withSequence(withTiming(from, { duration: 0 }), withTiming(until, { duration: Math.max(0, until - from) * 1000, easing: Easing.linear }));
      },
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
    return () => {
      stop();
      cancelAnimation(clock);
      moves.value = STILL;
    };
  }, [reduce, face, size, nav, moves, clock]);

  return (
    <View ref={ref} style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Defs>
          <RadialGradient id={`${id}b`} gradientUnits="userSpaceOnUse" cx={LIGHT.cx} cy={LIGHT.cy} r={LIGHT.r}>
            <Stop offset="0" stopColor={k.bodyHi} />
            <Stop offset={LIGHT.mid} stopColor={k.body} />
            <Stop offset="1" stopColor={k.bodyLo} />
          </RadialGradient>
          <RadialGradient id={`${id}h`} gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1">
            <Stop offset="0" stopColor={k.hi} stopOpacity={k.hiA} />
            <Stop offset="1" stopColor={k.hi} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id={`${id}s`} gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1">
            <Stop offset="0" stopColor={k.shadow} stopOpacity={k.shadowA} />
            <Stop offset="1" stopColor={k.shadow} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width="100" height="100" fill={k.field} />
        <G matrix={[PLACE.scale, 0, 0, PLACE.scale, PLACE.x, PLACE.y]}>
          <Moving posed={posed} index={1}>
            <Ellipse rx="1" ry="1" fill={`url(#${id}s)`} />
          </Moving>
          <Moving posed={posed} index={0}>
            <Path d={BODY} fill={`url(#${id}b)`} />
            <Moving posed={posed} index={2}>
              <Ellipse rx="1" ry="1" fill={`url(#${id}h)`} />
            </Moving>
            {drawn.map((d, i) => (
              <Moving key={i} posed={posed} index={3 + i * 2}>
                <Moving posed={posed} index={4 + i * 2}>
                  {d.ellipse === undefined ? <Path d={d.path ?? ""} fill={k.eye} /> : <Ellipse rx={d.ellipse[0]} ry={d.ellipse[1]} rotation={d.ellipse[2]} fill={k.eye} />}
                </Moving>
              </Moving>
            ))}
          </Moving>
        </G>
      </Svg>
    </View>
  );
}
